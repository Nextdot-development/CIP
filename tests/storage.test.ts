import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * The object store.
 *
 * The local driver always runs. The Supabase driver runs only when the
 * credentials are present, so `npm test` needs no network by default — but
 * when they are set, these are real calls against the real bucket.
 */

let storageDir: string;
let storage: typeof import('../src/server/drive/storage');

const BAD_KEYS = [
  '../../etc/passwd',
  'companies/../secrets/x',
  'not-a-key',
  'companies/11111111-1111-1111-1111-111111111111/../../22222222-2222-2222-2222-222222222222/x.txt',
  '/etc/passwd',
  '',
];

before(async () => {
  storageDir = mkdtempSync(join(tmpdir(), 'cip-store-'));
  process.env.CIP_STORAGE_DIR = storageDir;
  process.env.CIP_FORCE_LOCAL_STORAGE = 'true';
  storage = await import('../src/server/drive/storage');
});

after(() => {
  try {
    rmSync(storageDir, { recursive: true, force: true });
  } catch {
    /* temp dir */
  }
});

describe('storage keys', () => {
  it('refuses anything that is not a company-scoped uuid key', () => {
    for (const key of BAD_KEYS) {
      assert.throws(() => storage.assertSafeKey(key), /unexpected storage key/i, `accepted "${key}"`);
    }
  });

  it('always builds a key underneath the owning company', () => {
    const key = storage.storageKeyFor(
      '11111111-1111-1111-1111-111111111111',
      '33333333-3333-3333-3333-333333333333',
      'pdf',
    );
    assert.equal(key, 'companies/11111111-1111-1111-1111-111111111111/33333333-3333-3333-3333-333333333333.pdf');
    assert.doesNotThrow(() => storage.assertSafeKey(key));
  });
});

describe('local disk driver', () => {
  const key = 'companies/11111111-1111-1111-1111-111111111111/33333333-3333-3333-3333-333333333333.txt';

  it('round-trips bytes and deletes them', async () => {
    const store = storage.driveStorage();
    await store.put(key, Buffer.from('hello drive'), 'text/plain');
    assert.equal((await store.get(key)).toString(), 'hello drive');
    await store.remove(key);
    await assert.rejects(() => store.get(key));
  });

  it('will not read or write outside the storage root', async () => {
    const store = storage.driveStorage();
    for (const bad of BAD_KEYS) {
      await assert.rejects(() => store.get(bad), `read accepted "${bad}"`);
      await assert.rejects(() => store.put(bad, Buffer.from('x'), 'text/plain'), `write accepted "${bad}"`);
    }
  });
});

const supabaseConfigured = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);

describe('Supabase Storage driver', { skip: supabaseConfigured ? false : 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set' }, () => {
  const companyA = '11111111-1111-1111-1111-111111111111';
  const secret = 'company A confidential payload';
  // A key per test. Sharing one made these interfere with each other, which
  // looked like eventual consistency and was not.
  const freshKey = () => `companies/${companyA}/${randomUUID()}.txt`;
  const base = process.env.SUPABASE_URL ?? '';
  const bucket = process.env.SUPABASE_STORAGE_BUCKET ?? 'cip-drive';

  /**
   * Supabase Storage reads are eventually consistent: an object can still be
   * served for a moment after a successful delete. Poll rather than assert an
   * instant 404, which would be a flaky test of a real characteristic.
   */
  const eventuallyGone = async (store: { get: (k: string) => Promise<Buffer> }, k: string) => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        await store.get(k);
      } catch {
        return true;
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    return false;
  };

  const driver = async () => {
    const { SupabaseStorage } = await import('../src/server/drive/supabaseStorage');
    return new SupabaseStorage(base, process.env.SUPABASE_SERVICE_ROLE_KEY!, bucket);
  };

  it('round-trips bytes and deletes them', async () => {
    const store = await driver();
    const key = freshKey();
    await store.put(key, Buffer.from(secret), 'text/plain');
    assert.equal((await store.get(key)).toString(), secret);
    await store.remove(key);
    assert.ok(await eventuallyGone(store, key), 'object was still readable after delete');
  });

  it('the bucket is not readable without our server', async () => {
    const store = await driver();
    const key = freshKey();
    await store.put(key, Buffer.from(secret), 'text/plain');
    try {
      const publicRead = await fetch(`${base}/storage/v1/object/public/${bucket}/${key}`);
      assert.ok(publicRead.status >= 400, `public URL returned ${publicRead.status}`);
      assert.ok(!(await publicRead.text()).includes('confidential'));

      const anonRead = await fetch(`${base}/storage/v1/object/${bucket}/${key}`);
      assert.ok(anonRead.status >= 400, `unauthenticated read returned ${anonRead.status}`);

      const anonList = await fetch(`${base}/storage/v1/object/list/${bucket}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prefix: '', limit: 100 }),
      });
      assert.ok(anonList.status >= 400, `unauthenticated listing returned ${anonList.status}`);
    } finally {
      await store.remove(key);
    }
  });

  it('refuses a malformed key before making any request', async () => {
    const store = await driver();
    for (const bad of BAD_KEYS) {
      await assert.rejects(() => store.get(bad), /unexpected storage key/i, `accepted "${bad}"`);
    }
  });
});
