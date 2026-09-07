import 'server-only';
import { FakeEmbedder } from './fake';
import { OpenAIEmbedder } from './openai';
import type { Embedder } from './types';

export { EMBEDDING_LIMITS, EmbeddingFailed, normalise, toVectorLiteral } from './types';
export type { Embedder, FailureKind } from './types';

/**
 * The embedder the application uses.
 *
 * OpenAI when a key is configured, the deterministic fake otherwise — which is
 * what lets `npm test` run the entire pipeline and every search assertion with
 * no key, no network and no cost. Same selection shape as driveStorage().
 *
 * CIP_FORCE_FAKE_EMBEDDER=true pins the fake even when a key is present.
 */
let cached: Embedder | null = null;

export function embedder(): Embedder {
  if (cached) return cached;

  const key = process.env.OPENAI_API_KEY;
  const model = process.env.CIP_EMBEDDING_MODEL ?? 'text-embedding-3-small';
  const forceFake = process.env.CIP_FORCE_FAKE_EMBEDDER === 'true';

  cached = key && !forceFake ? new OpenAIEmbedder(key, model) : new FakeEmbedder();
  return cached;
}

/** Tests swap in their own. */
export function __setEmbedder(next: Embedder | null): void {
  cached = next;
}
