import 'server-only';
import { createHash, timingSafeEqual } from 'node:crypto';
import { adminSql } from '../db-admin';
import type { PumpTally } from './pump';

/**
 * What the deployment keeps about itself: where it lives, the token the
 * database's scheduler calls the pump with, and every pass the pump made.
 *
 * Read and written with the admin connection only. The app's own role cannot
 * see the token, so nothing a request can reach through it can leak it.
 */

export type PumpTrigger = 'scheduler' | 'github' | 'vercel' | 'manual';

/** Compares without saying, by how long it took, how much of a guess was right. */
function same(a: string, b: string): boolean {
  const x = createHash('sha256').update(a).digest();
  const y = createHash('sha256').update(b).digest();
  return timingSafeEqual(x, y);
}

/** True when the bearer is the token the database's scheduler holds. */
export async function isSchedulerToken(bearer: string): Promise<boolean> {
  if (!bearer) return false;
  const sql = adminSql();
  try {
    const [row] = await sql<{ value: string }[]>`select value from cip_runtime where key = 'pump_token'`;
    return Boolean(row) && same(bearer, row!.value);
  } catch {
    return false;
  } finally {
    await sql.end();
  }
}

/**
 * Where the deployment lives, as the caller that just reached it saw it.
 * The scheduler calls nothing until this is known.
 */
export async function rememberPumpUrl(origin: string): Promise<void> {
  if (!/^https:\/\//.test(origin) || /localhost|127\.0\.0\.1/.test(origin)) return;
  const sql = adminSql();
  try {
    await sql`
      insert into cip_runtime (key, value) values ('pump_url', ${origin})
      on conflict (key) do update set value = excluded.value, updated_at = now()
       where cip_runtime.value is distinct from excluded.value
    `;
  } catch {
    // Not knowing the address costs the schedule a pass; it never costs the pass.
  } finally {
    await sql.end();
  }
}

export async function recordPumpStart(trigger: PumpTrigger): Promise<string | null> {
  const sql = adminSql();
  try {
    const [row] = await sql<{ id: string }[]>`insert into pump_runs (trigger) values (${trigger}) returning id`;
    // A record, not an archive: a month of passes is plenty to see a pattern.
    await sql`delete from pump_runs where started_at < now() - interval '30 days'`;
    return row?.id ?? null;
  } catch {
    return null;
  } finally {
    await sql.end();
  }
}

export async function recordPumpEnd(id: string | null, outcome: { tally: PumpTally } | { error: string }): Promise<void> {
  if (!id) return;
  const sql = adminSql();
  try {
    await sql`
      update pump_runs
         set finished_at = now(),
             tally = ${'tally' in outcome ? sql.json(outcome.tally) : null},
             error = ${'error' in outcome ? outcome.error.slice(0, 300) : null}
       where id = ${id}
    `;
  } catch {
    // The pass happened either way.
  } finally {
    await sql.end();
  }
}

export type PumpHealth = {
  /** The newest pass that finished, and what called it. */
  lastFinishedAt: string | null;
  lastTrigger: PumpTrigger | null;
  lastError: string | null;
  passesLastDay: number;
  /** Whether the database's own schedule is set up and knows where to call. */
  scheduled: boolean;
};

export async function pumpHealth(): Promise<PumpHealth> {
  const sql = adminSql();
  try {
    const [last] = await sql<{ finished_at: Date; trigger: PumpTrigger; error: string | null }[]>`
      select finished_at, trigger, error from pump_runs
       where finished_at is not null order by finished_at desc limit 1
    `;
    const [day] = await sql<{ n: number }[]>`
      select count(*)::int as n from pump_runs where started_at > now() - interval '1 day'
    `;
    const [url] = await sql<{ n: number }[]>`select count(*)::int as n from cip_runtime where key = 'pump_url'`;
    let job = false;
    try {
      const [row] = await sql<{ n: number }[]>`select count(*)::int as n from cron.job where jobname = 'cip-pump' and active`;
      job = (row?.n ?? 0) > 0;
    } catch {
      job = false;
    }
    return {
      lastFinishedAt: last?.finished_at.toISOString() ?? null,
      lastTrigger: last?.trigger ?? null,
      lastError: last?.error ?? null,
      passesLastDay: day?.n ?? 0,
      scheduled: job && (url?.n ?? 0) > 0,
    };
  } catch {
    return { lastFinishedAt: null, lastTrigger: null, lastError: null, passesLastDay: 0, scheduled: false };
  } finally {
    await sql.end();
  }
}
