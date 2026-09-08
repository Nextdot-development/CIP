import 'server-only';
import { MAX_FILE_BYTES } from '@/lib/fileTypes';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { SupabaseStorage } from './supabaseStorage';

/**
 * Where file bytes live.
 *
 * The store is deliberately dumb: it knows keys and bytes, not companies. The
 * company boundary is enforced in the database and the service layer, and the
 * key itself carries the company id so a mis-scoped read is also wrong here.
 *
 * Nothing in the object store is ever reachable from a browser directly.
 * Downloads go through a route handler that proves the session first, so there
 * is no signed URL to leak and no public bucket to misconfigure.
 */
export interface DriveStorage {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
  readonly name: string;
  /**
   * The largest single object this backend will accept.
   *
   * Asked before a file is fetched rather than discovered by having one
   * rejected. Two real 52.84 MB decks were downloaded in full — 106 MB over
   * the wire, every sync — only for Supabase to refuse the object at 50 MB and
   * the sync to record "Storage upload failed (400)". The limit belongs to the
   * backend, so the backend is what states it.
   */
  readonly maxObjectBytes: number;
}

/**
 * An object the store would not accept because of its size.
 *
 * Distinct from a failed write: nothing went wrong, the file is simply larger
 * than this backend allows. Both numbers travel with it so a caller can say
 * which limit was hit and by how much, rather than paraphrasing.
 */
export class ObjectTooLarge extends Error {
  readonly measuredBytes: number;
  readonly limitBytes: number;

  constructor(measuredBytes: number, limitBytes: number, backend: string) {
    super(
      `That file is ${(measuredBytes / 1024 / 1024).toFixed(2)} MB, over the ` +
        `${(limitBytes / 1024 / 1024).toFixed(0)} MB limit of the ${backend} object store.`,
    );
    this.name = 'ObjectTooLarge';
    this.measuredBytes = measuredBytes;
    this.limitBytes = limitBytes;
  }
}

/**
 * Keys are generated from UUIDs, but never trust that on the way to a path.
 *
 * Two shapes are allowed and nothing else:
 *
 *   companies/{companyId}/{fileId}.ext                     an uploaded file
 *   companies/{companyId}/media/{generationId}/{assetId}.ext  a generated one
 *
 * Both start with the owning company, so a key that has drifted from its row
 * is wrong here too, and neither can contain a path segment that did not come
 * from a UUID we generated. Adding a shape means adding it here on purpose,
 * which is the point of an allow-list.
 */
const UUID = '[0-9a-f-]{36}';
const EXTENSION = '(\\.[a-z0-9]{1,10})?';
const SAFE_KEY = new RegExp(
  `^companies\\/${UUID}\\/(${UUID}` +
    `|media\\/${UUID}\\/${UUID}` +
    // A PDF read visually keeps each rendered page, grouped under the file it
    // came from so a file's pages can be found without consulting the database.
    // Both segments are ids we generated, so the shape stays as strict as the
    // others: no page number, no filename, nothing a caller chose.
    `|pdf-pages\\/${UUID}\\/${UUID}` +
    `)${EXTENSION}$`,
  'i',
);

/** Where one rendered page of a PDF lives. */
export function pdfPageKeyFor(companyId: string, fileId: string, pageId: string): string {
  return `companies/${companyId}/pdf-pages/${fileId}/${pageId}.jpg`;
}

export function assertSafeKey(key: string): void {
  if (!SAFE_KEY.test(key)) {
    throw new Error(`Refusing to touch an unexpected storage key: ${key}`);
  }
}

export function storageKeyFor(companyId: string, fileId: string, extension: string): string {
  return `companies/${companyId}/${fileId}${extension ? `.${extension}` : ''}`;
}

export function sha256(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

/**
 * Local disk. The default, and what the tests run against.
 * Files land under CIP_STORAGE_DIR (./.storage by default), which is gitignored.
 */
class LocalDiskStorage implements DriveStorage {
  readonly name = 'local-disk';
  /**
   * A disk has no object limit of its own, so the app's own ceiling stands —
   * unless one is configured. The override is honoured here as well as in the
   * hosted backend so the limit can be exercised without a 50 MB fixture, and
   * so a deployment on disk can still be given a bound.
   */
  get maxObjectBytes(): number {
    // Read each time rather than captured: the store is built once per process
    // and cached, so a value fixed in the constructor could never be changed.
    const configured = Number(process.env.CIP_STORAGE_MAX_OBJECT_BYTES);
    return Number.isFinite(configured) && configured > 0 ? configured : MAX_FILE_BYTES;
  }
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private pathFor(key: string): string {
    assertSafeKey(key);
    const full = resolve(join(this.root, key));
    // Belt and braces: even with a valid-looking key, never escape the root.
    if (full !== this.root && !full.startsWith(this.root + sep)) {
      throw new Error('Storage key resolved outside the storage root');
    }
    return full;
  }

  async put(key: string, body: Buffer): Promise<void> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.pathFor(key));
  }

  async remove(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }
}

let cached: DriveStorage | null = null;

/**
 * Supabase Storage when it is configured, local disk otherwise.
 *
 * Both are private and both are reached only from the server, so the isolation
 * story does not change with the driver — only where the bytes sit. Set
 * CIP_FORCE_LOCAL_STORAGE=true to keep tests off the network.
 */
export function driveStorage(): DriveStorage {
  if (cached) return cached;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const bucket = process.env.SUPABASE_STORAGE_BUCKET ?? 'cip-drive';
  const forceLocal = process.env.CIP_FORCE_LOCAL_STORAGE === 'true';

  if (url && key && !forceLocal) {
    cached = new SupabaseStorage(url, key, bucket);
    return cached;
  }

  cached = new LocalDiskStorage(process.env.CIP_STORAGE_DIR ?? join(process.cwd(), '.storage'));
  return cached;
}

/** Tests swap in their own root. */
export function __setDriveStorage(store: DriveStorage | null): void {
  cached = store;
}
