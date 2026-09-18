/**
 * Puts a company's objects back under a company's own prefix.
 *
 *   npm run storage:relocate            # report what is out of place
 *   npm run storage:relocate -- --apply # copy the bytes and repoint the rows
 *
 * Every object key in CIP names the company that owns it:
 * `companies/<company_id>/...`. That is not decoration. It is the reason a
 * mis-scoped read is wrong in the object store as well as in the database, and
 * it is what makes "delete this company" a thing that can be done.
 *
 * `npm run merge` moves a company's rows into another company, and its own
 * comment claims it moves "files and their bytes". It moves the rows. The
 * objects stay where they were written, under the old company's prefix, and
 * nothing notices because reads follow the stored path. Radico is holding
 * thirty-odd objects that sit under Magic Moments, which still works and would
 * stop working the day anybody cleaned up Magic Moments.
 *
 * What this does, per object: copy the bytes to the right key, read them back,
 * then repoint the row. The old object is left where it is — `storage:gc`
 * reports it as an orphan and `storage:gc -- --delete` removes it — because
 * losing a file to a tidy-up is worse than leaving a copy behind.
 *
 * An object that is already missing is reported and left alone: its row is the
 * only record that it ever existed, and repointing it at a key with nothing
 * behind it would lose that.
 */
import postgres from 'postgres';
import { driveStorage, pdfPageKeyFor, storageKeyFor } from '../src/server/drive/storage';
import { extensionFor, mediaStorageKey } from '../src/server/media/storage';

const APPLY = process.argv.includes('--apply');
const admin = postgres(process.env.DATABASE_ADMIN_URL!, { onnotice: () => {} });
const store = driveStorage();

type Move = {
  what: string;
  from: string;
  to: string;
  /** Carried across with the bytes, so the new object is stored as what it is. */
  contentType: string;
  /** Repoints the rows once the bytes are in the new place. */
  repoint: () => Promise<void>;
};

async function drivePlan(): Promise<Move[]> {
  const rows = await admin<
    { id: string; company_id: string; name: string; file_type: string; mime_type: string; storage_path: string }[]
  >`
    select id, company_id, name, file_type, mime_type, storage_path
      from drive_files
     where storage_path is not null
       and storage_path not like 'companies/' || company_id || '/%'
     order by name
  `;

  return rows.map((row) => {
    const to = storageKeyFor(row.company_id, row.id, row.file_type);
    return {
      what: `file ${row.name}`,
      from: row.storage_path,
      to,
      contentType: row.mime_type,
      repoint: async () => {
        await admin`update drive_files set storage_path = ${to}, updated_at = now() where id = ${row.id}`;
      },
    };
  });
}

async function mediaPlan(): Promise<Move[]> {
  const rows = await admin<
    {
      id: string; company_id: string; generation_id: string; mime_type: string;
      storage_path: string; prompt: string;
    }[]
  >`
    select a.id, a.company_id, a.generation_id, a.mime_type, a.storage_path, g.prompt
      from media_generation_assets a
      join media_generations g on g.id = a.generation_id
     where a.storage_path not like 'companies/' || a.company_id || '/%'
     order by a.created_at
  `;

  return rows.map((row) => {
    const to = mediaStorageKey(row.company_id, row.generation_id, row.id, extensionFor(row.mime_type));
    return {
      what: `generated image "${row.prompt.slice(0, 40)}…"`,
      from: row.storage_path,
      to,
      contentType: row.mime_type,
      repoint: async () => {
        await admin`update media_generation_assets set storage_path = ${to} where id = ${row.id}`;
        // The generation carries the same path, so it moves with its asset.
        await admin`
          update media_generations
             set storage_path = ${to}
           where id = ${row.generation_id} and storage_path = ${row.storage_path}
        `;
      },
    };
  });
}

async function pdfPlan(): Promise<Move[]> {
  const rows = await admin<
    { id: string; file_id: string; company_id: string; page_number: number; image_path: string; name: string }[]
  >`
    select p.id, p.file_id, f.company_id, p.page_number, p.image_path, f.name
      from pdf_page_understanding p
      join drive_files f on f.id = p.file_id
     where p.image_path is not null
       and p.image_path not like 'companies/' || f.company_id || '/%'
     order by f.name, p.page_number
  `;

  return rows.map((row) => {
    const to = pdfPageKeyFor(row.company_id, row.file_id, row.id);
    return {
      what: `page ${row.page_number} of ${row.name}`,
      from: row.image_path,
      to,
      // Rendered pages are written as JPEG, which is what pdfPageKeyFor names.
      contentType: 'image/jpeg',
      repoint: async () => {
        await admin`update pdf_page_understanding set image_path = ${to} where id = ${row.id}`;
      },
    };
  });
}

async function main(): Promise<void> {
  const moves = [...(await drivePlan()), ...(await mediaPlan()), ...(await pdfPlan())];

  if (moves.length === 0) {
    console.log('\nEvery object is under its own company. Nothing to do.\n');
    return;
  }

  console.log(`\n${moves.length} object(s) sit under another company's prefix.\n`);
  for (const move of moves) {
    console.log(`  ${move.what}`);
    console.log(`    from ${move.from}`);
    console.log(`      to ${move.to}`);
  }

  if (!APPLY) {
    console.log('\nNothing was changed. Re-run with --apply to copy the bytes and repoint the rows.\n');
    return;
  }

  console.log('\nApplying…\n');
  let moved = 0;
  let missing = 0;
  let failed = 0;

  for (const move of moves) {
    let bytes: Buffer;
    try {
      bytes = await store.get(move.from);
    } catch {
      // The row is the only record this ever existed. Repointing it at an
      // empty key would erase that, so it is reported and left as it is.
      missing += 1;
      console.log(`  bytes already gone, left alone: ${move.what}`);
      continue;
    }

    try {
      await store.put(move.to, bytes, move.contentType);
      const check = await store.get(move.to);
      if (check.byteLength !== bytes.byteLength) {
        throw new Error(`copied ${bytes.byteLength} bytes, read back ${check.byteLength}`);
      }
      await move.repoint();
      moved += 1;
      console.log(`  moved: ${move.what}`);
    } catch (error) {
      failed += 1;
      console.log(`  FAILED: ${move.what} — ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.log(`\n${moved} moved, ${missing} already gone, ${failed} failed.`);
  console.log('The old objects are still there. `npm run storage:gc -- --delete` removes them.\n');
}

main()
  .then(async () => {
    await admin.end();
  })
  .catch(async (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    await admin.end();
    process.exitCode = 1;
  });
