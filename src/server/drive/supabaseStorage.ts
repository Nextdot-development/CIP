import 'server-only';
import type { DriveStorage } from './storage';
import { assertSafeKey } from './storage';

/**
 * Supabase Storage, reached over its REST API.
 *
 * No SDK: the three calls we need are plain HTTP, and adding a dependency to
 * make them shorter would not make them clearer.
 *
 * The bucket is private. Supabase Storage policies are written against Supabase
 * Auth JWTs (`auth.uid()`), and CIP issues its own sessions, so a bucket policy
 * could not tell one CIP company from another even if we wrote one. Isolation
 * therefore lives where it can actually see the company: the drive_files row —
 * which is under row-level security — decides whether a key may be read at all,
 * and only then does this module fetch it. Nothing here is ever handed a key
 * that came from a browser.
 */
export class SupabaseStorage implements DriveStorage {
  readonly name = 'supabase-storage';

  private readonly base: string;
  private readonly bucket: string;
  private readonly headers: Record<string, string>;

  constructor(url: string, serviceRoleKey: string, bucket: string) {
    this.base = url.replace(/\/+$/, '');
    this.bucket = bucket;
    this.headers = {
      authorization: `Bearer ${serviceRoleKey}`,
      apikey: serviceRoleKey,
    };
  }

  private objectUrl(key: string): string {
    assertSafeKey(key);
    // Keys are UUID segments, so this only guards against a future key format.
    const path = key.split('/').map(encodeURIComponent).join('/');
    return `${this.base}/storage/v1/object/${this.bucket}/${path}`;
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    const res = await fetch(this.objectUrl(key), {
      method: 'POST',
      headers: {
        ...this.headers,
        'content-type': contentType,
        // Re-uploading the same key replaces it rather than failing, which
        // matters when a retry follows a half-finished upload.
        'x-upsert': 'true',
      },
      body: new Uint8Array(body),
    });
    if (!res.ok) {
      throw new Error(`Storage upload failed (${res.status}): ${await safeText(res)}`);
    }
  }

  async get(key: string): Promise<Buffer> {
    const res = await fetch(this.objectUrl(key), { headers: this.headers });
    if (!res.ok) {
      throw new Error(`Storage read failed (${res.status}): ${await safeText(res)}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }

  async remove(key: string): Promise<void> {
    const res = await fetch(this.objectUrl(key), { method: 'DELETE', headers: this.headers });
    // A missing object is already the state we wanted.
    if (!res.ok && res.status !== 404) {
      throw new Error(`Storage delete failed (${res.status}): ${await safeText(res)}`);
    }
  }
}

/** Error bodies are echoed back to logs, so never let a token ride along. */
async function safeText(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  return text.slice(0, 300);
}
