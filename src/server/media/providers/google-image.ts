import 'server-only';
import { GoogleGenAI } from '@google/genai';
import { MEDIA_LIMITS, ProviderFailed, SUPPORTED_IMAGE_TYPES } from './types';
import type { ImageGenerationProvider, ImageRequest, ImageResult, GeneratedAsset } from './types';

/**
 * Nano Banana 2 — `gemini-3.1-flash-image` — through the Gemini Interactions
 * API.
 *
 * The model id, the endpoint and the response shape were taken from the
 * installed @google/genai types rather than from memory: `interactions.create`
 * takes `{ model, input, response_format }`, and an image comes back either as
 * `interaction.output_image` or as an image content block inside
 * `interaction.steps`.
 *
 * PRIVACY: this sends the prompt text and any reference image bytes to Google.
 * It sends nothing else — no company id, no file id, no storage path, no
 * database id. Neither the request nor the response is ever logged, because
 * both contain the customer's content.
 *
 * Google's retention and deletion policy is not restated here. Whatever it is,
 * it is theirs to publish and ours not to paraphrase from memory.
 */

const MODEL = 'gemini-3.1-flash-image';

export class GoogleImageProvider implements ImageGenerationProvider {
  readonly name = 'google' as const;
  readonly model: string;
  readonly configured: boolean;
  /** From ImageResponseFormatAspectRatio in the installed SDK types. */
  readonly aspectRatios = [
    '1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9',
  ] as const;
  /** From ImageResponseFormatImageSize. */
  readonly imageSizes = ['512', '1K', '2K', '4K'] as const;

  private readonly client: GoogleGenAI | null;

  constructor(apiKey: string | undefined, model = MODEL) {
    this.model = model;
    this.configured = Boolean(apiKey);
    this.client = apiKey ? new GoogleGenAI({ apiKey }) : null;
  }

  async generate(request: ImageRequest): Promise<ImageResult> {
    if (!this.client) {
      throw new ProviderFailed(
        'PROVIDER_NOT_CONFIGURED',
        'permanent',
        'Image generation is not configured.',
      );
    }

    // The provider receives the prompt and the reference bytes. Nothing that
    // identifies the company, the user or where the bytes came from.
    const input: Record<string, unknown>[] = [{ type: 'text', text: request.prompt }];
    for (const reference of request.references) {
      input.push({
        type: 'image',
        mime_type: reference.mimeType,
        data: reference.bytes.toString('base64'),
      });
    }

    // JPEG because that is what this model returns: asking for image/png is
    // refused outright with "Supported values: 'image/jpeg'". Verified against
    // the live API, not assumed from the type union, which is wider than the
    // model actually accepts.
    const responseFormat: Record<string, unknown> = { type: 'image', mime_type: 'image/jpeg' };
    if (request.aspectRatio) responseFormat.aspect_ratio = request.aspectRatio;
    if (request.imageSize) responseFormat.image_size = request.imageSize;

    let interaction: unknown;
    try {
      interaction = await this.client.interactions.create({
        model: this.model,
        input,
        response_format: responseFormat,
      } as Parameters<GoogleGenAI['interactions']['create']>[0]);
    } catch (error) {
      throw classify(error);
    }

    const assets = extractImages(interaction);
    if (assets.length === 0) {
      // A response with no image is a failure even though the call succeeded —
      // usually a safety refusal. Retrying sends the identical prompt, so this
      // is permanent rather than transient.
      throw new ProviderFailed(
        'GENERATION_FAILED',
        'permanent',
        'The model did not return an image for that prompt.',
      );
    }

    return {
      assets,
      model: this.model,
      usage: {
        providerRequestId: idOf(interaction),
        inputUnits: request.prompt.length,
        outputUnits: assets.length,
        // The Interactions response carries no price, and a number invented
        // from a pricing page would be indistinguishable from a real one.
        estimatedCost: null,
        costCurrency: null,
      },
    };
  }
}

/**
 * Finds the generated images in a response.
 *
 * `output_image` is the convenience field the SDK adds for the common case,
 * but a response can interleave text and several images across steps. Taking
 * whatever sits in the first field would silently drop images, or worse,
 * return a reference image the model echoed back. So: prefer output_image,
 * then walk the steps for every image content block, and de-duplicate.
 */
function extractImages(interaction: unknown): GeneratedAsset[] {
  const found: GeneratedAsset[] = [];
  const seen = new Set<string>();

  const take = (block: unknown): void => {
    if (!isRecord(block)) return;
    if (block.type !== 'image') return;
    const data = block.data;
    if (typeof data !== 'string' || data.length === 0) return;
    if (seen.has(data)) return;
    seen.add(data);

    const mimeType =
      typeof block.mime_type === 'string' && (SUPPORTED_IMAGE_TYPES as readonly string[]).includes(block.mime_type)
        ? block.mime_type
        : 'image/jpeg';

    found.push({ bytes: Buffer.from(data, 'base64'), mimeType });
  };

  if (!isRecord(interaction)) return found;

  take(interaction.output_image);

  const steps = interaction.steps;
  if (Array.isArray(steps)) {
    for (const step of steps) {
      if (!isRecord(step)) continue;
      const content = step.content;
      if (Array.isArray(content)) for (const block of content) take(block);
    }
  }

  return found;
}

function idOf(interaction: unknown): string | null {
  if (!isRecord(interaction)) return null;
  return typeof interaction.id === 'string' ? interaction.id : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Turns a provider error into one of ours.
 *
 * The provider's message is deliberately dropped: it can quote the prompt back,
 * and the prompt is the customer's. Only the status shapes the outcome.
 */
function classify(error: unknown): ProviderFailed {
  const status = statusOf(error);

  if (status === 429) {
    return new ProviderFailed(
      'RATE_LIMITED',
      'rate_limited',
      'The image provider is rate limiting us.',
      retryAfterOf(error),
    );
  }
  if (status === 401 || status === 403) {
    return new ProviderFailed(
      'PROVIDER_NOT_CONFIGURED',
      'permanent',
      'The image provider rejected our credentials.',
    );
  }
  if (status === 400 || status === 422) {
    return new ProviderFailed('INVALID_REQUEST', 'permanent', 'The provider refused that request.');
  }
  if (status !== null && status >= 500) {
    return new ProviderFailed('PROVIDER_ERROR', 'transient', 'The image provider is having trouble.');
  }
  if (isTimeout(error)) {
    return new ProviderFailed('PROVIDER_TIMEOUT', 'transient', 'The image provider timed out.');
  }
  return new ProviderFailed('PROVIDER_ERROR', 'transient', 'The image provider could not be reached.');
}

function statusOf(error: unknown): number | null {
  if (!isRecord(error)) return null;
  for (const key of ['status', 'statusCode', 'code']) {
    const value = error[key];
    if (typeof value === 'number') return value;
  }
  return null;
}

function retryAfterOf(error: unknown): number | null {
  if (!isRecord(error)) return null;
  const headers = error.headers;
  if (headers instanceof Headers) {
    const value = Number(headers.get('retry-after'));
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  return null;
}

function isTimeout(error: unknown): boolean {
  if (!isRecord(error)) return false;
  return error.name === 'AbortError' || error.name === 'TimeoutError';
}

/** Reads configuration without ever putting the key anywhere it could be seen. */
export function googleImageProviderFromEnv(): GoogleImageProvider {
  const key = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  const model = process.env.CIP_IMAGE_MODEL ?? MODEL;
  void MEDIA_LIMITS;
  return new GoogleImageProvider(key, model);
}
