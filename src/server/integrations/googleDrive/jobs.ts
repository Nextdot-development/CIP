import 'server-only';
import { adminSql } from '../../db-admin';
import type { CompanyScope } from '../../db';
import { syncNow } from './sync';
import type { SyncOutcome } from './sync';
import { GoogleDriveNeedsReauth } from './types';

/**
 * The sync queue.
 *
 * A sync is a long walk through somebody else's API, so it belongs in a worker
 * rather than in a request. This is the abstraction a scheduler would use: a
 * claim, a step, and a lease. Adding "sync every hour" later means calling
 * claimConnectionForSync on a timer — no new machinery.
 *
 * Finding work is the only statement that looks across companies, exactly as
 * in Phases 3 and 4. Everything after the claim runs under that company's
 * scope, so row-level security applies throughout.
 */

/** How long a claim holds a connection before another worker may take it. */
const CLAIM_LEASE_SECONDS = 600;

/** How often a connected Drive is swept when the worker runs on a schedule. */
const DEFAULT_INTERVAL_MINUTES = 60;

export type ClaimedConnection = {
  connectionId: string;
  companyId: string;
  userId: string;
};

/** A scope for the worker, which has no session to derive one from. */
function workerScope(claim: ClaimedConnection): CompanyScope {
  return { companyId: claim.companyId, userId: claim.userId, role: 'owner' };
}

/**
 * Takes the next connection due for a sync, and marks it taken.
 *
 * The lease is an UPDATE rather than a bare row lock for the same reason the
 * media queue's is: a single statement commits as soon as it returns, so a
 * lock would be gone before the first Google call and two workers would sync
 * the same folder at once.
 */
export async function claimConnectionForSync(
  options: { intervalMinutes?: number; connectionId?: string } = {},
): Promise<ClaimedConnection | null> {
  const sql = adminSql();
  const interval = options.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES;

  try {
    const rows = await sql<
      { id: string; company_id: string; connected_by: string | null }[]
    >`
      update google_drive_connections
         set sync_claimed_until = now() + (${CLAIM_LEASE_SECONDS} * interval '1 second')
       where id = (
         select id
           from google_drive_connections
          where status = 'connected'
            and folder_id is not null
            and (sync_claimed_until is null or sync_claimed_until <= now())
            and (${options.connectionId ?? null}::uuid is null or id = ${options.connectionId ?? null}::uuid)
            and (
              ${options.connectionId ?? null}::uuid is not null
              or last_sync_at is null
              or last_sync_at < now() - (${interval} * interval '1 minute')
            )
          order by last_sync_at nulls first
            for update skip locked
          limit 1
       )
      returning id, company_id, connected_by
    `;

    const row = rows[0];
    if (!row) return null;

    return {
      connectionId: row.id,
      companyId: row.company_id,
      // The person who connected it owns the ingested files. A connection with
      // nobody attached cannot be synced by the worker, because every file it
      // creates needs an uploader.
      userId: row.connected_by ?? '',
    };
  } finally {
    await sql.end();
  }
}

export type SyncJobOutcome =
  | { status: 'synced'; companyId: string; outcome: SyncOutcome }
  | { status: 'needs_reauth'; companyId: string }
  | { status: 'failed'; companyId: string; message: string };

/** Runs one claimed sync and releases the lease. */
export async function runClaimedSync(claim: ClaimedConnection): Promise<SyncJobOutcome> {
  if (!claim.userId) {
    await release(claim.connectionId);
    return {
      status: 'failed',
      companyId: claim.companyId,
      message: 'The connection has no owner to attribute synced files to.',
    };
  }

  try {
    const outcome = await syncNow(workerScope(claim));
    return { status: 'synced', companyId: claim.companyId, outcome };
  } catch (error) {
    if (error instanceof GoogleDriveNeedsReauth) {
      // syncNow has already recorded needs_reauth; the lease is cleared with it.
      return { status: 'needs_reauth', companyId: claim.companyId };
    }
    return {
      status: 'failed',
      companyId: claim.companyId,
      // Never the raw error: it can carry a file name, which is the customer's.
      message: error instanceof Error ? error.message : 'The sync did not finish.',
    };
  } finally {
    await release(claim.connectionId);
  }
}

async function release(connectionId: string): Promise<void> {
  const sql = adminSql();
  try {
    await sql`
      update google_drive_connections
         set sync_claimed_until = null, updated_at = now()
       where id = ${connectionId}
    `;
  } finally {
    await sql.end();
  }
}

/** How much is waiting. Used by the worker summary and /api/health. */
export async function syncQueueDepth(): Promise<{
  connected: number;
  needsReauth: number;
  due: number;
}> {
  const sql = adminSql();
  try {
    const rows = await sql<{ connected: number; needs_reauth: number; due: number }[]>`
      select
        count(*) filter (where status = 'connected')::int    as connected,
        count(*) filter (where status = 'needs_reauth')::int as needs_reauth,
        count(*) filter (
          where status = 'connected' and folder_id is not null
            and (last_sync_at is null
                 or last_sync_at < now() - (${DEFAULT_INTERVAL_MINUTES} * interval '1 minute'))
        )::int as due
        from google_drive_connections
    `;
    const row = rows[0] ?? { connected: 0, needs_reauth: 0, due: 0 };
    return { connected: row.connected, needsReauth: row.needs_reauth, due: row.due };
  } finally {
    await sql.end();
  }
}
