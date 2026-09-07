import 'server-only';
import { EMBEDDING_LIMITS, EmbeddingFailed, normalise } from './types';
import type { Embedder } from './types';

/**
 * OpenAI embeddings over plain HTTP.
 *
 * No SDK: this is one POST to one endpoint, and a dependency would not make it
 * clearer. Same call shape as the Supabase Storage driver in Phase 2.
 *
 * PRIVACY: the request body carries the chunk text and nothing else. No file
 * id, no company id, no path, no user. Errors are classified and re-thrown
 * with a short message; neither the inputs nor the raw response body is ever
 * logged, because both contain document text.
 */
export class OpenAIEmbedder implements Embedder {
  readonly name = 'openai' as const;
  readonly model: string;
  readonly dimensions = 1536;
  /**
   * text-embedding-3-small separates unrelated text well — unrelated pairs sit
   * near 0.0-0.2 and related text from about 0.35 up — so 0.30 is the usual
   * starting point and what we ship.
   *
   * NOT YET CALIBRATED against a real corpus: it comes from the model's
   * published behaviour, not from measurement on CIP documents, because this
   * driver has never run. Measure it on real Drive content before trusting it,
   * and override with CIP_MIN_RELEVANCE_SCORE while doing so. Too high silently
   * hides real answers, which is the more expensive mistake of the two.
   */
  readonly minRelevanceScore: number;

  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(apiKey: string, model = 'text-embedding-3-small', baseUrl = 'https://api.openai.com/v1') {
    const override = Number(process.env.CIP_MIN_RELEVANCE_SCORE);
    this.minRelevanceScore = Number.isFinite(override) && override >= 0 && override <= 1 ? override : 0.3;
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    if (texts.length > EMBEDDING_LIMITS.batchSize) {
      throw new EmbeddingFailed('permanent', `Batch of ${texts.length} exceeds the ${EMBEDDING_LIMITS.batchSize} limit.`);
    }

    const input = texts.map((t) => t.slice(0, EMBEDDING_LIMITS.maxInputChars));

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ model: this.model, input, encoding_format: 'float' }),
        signal: AbortSignal.timeout(EMBEDDING_LIMITS.requestTimeoutMs),
      });
    } catch (error) {
      // A timeout or a dropped connection is worth another try later.
      const reason = error instanceof Error && error.name === 'TimeoutError' ? 'timed out' : 'could not be reached';
      throw new EmbeddingFailed('transient', `The embedding service ${reason}.`);
    }

    if (!response.ok) throw this.classify(response, await this.safeError(response));

    const body = (await response.json()) as { data?: { index: number; embedding: number[] }[] };
    if (!body.data || body.data.length !== texts.length) {
      throw new EmbeddingFailed('transient', 'The embedding service returned an unexpected response.');
    }

    // The API is documented to return results in order, but it also carries an
    // index; trusting the index costs nothing and cannot silently mis-pair a
    // vector with the wrong chunk.
    const ordered = new Array<number[]>(texts.length);
    for (const item of body.data) ordered[item.index] = normalise(item.embedding);

    for (let i = 0; i < ordered.length; i += 1) {
      if (!ordered[i]) throw new EmbeddingFailed('transient', 'The embedding service returned an incomplete batch.');
    }
    return ordered;
  }

  private classify(response: Response, detail: string): EmbeddingFailed {
    if (response.status === 429) {
      const header = response.headers.get('retry-after');
      const seconds = header ? Number(header) : null;
      // Rate limiting is not this chunk's fault. The queue backs off without
      // spending an attempt, or three tries would burn during one busy minute.
      return new EmbeddingFailed('rate_limited', 'The embedding service is rate limiting us.',
        Number.isFinite(seconds) ? seconds : null);
    }
    if (response.status === 401 || response.status === 403) {
      return new EmbeddingFailed('permanent', 'The embedding service rejected our credentials.');
    }
    if (response.status === 400 || response.status === 422) {
      // The same input will be refused identically every time.
      return new EmbeddingFailed('permanent', `The embedding service refused this input. ${detail}`);
    }
    if (response.status >= 500) {
      return new EmbeddingFailed('transient', 'The embedding service is unavailable.');
    }
    return new EmbeddingFailed('transient', `The embedding service returned ${response.status}.`);
  }

  /** Error bodies can echo the input back, so only the code and type escape. */
  private async safeError(response: Response): Promise<string> {
    try {
      const body = (await response.json()) as { error?: { code?: string; type?: string } };
      const parts = [body.error?.type, body.error?.code].filter(Boolean);
      return parts.length ? `(${parts.join(': ')})` : '';
    } catch {
      return '';
    }
  }
}
