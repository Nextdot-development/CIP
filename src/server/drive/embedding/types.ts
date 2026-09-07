import 'server-only';

/**
 * Turning text into a vector.
 *
 * The interface exists so the rest of the application never names a vendor.
 * Two drivers implement it: the OpenAI one used in production, and a
 * deterministic fake that lets the whole pipeline and every search test run
 * offline, with no key and no bill.
 *
 * PRIVACY: an implementation of this interface sends the strings it is given
 * to a third party. Callers pass chunk text and nothing else — never a
 * storage path, a company id, a file id, or any other metadata. See the
 * contract in embed() below.
 */

export type EmbedderName = 'openai' | 'fake';

export interface Embedder {
  readonly name: EmbedderName;
  /** Recorded on every row, so a second model can coexist with the first. */
  readonly model: string;
  readonly dimensions: number;
  /**
   * Returns one vector per input, in the same order.
   *
   * Implementations must send the text and nothing else. No identifiers, no
   * paths, no company information — the provider has no need for any of it,
   * and sending it would widen what leaves our infrastructure for no gain.
   */
  embed(texts: string[]): Promise<number[][]>;
  /**
   * Cosine similarity below which a passage is not a result at all.
   *
   * A nearest-neighbour index always has a nearest neighbour. Without a floor,
   * searching for something the Drive simply does not cover returns whatever
   * happens to be least unrelated, which reads as a wrong answer rather than
   * as "nothing here". Semantic search has to be able to say no.
   *
   * It belongs to the driver because the number means nothing on its own: two
   * models put unrelated text at quite different similarities, and a constant
   * that suits one is wrong for the other. Search asks the embedder rather
   * than assuming.
   */
  readonly minRelevanceScore: number;
}

/** Why an embedding attempt failed, and what the queue should do about it. */
export type FailureKind =
  /** Rate limited. Back off, but do NOT spend an attempt — the chunk is fine. */
  | 'rate_limited'
  /** Transient: network, timeout, 5xx. Spend an attempt and back off. */
  | 'transient'
  /** The input will be refused identically every time. Fail immediately. */
  | 'permanent';

export class EmbeddingFailed extends Error {
  readonly kind: FailureKind;
  /** Seconds the provider asked us to wait, when it said. */
  readonly retryAfterSeconds: number | null;

  constructor(kind: FailureKind, message: string, retryAfterSeconds: number | null = null) {
    super(message);
    this.name = 'EmbeddingFailed';
    this.kind = kind;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export const EMBEDDING_LIMITS = {
  /** Inputs per API call. Batching is the whole optimisation. */
  batchSize: 96,
  /** Chunks are capped at 1400 characters upstream; this is a backstop. */
  maxInputChars: 8_000,
  requestTimeoutMs: 30_000,
  maxAttempts: 3,
} as const;

/** Unit length, so cosine distance behaves and scores are comparable. */
export function normalise(vector: number[]): number[] {
  let sum = 0;
  for (const v of vector) sum += v * v;
  const length = Math.sqrt(sum);
  if (length === 0) return vector;
  return vector.map((v) => v / length);
}

/** Postgres wants a vector literal, not a JSON array. */
export function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(',')}]`;
}
