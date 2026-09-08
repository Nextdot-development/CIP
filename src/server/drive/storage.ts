import 'server-only';
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
