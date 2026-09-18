import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import postgres from 'postgres';
import { createFolder, uploadFile } from '../src/server/drive/service';
import { registerSource } from '../src/server/brain/market';
import type { CompanyScope } from '../src/server/db';

/**
 * Loads a folder of market reports as market intelligence, not brand material.
 *
 *   npm run ingest:market -- <company-slug> <folder> [--reference "<name>" ...] [--dry]
 *
 * Every file under <folder> goes into the company's Drive under
 * "Market Intelligence", keeping its subfolders, and is registered as a market
 * source. The worker then extracts its text, reads it into signals that quote
 * the report, and embeds it for search and for Chat. None of it reaches Brand
 * DNA: a competitor's annual report is not what this brand looks or sounds like.
 *
 * --reference names files or subfolders that are background reading rather than
 * market data - a book on how brands grow. Those go under "Reference": searchable
 * and citable, and read into neither market signals nor Brand DNA.
 *
 * --dry lists what would happen and changes nothing. Safe to run twice: a file
 * already in its target folder under the same name is skipped.
 */

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { ssl: 'require', max: 1, onnotice: () => {} });

const MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.csv': 'text/csv',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

function args() {
  const argv = process.argv.slice(2);
  const positional: string[] = [];
  const reference: string[] = [];
  let dry = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--reference') reference.push((argv[++i] ?? '').toLowerCase());
    else if (argv[i] === '--dry') dry = true;
    else positional.push(argv[i]!);
  }
  return { slug: positional[0], folder: positional[1], reference: reference.filter(Boolean), dry };
}

function walk(root: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    if (statSync(path).isDirectory()) found.push(...walk(path));
    else if (MIME[extname(name).toLowerCase()]) found.push(path);
  }
  return found.sort();
}

async function main(): Promise<void> {
  const { slug, folder, reference, dry } = args();
  if (!slug || !folder) {
    console.error('\n  npm run ingest:market -- <company-slug> <folder> [--reference "<name>" ...] [--dry]\n');
    process.exit(1);
  }

  const [row] = await admin<{ company_id: string; user_id: string; name: string }[]>`
    select c.id as company_id, u.id as user_id, c.name
      from companies c
      join memberships m on m.company_id = c.id
      join users u on u.id = m.user_id
     where c.slug = ${slug}
     order by m.role
     limit 1
  `;
  if (!row) throw new Error(`no company with slug "${slug}"`);
  const scope: CompanyScope = { companyId: row.company_id, userId: row.user_id, role: 'owner' };

  /** A folder by path under the Drive root, made if it is not there. */
  const folders = new Map<string, string>();
  async function ensureFolder(path: string[]): Promise<string> {
    let parent: string | null = null;
    for (let depth = 0; depth < path.length; depth += 1) {
      const key = path.slice(0, depth + 1).join('/').toLowerCase();
      const known = folders.get(key);
      if (known) {
        parent = known;
        continue;
      }
      const name = path[depth]!;
      const [existing] = await admin<{ id: string }[]>`
        select id from drive_folders
         where company_id = ${scope.companyId} and archived_at is null
           and parent_id is not distinct from ${parent}::uuid and lower(name) = lower(${name})
         limit 1
      `;
      const id: string = existing?.id ?? (await createFolder(scope, parent, name)).id;
      folders.set(key, id);
      parent = id;
    }
    return parent!;
  }

  const files = walk(folder);
  console.log(`\n${row.name}: ${files.length} file(s) under ${folder}${dry ? ' (dry run)' : ''}\n`);

  let uploaded = 0;
  let skipped = 0;
  let failed = 0;

  for (const path of files) {
    const segments = relative(folder, path).split(sep);
    const filename = segments.pop()!;
    const isReference = [...segments, filename].some((part) => reference.includes(part.toLowerCase()));
    const target = [isReference ? 'Reference' : 'Market Intelligence', ...segments];
    const label = `${target.join(' / ')} / ${filename}`;

    if (dry) {
      console.log(`  ${isReference ? 'reference' : 'market   '}  ${label}`);
      continue;
    }

    try {
      const folderId = await ensureFolder(target);
      const [already] = await admin<{ id: string }[]>`
        select id from drive_files
         where company_id = ${scope.companyId} and folder_id = ${folderId} and archived_at is null
           and (name = ${filename} or original_filename = ${filename})
         limit 1
      `;
      if (already) {
        skipped += 1;
        console.log(`  skip      ${label} (already there)`);
        continue;
      }

      const file = await uploadFile(scope, {
        folderId,
        filename,
        mimeType: MIME[extname(filename).toLowerCase()] ?? null,
        body: readFileSync(path),
      });

      if (isReference) {
        await admin`
          update drive_files set knowledge_role = 'reference', updated_at = now()
           where id = ${file.id} and company_id = ${scope.companyId}
        `;
        await admin`
          delete from asset_understanding
           where company_id = ${scope.companyId} and file_id = ${file.id} and status = 'pending'
        `;
      } else {
        await registerSource(scope, file.id);
      }
      uploaded += 1;
      console.log(`  ${isReference ? 'reference' : 'market   '}  ${label}`);
    } catch (error) {
      failed += 1;
      console.log(`  FAILED    ${label}: ${error instanceof Error ? error.message.slice(0, 160) : 'upload failed'}`);
    }
  }

  if (!dry) {
    console.log(`\n${uploaded} added, ${skipped} already there, ${failed} failed.`);
    console.log('The worker reads them next: `npm run cip:worker` (or leave `-- --watch` running).\n');
  }
}

main()
  .then(async () => {
    await admin.end();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error(error instanceof Error ? error.message : error);
    await admin.end({ timeout: 1 });
    process.exit(1);
  });
