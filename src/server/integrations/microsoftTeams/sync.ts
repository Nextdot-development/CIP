import 'server-only';
import { randomUUID } from 'node:crypto';
import { withCompanyScope } from '../../db';
import type { CompanyScope } from '../../db';
import { driveStorage, sha256, storageKeyFor } from '../../drive/storage';
import { MicrosoftGraphError, MicrosoftGraphTooLarge, maxDownloadBytes } from './client';
import type { DeltaItem } from './client';
import { microsoftGraph } from './index';
import { markNeedsAdminConsent, requireConnected } from './connection';
import {
  MicrosoftNeedsAdminConsent,
  ingestedFilename,
  planFor,
  storedMimeFor,
} from './types';

/**
 * Syncing a connected Team into the Knowledge Layer.
 *
 * The design is 0009's: a file in a Team becomes an ordinary drive_files row
 * with source_type = 'microsoft_teams', and from there the extraction queue
 * claims it because it is pending, understanding looks at it, and the
 * embedding queue follows its chunks. None of those three knows Microsoft
 * exists.
 *
 * What is different is how change is found. The Google sync lists the whole
 * folder every time and works out what moved by comparing modifiedTime and
 * md5Checksum against what it stored. Graph does that work itself: present the
 * deltaLink from last time and it returns only what has changed since —
 * additions, edits, renames, moves and deletions, and nothing else. A sync of
 * a Team where nothing has happened is one call that returns an empty page.
 *
 * That is also why this walks no folder tree. A delta covers the whole drive,
 * subfolders included, so there is no queue of folders, no visited set and no
 * ceiling on depth: the loop here is over pages, not over directories.
 */

export type TeamsSyncOutcome = {
  /** Items the delta reported, folders included. */
  scanned: number;
  added: number;
  updated: number;
  /** Reported as changed, but the content had not moved — a rename or a move. */
  unchanged: number;
  unsupported: number;
  tooLarge: number;
  removed: number;
  failed: number;
  pages: number;
  /** Files put into the processing queue by this sync. */
  queued: number;
  /** Whether this was a full walk rather than an incremental one. */
  full: boolean;
};

type ExistingRow = {
  id: string;
  external_id: string;
  external_ctag: string | null;
  file_id: string | null;
  state: string;
};

export class MicrosoftSyncRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MicrosoftSyncRejected';
  }
}

/**
 * How many delta pages one sync will take.
 *
 * A bound rather than a timeout: the first sync of a large Team is genuinely
 * many pages, and stopping part-way is fine because the nextLink is not
 * stored — the next sync simply starts the walk again. What must not happen is
 * one connection holding a worker for ever.
 */
const MAX_PAGES = 100;

export async function syncNow(scope: CompanyScope): Promise<TeamsSyncOutcome> {
  const connection = await requireConnected(scope);
  const api = microsoftGraph();
  const startedAt = new Date();

  await withCompanyScope(scope, async (tx) => {
    await tx`
      update microsoft_connections
         set last_sync_started_at = ${startedAt}, last_sync_error = null, updated_at = now()
       where id = ${connection.id}
    `;
  });

  const outcome: TeamsSyncOutcome = {
    scanned: 0, added: 0, updated: 0, unchanged: 0, unsupported: 0,
    tooLarge: 0, removed: 0, failed: 0, pages: 0, queued: 0,
    full: connection.deltaLink === null,
  };

  try {
    let link = connection.deltaLink;
    let finishedAt: string | null = null;

    for (let page = 0; page < MAX_PAGES; page += 1) {
      let delta;
      try {
        delta = await api.delta(connection.accessToken, connection.driveId, link);
      } catch (error) {
        // Graph expires a delta token eventually and asks for a fresh walk.
        // Not a failure, and not something to report to anybody: the position
        // is dropped and the next loop starts from nothing.
        if (error instanceof MicrosoftGraphError && error.message === 'resyncRequired' && link !== null) {
          link = null;
          outcome.full = true;
          await clearDeltaLink(scope, connection.id);
          continue;
        }
        throw error;
      }

      outcome.pages += 1;

      for (const item of delta.items) {
        outcome.scanned += 1;
        await applyItem(scope, connection.id, connection.driveId, connection.accessToken, item, startedAt, outcome);
      }

      if (delta.deltaLink) {
        finishedAt = delta.deltaLink;
        break;
      }
      if (!delta.nextLink) break;
      link = delta.nextLink;
    }

    await withCompanyScope(scope, async (tx) => {
      await tx`
        update microsoft_connections
           set last_sync_at = now(),
               last_sync_error = null,
               -- Only stored when the walk actually finished. A sync that ran
               -- out of pages must start again rather than pretend it is up to
               -- date, or everything past the bound is never seen.
               delta_link = ${finishedAt ?? null},
               updated_at = now()
         where id = ${connection.id}
      `;
    });

    return outcome;
  } catch (error) {
    const message = describe(error);

    if (error instanceof MicrosoftGraphError && error.kind === 'needs_admin_consent') {
      await markNeedsAdminConsent(scope, message);
      throw new MicrosoftNeedsAdminConsent();
    }

    await withCompanyScope(scope, async (tx) => {
      await tx`
        update microsoft_connections
           set last_sync_error = ${message}, updated_at = now()
         where id = ${connection.id}
      `;
    });

    throw error;
  }
}

/**
 * What one changed item means for what CIP holds.
 *
 * Every branch ends in a record, including the ones that ingest nothing. A
 * folder of Excel workbooks must read as twenty rows saying "Excel files
 * cannot be read yet", not as twenty files that quietly never arrived.
 */
async function applyItem(
  scope: CompanyScope,
  connectionId: string,
  driveId: string,
  accessToken: string,
  item: DeltaItem,
  seenAt: Date,
  outcome: TeamsSyncOutcome,
): Promise<void> {
  const existing = await existingRow(scope, item.id);

  // A folder is not ingested; the files inside it arrive as their own delta
  // entries. Recorded as nothing at all, so a Team's folder structure does not
  // fill the table with rows nobody can open.
  if (item.isFolder) return;

  // Deleted, or moved somewhere CIP cannot see. Archived rather than deleted:
  // the extraction and its chunks stay as history, and the file stops
  // appearing in search.
  if (item.deleted) {
    if (existing && existing.state !== 'trashed') {
      await archiveOne(scope, existing.id, existing.file_id, 'Removed from the Team.');
      outcome.removed += 1;
    }
    return;
  }

  const plan = planFor(item.mimeType ?? 'application/octet-stream', item.name);
  if (!plan.supported) {
    await upsertRecord(scope, connectionId, item, {
      state: 'unsupported', reason: plan.reason, seenAt, fileId: existing?.file_id ?? null,
    });
    outcome.unsupported += 1;
    return;
  }

  // The content test. Graph reports a rename and a move as changes, and
  // neither is a reason to download a file again or to send it back through
  // extraction, understanding and embedding — which is the expensive part. The
  // cTag moves only when the bytes do.
  const contentUnmoved =
    existing !== null &&
    existing.state === 'synced' &&
    existing.external_ctag !== null &&
    existing.external_ctag === item.cTag &&
    existing.file_id !== null;

  if (contentUnmoved) {
    await upsertRecord(scope, connectionId, item, {
      state: 'synced', reason: null, seenAt, fileId: existing.file_id,
    });
    outcome.unchanged += 1;
    return;
  }

  const limit = maxDownloadBytes();
  if (item.size !== null && item.size > limit) {
    await upsertRecord(scope, connectionId, item, {
      state: 'unsupported',
      reason: `That file is ${Math.round(item.size / 1024 / 1024)} MB; CIP reads up to ${Math.round(limit / 1024 / 1024)} MB.`,
      seenAt,
      fileId: existing?.file_id ?? null,
    });
    outcome.tooLarge += 1;
    return;
  }

  let bytes: Buffer;
  try {
    bytes = await api().download(accessToken, driveId, item.id);
  } catch (error) {
    if (error instanceof MicrosoftGraphTooLarge) {
      await upsertRecord(scope, connectionId, item, {
        state: 'unsupported', reason: error.message, seenAt, fileId: existing?.file_id ?? null,
      });
      outcome.tooLarge += 1;
      return;
    }
    // A tenant-level refusal is not about this file and must stop the sync, or
    // every remaining item is recorded as individually broken.
    if (error instanceof MicrosoftGraphError && error.kind === 'needs_admin_consent') throw error;

    await upsertRecord(scope, connectionId, item, {
      state: 'failed', reason: describe(error), seenAt, fileId: existing?.file_id ?? null,
    });
    outcome.failed += 1;
    return;
  }

  const name = ingestedFilename(item.name, plan.fileType);
  const fileId = await writeDriveFile(scope, {
    existingFileId: existing?.file_id ?? null,
    name,
    fileType: plan.fileType,
    mimeType: storedMimeFor(plan.fileType),
    bytes,
  });

  await upsertRecord(scope, connectionId, item, {
    state: 'synced', reason: null, seenAt, fileId,
  });

  if (existing?.file_id) outcome.updated += 1;
  else outcome.added += 1;
  outcome.queued += 1;
}

/** Late-bound so a test that swaps the Graph in after import still sees it. */
function api() {
  return microsoftGraph();
}

async function existingRow(scope: CompanyScope, externalId: string): Promise<ExistingRow | null> {
  return withCompanyScope(scope, async (tx) => {
    const rows = await tx<ExistingRow[]>`
      select id, external_id, external_ctag, file_id, state
        from microsoft_files
       where company_id = ${scope.companyId} and external_id = ${externalId}
       limit 1
    `;
    return rows[0] ?? null;
  });
}

/**
 * Writes the bytes and the drive_files row.
 *
 * An update rather than a second row when the file is already known, so a
 * document edited in the Team keeps its identity: the same drive_files id, the
 * same place in the Knowledge Graph, and its old extraction replaced rather
 * than duplicated. Setting processing_status back to pending is what sends it
 * round the pipeline again, which is the whole of "it learns when a file is
 * modified".
 */
async function writeDriveFile(
  scope: CompanyScope,
  input: {
    existingFileId: string | null;
    name: string;
    fileType: string;
    mimeType: string;
    bytes: Buffer;
  },
): Promise<string> {
  const fileId = input.existingFileId ?? randomUUID();
  const key = storageKeyFor(scope.companyId, fileId, input.fileType);
  const checksum = sha256(input.bytes);

  await driveStorage().put(key, input.bytes, input.mimeType);

  await withCompanyScope(scope, async (tx) => {
    if (input.existingFileId) {
      await tx`
        update drive_files
           set name = ${input.name},
               original_filename = ${input.name},
               file_size = ${input.bytes.byteLength},
               checksum_sha256 = ${checksum},
               storage_path = ${key},
               archived_at = null,
               processing_status = 'pending',
               processing_attempts = 0,
               processing_error = null,
               processing_started_at = null,
               next_attempt_at = null,
               updated_at = now()
         where id = ${fileId} and company_id = ${scope.companyId}
      `;
      return;
    }

    await tx`
      insert into drive_files
        (id, company_id, folder_id, name, original_filename, file_type, mime_type,
         file_size, checksum_sha256, storage_path, bytes_retained, uploaded_by,
         source_type, processing_status, metadata)
      values
        (${fileId}, ${scope.companyId}, null, ${input.name}, ${input.name},
         ${input.fileType}, ${input.mimeType}, ${input.bytes.byteLength}, ${checksum},
         ${key}, true, ${scope.userId}, 'microsoft_teams', 'pending', '{}'::jsonb)
    `;
  });

  return fileId;
}

async function upsertRecord(
  scope: CompanyScope,
  connectionId: string,
  item: DeltaItem,
  values: { state: string; reason: string | null; seenAt: Date; fileId: string | null },
): Promise<void> {
  await withCompanyScope(scope, async (tx) => {
    await tx`
      insert into microsoft_files
        (company_id, connection_id, external_id, name, external_mime, external_etag,
         external_ctag, external_modified_time, external_size, external_path,
         file_id, state, reason, last_seen_at, synced_at, updated_at)
      values
        (${scope.companyId}, ${connectionId}, ${item.id}, ${item.name},
         ${item.mimeType ?? 'application/octet-stream'}, ${item.eTag}, ${item.cTag},
         ${item.lastModified ? new Date(item.lastModified) : null}, ${item.size},
         ${item.path}, ${values.fileId}, ${values.state}, ${values.reason},
         ${values.seenAt}, ${values.state === 'synced' ? values.seenAt : null}, now())
      on conflict (company_id, external_id) do update
         set connection_id          = excluded.connection_id,
             name                   = excluded.name,
             external_mime          = excluded.external_mime,
             external_etag          = excluded.external_etag,
             external_ctag          = excluded.external_ctag,
             external_modified_time = excluded.external_modified_time,
             external_size          = excluded.external_size,
             external_path          = excluded.external_path,
             file_id                = excluded.file_id,
             state                  = excluded.state,
             reason                 = excluded.reason,
             last_seen_at           = excluded.last_seen_at,
             synced_at              = coalesce(excluded.synced_at, microsoft_files.synced_at),
             updated_at             = now()
    `;
  });
}

async function archiveOne(
  scope: CompanyScope,
  recordId: string,
  fileId: string | null,
  reason: string,
): Promise<void> {
  await withCompanyScope(scope, async (tx) => {
    if (fileId) {
      await tx`
        update drive_files
           set archived_at = now(), updated_at = now()
         where id = ${fileId} and company_id = ${scope.companyId} and archived_at is null
      `;
    }
    await tx`
      update microsoft_files
         set state = 'trashed', reason = ${reason}, updated_at = now()
       where id = ${recordId} and company_id = ${scope.companyId}
    `;
  });
}

async function clearDeltaLink(scope: CompanyScope, connectionId: string): Promise<void> {
  await withCompanyScope(scope, async (tx) => {
    await tx`
      update microsoft_connections
         set delta_link = null, updated_at = now()
       where id = ${connectionId}
    `;
  });
}

/**
 * What went wrong, without saying what was in it.
 *
 * A Graph error message can quote a file name or a site path, both of which
 * belong to the company. Only CIP's own wording is kept.
 */
function describe(error: unknown): string {
  if (error instanceof MicrosoftGraphTooLarge) return error.message;
  if (error instanceof MicrosoftGraphError) return error.message;
  if (error instanceof MicrosoftNeedsAdminConsent) return error.message;
  return 'Something went wrong while reading the Team.';
}
