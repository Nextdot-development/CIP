import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Files from storage kept on the server once read: a picture asked for again
 * is not downloaded again - but only under a version its caller vouches for,
 * so one written again is never served as it was.
 */

process.env.DATABASE_URL ??= 'postgres://unused@localhost:5432/unused';
const dir = await mkdtemp(join(tmpdir(), 'cip-cache-test-'));
process.env.CIP_STORAGE_CACHE_DIR = dir;

const { __setDriveStorage } = await import('../src/server/drive/storage');
const { readThrough, forget } = await import('../src/server/storageCache');

/** A store far away, that counts what it is asked for. */
const files = new Map<string, Buffer>();
const asked: string[] = [];
const remote = {
  name: 's3-storage',
  maxObjectBytes: 50 * 1024 * 1024,
  async put(key: string, body: Buffer) { files.set(key, body); },
  async get(key: string) {
    asked.push(key);
    await new Promise((r) => setTimeout(r, 5));
    const b = files.get(key);
    if (!b) throw new Error('missing');
    return b;
  },
  async remove(key: string) { files.delete(key); },
};
const read = (key: string) => () => remote.get(key);

describe('files kept on the server once read', () => {
  before(() => __setDriveStorage(remote as never));
  after(async () => { __setDriveStorage(null); await rm(dir, { recursive: true, force: true }); });

  it('downloads a file once, however often it is asked for - even twice at the same moment', async () => {
    files.set('a.png', Buffer.from('first'));
    asked.length = 0;
    const [one, two] = await Promise.all([readThrough('a.png', 'v1', read('a.png')), readThrough('a.png', 'v1', read('a.png'))]);
    const three = await readThrough('a.png', 'v1', read('a.png'));
    assert.equal(one.toString(), 'first');
    assert.equal(two.toString(), 'first');
    assert.equal(three.toString(), 'first');
    assert.deepEqual(asked, ['a.png']);
  });

  it('reads a file written again under a new version, never the one it kept', async () => {
    files.set('a.png', Buffer.from('second'));
    asked.length = 0;
    assert.equal((await readThrough('a.png', 'v2', read('a.png'))).toString(), 'second');
    // The earlier version is still that version's.
    assert.equal((await readThrough('a.png', 'v1', read('a.png'))).toString(), 'first');
    assert.deepEqual(asked, ['a.png']);
  });

  it('keeps what it read on the disk too, and lets go of one it is told was wrong', async () => {
    await new Promise((r) => setTimeout(r, 50));
    assert.ok((await readdir(dir)).length >= 2);
    asked.length = 0;
    await forget('a.png', 'v2');
    assert.equal((await readThrough('a.png', 'v2', read('a.png'))).toString(), 'second');
    assert.deepEqual(asked, ['a.png']);
  });

  it('does not keep what it could not read', async () => {
    asked.length = 0;
    await assert.rejects(readThrough('gone.png', 'v1', read('gone.png')));
    files.set('gone.png', Buffer.from('back'));
    assert.equal((await readThrough('gone.png', 'v1', read('gone.png'))).toString(), 'back');
    assert.deepEqual(asked, ['gone.png', 'gone.png']);
  });

  it('reads straight from a store on this machine\'s own disk, keeping nothing', async () => {
    __setDriveStorage({ ...remote, name: 'local-disk' } as never);
    files.set('b.png', Buffer.from('near'));
    asked.length = 0;
    await readThrough('b.png', 'v1', read('b.png'));
    await readThrough('b.png', 'v1', read('b.png'));
    assert.deepEqual(asked, ['b.png', 'b.png']);
    __setDriveStorage(remote as never);
  });
});
