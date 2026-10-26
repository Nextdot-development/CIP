/**
 * Brings a brand's pieces in from a Google Drive folder - bottles, logos,
 * finished posts - each read for what it is and filed by brand and kind.
 *
 *   npm run assets:import -- <company-slug> <google-folder-id> [--via <slug>] [--labels <file>] [--cache <dir>] [--apply]
 *
 * --labels is a JSON file of corrections a person made after looking at the
 * pictures, keyed by Google file id: { kind, brand, variant, tone } to set
 * what the file is, or { skip: "why" } to leave it out. --cache is a folder of
 * files already downloaded, named by their Google id.
 *
 * Without --apply it only lists what it would do. --via reads the folder
 * through another workspace's Google connection, while the company's own
 * needs reconnecting. A file brought in before is not brought in again.
 * Photoshop files, PDFs and archives are left: the layouts are read from the
 * Photoshop files separately.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import postgres from 'postgres';
import { brandFromPath, kindOf, readPicture, toneOf, variantFromName } from '../src/server/brain/brandAssets';
import type { BrandAsset } from '../src/server/brain/brandAssets';
import { setFileBrand } from '../src/server/brain/brands';
import { createFolder, uploadFile } from '../src/server/drive/service';
import { googleDrive } from '../src/server/integrations/googleDrive';
import { requireConnected } from '../src/server/integrations/googleDrive/connection';

const [slug, folderId] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const apply = process.argv.includes('--apply');
const viaAt = process.argv.indexOf('--via');
const via = viaAt > 0 ? process.argv[viaAt + 1] : slug;
const flag = (name: string) => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : null; };
type Label = { skip?: string; kind?: BrandAsset['kind']; brand?: string | null; variant?: string | null; tone?: BrandAsset['tone'] };
const labels: Record<string, Label> = flag('--labels') ? JSON.parse(readFileSync(flag('--labels')!, 'utf8')) : {};
const cacheDir = flag('--cache');
if (!slug || !folderId) {
  console.error('\n  npm run assets:import -- <company-slug> <google-folder-id> [--via <slug>] [--apply]\n');
  process.exit(1);
}

const IMAGE = /\.(png|jpe?g|webp)$/i;
/** Plenty for any post: a bottle placed at 3000 pixels tall is sharper than any feed. */
const MAX_EDGE = { bottle: 3000, logo: 2000, creative: 2400, other: 2400 } as const;
const FOLDER_FOR = { bottle: 'Bottles', logo: 'Logos', creative: 'Creatives', other: 'Other' } as const;

const sql = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1 });
const scopeOf = async (s: string) => {
  const [r] = await sql`select c.id as company_id, u.id as user_id from companies c join memberships m on m.company_id = c.id
    join users u on u.id = m.user_id where c.slug = ${s} order by m.created_at limit 1`;
  if (!r) throw new Error(`no company "${s}"`);
  return { companyId: r.company_id as string, userId: r.user_id as string, role: 'owner' as const };
};
const scope = await scopeOf(slug);
const reader = await scopeOf(via!);
const roster = (await sql`select name from company_brands where company_id = ${scope.companyId}`).map((r) => r.name as string);
const conn = await requireConnected(reader);
const api = googleDrive();

const files: { id: string; path: string; name: string; size: number | null }[] = [];
async function walk(id: string, path: string) {
  let token: string | null = null;
  do {
    const page = await api.listFolder(conn.accessToken, id, token);
    for (const f of page.files) {
      if (f.trashed) continue;
      if (f.mimeType === 'application/vnd.google-apps.folder') await walk(f.id, `${path}/${f.name.trim()}`);
      else if (IMAGE.test(f.name)) files.push({ id: f.id, path: `${path}/${f.name}`, name: f.name, size: f.size });
    }
    token = page.nextPageToken;
  } while (token);
}
await walk(folderId, '');

const known = new Set(
  (await sql`select metadata->>'googleFileId' as g from drive_files where company_id = ${scope.companyId} and metadata ? 'googleFileId'`)
    .map((r) => r.g as string),
);

/** Scaled evenly to fit, never cropped; transparency kept. */
async function fitted(bytes: Buffer, maxEdge: number): Promise<{ bytes: Buffer; mime: string; shrunk: boolean }> {
  const img = await loadImage(bytes);
  const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
  if (scale >= 1) return { bytes, mime: '', shrunk: false };
  const c = createCanvas(Math.round(img.width * scale), Math.round(img.height * scale));
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return { bytes: c.toBuffer('image/png'), mime: 'image/png', shrunk: true };
}

const folders = new Map<string, string | null>();
async function folderFor(...names: string[]): Promise<string | null> {
  let parent: string | null = null;
  for (const name of names) {
    const key: string = `${parent}/${name}`;
    if (!folders.has(key)) {
      const [found] = await sql`select id from drive_folders where company_id = ${scope.companyId} and name = ${name}
        and parent_id is not distinct from ${parent}::uuid limit 1`;
      folders.set(key, (found?.id as string) ?? (await createFolder(scope, parent, name)).id);
    }
    parent = folders.get(key)!;
  }
  return parent;
}

const seenChecksums = new Map<string, string>();
const counts: Record<string, number> = {};
for (const f of files) {
  if (known.has(f.id)) { console.log(`  had      ${f.path}`); continue; }
  const label = labels[f.id] ?? {};
  if (label.skip) { console.log(`  skip     ${f.path}  (${label.skip})`); continue; }
  const cached = cacheDir ? join(cacheDir, f.id) : null;
  const original = cached && existsSync(cached) ? readFileSync(cached) : await api.download(conn.accessToken, f.id, 200 * 1024 * 1024);
  const sum = (await import('node:crypto')).createHash('sha256').update(original).digest('hex');
  if (seenChecksums.has(sum)) { console.log(`  same as  ${seenChecksums.get(sum)}  <- ${f.path}`); continue; }
  seenChecksums.set(sum, f.path);

  const picture = await readPicture(original);
  const read = kindOf(f.name, picture);
  const kind = label.kind ?? read.kind;
  const cutout = read.cutout;
  // A person's word, where they gave one, over what the names suggest.
  const brand = 'brand' in label ? (label.brand && roster.includes(label.brand) ? label.brand : null) : brandFromPath(f.path, roster);
  const variant = 'variant' in label ? (label.variant ?? null) : kind === 'logo' ? null : variantFromName(f.name);
  const tone = kind === 'logo' ? (label.tone ?? toneOf(picture)) : null;
  counts[`${kind}${brand ? '' : ' (no brand)'}`] = (counts[`${kind}${brand ? '' : ' (no brand)'}`] ?? 0) + 1;
  console.log(
    `  ${kind.padEnd(8)} ${(brand ?? '-').padEnd(18)} ${(variant ?? tone ?? '').padEnd(20)} ${cutout ? 'cut-out' : 'opaque '} ` +
      `${picture.width}x${picture.height}  ${f.path}`,
  );
  if (!apply) continue;

  const fit = await fitted(original, MAX_EDGE[kind]);
  const stored = fit.shrunk ? await readPicture(fit.bytes) : picture;
  const asset: BrandAsset = { kind, brand, variant, tone, cutout, bbox: stored.bbox, width: stored.width, height: stored.height };
  const folder = await folderFor('Brand assets', brand ?? 'Unsorted', FOLDER_FOR[kind]);
  const filename = fit.shrunk ? f.name.replace(/\.[^.]+$/, '.png') : f.name;
  const file = await uploadFile(scope, {
    folderId: folder, filename, mimeType: fit.shrunk ? 'image/png' : (/\.png$/i.test(f.name) ? 'image/png' : 'image/jpeg'), body: fit.bytes,
  });
  await sql`update drive_files set metadata = coalesce(metadata, '{}'::jsonb) || ${sql.json({ asset, googleFileId: f.id, sourcePath: f.path } as never)},
    knowledge_role = 'brand' where id = ${file.id}`;
  if (brand) await setFileBrand(scope, file.id, brand);
}
console.log('\n ', JSON.stringify(counts), apply ? '- brought in.' : '- nothing written. Add --apply to bring them in.');
await sql.end();
process.exit(0);
