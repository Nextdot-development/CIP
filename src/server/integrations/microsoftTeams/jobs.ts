import 'server-only';
import { adminSql } from '../../db-admin';
import type { CompanyScope } from '../../db';
import { syncNow } from './sync';
import type { TeamsSyncOutcome } from './sync';
import { MicrosoftNeedsAdminConsent } from './types';

/**
 * The Teams sync queue.
 *
 * The same claim-step-lease shape as the Google Drive queue, for the same
 * reason: a sync is a walk through somebody else's API and belongs in a worker
 * rather than in a request.
 *
 * Finding work is the only statement that looks across companies. Everything
 * after the claim runs under that company's scope, so row-level security
 * applies throughout.
 */

/** How long a claim holds a connection before another worker may take it. */
const CLAIM_LEASE_SECONDS = 600;

/**
 * How often a connected Team is swept.
 *
 * Shorter than the Google default of an hour, and the reason is what a delta
 * costs. Asking Google again means listing every folder and every file to find
 * out that nothing moved; asking Graph means one call that returns an empty
 * page. So the interval can be set by how soon somebody should see their
 * upload learned, rather than by what the sweep costs.
 */
const DEFAULT_INTERVAL_MINUTES = 10;

export type ClaimedTeamsConnection = {
  connectionId: string;
  companyId: string;
  userId: string;
};

/** A scope for the worker, which has no session to derive one from. */
function workerScope(claim: ClaimedTeamsConnection): CompanyScope {
  return { companyId: claim.companyId, userId: claim.userId, role: 'owner' };
}

/**
 * Takes the next connection due for a sync, and marks it taken.
 *
 * The lease is an UPDATE rather than a bare row lock for the same reason the
 * media queue's is: a single statement commits as soon as it returns, which is
 * long before the first Graph call, and two workers would then sync the same
 * Team at once.
 */
export async function claimTeamsConnectionForSync(
  options: { intervalMinutes?: number; connectionId?: string } = {},
): Promise<ClaimedTeamsConnection | null> {
  const sql = adminSql();
  const interval = options.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES;

  try {
    const rows = await sql<{ id: string; company_id: string; connected_by: string | null }[]>`
      update microsoft_connections
         set sync_claimed_until = now() + (${CLAIM_LEASE_SECONDS} * interval '1 second')
       where id = (
         select id
           from microsoft_connections
          where status = 'connected'
            and drive_id is not null
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

export type TeamsSyncJobOutcome =
  | { status: 'synced'; companyId: string; outcome: TeamsSyncOutcome }
  | { status: 'needs_admin_consent'; companyId: string }
  | { status: 'failed'; companyId: string; message: string };

/** Runs one claimed sync and releases the lease. */
export async function runClaimedTeamsSync(claim: ClaimedTeamsConnection): Promise<TeamsSyncJobOutcome> {
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
    if (error instanceof MicrosoftNeedsAdminConsent) {
      // syncNow has already recorded it; the lease is cleared with it.
      return { status: 'needs_admin_consent', companyId: claim.companyId };
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
      update microsoft_connections
         set sync_claimed_until = null, updated_at = now()
       where id = ${connectionId}
    `;
  } finally {
    await sql.end();
  }
}

/** How much is waiting. Used by the worker summary. */
export async function teamsSyncQueueDepth(): Promise<{
  connected: number;
  needsAdminConsent: number;
  due: number;
}> {
  const sql = adminSql();
  try {
    const rows = await sql<{ connected: number; needs_consent: number; due: number }[]>`
      select
        count(*) filter (where status = 'connected')::int           as connected,
        count(*) filter (where status = 'needs_admin_consent')::int as needs_consent,
        count(*) filter (
          where status = 'connected' and drive_id is not null
            and (last_sync_at is null
                 or last_sync_at < now() - (${DEFAULT_INTERVAL_MINUTES} * interval '1 minute'))
        )::int as due
        from microsoft_connections
    `;
    const row = rows[0] ?? { connected: 0, needs_consent: 0, due: 0 };
    return { connected: row.connected, needsAdminConsent: row.needs_consent, due: row.due };
  } finally {
    await sql.end();
  }
}
