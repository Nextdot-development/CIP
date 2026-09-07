import 'server-only';
import { EMBEDDING_LIMITS, normalise } from './types';
import type { Embedder } from './types';

/**
 * A deterministic embedder for tests.
 *
 * It is a bag of words rather than a hash of the whole string, and that choice
 * is what makes the search tests meaningful: cosine similarity between two of
 * these vectors rises with shared vocabulary, so "the nearest chunk ranks
 * first" is a real assertion rather than an exact-match lookup. It also means
 * the isolation test — company A searching wording that appears only in
 * company B's documents — produces a query vector that *would* match B's
 * chunk closely if the boundary ever failed.
 *
 * No network, no key, no cost, and identical output on every run.
 */
export class FakeEmbedder implements Embedder {
  readonly name = 'fake' as const;
  readonly model = 'fake-bow-1';
  readonly dimensions = 1536;
  /**
   * Bag-of-words vectors are sparse and non-negative, so text sharing no
   * meaningful vocabulary scores exactly 0 and only shared content words lift
   * the score.
   *
   * Measured on the test corpus, with function words no longer counting:
   * unrelated passages reach 0.16 at worst, a passage that plainly answers the
   * query sits at 0.65, and the weakest true match — a single-word query
   * against a whole chunk, where one shared word is diluted by everything else
   * in the passage — is 0.28. So the usable gap is 0.16 to 0.28 and the floor
   * sits inside it, nearer the top than the middle. Short queries are the
   * tight case; if one starts returning nothing it wanted, this is why.
   */
  readonly minRelevanceScore = 0.25;

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => this.one(text));
  }

  private one(text: string): number[] {
    const vector = new Array<number>(this.dimensions).fill(0);
    const tokens = text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 1 && !FUNCTION_WORDS.has(t));

    for (const token of tokens) {
      const slot = hashToken(token, this.dimensions);
      vector[slot] = (vector[slot] ?? 0) + 1;
    }
    // An empty or punctuation-only string still needs a usable vector.
    if (tokens.length === 0) vector[0] = 1;

    return normalise(vector);
  }
}

/**
 * Words that carry no topic, dropped before hashing.
 *
 * A real embedding model does not think two sentences are related because both
 * contain "the" and "for", and neither should the double. Left in, they gave
 * two short unrelated passages a cosine of 0.32 — high enough to be mistaken
 * for a match, which made the double misrepresent the thing it stands in for.
 * The list is deliberately short: enough to stop function words dominating a
 * one-line passage, not an attempt at real stopword removal.
 */
const FUNCTION_WORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'was', 'were', 'are',
  'has', 'have', 'had', 'not', 'but', 'all', 'any', 'can', 'will', 'would',
  'about', 'into', 'than', 'then', 'them', 'they', 'their', 'there', 'been',
  'its', 'it', 'is', 'be', 'to', 'of', 'in', 'on', 'at', 'as', 'by', 'or',
  'an', 'a', 'no', 'so', 'if', 'we', 'our', 'you', 'your',
]);

/** FNV-1a, folded into the dimension count. Stable across runs and platforms. */
function hashToken(token: string, dimensions: number): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < token.length; i += 1) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % dimensions;
}

export const FAKE_BATCH_SIZE = EMBEDDING_LIMITS.batchSize;
