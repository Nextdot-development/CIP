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
 * Seedance 2.0, through Runway's Developer Platform.
 *
 * Runway hosts Seedance alongside its own models, so `seedance2` is a model id
 * on an otherwise ordinary Runway endpoint. Everything below was verified
 * against the live API rather than taken from memory — the model list, the
 * accepted ratios and the duration ceiling all came back from Runway's own
 * validation errors:
 *
 *   POST   /v1/text_to_video   { model, promptText, duration, ratio } -> { id }
 *   POST   /v1/image_to_video  { model, promptImage, promptText, ... } -> { id }
 *   GET    /v1/tasks/{id}      -> { status, output: [url], failure }
 *   DELETE /v1/tasks/{id}      cancel
 *
 * with `Authorization: Bearer key_...` and an `X-Runway-Version` header, which
 * is required. Cancellation is a real endpoint, which is why this provider
 * claims to support it.
 *
 * PRIVACY: this sends the prompt, and for image-to-video the reference image
 * bytes, to Runway. Nothing else — no company id, no storage path, no ids of
 * ours. Payloads are never logged.
 */

const BASE_URL = 'https://api.dev.runwayml.com/v1';

/**
 * Pinned deliberately. Runway dates its breaking changes, and an unpinned
 * client is one that changes behaviour on a day nobody deployed anything.
 */
const API_VERSION = '2024-11-06';

const DEFAULT_MODEL = 'seedance2';

/**
 * A curated subset of the ratios Runway accepts, all confirmed valid for this
 * model. Runway names them in pixels rather than as "720p", so these are the
 * literal values it takes.
 */
const RATIOS = ['1280:720', '720:1280', '960:960', '1920:1080', '1080:1920'] as const;

/** Runway's own ceiling, from its validation error: duration <= 15. */
const MAX_DURATION_SECONDS = 15;

export class SeedanceVideoProvider implements VideoGenerationProvider {
  readonly name = 'seedance' as const;
  readonly model: string;
  readonly configured: boolean;
  readonly resolutions = RATIOS;
  readonly supportsCancel = true;

  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;

  constructor(apiKey: string | undefined, baseUrl = BASE_URL, model = DEFAULT_MODEL) {
    this.apiKey = apiKey;
    this.configured = Boolean(apiKey);
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.model = model;
  }

  async submit(request: VideoRequest): Promise<VideoJob> {
    this.requireKey();

    // The endpoint is chosen by whether there is a reference frame, not by
    // anything the caller names, so a client cannot select one.
    const route = request.reference ? '/image_to_video' : '/text_to_video';

    const body: Record<string, unknown> = {
      model: this.model,
      promptText: request.prompt,
      ratio: RATIOS.includes(request.resolution as (typeof RATIOS)[number])
        ? request.resolution
        : RATIOS[0],
      duration: Math.min(request.durationSeconds ?? 5, MAX_DURATION_SECONDS),
    };

    if (request.reference) {
      // A data URI keeps the bytes in the request rather than requiring us to
      // publish the customer's image somewhere Runway can fetch it.
      body.promptImage = `data:${request.reference.mimeType};base64,${request.reference.bytes.toString('base64')}`;
    }

    const response = await this.call('POST', `${this.baseUrl}${route}`, body);
    const payload = await readJson(response);

    const id = stringAt(payload, 'id');
    if (!id) {
      throw new ProviderFailed(
        'PROVIDER_ERROR',
        'transient',
        'The video provider accepted the job but did not return a job id.',
      );
    }

    return {
      providerJobId: id,
      model: this.model,
      usage: { providerRequestId: id, inputUnits: request.prompt.length },
    };
  }

  async poll(providerJobId: string): Promise<VideoStatus> {
    this.requireKey();

    const response = await this.call('GET', `${this.baseUrl}/tasks/${encodeURIComponent(providerJobId)}`);
    const task = await readJson(response);
    const status = stringAt(task, 'status');

    if (status === 'PENDING' || status === 'RUNNING' || status === 'THROTTLED') {
      return { state: 'pending' };
    }

    if (status === 'CANCELLED') {
      return { state: 'failed', code: 'CANCELLED', message: 'The generation was cancelled.' };
    }

    if (status !== 'SUCCEEDED') {
      // Runway puts a reason in `failure`, but it can quote the prompt back, so
      // it is not passed on. The normalised code is what a caller needs.
      return {
        state: 'failed',
        code: 'GENERATION_FAILED',
        message: 'The video provider could not make that video.',
      };
    }

    const url = firstOutputUrl(task);
    if (!url) {
      return {
        state: 'failed',
        code: 'PROVIDER_ERROR',
        message: 'The video finished but no video file was found in the result.',
      };
    }

    return {
      state: 'completed',
      assets: [await this.download(url)],
      usage: { providerRequestId: providerJobId, outputUnits: 1 },
    };
  }

  async cancel(providerJobId: string): Promise<void> {
    this.requireKey();
    // 404 means Runway has already forgotten it and 400 that it has finished.
    // Neither is worth raising: in both cases there is nothing left to cancel.
    await this.call(
      'DELETE',
      `${this.baseUrl}/tasks/${encodeURIComponent(providerJobId)}`,
      undefined,
      [400, 404],
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
          authorization: `Bearer ${this.apiKey}`,
          'X-Runway-Version': API_VERSION,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(MEDIA_LIMITS.requestTimeoutMs),
      });
    } catch (error) {
      const timedOut =
        error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
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
    // Fetched server-side so the bytes land in our private bucket rather than
    // the browser following a link to somebody else's host. Runway's output
    // URLs expire, which is another reason not to hand one to a client.
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

/** The finished video's URL. Runway returns `output` as a list of URLs. */
function firstOutputUrl(task: unknown): string | null {
  if (typeof task !== 'object' || task === null) return null;
  const output = (task as { output?: unknown }).output;
  if (!Array.isArray(output)) return null;

  for (const entry of output) {
    if (typeof entry === 'string' && /^https?:\/\//i.test(entry)) return entry;
    // Tolerated in case an entry is ever an object carrying the url.
    if (typeof entry === 'object' && entry !== null) {
      const url = (entry as { url?: unknown }).url;
      if (typeof url === 'string' && /^https?:\/\//i.test(url)) return url;
    }
  }
  return null;
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
  if (response.status === 402) {
    // Out of credit. Retrying will not help, and it is worth saying plainly
    // rather than reporting a generic provider error nobody can act on.
    return new ProviderFailed(
      'PROVIDER_ERROR',
      'permanent',
      'The video provider account is out of credit.',
    );
  }
  if (response.status === 400 || response.status === 422) {
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
  // RUNWAY_API_KEY is what Runway's own documentation uses; SEEDANCE_API_KEY is
  // accepted as the name this project's configuration gave the same secret.
  const key = process.env.RUNWAY_API_KEY ?? process.env.SEEDANCE_API_KEY;
  const baseUrl = process.env.SEEDANCE_BASE_URL ?? BASE_URL;
  const model = process.env.SEEDANCE_MODEL ?? DEFAULT_MODEL;
  return new SeedanceVideoProvider(key, baseUrl, model);
}
