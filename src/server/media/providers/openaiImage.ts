import 'server-only';
import { MEDIA_LIMITS, ProviderFailed, SUPPORTED_IMAGE_TYPES } from './types';
import type { GeneratedAsset, ImageGenerationProvider, ImageRequest, ImageResult } from './types';

/**
 * OpenAI images, as a second image provider alongside Gemini.
 *
 * Plain fetch against the official API rather than the SDK, which is how the
 * embedding driver in Phase 4 already talks to OpenAI. One less dependency,
 * and the request and response shapes here were verified against the live API
 * rather than taken from memory:
 *
 *   POST /v1/images/generations  { model, prompt, size, quality }
 *   POST /v1/images/edits        multipart, with the reference images attached
 *
 * `size` is literal pixels — "Expected WIDTHxHEIGHT". `quality` is one of
 * low, medium, high, auto. `response_format` is rejected outright as an
 * unknown parameter: gpt-image models always return base64, so there is
 * nothing to ask for.
 *
 * PRIVACY: this sends the prompt text and any reference image bytes to OpenAI.
 * It sends nothing else — no company id, no file id, no storage path, no
 * database id. Neither the request nor the response is ever logged, because
 * both contain the customer's content.
 */

const DEFAULT_MODEL = 'gpt-image-2';
const BASE_URL = 'https://api.openai.com/v1';

/**
 * Aspect ratios, and the pixel size each becomes.
 *
 * OpenAI takes a size rather than a ratio, so the ratios CIP offers everywhere
 * else are mapped to the nearest size this model produces. Keeping the same
 * vocabulary as the Gemini provider is what lets the UI offer one set of
 * choices regardless of which provider is answering.
 */
const SIZE_FOR_RATIO: Record<string, string> = {
  '1:1': '1024x1024',
  '3:2': '1536x1024',
  '2:3': '1024x1536',
};

/**
 * OpenAI's own size knob is `quality`: it decides how much rendering the model
 * does, and therefore the cost and the wait. It is exposed through the shared
 * `imageSize` option so the service layer does not need to know that.
 */
const QUALITIES = ['auto', 'low', 'medium', 'high'] as const;

export class OpenAIImageProvider implements ImageGenerationProvider {
  readonly name = 'openai' as const;
  readonly model: string;
  readonly configured: boolean;
  readonly aspectRatios = Object.keys(SIZE_FOR_RATIO);
  readonly imageSizes = QUALITIES;

  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;

  constructor(apiKey: string | undefined, model = DEFAULT_MODEL, baseUrl = BASE_URL) {
    this.apiKey = apiKey;
    this.model = model;
    this.configured = Boolean(apiKey);
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async generate(request: ImageRequest): Promise<ImageResult> {
    if (!this.apiKey) {
      throw new ProviderFailed(
        'PROVIDER_NOT_CONFIGURED',
        'permanent',
        'Image generation is not configured.',
      );
    }
    if (request.prompt.length > MEDIA_LIMITS.maxPromptChars) {
      throw new ProviderFailed('INVALID_REQUEST', 'permanent', 'That prompt is too long.');
    }

    const size = SIZE_FOR_RATIO[request.aspectRatio ?? '1:1'] ?? SIZE_FOR_RATIO['1:1']!;
    const quality = (QUALITIES as readonly string[]).includes(request.imageSize ?? '')
      ? request.imageSize!
      : 'auto';

    // Editing an existing image is a different endpoint from making a new one,
    // and it takes multipart rather than JSON.
    const response = request.references.length > 0
      ? await this.edit(request, size, quality)
      : await this.create(request, size, quality);

    const payload = await readJson(response);
    const assets = extractImages(payload);

    if (assets.length === 0) {
      // A response with no image is a failure even though the call succeeded.
      // Retrying sends the identical prompt, so this is permanent.
      throw new ProviderFailed(
        'GENERATION_FAILED',
        'permanent',
        'The model did not return an image for that prompt.',
      );
    }

    const [width, height] = size.split('x').map(Number);

    return {
      assets: assets.map((asset) => ({ ...asset, width: width ?? null, height: height ?? null })),
      model: this.model,
      usage: {
        providerRequestId: null,
        inputUnits: tokensAt(payload, 'input_tokens') ?? request.prompt.length,
        outputUnits: tokensAt(payload, 'output_tokens') ?? assets.length,
        // OpenAI reports tokens, not money. A price worked out from a pricing
        // page would be indistinguishable from one the provider actually
        // charged, so it stays null.
        estimatedCost: null,
        costCurrency: null,
      },
    };
  }

  private async create(request: ImageRequest, size: string, quality: string): Promise<Response> {
    return this.call(`${this.baseUrl}/images/generations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.model, prompt: request.prompt, size, quality, n: 1 }),
    });
  }

  private async edit(request: ImageRequest, size: string, quality: string): Promise<Response> {
    const form = new FormData();
    form.append('model', this.model);
    form.append('prompt', request.prompt);
    form.append('size', size);
    form.append('quality', quality);

    for (const [index, reference] of request.references.entries()) {
      const type = (SUPPORTED_IMAGE_TYPES as readonly string[]).includes(reference.mimeType)
        ? reference.mimeType
        : 'image/png';
      // The filename is ours, not the customer's: OpenAI needs one, and the
      // real name would send them something they have no use for.
      form.append(
        'image[]',
        new Blob([new Uint8Array(reference.bytes)], { type }),
        `reference-${index}.${type.split('/')[1] ?? 'png'}`,
      );
    }

    return this.call(`${this.baseUrl}/images/edits`, { method: 'POST', body: form });
  }

  private async call(url: string, init: RequestInit): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        headers: {
          // The key goes in a header and nowhere else. Never logged, never
          // placed in a URL where it would reach an access log.
          authorization: `Bearer ${this.apiKey}`,
          ...(init.headers ?? {}),
        },
        signal: AbortSignal.timeout(MEDIA_LIMITS.requestTimeoutMs),
      });
    } catch (error) {
      const timedOut =
        error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
      throw new ProviderFailed(
        timedOut ? 'PROVIDER_TIMEOUT' : 'PROVIDER_ERROR',
        'transient',
        timedOut ? 'The image provider timed out.' : 'The image provider could not be reached.',
      );
    }

    if (!response.ok) throw await classify(response);
    return response;
  }
}

/**
 * Pulls the images out of a response.
 *
 * gpt-image models always return base64 and have no url mode, but a url is
 * tolerated so a future model or a compatible gateway does not silently yield
 * nothing. A url is not followed here — that would be a second network call
 * from inside a parser.
 */
function extractImages(payload: unknown): GeneratedAsset[] {
  if (typeof payload !== 'object' || payload === null) return [];
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];

  const found: GeneratedAsset[] = [];
  for (const entry of data) {
    if (typeof entry !== 'object' || entry === null) continue;
    const b64 = (entry as { b64_json?: unknown }).b64_json;
    if (typeof b64 !== 'string' || b64.length === 0) continue;

    const bytes = Buffer.from(b64, 'base64');
    if (bytes.byteLength === 0) continue;
    found.push({ bytes, mimeType: sniffImageType(bytes) });
  }
  return found;
}

/**
 * Reads the format from the bytes rather than trusting a parameter.
 *
 * The stored file's extension and content type come from this, so getting it
 * from the content is the only way it cannot disagree with what was actually
 * returned.
 */
function sniffImageType(bytes: Buffer): string {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return 'image/png';
}

function tokensAt(payload: unknown, key: string): number | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const usage = (payload as { usage?: unknown }).usage;
  if (typeof usage !== 'object' || usage === null) return null;
  const value = (usage as Record<string, unknown>)[key];
  return typeof value === 'number' ? value : null;
}

/**
 * Turns an error response into one of ours.
 *
 * Only the status and OpenAI's own error `code` shape the outcome. The message
 * is deliberately dropped: it can quote the prompt back, and the prompt is the
 * customer's.
 */
async function classify(response: Response): Promise<ProviderFailed> {
  const code = await errorCode(response);

  if (response.status === 429) {
    const retryAfter = Number(response.headers.get('retry-after'));
    // A spent quota is not a rate limit: waiting will not fix it, and retrying
    // three times just delays telling somebody the account needs attention.
    if (code === 'insufficient_quota') {
      return new ProviderFailed(
        'PROVIDER_ERROR',
        'permanent',
        'The image provider account is out of quota.',
      );
    }
    return new ProviderFailed(
      'RATE_LIMITED',
      'rate_limited',
      'The image provider is rate limiting us.',
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
    );
  }

  if (response.status === 401 || response.status === 403) {
    return new ProviderFailed(
      'PROVIDER_NOT_CONFIGURED',
      'permanent',
      'The image provider rejected our credentials.',
    );
  }

  if (code === 'moderation_blocked' || code === 'content_policy_violation') {
    return new ProviderFailed(
      'GENERATION_FAILED',
      'permanent',
      'That prompt was refused by the provider’s content rules.',
    );
  }

  if (response.status === 400 || response.status === 422) {
    return new ProviderFailed('INVALID_REQUEST', 'permanent', 'The provider refused that request.');
  }
  if (response.status >= 500) {
    return new ProviderFailed('PROVIDER_ERROR', 'transient', 'The image provider is having trouble.');
  }
  return new ProviderFailed('PROVIDER_ERROR', 'transient', 'The image provider returned an error.');
}

/** The error code only. The body is never kept: it can echo the prompt. */
async function errorCode(response: Response): Promise<string | null> {
  try {
    const body = (await response.clone().json()) as { error?: { code?: unknown; type?: unknown } };
    const code = body.error?.code ?? body.error?.type;
    return typeof code === 'string' ? code : null;
  } catch {
    return null;
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new ProviderFailed(
      'PROVIDER_ERROR',
      'transient',
      'The image provider sent a response we could not read.',
    );
  }
}

export function openAIImageProviderFromEnv(): OpenAIImageProvider {
  return new OpenAIImageProvider(
    process.env.OPENAI_API_KEY,
    process.env.CIP_OPENAI_IMAGE_MODEL ?? DEFAULT_MODEL,
    process.env.OPENAI_BASE_URL ?? BASE_URL,
  );
}
