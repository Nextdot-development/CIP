import postgres from 'postgres';
import { driveStorage } from '../src/server/drive/storage';

/**
 * Deletes stored objects that no drive_files row points at.
 *
 * Orphans appear whenever rows go away without the service deleting the bytes:
 * a `truncate companies cascade` during a re-seed, a manual SQL delete, or an
 * upload that crashed between writing the row and writing the object. Bytes
 * that outlive their row are invisible in the UI but still exist, which is
 * both a cost and a privacy problem.
 *
 *   npm run storage:gc           # report only
 *   npm run storage:gc -- --delete
 */
const DELETE = process.argv.includes('--delete');

async function listBucketKeys(): Promise<string[]> {
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const bucket = process.env.SUPABASE_STORAGE_BUCKET ?? 'cip-drive';
  if (!base || !key) throw new Error('This tool currently only inspects Supabase Storage.');

  const headers = { authorization: `Bearer ${key}`, apikey: key, 'content-type': 'application/json' };
  const list = async (prefix: string) => {
    const res = await fetch(`${base}/storage/v1/object/list/${bucket}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ prefix, limit: 1000, sortBy: { column: 'name', order: 'asc' } }),
    });
    if (!res.ok) throw new Error(`Listing failed (${res.status})`);
    return (await res.json()) as { name: string; id: string | null }[];
  };

  const keys: string[] = [];
  for (const company of await list('companies/')) {
    for (const object of await list(`companies/${company.name}/`)) {
      // A folder placeholder has a null id; real objects do not.
      if (object.id !== null) keys.push(`companies/${company.name}/${object.name}`);
    }
  }
  return keys;
}

async function main() {
  const sql = postgres(process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL!, { onnotice: () => {} });
  try {
    // Every table that owns an object, not just the Drive. This used to read
    // drive_files alone, which meant generated media and rendered PDF pages
    // both looked orphaned — and --delete would have removed them.
    const rows = await sql<{ storage_path: string }[]>`
      select storage_path from drive_files where storage_path is not null
      union
      select storage_path from media_generation_assets where storage_path is not null
      union
      select image_path as storage_path from pdf_page_understanding where image_path is not null
    `;
    const known = new Set(rows.map((r) => r.storage_path));
    const stored = await listBucketKeys();

    const orphans = stored.filter((k) => !known.has(k));
    const dangling = rows.filter((r) => !stored.includes(r.storage_path));

    console.log(`\n${stored.length} object(s) stored, ${known.size} referenced by a row.`);

    if (dangling.length > 0) {
      console.log(`\n${dangling.length} row(s) point at an object that is not there:`);
      for (const d of dangling) console.log(`  ${d.storage_path}`);
      console.log('These will fail to download. Re-upload them, or archive the rows.');
    }

    if (orphans.length === 0) {
      console.log('\nNo orphaned objects.');
      return;
    }

    console.log(`\n${orphans.length} orphaned object(s):`);
    for (const key of orphans) console.log(`  ${key}`);

    if (!DELETE) {
      console.log('\nRe-run with --delete to remove them.');
      return;
    }

    const store = driveStorage();
    for (const key of orphans) {
      await store.remove(key);
      console.log(`  deleted ${key}`);
    }
    console.log(`\nRemoved ${orphans.length} orphaned object(s).`);
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error('Storage GC failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
