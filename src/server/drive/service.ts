import 'server-only';
import { randomUUID } from 'node:crypto';
import type { TransactionSql } from 'postgres';
import { withCompanyScope } from '../db';
import type { CompanyScope } from '../db';
import { driveStorage, sha256, storageKeyFor } from './storage';
import { MAX_FILE_BYTES, maxFileSizeLabel, sanitiseFilename, specFor } from '@/lib/fileTypes';
import type { FileKind } from '@/lib/fileTypes';
import type * as D from '@/types/drive';

/**
 * Every Drive read and write.
 *
 * The only way in is a CompanyScope, which can be built only from a verified
 * session. Each query also filters on company_id explicitly and runs inside
 * withCompanyScope, so row-level security applies too — a query that lost its
 * WHERE clause returns nothing rather than another company's folders.
 *
 * Missing and forbidden are the same answer on purpose. Asking for another
 * company's file id gets DriveNotFound, exactly like an id that never existed,
 * so ids cannot be probed for existence.
 */

export class DriveNotFound extends Error {
  constructor(what = 'That item') {
    super(`${what} could not be found.`);
    this.name = 'DriveNotFound';
  }
}

export class DriveConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DriveConflict';
  }
}

export class DriveRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DriveRejected';
  }
}

const ROOT_SENTINEL = '00000000-0000-0000-0000-000000000000';

type FolderRow = {
  id: string; name: string; parent_id: string | null;
  created_at: Date; updated_at: Date;
};

type FileRow = {
  id: string; name: string; original_filename: string; file_type: string;
  mime_type: string; file_size: string; created_at: Date; updated_at: Date;
  uploaded_by_id: string | null; uploaded_by_name: string | null;
  processing_status: D.ProcessingStatus;
  source_type: D.DriveSourceType;
  understanding_status: string | null;
  understanding_kind: string | null;
  market: string | null;
};

function toFolder(r: FolderRow): D.DriveFolderDTO {
  return {
    id: r.id,
    name: r.name,
    parentId: r.parent_id,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

function toFile(r: FileRow): D.DriveFileDTO {
  // file_type holds the extension we settled on at upload, so the spec lookup
  // goes through a synthetic filename rather than trusting anything stored.
  const spec = specFor(`x.${r.file_type}`);
  return {
    id: r.id,
    name: r.name,
    originalFilename: r.original_filename,
    fileType: r.file_type,
    mimeType: r.mime_type,
    kind: (spec?.kind ?? 'document') as FileKind,
    fileSize: Number(r.file_size),
    previewable: spec ? spec.previewable : false,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    uploadedBy: r.uploaded_by_id ? { id: r.uploaded_by_id, name: r.uploaded_by_name ?? 'Someone' } : null,
    processingStatus: r.processing_status,
    // How far the Brain got with it, which for most files is the only half of
    // the story that matters. An image is never extracted as text, so its
    // processing_status stays pending for ever; what actually happened to it
    // is here.
    understanding: r.understanding_status
      ? { status: r.understanding_status as D.UnderstandingStatus, kind: r.understanding_kind ?? 'document' }
      : null,
    // Which market this file's knowledge belongs to. Suggested from the
    // filename and correctable, so a wrong guess is visible rather than
    // quietly shaping every brief.
    market: r.market ?? null,
    // Which source this came from. Safe to show: it names the integration,
    // not the account, the folder or anything about another company.
    sourceType: r.source_type ?? 'cip_drive',
  };
}

/** Confirms a folder belongs to this company, or refuses. Null means the root. */
async function requireFolder(
  tx: TransactionSql,
  scope: CompanyScope,
  folderId: string | null,
): Promise<FolderRow | null> {
  if (folderId === null) return null;
  const rows = await tx<FolderRow[]>`
    select id, name, parent_id, created_at, updated_at
      from drive_folders
     where id = ${folderId} and company_id = ${scope.companyId} and archived_at is null
  `;
  const row = rows[0];
  if (!row) throw new DriveNotFound('That folder');
  return row;
}

async function breadcrumbsFor(
  tx: TransactionSql,
  scope: CompanyScope,
  folderId: string | null,
): Promise<D.BreadcrumbDTO[]> {
  const crumbs: D.BreadcrumbDTO[] = [{ id: null, name: 'Drive' }];
  if (folderId === null) return crumbs;

  const rows = await tx<{ id: string; name: string; depth: number }[]>`
    with recursive up as (
      select id, name, parent_id, 0 as depth
        from drive_folders
       where id = ${folderId} and company_id = ${scope.companyId}
      union all
      select f.id, f.name, f.parent_id, up.depth + 1
        from drive_folders f
        join up on f.id = up.parent_id
       where f.company_id = ${scope.companyId}
    )
    select id, name, depth from up order by depth desc
  `;
  return [...crumbs, ...rows.map((r) => ({ id: r.id, name: r.name }))];
}

export async function listFolder(
  scope: CompanyScope,
  folderId: string | null,
): Promise<D.DriveListingDTO> {
  return withCompanyScope(scope, async (tx) => {
    const folder = await requireFolder(tx, scope, folderId);

    const [folders, files, crumbs] = await Promise.all([
      tx<FolderRow[]>`
        select id, name, parent_id, created_at, updated_at
          from drive_folders
         where company_id = ${scope.companyId}
           and coalesce(parent_id, ${ROOT_SENTINEL}) = coalesce(${folderId}::uuid, ${ROOT_SENTINEL})
           and archived_at is null
         order by lower(name)
      `,
      tx<FileRow[]>`
        select f.id, f.name, f.original_filename, f.file_type, f.mime_type, f.file_size,
               f.created_at, f.updated_at, f.processing_status, f.source_type, f.market,
             (select status from asset_understanding
               where file_id = f.id and company_id = f.company_id
               order by updated_at desc limit 1) as understanding_status,
             (select kind from asset_understanding
               where file_id = f.id and company_id = f.company_id
               order by updated_at desc limit 1) as understanding_kind,
               (select status from asset_understanding
                 where file_id = f.id and company_id = f.company_id
                 order by updated_at desc limit 1) as understanding_status,
               (select kind from asset_understanding
                 where file_id = f.id and company_id = f.company_id
                 order by updated_at desc limit 1) as understanding_kind,
               f.uploaded_by as uploaded_by_id, u.full_name as uploaded_by_name
          from drive_files f
          left join users u on u.id = f.uploaded_by
         where f.company_id = ${scope.companyId}
           and coalesce(f.folder_id, ${ROOT_SENTINEL}) = coalesce(${folderId}::uuid, ${ROOT_SENTINEL})
           and f.archived_at is null
         order by lower(f.name)
      `,
      breadcrumbsFor(tx, scope, folderId),
    ]);

    return {
      folder: folder ? { id: folder.id, name: folder.name, parentId: folder.parent_id } : null,
      breadcrumbs: crumbs,
      folders: folders.map(toFolder),
      files: files.map(toFile),
    };
  });
}

export async function createFolder(
  scope: CompanyScope,
  parentId: string | null,
  rawName: string,
): Promise<D.DriveFolderDTO> {
  const name = rawName.trim();
  if (!name || name.length > 200) throw new DriveRejected('A folder needs a name of 200 characters or fewer.');

  return withCompanyScope(scope, async (tx) => {
    await requireFolder(tx, scope, parentId);
    try {
      const rows = await tx<FolderRow[]>`
        insert into drive_folders (company_id, parent_id, name, created_by)
        values (${scope.companyId}, ${parentId}, ${name}, ${scope.userId})
        returning id, name, parent_id, created_at, updated_at
      `;
      return toFolder(rows[0]!);
    } catch (error) {
      throw translate(error, `A folder called "${name}" is already here.`);
    }
  });
}

export async function renameFolder(
  scope: CompanyScope,
  folderId: string,
  rawName: string,
): Promise<D.DriveFolderDTO> {
  const name = rawName.trim();
  if (!name || name.length > 200) throw new DriveRejected('A folder needs a name of 200 characters or fewer.');

  return withCompanyScope(scope, async (tx) => {
    try {
      const rows = await tx<FolderRow[]>`
        update drive_folders
           set name = ${name}, updated_at = now()
         where id = ${folderId} and company_id = ${scope.companyId} and archived_at is null
        returning id, name, parent_id, created_at, updated_at
      `;
      const row = rows[0];
      if (!row) throw new DriveNotFound('That folder');
      return toFolder(row);
    } catch (error) {
      if (error instanceof DriveNotFound) throw error;
      throw translate(error, `A folder called "${name}" is already here.`);
    }
  });
}

/** Archiving a folder archives everything inside it, however deep. */
export async function archiveFolder(scope: CompanyScope, folderId: string): Promise<void> {
  await withCompanyScope(scope, async (tx) => {
    await requireFolder(tx, scope, folderId);

    const descendants = await tx<{ id: string }[]>`
      with recursive down as (
        select id from drive_folders
         where id = ${folderId} and company_id = ${scope.companyId}
        union all
        select f.id from drive_folders f
          join down on f.parent_id = down.id
         where f.company_id = ${scope.companyId}
      )
      select id from down
    `;
    const ids = descendants.map((d) => d.id);

    await tx`
      update drive_files set archived_at = now(), updated_at = now()
       where company_id = ${scope.companyId} and folder_id = any(${ids}::uuid[]) and archived_at is null
    `;
    await tx`
      update drive_folders set archived_at = now(), updated_at = now()
       where company_id = ${scope.companyId} and id = any(${ids}::uuid[]) and archived_at is null
    `;
  });
}

export type UploadInput = {
  folderId: string | null;
  filename: string;
  mimeType: string | null;
  body: Buffer;
  /**
   * Where this came from. Defaults to the CIP Drive, which is what an upload
   * through the browser is; a page fetched from the brand's own site says so,
   * because a brief drawn from a product page and one drawn from a packshot
   * are different claims and somebody reading it needs to tell them apart.
   */
  sourceType?: 'cip_drive' | 'website';
};

export async function uploadFile(scope: CompanyScope, input: UploadInput): Promise<D.DriveFileDTO> {
  const name = sanitiseFilename(input.filename);
  const spec = specFor(name);

  if (!spec) {
    throw new DriveRejected(
      `We cannot store "${name}" yet. Try a PDF, Office document, CSV, image, video or audio file.`,
    );
  }
  if (input.body.length === 0) throw new DriveRejected('That file is empty.');
  if (input.body.length > MAX_FILE_BYTES) {
    throw new DriveRejected(`Files need to be ${maxFileSizeLabel()} or smaller.`);
  }

  // The browser's Content-Type is a hint, not evidence. The extension decides,
  // and the stored type comes from our own list.
  const mimeType = spec.mimeTypes.includes(input.mimeType ?? '')
    ? (input.mimeType as string)
    : spec.mimeTypes[0]!;

  const fileId = randomUUID();
  const storagePath = storageKeyFor(scope.companyId, fileId, spec.extension);
  const checksum = sha256(input.body);

  const row = await withCompanyScope(scope, async (tx) => {
    await requireFolder(tx, scope, input.folderId);
    try {
      const rows = await tx<FileRow[]>`
        insert into drive_files (
          id, company_id, folder_id, name, original_filename, file_type, mime_type,
          file_size, checksum_sha256, storage_path, uploaded_by, source_type
        ) values (
          ${fileId}, ${scope.companyId}, ${input.folderId}, ${name}, ${input.filename},
          ${spec.extension}, ${mimeType}, ${input.body.length}, ${checksum}, ${storagePath},
          ${scope.userId}, ${input.sourceType ?? 'cip_drive'}
        )
        returning id, name, original_filename, file_type, mime_type, file_size,
                  created_at, updated_at, processing_status, source_type, market,
                  null::text as understanding_status, null::text as understanding_kind,
                  uploaded_by as uploaded_by_id, null::text as uploaded_by_name
      `;
      return rows[0]!;
    } catch (error) {
      throw translate(error, `A file called "${name}" is already here.`);
    }
  });

  // Bytes land only after the row committed. A crash here leaves a row with no
  // object, which reads as a broken download; the reverse would leave an
  // orphaned object nobody can see or clean up.
  await driveStorage().put(storagePath, input.body, mimeType);

  return toFile(row);
}

export async function renameFile(
  scope: CompanyScope,
  fileId: string,
  rawName: string,
): Promise<D.DriveFileDTO> {
  const name = sanitiseFilename(rawName);
  if (!name) throw new DriveRejected('A file needs a name.');

  // Renaming must not smuggle a file into a type we do not accept, so the
  // extension is fixed to whatever was uploaded.
  return withCompanyScope(scope, async (tx) => {
    const current = await tx<{ file_type: string }[]>`
      select file_type from drive_files
       where id = ${fileId} and company_id = ${scope.companyId} and archived_at is null
    `;
    const ext = current[0]?.file_type;
    if (!ext) throw new DriveNotFound('That file');

    const base = name.toLowerCase().endsWith(`.${ext}`) ? name.slice(0, -(ext.length + 1)) : name;
    const finalName = `${base.trim() || 'untitled'}.${ext}`;

    try {
      const rows = await tx<FileRow[]>`
        update drive_files f
           set name = ${finalName}, updated_at = now()
          from (select 1) as _
         where f.id = ${fileId} and f.company_id = ${scope.companyId} and f.archived_at is null
        returning f.id, f.name, f.original_filename, f.file_type, f.mime_type, f.file_size,
                  f.created_at, f.updated_at, f.processing_status, f.source_type, f.market,
             (select status from asset_understanding
               where file_id = f.id and company_id = f.company_id
               order by updated_at desc limit 1) as understanding_status,
             (select kind from asset_understanding
               where file_id = f.id and company_id = f.company_id
               order by updated_at desc limit 1) as understanding_kind,
               (select status from asset_understanding
                 where file_id = f.id and company_id = f.company_id
                 order by updated_at desc limit 1) as understanding_status,
               (select kind from asset_understanding
                 where file_id = f.id and company_id = f.company_id
                 order by updated_at desc limit 1) as understanding_kind,
                  (select status from asset_understanding
                    where file_id = f.id and company_id = f.company_id
                    order by updated_at desc limit 1) as understanding_status,
                  (select kind from asset_understanding
                    where file_id = f.id and company_id = f.company_id
                    order by updated_at desc limit 1) as understanding_kind,
                  f.uploaded_by as uploaded_by_id, null::text as uploaded_by_name
      `;
      const row = rows[0];
      if (!row) throw new DriveNotFound('That file');
      return toFile(row);
    } catch (error) {
      if (error instanceof DriveNotFound) throw error;
      throw translate(error, `A file called "${finalName}" is already here.`);
    }
  });
}

/** Soft delete. The bytes stay until someone purges the archive. */
export async function archiveFile(scope: CompanyScope, fileId: string): Promise<void> {
  await withCompanyScope(scope, async (tx) => {
    const rows = await tx<{ id: string }[]>`
      update drive_files set archived_at = now(), updated_at = now()
       where id = ${fileId} and company_id = ${scope.companyId} and archived_at is null
      returning id
    `;
    if (!rows[0]) throw new DriveNotFound('That file');
  });
}

export async function restoreFile(scope: CompanyScope, fileId: string): Promise<void> {
  await withCompanyScope(scope, async (tx) => {
    const rows = await tx<{ id: string }[]>`
      update drive_files set archived_at = null, updated_at = now()
       where id = ${fileId} and company_id = ${scope.companyId} and archived_at is not null
      returning id
    `;
    if (!rows[0]) throw new DriveNotFound('That file');
  });
}

/** Permanent. Removes the row and the bytes. */
export async function deleteFileForever(scope: CompanyScope, fileId: string): Promise<void> {
  const key = await withCompanyScope(scope, async (tx) => {
    const rows = await tx<{ storage_path: string }[]>`
      delete from drive_files
       where id = ${fileId} and company_id = ${scope.companyId}
      returning storage_path
    `;
    const row = rows[0];
    if (!row) throw new DriveNotFound('That file');
    return row.storage_path;
  });

  await driveStorage().remove(key);
}

export type FileForDownload = {
  file: D.DriveFileDTO;
  body: Buffer;
  /** The download name, sanitised, with the real extension. */
  filename: string;
};

export async function readFile(scope: CompanyScope, fileId: string): Promise<FileForDownload> {
  const row = await withCompanyScope(scope, async (tx) => {
    const rows = await tx<(FileRow & { storage_path: string })[]>`
      select id, name, original_filename, file_type, mime_type, file_size,
             created_at, updated_at, processing_status, source_type, market, storage_path,
             (select status from asset_understanding u
               where u.file_id = drive_files.id and u.company_id = drive_files.company_id
               order by u.updated_at desc limit 1) as understanding_status,
             (select kind from asset_understanding u
               where u.file_id = drive_files.id and u.company_id = drive_files.company_id
               order by u.updated_at desc limit 1) as understanding_kind,
             uploaded_by as uploaded_by_id, null::text as uploaded_by_name
        from drive_files
       where id = ${fileId} and company_id = ${scope.companyId} and archived_at is null
    `;
    const found = rows[0];
    if (!found) throw new DriveNotFound('That file');
    return found;
  });

  // The key is read back from the row we just proved belongs to this company,
  // never assembled from anything the caller sent.
  const body = await driveStorage().get(row.storage_path);
  return { file: toFile(row), body, filename: row.name };
}

export async function listArchived(scope: CompanyScope): Promise<D.DriveFileDTO[]> {
  return withCompanyScope(scope, async (tx) => {
    const rows = await tx<FileRow[]>`
      select f.id, f.name, f.original_filename, f.file_type, f.mime_type, f.file_size,
             f.created_at, f.updated_at, f.processing_status, f.source_type, f.market,
             (select status from asset_understanding
               where file_id = f.id and company_id = f.company_id
               order by updated_at desc limit 1) as understanding_status,
             (select kind from asset_understanding
               where file_id = f.id and company_id = f.company_id
               order by updated_at desc limit 1) as understanding_kind,
             f.uploaded_by as uploaded_by_id, u.full_name as uploaded_by_name
        from drive_files f
        left join users u on u.id = f.uploaded_by
       where f.company_id = ${scope.companyId} and f.archived_at is not null
       order by f.archived_at desc
    `;
    return rows.map(toFile);
  });
}

export async function search(
  scope: CompanyScope,
  query: string,
  kind: FileKind | null = null,
): Promise<D.DriveSearchResultDTO> {
  const term = query.trim();
  if (term.length < 2) return { query: term, files: [], folders: [] };

  // Escape the LIKE wildcards so a search for "100%" means what it says.
  const BACKSLASH = String.fromCharCode(92);
  const escaped = term
    .split(BACKSLASH).join(BACKSLASH + BACKSLASH)
    .split('%').join(BACKSLASH + '%')
    .split('_').join(BACKSLASH + '_');
  const pattern = `%${escaped}%`;

  return withCompanyScope(scope, async (tx) => {
    const [files, folders] = await Promise.all([
      tx<(FileRow & { folder_id: string | null; folder_name: string | null })[]>`
        select f.id, f.name, f.original_filename, f.file_type, f.mime_type, f.file_size,
               f.created_at, f.updated_at, f.processing_status, f.source_type, f.market,
             (select status from asset_understanding
               where file_id = f.id and company_id = f.company_id
               order by updated_at desc limit 1) as understanding_status,
             (select kind from asset_understanding
               where file_id = f.id and company_id = f.company_id
               order by updated_at desc limit 1) as understanding_kind,
               (select status from asset_understanding
                 where file_id = f.id and company_id = f.company_id
                 order by updated_at desc limit 1) as understanding_status,
               (select kind from asset_understanding
                 where file_id = f.id and company_id = f.company_id
                 order by updated_at desc limit 1) as understanding_kind,
               f.folder_id, d.name as folder_name,
               f.uploaded_by as uploaded_by_id, u.full_name as uploaded_by_name
          from drive_files f
          left join drive_folders d on d.id = f.folder_id
          left join users u on u.id = f.uploaded_by
         where f.company_id = ${scope.companyId}
           and f.archived_at is null
           and f.name ilike ${pattern}
         order by lower(f.name)
         limit 100
      `,
      tx<FolderRow[]>`
        select id, name, parent_id, created_at, updated_at
          from drive_folders
         where company_id = ${scope.companyId}
           and archived_at is null
           and name ilike ${pattern}
         order by lower(name)
         limit 50
      `,
    ]);

    const mapped = files
      .map((r) => ({ ...toFile(r), folderId: r.folder_id, folderName: r.folder_name }))
      .filter((f) => (kind ? f.kind === kind : true));

    return { query: term, files: mapped, folders: folders.map(toFolder) };
  });
}

/** Turns a Postgres constraint violation into something a person can act on. */
function translate(error: unknown, duplicateMessage: string): Error {
  const code = (error as { code?: string } | null)?.code;
  if (code === '23505') return new DriveConflict(duplicateMessage);
  // 23503: the composite foreign key refused a parent in another company.
  if (code === '23503') return new DriveNotFound('That folder');
  if (code === '42501') return new DriveNotFound('That item');
  return error instanceof Error ? error : new Error(String(error));
}
