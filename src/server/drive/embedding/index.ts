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

  cached = remembering(key && !forceFake ? new OpenAIEmbedder(key, model) : new FakeEmbedder());
  return cached;
}

/** How long a query's vector is kept, and how many are kept. */
const REMEMBER_MS = 120_000;
const REMEMBER_MAX = 200;

/**
 * The embedder, remembering the queries it was just asked.
 *
 * Planning one picture searches products, assets, posts, books and markets,
 * each with the same request - and each embedded it again, a round trip to
 * OpenAI apiece. One text, one vector: only single-text calls are kept, so
 * the queue's batches pass straight through, and a failure is not kept.
 */
function remembering(inner: Embedder): Embedder {
  const recent = new Map<string, { at: number; vectors: Promise<number[][]> }>();
  const wrapper: Embedder = Object.create(inner);
  wrapper.embed = (texts: string[]) => {
    if (texts.length !== 1) return inner.embed(texts);
    const key = texts[0]!;
    const now = Date.now();
    const kept = recent.get(key);
    if (kept && now - kept.at < REMEMBER_MS) return kept.vectors;
    const vectors = inner.embed(texts);
    recent.set(key, { at: now, vectors });
    vectors.catch(() => recent.delete(key));
    if (recent.size > REMEMBER_MAX) recent.delete(recent.keys().next().value!);
    return vectors;
  };
  return wrapper;
}

/** Tests swap in their own. */
export function __setEmbedder(next: Embedder | null): void {
  cached = next;
}
