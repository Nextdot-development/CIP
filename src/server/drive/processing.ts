import 'server-only';
import { withCompanyScope } from '../db';
import type { CompanyScope } from '../db';
import { adminSql } from '../db-admin';
import { driveStorage } from './storage';
import { DriveNotFound } from './service';
import { EXTRACTABLE_TYPES, ExtractionFailed, runExtraction } from './extraction';
import { CHUNKER_VERSION, chunkText } from './extraction/chunk';

/**
 * The extraction queue.
 *
 * Finding work is the one thing that has to look across companies, so it — and
 * only it — uses the admin connection: a single statement that returns a file
 * id and its company id. Everything after that runs inside withCompanyScope for
 * that one company, under the app role, so row-level security applies to every
 * read and write the extraction actually does.
 *
 * The worker is a trusted background process, like the migrator and the seeder.
 * Nothing in the request path imports this module's claiming functions.
 */

/** Give up after this many tries and leave the file as 'failed'. */
export const MAX_ATTEMPTS = 3;
/** A row still 'processing' after this long is assumed to be from a dead worker. */
export const STUCK_AFTER_MINUTES = 15;

export type ClaimedFile = {
  id: string;
  companyId: string;
  name: string;
  fileType: string;
  storagePath: string;
  checksum: string | null;
  attempts: number;
};

/**
 * Returns rows that a worker claimed and never finished. A worker that is
 * killed mid-extraction would otherwise leave its file stuck in 'processing'
 * for ever.
 */
export async function recoverStuckFiles(): Promise<number> {
  const sql = adminSql();
  try {
    const rows = await sql<{ id: string }[]>`
      update drive_files
         set processing_status = case
               when processing_attempts >= ${MAX_ATTEMPTS} then 'failed'
               else 'pending'
             end,
             processing_error = case
               when processing_attempts >= ${MAX_ATTEMPTS}
               then 'Extraction stopped unexpectedly too many times.'
               else processing_error
             end,
             processing_started_at = null,
             next_attempt_at = now(),
             updated_at = now()
       where processing_status = 'processing'
         and processing_started_at < now() - (${STUCK_AFTER_MINUTES} * interval '1 minute')
      returning id
    `;
    return rows.length;
  } finally {
    await sql.end();
  }
}

/**
 * Takes the next file, atomically.
 *
 * FOR UPDATE SKIP LOCKED is what makes two workers safe to run side by side:
 * a row being claimed by one is invisible to the other rather than contended.
 */
export async function claimNextFile(): Promise<ClaimedFile | null> {
  const sql = adminSql();
  try {
    const rows = await sql<
      {
        id: string; company_id: string; name: string; file_type: string;
        storage_path: string; checksum_sha256: string | null; processing_attempts: number;
      }[]
    >`
      with next_file as (
        select id
          from drive_files
         where archived_at is null
           and processing_status = 'pending'
           and file_type = any(${EXTRACTABLE_TYPES})
           -- A file we read without keeping has no bytes here to read again.
           -- What it holds is learned by the Brain, which fetches it from its
           -- source once; claiming it here would only fail on a missing object.
           and bytes_retained
           and (next_attempt_at is null or next_attempt_at <= now())
         order by created_at
         for update skip locked
         limit 1
      )
      update drive_files f
         set processing_status    = 'processing',
             processing_attempts  = f.processing_attempts + 1,
             processing_started_at = now(),
             updated_at           = now()
        from next_file
       where f.id = next_file.id
      returning f.id, f.company_id, f.name, f.file_type, f.storage_path,
                f.checksum_sha256, f.processing_attempts
    `;

    const row = rows[0];
    if (!row) return null;

    return {
      id: row.id,
      companyId: row.company_id,
      name: row.name,
      fileType: row.file_type,
      storagePath: row.storage_path,
      checksum: row.checksum_sha256,
      attempts: row.processing_attempts,
    };
  } finally {
    await sql.end();
  }
}

/** A scope built from a claimed row. The worker has no session to derive one from. */
function workerScope(companyId: string): CompanyScope {
  // role is irrelevant here: nothing the worker does is role-gated, and the
  // company is the only thing that decides what it can touch.
  return { companyId, userId: '00000000-0000-0000-0000-000000000000', role: 'owner' };
}

export type ProcessOutcome =
  | { status: 'processed'; fileId: string; name: string; chars: number; chunks: number; warnings: string[] }
  | { status: 'failed'; fileId: string; name: string; message: string; willRetry: boolean };

/**
 * Extracts one claimed file and records the result.
 *
 * Everything below the claim happens under the claimed file's company scope,
 * so the row-level security policies apply exactly as they do to a request.
 */
export async function processClaimedFile(file: ClaimedFile): Promise<ProcessOutcome> {
  const scope = workerScope(file.companyId);

  try {
    const body = await driveStorage().get(file.storagePath);
    const run = await runExtraction(file.fileType, body);
    const chunks = chunkText(run.content);

    await withCompanyScope(scope, async (tx) => {
      // Replace rather than accumulate: re-processing a file should leave one
      // extraction behind, not a pile. Chunks go with it via cascade.
      await tx`
        delete from drive_file_extractions
         where company_id = ${scope.companyId} and file_id = ${file.id} and kind = 'text'
      `;

      const inserted = await tx<{ id: string }[]>`
        insert into drive_file_extractions (
          company_id, file_id, kind, content, content_chars, extractor,
          extractor_version, source_checksum, page_count, warnings
        ) values (
          ${scope.companyId}, ${file.id}, 'text', ${run.content}, ${run.content.length},
          ${run.extractor}, ${run.extractorVersion}, ${file.checksum},
          ${run.pageCount}, ${run.truncated ? [...run.warnings, 'content-truncated'] : run.warnings}
        )
        returning id
      `;
      const extractionId = inserted[0]!.id;

      for (const chunk of chunks) {
        await tx`
          insert into drive_file_chunks (
            company_id, file_id, extraction_id, ordinal, content,
            char_start, char_end, token_estimate, heading, chunker_version
          ) values (
            ${scope.companyId}, ${file.id}, ${extractionId}, ${chunk.ordinal}, ${chunk.content},
            ${chunk.charStart}, ${chunk.charEnd}, ${chunk.tokenEstimate},
            ${chunk.heading}, ${CHUNKER_VERSION}
          )
        `;
      }

      await tx`
        update drive_files
           set processing_status = 'processed',
               processed_at      = now(),
               processing_error  = null,
               processing_started_at = null,
               next_attempt_at   = null,
               updated_at        = now()
         where id = ${file.id} and company_id = ${scope.companyId}
      `;
    });

    return {
      status: 'processed',
      fileId: file.id,
      name: file.name,
      chars: run.content.length,
      chunks: chunks.length,
      warnings: run.truncated ? [...run.warnings, 'content-truncated'] : run.warnings,
    };
  } catch (error) {
    const message =
      error instanceof ExtractionFailed
        ? error.message
        : // Never let an internal message — which could carry a path or a
          // fragment of the file — become a stored error.
          'Something went wrong while reading this file.';

    if (!(error instanceof ExtractionFailed)) {
      console.error(`[worker] unexpected failure on ${file.id}:`, error);
    }

    const willRetry = file.attempts < MAX_ATTEMPTS;
    await recordFailure(file, message, willRetry);
    return { status: 'failed', fileId: file.id, name: file.name, message, willRetry };
  }
}

async function recordFailure(file: ClaimedFile, message: string, willRetry: boolean): Promise<void> {
  // Backoff grows with each attempt: 2, 4, 8 minutes.
  const backoffMinutes = Math.min(2 ** file.attempts, 60);
  const scope = workerScope(file.companyId);

  await withCompanyScope(scope, async (tx) => {
    await tx`
      update drive_files
         set processing_status = ${willRetry ? 'pending' : 'failed'},
             processing_error  = ${message.slice(0, 500)},
             processing_started_at = null,
             next_attempt_at   = ${willRetry ? tx`now() + (${backoffMinutes} * interval '1 minute')` : null},
             updated_at        = now()
       where id = ${file.id} and company_id = ${scope.companyId}
    `;
  });
}

/** How much is waiting, per status. Used by the worker's summary line. */
export async function queueDepth(): Promise<Record<string, number>> {
  const sql = adminSql();
  try {
    const rows = await sql<{ processing_status: string; n: number }[]>`
      select processing_status, count(*)::int as n
        from drive_files
       where archived_at is null and file_type = any(${EXTRACTABLE_TYPES})
       group by processing_status
    `;
    return Object.fromEntries(rows.map((r) => [r.processing_status, r.n]));
  } finally {
    await sql.end();
  }
}

/** Puts a file back in the queue. Called from the reprocess endpoint. */
export async function requestReprocess(scope: CompanyScope, fileId: string): Promise<void> {
  await withCompanyScope(scope, async (tx) => {
    const rows = await tx<{ id: string }[]>`
      update drive_files
         set processing_status    = 'pending',
             processing_attempts  = 0,
             processing_error     = null,
             processing_started_at = null,
             next_attempt_at      = null,
             processed_at         = null,
             updated_at           = now()
       where id = ${fileId} and company_id = ${scope.companyId} and archived_at is null
      returning id
    `;
    if (!rows[0]) throw new DriveNotFound('That file');
  });
}

/** The API never ships megabytes of text; the full length is reported separately. */
const MAX_API_CONTENT_CHARS = 200_000;

/**
 * The extracted text for one of this company's files.
 *
 * Scoped like every other Drive read, so another company's file id is a
 * DriveNotFound rather than a different answer.
 */
export async function getExtraction(
  scope: CompanyScope,
  fileId: string,
): Promise<import('@/types/drive').ExtractionDTO | null> {
  return withCompanyScope(scope, async (tx) => {
    const files = await tx<{ id: string }[]>`
      select id from drive_files
       where id = ${fileId} and company_id = ${scope.companyId} and archived_at is null
    `;
    if (!files[0]) throw new DriveNotFound('That file');

    const rows = await tx<
      {
        id: string; kind: 'text' | 'ocr' | 'transcript' | 'caption'; content: string;
        content_chars: number; extractor: string; extractor_version: string;
        page_count: number | null; warnings: string[]; created_at: Date;
      }[]
    >`
      select id, kind, content, content_chars, extractor, extractor_version,
             page_count, warnings, created_at
        from drive_file_extractions
       where company_id = ${scope.companyId} and file_id = ${fileId} and kind = 'text'
       order by created_at desc
       limit 1
    `;
    const row = rows[0];
    if (!row) return null;

    const counted = await tx<{ n: number; chunker_version: string | null }[]>`
      select count(*)::int as n, max(chunker_version) as chunker_version
        from drive_file_chunks
       where company_id = ${scope.companyId} and extraction_id = ${row.id}
    `;

    return {
      fileId,
      kind: row.kind,
      extractor: row.extractor,
      extractorVersion: row.extractor_version,
      contentChars: row.content_chars,
      content: row.content.slice(0, MAX_API_CONTENT_CHARS),
      contentTruncated: row.content.length > MAX_API_CONTENT_CHARS,
      pageCount: row.page_count,
      warnings: row.warnings,
      chunkCount: counted[0]?.n ?? 0,
      chunkerVersion: counted[0]?.chunker_version ?? null,
      createdAt: row.created_at.toISOString(),
    };
  });
}

/**
 * Where a file has got to, when there is no extraction to show.
 *
 * The extraction endpoint needs to tell four situations apart that all used to
 * look the same from outside: a file nothing will ever read, one waiting its
 * turn, one being read right now, and one that failed. Only the row knows, so
 * this asks it.
 *
 * Returns null when the file does not exist for this company — the same answer
 * as one that never existed anywhere, so ids stay unprobeable.
 */
export async function getProcessingState(
  scope: CompanyScope,
  fileId: string,
): Promise<{
  status: 'pending' | 'processing' | 'processed' | 'failed';
  fileType: string;
  attempts: number;
  error: string | null;
  updatedAt: string;
  /** Whether this type is read as text at all. */
  extractable: boolean;
  /**
   * Whether the original bytes are held here. A file read without being kept
   * is never claimed by the extractor, so its processing_status stays pending
   * for ever and means nothing.
   */
  retained: boolean;
  /** What the Brain made of it, for a file that is understood by looking. */
  visual: {
    kind: string;
    status: string;
    pages: number;
    pagesUnderstood: number;
    posts: number;
  } | null;
} | null> {
  return withCompanyScope(scope, async (tx) => {
    const rows = await tx<
      {
        processing_status: 'pending' | 'processing' | 'processed' | 'failed';
        file_type: string;
        processing_attempts: number;
        processing_error: string | null;
        updated_at: Date;
        bytes_retained: boolean;
        understanding_kind: string | null;
        understanding_status: string | null;
        pages: number | null;
        pages_understood: number | null;
        posts: number | null;
      }[]
    >`
      select f.processing_status, f.file_type, f.processing_attempts, f.processing_error,
             f.updated_at, f.bytes_retained,
             u.kind as understanding_kind, u.status as understanding_status,
             p.pages, p.pages_understood, p.posts
        from drive_files f
        left join lateral (
          select kind, status from asset_understanding
           where file_id = f.id and company_id = f.company_id
           order by updated_at desc limit 1
        ) u on true
        left join lateral (
          select count(*)::int as pages,
                 count(*) filter (where status = 'ready')::int as pages_understood,
                 coalesce(sum(posts_detected), 0)::int as posts
            from pdf_page_understanding
           where file_id = f.id and company_id = f.company_id
        ) p on true
       where f.id = ${fileId} and f.company_id = ${scope.companyId} and f.archived_at is null
    `;

    const row = rows[0];
    if (!row) return null;

    return {
      status: row.processing_status,
      fileType: row.file_type,
      attempts: row.processing_attempts,
      error: row.processing_error,
      updatedAt: row.updated_at.toISOString(),
      extractable: EXTRACTABLE_TYPES.includes(row.file_type.toLowerCase()),
      retained: row.bytes_retained,
      visual: row.understanding_kind
        ? {
            kind: row.understanding_kind,
            status: row.understanding_status ?? 'pending',
            pages: row.pages ?? 0,
            pagesUnderstood: row.pages_understood ?? 0,
            posts: row.posts ?? 0,
          }
        : null,
    };
  });
}
