import 'server-only';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { driveStorage } from './drive/storage';

/**
 * Files read from storage, kept here once read: in memory, and on this
 * server's disk, so the same picture is not downloaded again and again.
 *
 * The object store counts every download, and a day of opening posts,
 * placing pieces and refreshing the list used up its daily allowance - the
 * same background, bottle and logo fetched hundreds of times.
 *
 * A file is kept only under a version its caller vouches for - a layer's
 * hash, when a post's scene was last changed, when a file was last updated -
 * so a file written again under the same key is never served stale: its
 * version is new, and so is its place here. Many servers run the app; each
 * keeps its own copy, and none can hand back another's out-of-date one.
 */

const MEMORY_BYTES = 160 * 1024 * 1024;
const DISK_BYTES = 400 * 1024 * 1024;
const dir = process.env.CIP_STORAGE_CACHE_DIR ?? join(tmpdir(), 'cip-storage-cache');

const memory = new Map<string, Buffer>();
let memoryBytes = 0;
const reading = new Map<string, Promise<Buffer>>();
let writes = 0;

const idOf = (key: string, version: string) => createHash('sha1').update(`${key}\n${version}`).digest('hex');

function remember(id: string, bytes: Buffer) {
  const had = memory.get(id);
  if (had) { memoryBytes -= had.byteLength; memory.delete(id); }
  // Something bigger than a tenth of what is kept is not worth pushing everything else out for.
  if (bytes.byteLength > MEMORY_BYTES / 10) return;
  memory.set(id, bytes);
  memoryBytes += bytes.byteLength;
  while (memoryBytes > MEMORY_BYTES && memory.size) {
    const [oldest, b] = memory.entries().next().value!;
    memory.delete(oldest);
    memoryBytes -= b.byteLength;
  }
}

/** The disk kept under its limit: the files least lately used go first. Now and then, not on every write. */
async function prune() {
  const names = await readdir(dir).catch(() => [] as string[]);
  const files = (await Promise.all(names.map(async (n) => {
    const s = await stat(join(dir, n)).catch(() => null);
    return s ? { n, size: s.size, at: s.mtimeMs } : null;
  }))).filter((f): f is { n: string; size: number; at: number } => f !== null);
  let total = files.reduce((t, f) => t + f.size, 0);
  for (const f of files.sort((a, b) => a.at - b.at)) {
    if (total <= DISK_BYTES * 0.8) break;
    await rm(join(dir, f.n), { force: true }).catch(() => undefined);
    total -= f.size;
  }
}

/**
 * A file, from memory, then this server's disk, then storage - kept on the
 * way back. Asked for twice at once, it is read once.
 */
export async function readThrough(key: string, version: string, read: () => Promise<Buffer>): Promise<Buffer> {
  // Files on this machine's own disk cost nothing to read again: kept only when they come from afar.
  if (driveStorage().name === 'local-disk') return read();
  const id = idOf(key, version);
  const held = memory.get(id);
  if (held) {
    memory.delete(id);
    memory.set(id, held);
    return held;
  }
  const pending = reading.get(id);
  if (pending) return pending;
  const task = (async () => {
    const path = join(dir, id);
    const onDisk = await readFile(path).catch(() => null);
    if (onDisk) {
      remember(id, onDisk);
      // Marked as used, so pruning keeps it. Best effort: a disk that refuses is no reason to fail a read.
      const now = new Date();
      void utimes(path, now, now).catch(() => undefined);
      return onDisk;
    }
    const bytes = await read();
    remember(id, bytes);
    void (async () => {
      await mkdir(dir, { recursive: true });
      await writeFile(path, bytes);
      if (++writes % 40 === 0) await prune();
    })().catch(() => undefined);
    return bytes;
  })();
  reading.set(id, task);
  try {
    return await task;
  } finally {
    reading.delete(id);
  }
}

/** Lets go of a file kept under a version that turned out not to be what was stored. */
export async function forget(key: string, version: string): Promise<void> {
  const id = idOf(key, version);
  const had = memory.get(id);
  if (had) { memoryBytes -= had.byteLength; memory.delete(id); }
  await rm(join(dir, id), { force: true }).catch(() => undefined);
}
