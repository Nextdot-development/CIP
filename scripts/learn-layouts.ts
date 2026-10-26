/**
 * Learns a brand's layouts from its designers' Photoshop files in a Google
 * Drive folder: the logo, the bottle and the words of each post, as numbers.
 *
 *   npm run layouts:learn -- <company-slug> <google-folder-id> [--via <slug>] [--cache <dir>] [--apply]
 *
 * Without --apply it prints what it learned from each file and writes nothing.
 * A file of a single bottle or logo has no layout and is passed over.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { initializeCanvas, readPsd } from 'ag-psd';
import postgres from 'postgres';
import { brandFromPath } from '../src/server/brain/brandAssets';
import { learnLayout, saveLayout } from '../src/server/brain/layouts';
import type { LayoutSpec } from '../src/server/brain/layouts';
import { googleDrive } from '../src/server/integrations/googleDrive';
import { requireConnected } from '../src/server/integrations/googleDrive/connection';

initializeCanvas((w, h) => createCanvas(w, h) as unknown as HTMLCanvasElement);

const [slug, folderId] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const flag = (name: string) => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : null; };
const apply = process.argv.includes('--apply');
if (!slug || !folderId) {
  console.error('\n  npm run layouts:learn -- <company-slug> <google-folder-id> [--via <slug>] [--cache <dir>] [--apply]\n');
  process.exit(1);
}

const sql = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1 });
const scopeOf = async (s: string) => {
  const [r] = await sql`select c.id as company_id, u.id as user_id from companies c join memberships m on m.company_id = c.id
    join users u on u.id = m.user_id where c.slug = ${s} order by m.created_at limit 1`;
  if (!r) throw new Error(`no company "${s}"`);
  return { companyId: r.company_id as string, userId: r.user_id as string, role: 'owner' as const };
};
const scope = await scopeOf(slug);
const conn = await requireConnected(await scopeOf(flag('--via') ?? slug));
const roster = (await sql`select name from company_brands where company_id = ${scope.companyId}`).map((r) => r.name as string);
// The brand's own pieces, by name: a layer called "Untitled design (4)" is the
// Whytehall Chocolate logo because that is what the library holds under that name.
const pieces = new Map<string, { kind: 'bottle' | 'logo' | 'creative' | 'other'; brand: string | null }>();
for (const r of await sql`select name, metadata->'asset' as asset from drive_files
    where company_id = ${scope.companyId} and metadata ? 'asset' and archived_at is null`) {
  pieces.set(String(r.name).replace(/\.[^.]+$/, '').trim().toLowerCase(), { kind: r.asset.kind, brand: r.asset.brand ?? null });
}
const known = (layer: string) => pieces.get(layer.replace(/\s+copy(\s*\d+)?$/i, '').trim().toLowerCase()) ?? null;
await sql.end();
const api = googleDrive();
const cacheDir = flag('--cache');

const psds: { id: string; path: string }[] = [];
async function walk(id: string, path: string) {
  let token: string | null = null;
  do {
    const page = await api.listFolder(conn.accessToken, id, token);
    for (const f of page.files) {
      if (f.trashed) continue;
      if (f.mimeType === 'application/vnd.google-apps.folder') await walk(f.id, `${path}/${f.name.trim()}`);
      else if (/\.ps[db]$/i.test(f.name)) psds.push({ id: f.id, path: `${path}/${f.name}` });
    }
    token = page.nextPageToken;
  } while (token);
}
await walk(folderId, '');

// A bottle layer is usually named for the bottle or its brand.
const BOTTLE = /bottle|pack|8\s*pm|whyt|whtehall|gold|rampur|morph|marph|ranth|afri|magic|jaisalmer|sangam|kohinoor/i;
const names = (layers: { name?: string; children?: unknown[] }[] = []): string[] =>
  layers.flatMap((l) => [l.name ?? '', ...names((l.children ?? []) as { name?: string }[])]);
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

for (const f of psds) {
  const cached = cacheDir ? join(cacheDir, f.id) : null;
  const bytes = cached && existsSync(cached) ? readFileSync(cached) : await api.download(conn.accessToken, f.id, 400 * 1024 * 1024);
  const psd = readPsd(new Uint8Array(bytes), { skipLayerImageData: true, skipCompositeImageData: true, skipThumbnail: true });
  const spec: LayoutSpec | null = learnLayout(psd as never, BOTTLE, known);
  const name = f.path.split('/').pop()!.replace(/\.ps[db]$/i, '');
  if (!spec) { console.log(`\n  ${name}: no layout (a single picture)`); continue; }
  // The brand: the file's name first, then the library pieces it is built from,
  // then what its layers are called.
  const fromPieces = names(psd.children as never).map((n) => known(n)?.brand).find((b): b is string => Boolean(b)) ?? null;
  const brand = brandFromPath(f.path, roster) ?? fromPieces ?? brandFromPath(`/${names(psd.children as never).join('/')}`, roster);
  console.log(`\n  ${name}  ${psd.width}x${psd.height}  brand=${brand ?? '-'}`);
  if (spec.logo) console.log(`    logo    ${spec.logo.corner}, ${pct(spec.logo.width)} wide, ${pct(spec.logo.insetX)} in, ${pct(spec.logo.insetY)} down`);
  if (spec.bottle) console.log(`    bottle  centre ${pct(spec.bottle.cx)} across, stands at ${pct(spec.bottle.base)}, ${pct(spec.bottle.height)} tall`);
  if (spec.text) {
    console.log(`    words   at ${pct(spec.text.x)} across, ${pct(spec.text.y)} down, ${pct(spec.text.width)} wide, ${spec.text.align}, leading ${spec.text.leading.toFixed(2)}, ink ${spec.text.ink}, accent ${spec.text.accent ?? '-'}`);
    for (const l of spec.text.lines) {
      console.log(`      ${l.role.padEnd(5)} ${pct(l.size)} ${l.font ?? '(face not recorded)'} ${l.weight}${l.italic ? ' italic' : ''}${l.script ? ' script' : ''}${l.upper ? ' CAPS' : ''}${l.accent ? ' accent' : ''}${l.box ? ` box ${l.box}` : ''}`);
    }
  }
  if (apply) await saveLayout(scope, { brand, name, source: f.path, spec });
}
console.log(apply ? '\n  Saved.' : '\n  Nothing written. Add --apply to keep them.');
process.exit(0);
