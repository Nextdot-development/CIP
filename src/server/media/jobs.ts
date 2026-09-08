import 'server-only';
import { adminSql } from '../db-admin';
import { withCompanyScope } from '../db';
import type { CompanyScope } from '../db';
import { driveStorage } from '../drive/storage';
import { imageGenerationProvider, videoGenerationProvider } from './providers';
import { MEDIA_LIMITS, ProviderFailed } from './providers/types';
import type { ReferenceImage } from './providers/types';
import { completeGeneration, failGeneration } from './generation';
import { isSupportedImageType } from './types';
import type { MediaType } from './types';

/**
 * The media generation queue.
 *
 * Videos are the reason this exists: a Seedance job takes minutes, so the
 * request that asks for one only writes a row, and this claims it, submits it,
 * and keeps asking the provider whether it is done. Images arrive here only
 * when a first attempt failed and is being retried.
 *
 * Finding work is the only statement that looks across companies, exactly as
 * in Phases 3 and 4. Everything after the claim runs inside that company's
 * scope, so row-level security applies to every read and write that follows.
 */

export type ClaimedGeneration = {
  id: string;
  companyId: string;
  createdBy: string;
  type: MediaType;
  prompt: string;
  status: 'queued' | 'processing';
  providerJobId: string | null;
  inputMetadata: {
    aspectRatio?: string | null;
    imageSize?: string | null;
    providerChoice?: 'openai' | 'gemini' | null;
    resolution?: string | null;
    durationSeconds?: number | null;
    referenceFileId?: string | null;
  } | null;
  startedAt: Date | null;
};

/** A scope for the worker, which has no session to derive one from. */
function workerScope(companyId: string, userId: string): CompanyScope {
  return { companyId, userId, role: 'owner' };
}

/**
 * Takes the next generation that needs attention, and marks it taken.
 *
 * The marking is the point. A bare SELECT ... FOR UPDATE SKIP LOCKED holds the
 * row only until its transaction ends, and a single statement commits as soon
 * as it returns — so the lock would be gone before the provider call even
 * started, and a second worker would happily claim the same video. Paying
 * twice for one video is exactly what this is supposed to prevent.
 *
 * So the claim is an UPDATE that pushes next_attempt_at out by a lease. While
 * the lease holds, the row is not claimable. If the worker dies mid-call the
 * lease expires and somebody else picks it up, which is the behaviour we want
 * from a crash — at-least-once, never silently abandoned.
 *
 * One row at a time: a video job is a slow external call, so batching would
 * only mean holding a lease while waiting on somebody else's queue.
 */
const CLAIM_LEASE_SECONDS = 120;

export async function claimGeneration(): Promise<ClaimedGeneration | null> {
  const sql = adminSql();

  try {
    const rows = await sql<
      {
        id: string;
        company_id: string;
        created_by: string;
        type: MediaType;
        prompt: string;
        status: 'queued' | 'processing';
        provider_job_id: string | null;
        input_metadata: ClaimedGeneration['inputMetadata'];
        started_at: Date | null;
      }[]
    >`
      update media_generations
         set next_attempt_at = now() + (${CLAIM_LEASE_SECONDS} * interval '1 second')
       where id = (
         select id
           from media_generations
          where status in ('queued', 'processing')
            and attempts < ${MEDIA_LIMITS.maxAttempts}
            and (next_attempt_at is null or next_attempt_at <= now())
          order by created_at
            for update skip locked
          limit 1
       )
      returning id, company_id, created_by, type, prompt, status,
                provider_job_id, input_metadata, started_at
    `;

    const row = rows[0];
    if (!row) return null;

    return {
      id: row.id,
      companyId: row.company_id,
      createdBy: row.created_by,
      type: row.type,
      prompt: row.prompt,
      status: row.status,
      providerJobId: row.provider_job_id,
      inputMetadata: row.input_metadata,
      startedAt: row.started_at,
    };
  } finally {
    await sql.end();
  }
}

export type JobOutcome =
  | { status: 'submitted'; id: string }
  | { status: 'pending'; id: string }
  | { status: 'completed'; id: string }
  | { status: 'failed'; id: string; message: string; willRetry: boolean };

/**
 * Moves one claimed generation forward by exactly one step.
 *
 * Each call does the smallest useful thing — submit, or poll once, or store a
 * finished file — so a worker that stops between steps loses nothing and the
 * next one picks up from the record rather than from memory.
 */
export async function processGeneration(claim: ClaimedGeneration): Promise<JobOutcome> {
  const scope = workerScope(claim.companyId, claim.createdBy);

  try {
    if (claim.type === 'image') return await runImage(scope, claim);
    return await runVideo(scope, claim);
  } catch (error) {
    await failGeneration(scope, claim.id, error);
    const failure = error instanceof ProviderFailed ? error : null;
    return {
      status: 'failed',
      id: claim.id,
      message: failure?.message ?? 'The generation did not finish.',
      willRetry: failure ? failure.kind !== 'permanent' : true,
    };
  }
}

async function runImage(scope: CompanyScope, claim: ClaimedGeneration): Promise<JobOutcome> {
  // The provider the request originally chose, so a retry does not wander to
  // a different one and produce something unlike the first attempt.
  const provider = imageGenerationProvider(claim.inputMetadata?.providerChoice ?? null);
  const references = await loadReferences(scope, claim.inputMetadata?.referenceFileId ?? null);

  await markProcessing(scope, claim.id);

  const result = await provider.generate({
    prompt: claim.prompt,
    references,
    aspectRatio: claim.inputMetadata?.aspectRatio ?? null,
    imageSize: claim.inputMetadata?.imageSize ?? null,
  });

  await completeGeneration(scope, claim.id, result.assets, result.usage, result.model);
  return { status: 'completed', id: claim.id };
}

async function runVideo(scope: CompanyScope, claim: ClaimedGeneration): Promise<JobOutcome> {
  const provider = videoGenerationProvider();

  // Nothing submitted yet: send it and record the handle before doing anything
  // else, so a crash cannot lose a job the provider has already accepted.
  if (!claim.providerJobId) {
    const reference = (await loadReferences(scope, claim.inputMetadata?.referenceFileId ?? null))[0] ?? null;

    const job = await provider.submit({
      prompt: claim.prompt,
      reference,
      durationSeconds: claim.inputMetadata?.durationSeconds ?? null,
      resolution: claim.inputMetadata?.resolution ?? null,
      aspectRatio: claim.inputMetadata?.aspectRatio ?? null,
    });

    await withCompanyScope(scope, async (tx) => {
      await tx`
        update media_generations
           set status = 'processing',
               provider_job_id = ${job.providerJobId},
               model = ${job.model},
               provider_request_id = ${job.usage.providerRequestId ?? null},
               input_units = ${job.usage.inputUnits ?? null},
               started_at = coalesce(started_at, now()),
               next_attempt_at = null
         where id = ${claim.id}
      `;
    });

    return { status: 'submitted', id: claim.id };
  }

  // A job that has been running far too long is abandoned rather than polled
  // forever: providers do lose work, and a row stuck at 'processing' with
  // nothing behind it is worse than an honest failure.
  const startedAt = claim.startedAt?.getTime() ?? Date.now();
  if (Date.now() - startedAt > MEDIA_LIMITS.videoTimeoutMs) {
    throw new ProviderFailed('PROVIDER_TIMEOUT', 'permanent', 'The video took too long and was given up on.');
  }

  const status = await provider.poll(claim.providerJobId);

  if (status.state === 'pending') {
    // Ask again shortly. This is the only place that sets a poll interval, so
    // the provider is not hammered by a tight worker loop.
    await withCompanyScope(scope, async (tx) => {
      await tx`
        update media_generations
           set next_attempt_at = now() + interval '10 seconds'
         where id = ${claim.id}
      `;
    });
    return { status: 'pending', id: claim.id };
  }

  if (status.state === 'failed') {
    // A provider that reports a failed job will report it identically forever.
    throw new ProviderFailed(status.code, 'permanent', status.message);
  }

  await completeGeneration(scope, claim.id, status.assets, status.usage, provider.model);
  return { status: 'completed', id: claim.id };
}

async function markProcessing(scope: CompanyScope, id: string): Promise<void> {
  await withCompanyScope(scope, async (tx) => {
    await tx`
      update media_generations
         set status = 'processing', started_at = coalesce(started_at, now())
       where id = ${id}
    `;
  });
}

/**
 * Reads a reference image back under company scope.
 *
 * The worker holds an id, not bytes, so it re-resolves through the company's
 * own rows. A file that has since been archived or deleted simply yields no
 * reference rather than reaching across a boundary to find one.
 */
async function loadReferences(
  scope: CompanyScope,
  fileId: string | null,
): Promise<ReferenceImage[]> {
  if (!fileId) return [];

  const rows = await withCompanyScope(scope, async (tx) =>
    tx<{ storage_path: string; file_type: string }[]>`
      select storage_path, file_type
        from drive_files
       where id = ${fileId} and archived_at is null
    `,
  );

  const row = rows[0];
  if (!row) return [];

  const mimeType =
    { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' }[
      row.file_type.toLowerCase()
    ] ?? null;
  if (!mimeType || !isSupportedImageType(mimeType)) return [];

  try {
    return [{ bytes: await driveStorage().get(row.storage_path), mimeType }];
  } catch {
    throw new ProviderFailed('STORAGE_ERROR', 'transient', 'A reference image could not be read.');
  }
}

/** How much is waiting. Used by the worker summary and /api/health. */
export async function mediaQueueDepth(): Promise<{
  queued: number;
  processing: number;
  failed: number;
  completed: number;
}> {
  const sql = adminSql();
  try {
    const rows = await sql<{ queued: number; processing: number; failed: number; completed: number }[]>`
      select
        count(*) filter (where status = 'queued')::int     as queued,
        count(*) filter (where status = 'processing')::int as processing,
        count(*) filter (where status = 'failed')::int     as failed,
        count(*) filter (where status = 'completed')::int  as completed
        from media_generations
    `;
    return rows[0] ?? { queued: 0, processing: 0, failed: 0, completed: 0 };
  } finally {
    await sql.end();
  }
}
