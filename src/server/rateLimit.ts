import 'server-only';

/**
 * A token bucket, per subject, in memory.
 *
 * Semantic search spends money on every call: one embedding request per query.
 * Authentication already stops strangers, but an authenticated user in a loop
 * is a bill, so the paid endpoint needs a ceiling of its own.
 *
 * LIMITATION, stated plainly: this counts within one server process. Two
 * instances give a user two buckets. That is the right trade for now — it
 * needs no new infrastructure and it stops the realistic case, which is a
 * runaway client or a careless script rather than a distributed attacker.
 * Moving to a shared counter is a swap of this one module.
 */

export type RateLimitResult = {
  allowed: boolean;
  /** Whole seconds until the next token, for Retry-After. */
  retryAfterSeconds: number;
  remaining: number;
};

type Bucket = { tokens: number; lastRefill: number };

const buckets = new Map<string, Bucket>();

/** Drop buckets nobody has touched for an hour, so the map cannot grow forever. */
const IDLE_MS = 60 * 60 * 1000;
let lastSweep = Date.now();

function sweep(now: number): void {
  if (now - lastSweep < IDLE_MS) return;
  lastSweep = now;
  for (const [key, bucket] of buckets) {
    if (now - bucket.lastRefill > IDLE_MS) buckets.delete(key);
  }
}

export type RateLimitOptions = {
  /** Bucket size: how many calls may burst before refill matters. */
  capacity: number;
  /** Tokens added per second. capacity 20 at 0.5/s is 20 at once, then 30/min. */
  refillPerSecond: number;
};

export function rateLimit(key: string, options: RateLimitOptions): RateLimitResult {
  const now = Date.now();
  sweep(now);

  const bucket = buckets.get(key) ?? { tokens: options.capacity, lastRefill: now };

  const elapsedSeconds = (now - bucket.lastRefill) / 1000;
  bucket.tokens = Math.min(options.capacity, bucket.tokens + elapsedSeconds * options.refillPerSecond);
  bucket.lastRefill = now;

  if (bucket.tokens < 1) {
    buckets.set(key, bucket);
    const wait = (1 - bucket.tokens) / options.refillPerSecond;
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(wait)), remaining: 0 };
  }

  bucket.tokens -= 1;
  buckets.set(key, bucket);
  return { allowed: true, retryAfterSeconds: 0, remaining: Math.floor(bucket.tokens) };
}

/** Semantic search: 20 in a burst, then a sustained 30 a minute. */
export const SEMANTIC_SEARCH_LIMIT: RateLimitOptions = { capacity: 20, refillPerSecond: 0.5 };

/** Tests need a clean slate between cases. */
export function __resetRateLimits(): void {
  buckets.clear();
}
