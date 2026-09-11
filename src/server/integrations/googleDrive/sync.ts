import 'server-only';
import { randomUUID } from 'node:crypto';
import { withCompanyScope } from '../../db';
import type { CompanyScope } from '../../db';
import { driveStorage, ObjectTooLarge, sha256, storageKeyFor } from '../../drive/storage';
import { GoogleDriveError, GoogleDriveTooLarge, maxDownloadBytes } from './client';
import type { GoogleFile } from './client';
import { googleDrive } from './index';
import { markNeedsReauth, requireConnected } from './connection';
import { GoogleDriveNeedsReauth, ingestedFilename, planFor, storedMimeFor } from './types';

/**
 * Syncing a connected folder into the Knowledge Layer.
 *
 * The whole design is that a Google Drive file becomes an ordinary drive_files
 * row with source_type = 'google_drive'. Once it is there, the Phase 3
 * extraction queue claims it because it is pending, and the Phase 4 embedding
 * queue follows its chunks. Neither pipeline knows Google exists, and there is
 * no second extractor or embedder to keep in step with the first.
 *
 * Change detection is by Google's own modifiedTime and md5Checksum. A file
 * whose neither has moved is left completely alone — not re-downloaded, not
 * re-extracted, not re-embedded — so a sync of an unchanged folder costs one
 * listing and nothing else.
 */

/** Google's own type for a folder. */
const FOLDER_MIME = 'application/vnd.google-apps.folder';

/**
 * How many folders one sync will walk.
 *
 * A bound rather than a depth limit: what matters is that the walk ends, and a
 * Drive with a shortcut pointing at its own ancestor has no depth at all.
 */
const MAX_FOLDERS = 200;

export type SyncOutcome = {
  scanned: number;
  added: number;
  updated: number;
  unchanged: number;
  unsupported: number;
  /** Refused by our own size limit, which is not the same as having failed. */
  tooLarge: number;
  removed: number;
  failed: number;
  pages: number;
  /** Files put into the processing queue by this sync. */
  queued: number;
  /** Folders walked, including the one that was connected. */
  folders: number;
};

type ExistingRow = {
  id: string;
  external_id: string;
  external_modified_time: Date | null;
  external_md5: string | null;
  file_id: string | null;
  state: string;
};

export class GoogleDriveSyncRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoogleDriveSyncRejected';
  }
}

/**
 * Runs one sync.
 *
 * The company comes from the scope. There is no folder argument: the folder is
 * whatever this company configured, so one company cannot ask for a sync of
 * another company's folder even if it knew the id.
 */
export async function syncNow(scope: CompanyScope): Promise<SyncOutcome> {
  const connection = await requireConnected(scope);
  if (!connection.folderId) {
    throw new GoogleDriveSyncRejected('Choose a folder to sync before syncing.');
  }

  const api = googleDrive();
  const startedAt = new Date();

  await withCompanyScope(scope, async (tx) => {
    await tx`
      update google_drive_connections
         set last_sync_started_at = ${startedAt}, last_sync_error = null, updated_at = now()
       where id = ${connection.id}
    `;
  });

  const outcome: SyncOutcome = {
    scanned: 0, added: 0, updated: 0, unchanged: 0,
    unsupported: 0, tooLarge: 0, removed: 0, failed: 0, pages: 0, queued: 0, folders: 0,
  };

  try {
    // Subfolders are walked, not skipped. People file assets by brand — a
    // folder per brand, a folder of bottles — and a sync that read only the
    // top level found one logo and reported the other twenty-six as
    // unsupported, when most of them were simply never looked in.
    //
    // Breadth first, with a seen-set, because a shortcut in Drive can point
    // back at an ancestor and turn the walk into a loop. Bounded, so a Drive
    // nested deeper than anyone intended cannot hold the sync open for ever.
    const queue: string[] = [connection.folderId];
    const visited = new Set<string>([connection.folderId]);
    const folderNames = new Map<string, string>();

    while (queue.length > 0 && visited.size <= MAX_FOLDERS) {
      const folderId = queue.shift()!;
      let pageToken: string | null = null;

      // Google returns a folder a page at a time and a large folder is many
      // pages. Stopping at the first page would silently ingest a prefix of
      // the Drive and report success.
      do {
        const page = await api.listFolder(connection.accessToken, folderId, pageToken);
        outcome.pages += 1;

        for (const file of page.files) {
          if (file.mimeType === FOLDER_MIME) {
            // A folder is not ingested; what is inside it is.
            if (!file.trashed && !visited.has(file.id) && visited.size < MAX_FOLDERS) {
              visited.add(file.id);
              folderNames.set(file.id, file.name);
              queue.push(file.id);
            }
            continue;
          }

          outcome.scanned += 1;
          await syncOneFile(
            scope, connection.id, connection.accessToken, file, startedAt, outcome,
            folderId === connection.folderId ? null : (folderNames.get(folderId) ?? null),
          );
        }

        pageToken = page.nextPageToken;
      } while (pageToken);
    }

    outcome.folders = visited.size;

    // Anything not seen in this pass has gone from the folder — deleted, moved
    // out, or unshared. It is archived rather than deleted: the extraction and
    // its chunks stay as history, and the file stops appearing in search.
    outcome.removed += await archiveVanished(scope, connection.id, startedAt);

    await withCompanyScope(scope, async (tx) => {
      await tx`
        update google_drive_connections
           set last_sync_at = now(), last_sync_error = null, updated_at = now()
         where id = ${connection.id}
      `;
    });

    return outcome;
  } catch (error) {
    const message = describe(error);

    if (error instanceof GoogleDriveError && error.kind === 'needs_reauth') {
      await markNeedsReauth(scope, message);
      throw new GoogleDriveNeedsReauth();
    }

    await withCompanyScope(scope, async (tx) => {
      await tx`
        update google_drive_connections
           set last_sync_error = ${message.slice(0, 500)}, updated_at = now()
         where id = ${connection.id}
      `;
    });
    throw error;
  }
}

async function syncOneFile(
  scope: CompanyScope,
  connectionId: string,
  accessToken: string,
  file: GoogleFile,
  seenAt: Date,
  outcome: SyncOutcome,
  /**
   * The Drive folder it came from, when that is not the connected folder
   * itself.
   *
   * Every synced file lands in the root of the CIP Drive, so two files called
   * 8PM.png in two different Drive folders collide on a name that has to be
   * unique. The folder is what tells them apart — and since people file assets
   * by brand, it is usually the brand's own name, which makes it the right
   * thing to qualify with rather than a number.
   */
  folderName: string | null,
): Promise<void> {
  const existing = await withCompanyScope(scope, async (tx) => {
    const rows = await tx<ExistingRow[]>`
      select id, external_id, external_modified_time, external_md5, file_id, state
        from google_drive_files
       where external_id = ${file.id}
    `;
    return rows[0] ?? null;
  });

  // Moved to the bin on their side. Archive what we hold, keep the record.
  if (file.trashed) {
    if (existing && existing.state !== 'trashed') {
      await archiveOne(scope, existing.id, existing.file_id, 'Moved to the bin in Google Drive.');
      outcome.removed += 1;
    } else if (existing) {
      await touch(scope, existing.id, seenAt);
    }
    return;
  }

  const plan = planFor(file.mimeType, file.name);

  if (!plan.supported) {
    // Recorded with a reason, never silently skipped and never counted as
    // processed. The UI shows these so nobody wonders where a file went.
    await upsertRecord(scope, connectionId, file, {
      state: 'unsupported',
      reason: plan.reason,
      seenAt,
      exportedMime: null,
      fileId: existing?.file_id ?? null,
    });
    outcome.unsupported += 1;
    return;
  }

  const unchanged =
    existing !== null &&
    existing.state === 'synced' &&
    existing.file_id !== null &&
    sameVersion(existing, file);

  if (unchanged) {
    await touch(scope, existing.id, seenAt);
    outcome.unchanged += 1;
    return;
  }

  // Google already told us how big it is, so an oversize file is declined
  // before a byte of it moves. The size is absent for Google-native documents,
  // which are exported rather than downloaded and are never large.
  //
  // Two ceilings apply and the lower one governs: how much we are willing to
  // hold in memory, and how large an object the store will accept. Checking
  // only the first meant downloading 52.84 MB twice per sync to have the
  // bucket refuse it at 50 MB.
  // Two ceilings apply. The object store's is the smaller one here, and it is
  // not raisable on this plan — but a file we cannot keep is not a file we
  // cannot read. Anything within what we can hold in memory is fetched and
  // understood; only the original goes unsaved.
  const storeLimit = driveStorage().maxObjectBytes;
  const readLimit = maxDownloadBytes();
  const retain = file.size === null || file.size <= storeLimit;

  if (file.size !== null && file.size > readLimit) {
    await upsertRecord(scope, connectionId, file, {
      state: 'too_large',
      reason:
        `That file is ${(file.size / 1024 / 1024).toFixed(2)} MB, over the ` +
        `${(readLimit / 1024 / 1024).toFixed(0)} MB limit CIP can read in one piece.`,
      seenAt,
      exportedMime: plan.exportMime,
      fileId: existing?.file_id ?? null,
      limitBytes: readLimit,
    });
    outcome.tooLarge += 1;
    return;
  }

  try {
    const bytes = plan.exportMime
      ? await api().exportFile(accessToken, file.id, plan.exportMime)
      : await api().download(accessToken, file.id);

    if (bytes.byteLength === 0) {
      await upsertRecord(scope, connectionId, file, {
        state: 'failed',
        reason: 'The file is empty in Google Drive.',
        seenAt,
        exportedMime: plan.exportMime,
        fileId: existing?.file_id ?? null,
      });
      outcome.failed += 1;
      return;
    }

    const fileId = await writeDriveFile(scope, {
      existingFileId: existing?.file_id ?? null,
      name: await uniqueName(scope, file.name, plan.fileType, folderName, existing?.file_id ?? null),
      fileType: plan.fileType,
      mimeType: storedMimeFor(plan.fileType),
      bytes,
      retain,
    });

    await upsertRecord(scope, connectionId, file, {
      state: 'synced',
      reason: null,
      seenAt,
      exportedMime: plan.exportMime,
      fileId,
    });

    if (existing?.file_id) outcome.updated += 1;
    else outcome.added += 1;
  } catch (error) {
    if (error instanceof GoogleDriveError && error.kind === 'needs_reauth') throw error;

    // Our own limit, reached despite the check above — an export, or a file
    // whose reported size was wrong. Recorded as itself, not as a failure.
    if (error instanceof ObjectTooLarge) {
      await upsertRecord(scope, connectionId, file, {
        state: 'too_large',
        reason: error.message.slice(0, 300),
        seenAt,
        exportedMime: plan.exportMime,
        fileId: existing?.file_id ?? null,
        limitBytes: error.limitBytes,
      });
      outcome.tooLarge += 1;
      return;
    }

    if (error instanceof GoogleDriveTooLarge) {
      await upsertRecord(scope, connectionId, file, {
        state: 'too_large',
        reason: error.message.slice(0, 300),
        seenAt,
        exportedMime: plan.exportMime,
        fileId: existing?.file_id ?? null,
        limitBytes: error.limitBytes,
      });
      outcome.tooLarge += 1;
      return;
    }

    // One unreadable file must not abandon the rest of the folder.
    await upsertRecord(scope, connectionId, file, {
      state: 'failed',
      reason: describe(error).slice(0, 300),
      seenAt,
      exportedMime: plan.exportMime,
      fileId: existing?.file_id ?? null,
    });
    outcome.failed += 1;
  }
}

/**
 * A name no other live file in this Drive already holds.
 *
 * Everything synced lands in the root, so a Drive organised into folders
 * produces collisions the moment two of them hold a logo with the same name.
 * The Drive folder disambiguates, and reads well because it is usually the
 * brand: "8PM.png" from the 8PM folder becomes "8PM (8PM).png".
 *
 * If that is still taken — the same name in the same folder, which Drive does
 * allow — a number is appended, because something has to give and a number is
 * at least honest about being arbitrary.
 */
async function uniqueName(
  scope: CompanyScope,
  rawName: string,
  fileType: string,
  folderName: string | null,
  existingFileId: string | null,
): Promise<string> {
  const taken = async (name: string): Promise<boolean> =>
    withCompanyScope(scope, async (tx) => {
      const rows = await tx<{ id: string }[]>`
        select id from drive_files
         where company_id = ${scope.companyId}
           and folder_id is null
           and archived_at is null
           and lower(btrim(name)) = lower(btrim(${name}))
           and (${existingFileId}::uuid is null or id <> ${existingFileId}::uuid)
         limit 1
      `;
      return rows.length > 0;
    });

  const plain = ingestedFilename(rawName, fileType);
  if (!(await taken(plain))) return plain;

  if (folderName) {
    const stem = rawName.replace(/\.[^.]+$/, '');
    const qualified = ingestedFilename(`${stem} (${folderName})`, fileType);
    if (!(await taken(qualified))) return qualified;
  }

  const stem = rawName.replace(/\.[^.]+$/, '');
  for (let n = 2; n < 50; n += 1) {
    const numbered = ingestedFilename(`${stem} (${n})`, fileType);
    if (!(await taken(numbered))) return numbered;
  }

  return ingestedFilename(`${stem} (${Date.now()})`, fileType);
}

/** Google's view of the version, as far as it gives us one. */
function sameVersion(existing: ExistingRow, file: GoogleFile): boolean {
  // md5 is authoritative when present, but Google-native documents have none —
  // hence modifiedTime as well. Either moving counts as a change.
  if (file.md5Checksum && existing.external_md5) {
    return file.md5Checksum === existing.external_md5;
  }

  const seen = existing.external_modified_time?.getTime() ?? null;
  const now = file.modifiedTime ? new Date(file.modifiedTime).getTime() : null;
  if (seen === null || now === null) return false;
  return seen === now;
}

/**
 * Writes the bytes and the drive_files row.
 *
 * An update replaces the object in place and puts the row back to pending,
 * which is all it takes for the existing pipeline to re-extract it: extraction
 * deletes the previous extraction, and chunks and embeddings cascade from it.
 * Only the changed file is touched.
 */
async function writeDriveFile(
  scope: CompanyScope,
  input: {
    existingFileId: string | null;
    name: string;
    fileType: string;
    mimeType: string;
    bytes: Buffer;
    /**
     * False for a file too large for the object store. The row is written and
     * the file is understood; only the original is not kept. Re-reading it
     * fetches it from Google again, which is the price of not being able to
     * hold it.
     */
    retain: boolean;
  },
): Promise<string> {
  const fileId = input.existingFileId ?? randomUUID();
  const key = input.retain ? storageKeyFor(scope.companyId, fileId, input.fileType) : null;
  const checksum = sha256(input.bytes);

  if (key) await driveStorage().put(key, input.bytes, input.mimeType);

  await withCompanyScope(scope, async (tx) => {
    if (input.existingFileId) {
      await tx`
        update drive_files
           set name = ${input.name},
               original_filename = ${input.name},
               file_size = ${input.bytes.byteLength},
               checksum_sha256 = ${checksum},
               storage_path = ${key},
               bytes_retained = ${input.retain},
               archived_at = null,
               processing_status = 'pending',
               processing_attempts = 0,
               processing_error = null,
               processing_started_at = null,
               next_attempt_at = null,
               updated_at = now()
         where id = ${fileId}
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
         ${key}, ${input.retain}, ${scope.userId}, 'google_drive', 'pending', '{}'::jsonb)
    `;
  });

  return fileId;
}

async function upsertRecord(
  scope: CompanyScope,
  connectionId: string,
  file: GoogleFile,
  values: {
    state: string;
    reason: string | null;
    seenAt: Date;
    exportedMime: string | null;
    fileId: string | null;
    /** Only for `too_large`: the ceiling that rejected it. */
    limitBytes?: number | null;
  },
): Promise<void> {
  await withCompanyScope(scope, async (tx) => {
    await tx`
      insert into google_drive_files
        (company_id, connection_id, external_id, name, external_mime, exported_mime,
         external_modified_time, external_md5, external_size, file_id, state, reason,
         limit_bytes, last_seen_at, synced_at, updated_at)
      values
        (${scope.companyId}, ${connectionId}, ${file.id}, ${file.name}, ${file.mimeType},
         ${values.exportedMime},
         ${file.modifiedTime ? new Date(file.modifiedTime) : null}, ${file.md5Checksum},
         ${file.size}, ${values.fileId}, ${values.state}, ${values.reason},
         ${values.limitBytes ?? null},
         ${values.seenAt}, ${values.state === 'synced' ? values.seenAt : null}, now())
      on conflict (company_id, external_id) do update
         set connection_id          = excluded.connection_id,
             name                   = excluded.name,
             external_mime          = excluded.external_mime,
             exported_mime          = excluded.exported_mime,
             external_modified_time = excluded.external_modified_time,
             external_md5           = excluded.external_md5,
             external_size          = excluded.external_size,
             file_id                = coalesce(excluded.file_id, google_drive_files.file_id),
             state                  = excluded.state,
             reason                 = excluded.reason,
             limit_bytes            = excluded.limit_bytes,
             last_seen_at           = excluded.last_seen_at,
             synced_at              = coalesce(excluded.synced_at, google_drive_files.synced_at),
             updated_at             = now()
    `;
  });
}

/** Marks a file as still present without doing any other work. */
async function touch(scope: CompanyScope, recordId: string, seenAt: Date): Promise<void> {
  await withCompanyScope(scope, async (tx) => {
    await tx`
      update google_drive_files
         set last_seen_at = ${seenAt}, updated_at = now()
       where id = ${recordId}
    `;
  });
}

/**
 * Archives everything the listing did not mention.
 *
 * Deliberately archive rather than delete. The extraction and its chunks are
 * knowledge the company built up, and a file disappearing from a shared folder
 * is not a request to erase the record that it was ever there.
 */
async function archiveVanished(
  scope: CompanyScope,
  connectionId: string,
  startedAt: Date,
): Promise<number> {
  const gone = await withCompanyScope(scope, async (tx) =>
    tx<{ id: string; file_id: string | null }[]>`
      select id, file_id
        from google_drive_files
       where connection_id = ${connectionId}
         and state <> 'trashed'
         and (last_seen_at is null or last_seen_at < ${startedAt})
    `,
  );

  for (const record of gone) {
    await archiveOne(scope, record.id, record.file_id, 'No longer in the connected folder.');
  }
  return gone.length;
}

async function archiveOne(
  scope: CompanyScope,
  recordId: string,
  fileId: string | null,
  reason: string,
): Promise<void> {
  await withCompanyScope(scope, async (tx) => {
    await tx`
      update google_drive_files
         set state = 'trashed', reason = ${reason}, updated_at = now()
       where id = ${recordId}
    `;

    if (fileId) {
      // Archived, not deleted: it leaves search and the Drive listing, and the
      // extraction history stays intact.
      await tx`
        update drive_files
           set archived_at = coalesce(archived_at, now()), updated_at = now()
         where id = ${fileId}
      `;
    }
  });
}

function api() {
  return googleDrive();
}

/** A message safe to store: never a token, never a provider payload. */
function describe(error: unknown): string {
  if (error instanceof GoogleDriveError) return error.message;
  if (error instanceof Error && error.name === 'GoogleDriveNeedsReauth') return error.message;

  // Anything else is ours — storage refusing an object, a database constraint,
  // a bug. "The sync did not finish" was all this said, which is the one thing
  // the reader already knew, and it made a real 52 MB upload failure take a
  // code change to see. The row is only ever shown to the company it belongs
  // to, so its own error is safe to put in front of it.
  if (error instanceof Error && error.message) return error.message;
  return 'The sync did not finish.';
}
