import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import postgres from 'postgres';
import { SupabaseStorage } from '../src/server/drive/supabaseStorage';

/**
 * Copies Drive objects from local disk into Supabase Storage.
 *
 * Run once after switching drivers, so files uploaded before the change stay
 * downloadable. Reads the key list from the database rather than walking the
 * directory, so nothing orphaned gets copied up.
 *
 *   npm run storage:migrate
 */
async function main() {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.');
  }

  const root = process.env.CIP_STORAGE_DIR ?? join(process.cwd(), '.storage');
  const store = new SupabaseStorage(
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
    process.env.SUPABASE_STORAGE_BUCKET ?? 'cip-drive',
  );

  const sql = postgres(process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL!, { onnotice: () => {} });

  try {
    const files = await sql<{ storage_path: string; mime_type: string; name: string }[]>`
      select storage_path, mime_type, name from drive_files order by created_at
    `;
    console.log(`Found ${files.length} file(s) recorded in the database.`);

    let copied = 0;
    let already = 0;
    let missing = 0;

    for (const file of files) {
      try {
        await store.get(file.storage_path);
        already += 1;
        console.log(`  have  ${file.name}`);
        continue;
      } catch {
        /* not in Supabase yet — try to copy it up */
      }

      try {
        const body = await readFile(join(root, file.storage_path));
        await store.put(file.storage_path, body, file.mime_type);
        copied += 1;
        console.log(`  copy  ${file.name} (${body.length} bytes)`);
      } catch {
        missing += 1;
        console.log(`  MISS  ${file.name} — no local copy at ${file.storage_path}`);
      }
    }

    console.log(`\nDone. ${copied} copied, ${already} already there, ${missing} with no local copy.`);
    if (missing > 0) {
      console.log('Files with no local copy will fail to download until they are re-uploaded.');
    }
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error('Storage migration failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
