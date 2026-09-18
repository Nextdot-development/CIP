import 'server-only';
import { sql } from './db';

/**
 * A token bucket per subject, shared by every server instance.
 *
 * Semantic search spends money on every call, and generation spends more.
 * Authentication stops strangers, but an authenticated user in a loop is a
 * bill, so the paid endpoints need ceilings of their own.
 *
 * The buckets live in the database. They used to live in memory, which counted
 * within one process: on a host running several instances a person got a bucket
 * per instance, and a limit of five became five times however many were up.
 * Each take now happens under a row lock, so two instances cannot both spend
 * the last token.
 *
 * A limiter that cannot reach its store must not take the endpoint down with
 * it. If the database is unavailable the same bucket is kept in memory for that
 * call, which is the old behaviour - weaker, and far better than refusing.
 * CIP_RATE_LIMIT_STORE=memory forces that, for a single-process setup.
 */

export type RateLimitResult = {
  allowed: boolean;
  /** Whole seconds until the next token, for Retry-After. */
  retryAfterSeconds: number;
  remaining: number;
};

export type RateLimitOptions = {
  /** Bucket size: how many calls may burst before refill matters. */
  capacity: number;
  /** Tokens added per second. capacity 20 at 0.5/s is 20 at once, then 30/min. */
  refillPerSecond: number;
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

function takeFromMemory(key: string, options: RateLimitOptions): RateLimitResult {
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

/** Takes one token for `key`, or says how long until there is one. */
export async function rateLimit(key: string, options: RateLimitOptions): Promise<RateLimitResult> {
  if (process.env.CIP_RATE_LIMIT_STORE === 'memory') return takeFromMemory(key, options);

  try {
    const result = await sql.begin(async (tx) => {
      await tx`
        insert into rate_limit_buckets (key, tokens, refilled_at)
        values (${key}, ${options.capacity}, now())
        on conflict (key) do nothing
      `;
      const rows = await tx<{ tokens: number; elapsed: number }[]>`
        select tokens, extract(epoch from (now() - refilled_at))::float8 as elapsed
          from rate_limit_buckets
         where key = ${key}
         for update
      `;
      const row = rows[0]!;
      const tokens = Math.min(options.capacity, row.tokens + Math.max(0, row.elapsed) * options.refillPerSecond);

      if (tokens < 1) {
        await tx`update rate_limit_buckets set tokens = ${tokens}, refilled_at = now() where key = ${key}`;
        const wait = (1 - tokens) / options.refillPerSecond;
        return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(wait)), remaining: 0 };
      }

      await tx`update rate_limit_buckets set tokens = ${tokens - 1}, refilled_at = now() where key = ${key}`;
      return { allowed: true, retryAfterSeconds: 0, remaining: Math.floor(tokens - 1) };
    });

    // Now and then, forget buckets nobody has used for a day.
    if (Math.random() < 0.01) {
      void sql`delete from rate_limit_buckets where refilled_at < now() - interval '1 day'`.catch(() => {});
    }
    return result;
  } catch {
    return takeFromMemory(key, options);
  }
}

/** Semantic search: 20 in a burst, then a sustained 30 a minute. */
export const SEMANTIC_SEARCH_LIMIT: RateLimitOptions = { capacity: 20, refillPerSecond: 0.5 };

/**
 * Generation is the expensive one.
 *
 * An embedding call costs a fraction of a cent; an image is cents and a video
 * is more, so these ceilings are much lower and are applied per user and per
 * company. The company bucket is what stops five colleagues each running a
 * script overnight and nobody noticing until the invoice.
 *
 * Deliberately configurable: the right number depends on the plan somebody is
 * paying for, and hard-coding it would mean a deploy to change it.
 */
function fromEnv(name: string, fallback: RateLimitOptions): RateLimitOptions {
  const capacity = Number(process.env[`${name}_CAPACITY`]);
  const refill = Number(process.env[`${name}_REFILL_PER_SECOND`]);
  return {
    capacity: Number.isFinite(capacity) && capacity > 0 ? capacity : fallback.capacity,
    refillPerSecond: Number.isFinite(refill) && refill > 0 ? refill : fallback.refillPerSecond,
  };
}

/** Images, per user: 5 at once, then one every 12 seconds. */
export const IMAGE_GENERATION_LIMIT = (): RateLimitOptions =>
  fromEnv('CIP_IMAGE_RATE', { capacity: 5, refillPerSecond: 1 / 12 });

/** Videos, per user: 2 at once, then one a minute. Videos cost more. */
export const VIDEO_GENERATION_LIMIT = (): RateLimitOptions =>
  fromEnv('CIP_VIDEO_RATE', { capacity: 2, refillPerSecond: 1 / 60 });

/**
 * Google Drive sync, per company: 3 in a burst, then one every two minutes.
 *
 * A sync walks somebody else's API and Google's quotas are per project, so one
 * company leaning on the button spends every company's allowance.
 */
export const GOOGLE_SYNC_LIMIT = (): RateLimitOptions =>
  fromEnv('CIP_GDRIVE_SYNC_RATE', { capacity: 3, refillPerSecond: 1 / 120 });

/** Everything the company generates, across all its users. */
export const COMPANY_GENERATION_LIMIT = (): RateLimitOptions =>
  fromEnv('CIP_COMPANY_RATE', { capacity: 20, refillPerSecond: 1 / 6 });

/** Tests need a clean slate between cases. */
export async function __resetRateLimits(): Promise<void> {
  buckets.clear();
  await sql`delete from rate_limit_buckets`.catch(() => {});
}
