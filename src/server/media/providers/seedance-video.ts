import 'server-only';
import { MEDIA_LIMITS, ProviderFailed } from './types';
import type {
  GeneratedAsset,
  VideoGenerationProvider,
  VideoJob,
  VideoRequest,
  VideoStatus,
} from './types';

/**
 * Seedance 2.0, through fal's queue API.
 *
 * fal is the route ByteDance publishes for Seedance 2.0; there is no
 * first-party endpoint to call instead. What is verified and relied on here is
 * fal's queue contract:
 *
 *   POST https://queue.fal.run/{model}                      -> { request_id }
 *   GET  https://queue.fal.run/{model}/requests/{id}/status -> IN_QUEUE |
 *                                                              IN_PROGRESS |
 *                                                              COMPLETED
 *   GET  https://queue.fal.run/{model}/requests/{id}        -> result
 *   PUT  https://queue.fal.run/{model}/requests/{id}/cancel
 *
 * with `Authorization: Key <FAL_KEY>`. Cancellation is a real endpoint, which
 * is why this provider claims to support it.
 *
 * The REST queue is used rather than the fal SDK because the SDK's convenience
 * call waits for the video, and waiting is the one thing a queued job must not
 * do. Polling belongs to our worker.
 *
 * NOT VERIFIED: the exact field the finished result puts the video URL in.
 * Rather than assert a shape from memory, findVideoUrl() looks through the
 * result for a plausible video and fails honestly when it cannot find one.
 *
 * PRIVACY: this sends the prompt, and for image-to-video the reference image
 * bytes, to fal. Nothing else — no company id, no storage path, no ids of ours.
 * Payloads are never logged.
 */

const BASE_URL = 'https://queue.fal.run';
const TEXT_TO_VIDEO = 'bytedance/seedance-2.0/text-to-video';
const IMAGE_TO_VIDEO = 'bytedance/seedance-2.0/image-to-video';

export class SeedanceVideoProvider implements VideoGenerationProvider {
  readonly name = 'seedance' as const;
  readonly model: string;
  readonly configured: boolean;
  readonly resolutions = ['480p', '720p', '1080p'] as const;
  readonly supportsCancel = true;

  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  /** Which endpoint a job was submitted to, so polling addresses the same one. */
  private readonly routes = new Map<string, string>();

  constructor(apiKey: string | undefined, baseUrl = BASE_URL, model = TEXT_TO_VIDEO) {
    this.apiKey = apiKey;
    this.configured = Boolean(apiKey);
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.model = model;
  }

  async submit(request: VideoRequest): Promise<VideoJob> {
    this.requireKey();

    // The route is chosen by whether there is a reference frame, not by
    // anything the caller names, so a client cannot select an endpoint.
    const route = request.reference ? IMAGE_TO_VIDEO : TEXT_TO_VIDEO;

    const body: Record<string, unknown> = { prompt: request.prompt };
    if (request.resolution) body.resolution = request.resolution;
    if (request.durationSeconds) body.duration = String(request.durationSeconds);
    if (request.aspectRatio) body.aspect_ratio = request.aspectRatio;
    if (request.reference) {
      // A data URI keeps the bytes in the request rather than requiring us to
      // publish the customer's image somewhere fal can fetch it.
      body.image_url = `data:${request.reference.mimeType};base64,${request.reference.bytes.toString('base64')}`;
    }

    const response = await this.call('POST', `${this.baseUrl}/${route}`, body);
    const payload = await readJson(response);

    const requestId = stringAt(payload, 'request_id');
    if (!requestId) {
      throw new ProviderFailed(
        'PROVIDER_ERROR',
        'transient',
        'The video provider accepted the job but did not return a job id.',
      );
    }

    this.routes.set(requestId, route);
    return {
      providerJobId: requestId,
      model: route,
      usage: { providerRequestId: requestId, inputUnits: request.prompt.length },
    };
  }

  async poll(providerJobId: string): Promise<VideoStatus> {
    this.requireKey();
    const route = this.routes.get(providerJobId) ?? TEXT_TO_VIDEO;

    const statusResponse = await this.call(
      'GET',
      `${this.baseUrl}/${route}/requests/${encodeURIComponent(providerJobId)}/status`,
    );
    const statusPayload = await readJson(statusResponse);
    const status = stringAt(statusPayload, 'status');

    if (status === 'IN_QUEUE' || status === 'IN_PROGRESS') return { state: 'pending' };

    if (status !== 'COMPLETED') {
      return {
        state: 'failed',
        code: 'GENERATION_FAILED',
        message: 'The video provider reported the job did not finish.',
      };
    }

    const resultResponse = await this.call(
      'GET',
      `${this.baseUrl}/${route}/requests/${encodeURIComponent(providerJobId)}`,
    );
    const result = await readJson(resultResponse);

    const url = findVideoUrl(result);
    if (!url) {
      return {
        state: 'failed',
        code: 'PROVIDER_ERROR',
        message: 'The video finished but no video file was found in the result.',
      };
    }

    const asset = await this.download(url);
    return {
      state: 'completed',
      assets: [asset],
      usage: { providerRequestId: providerJobId, outputUnits: 1 },
    };
  }

  async cancel(providerJobId: string): Promise<void> {
    this.requireKey();
    const route = this.routes.get(providerJobId) ?? TEXT_TO_VIDEO;
    // 400 means it already finished, 404 that fal has forgotten it. Neither is
    // worth raising: in both cases there is nothing left to cancel.
    await this.call(
      'PUT',
      `${this.baseUrl}/${route}/requests/${encodeURIComponent(providerJobId)}/cancel`,
      undefined,
      [202, 400, 404],
    );
  }

  private requireKey(): void {
    if (!this.apiKey) {
      throw new ProviderFailed(
        'PROVIDER_NOT_CONFIGURED',
        'permanent',
        'Video generation is not configured.',
      );
    }
  }

  private async call(
    method: string,
    url: string,
    body?: unknown,
    tolerate: number[] = [],
  ): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          // The key goes in a header and nowhere else. Never logged, never
          // placed in a URL where it would reach an access log.
          authorization: `Key ${this.apiKey}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(MEDIA_LIMITS.requestTimeoutMs),
      });
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
      throw new ProviderFailed(
        timedOut ? 'PROVIDER_TIMEOUT' : 'PROVIDER_ERROR',
        'transient',
        timedOut ? 'The video provider timed out.' : 'The video provider could not be reached.',
      );
    }

    if (response.ok || tolerate.includes(response.status)) return response;
    throw classify(response);
  }

  private async download(url: string): Promise<GeneratedAsset> {
    // The result URL is fal's own, and it is fetched server-side so the bytes
    // land in our private bucket rather than the browser following a link to
    // somebody else's host.
    let response: Response;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(MEDIA_LIMITS.requestTimeoutMs) });
    } catch {
      throw new ProviderFailed('PROVIDER_ERROR', 'transient', 'The finished video could not be downloaded.');
    }
    if (!response.ok) throw classify(response);

    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > MEDIA_LIMITS.maxAssetBytes) {
      throw new ProviderFailed('PROVIDER_ERROR', 'permanent', 'The generated video is too large to store.');
    }

    return {
      bytes,
      mimeType: response.headers.get('content-type')?.split(';')[0]?.trim() ?? 'video/mp4',
    };
  }
}

/**
 * Looks for the finished video in a result of unverified shape.
 *
 * fal models return their output under model-specific keys, and this one's was
 * not confirmed against documentation. So rather than reach for `result.video.url`
 * and break silently if it is `result.videos[0].url`, this walks the structure
 * for the first URL that is plainly a video. If the shape is something else
 * again, the caller reports a normalised failure instead of a wrong asset.
 */
function findVideoUrl(payload: unknown): string | null {
  const seen = new Set<unknown>();

  const walk = (node: unknown, depth: number): string | null => {
    if (depth > 6 || node === null || typeof node !== 'object') return null;
    if (seen.has(node)) return null;
    seen.add(node);

    if (Array.isArray(node)) {
      for (const item of node) {
        const found = walk(item, depth + 1);
        if (found) return found;
      }
      return null;
    }

    const record = node as Record<string, unknown>;
    const url = record.url;
    if (typeof url === 'string' && looksLikeVideo(url, record)) return url;

    for (const value of Object.values(record)) {
      const found = walk(value, depth + 1);
      if (found) return found;
    }
    return null;
  };

  return walk(payload, 0);
}

function looksLikeVideo(url: string, record: Record<string, unknown>): boolean {
  if (!/^https?:\/\//i.test(url)) return false;
  const contentType = record.content_type;
  if (typeof contentType === 'string') return contentType.startsWith('video/');
  return /\.(mp4|webm|mov|m4v)(\?|$)/i.test(url);
}

function classify(response: Response): ProviderFailed {
  if (response.status === 429) {
    const retryAfter = Number(response.headers.get('retry-after'));
    return new ProviderFailed(
      'RATE_LIMITED',
      'rate_limited',
      'The video provider is rate limiting us.',
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
    );
  }
  if (response.status === 401 || response.status === 403) {
    return new ProviderFailed(
      'PROVIDER_NOT_CONFIGURED',
      'permanent',
      'The video provider rejected our credentials.',
    );
  }
  if (response.status === 422 || response.status === 400) {
    return new ProviderFailed('INVALID_REQUEST', 'permanent', 'The provider refused that request.');
  }
  if (response.status >= 500) {
    return new ProviderFailed('PROVIDER_ERROR', 'transient', 'The video provider is having trouble.');
  }
  return new ProviderFailed('PROVIDER_ERROR', 'transient', 'The video provider returned an error.');
}

/**
 * Reads a JSON body without letting it reach an exception message.
 *
 * A provider error body can echo the prompt back, so nothing from it is ever
 * put in a thrown message or a log line.
 */
async function readJson(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new ProviderFailed('PROVIDER_ERROR', 'transient', 'The video provider sent a response we could not read.');
  }
}

function stringAt(payload: unknown, key: string): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function seedanceProviderFromEnv(): SeedanceVideoProvider {
  // FAL_KEY is what fal's own tooling reads; SEEDANCE_API_KEY is accepted as
  // the name this project's configuration uses for the same secret.
  const key = process.env.FAL_KEY ?? process.env.SEEDANCE_API_KEY;
  const baseUrl = process.env.SEEDANCE_BASE_URL ?? BASE_URL;
  const model = process.env.SEEDANCE_MODEL ?? TEXT_TO_VIDEO;
  return new SeedanceVideoProvider(key, baseUrl, model);
}
