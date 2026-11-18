import 'server-only';
import { randomUUID, createHash } from 'node:crypto';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { withCompanyScope, type CompanyScope } from '../db';
import { readFile } from '../drive/service';
import { driveStorage, storageKeyFor } from '../drive/storage';
import { sanitiseFilename } from '@/lib/fileTypes';
import { cutPlainBackground, type Cutout } from './cutout';
import { MediaRejected } from './types';

/**
 * Pictures to lay on a post - a glass, ice, a garnish - kept in the company's Drive, in a
 * "Studio pictures" folder, so one brought once is there for every post after.
 *
 * Kept as reference, already processed: no model reads them, nothing is spent.
 */
export const STUDIO_FOLDER = 'Studio pictures';
export const STUDIO_PICTURE_MAX_BYTES = 15 * 1024 * 1024;
/** The longest side a picture is kept at: plenty for a glass on a post. */
const LONGEST = 1600;
const IMAGE_TYPES = ['png', 'jpg', 'jpeg', 'webp'];

export type StudioPicture = { file: string; name: string; aspect: number };
export type PictureChoice = { id: string; name: string; type: string; mine: boolean; brand: string | null; glass: boolean };

async function studioFolder(scope: CompanyScope): Promise<string> {
  return withCompanyScope(scope, async (tx) => {
    const [had] = await tx<{ id: string }[]>`
      select id from drive_folders
       where company_id = ${scope.companyId} and parent_id is null and lower(btrim(name)) = lower(${STUDIO_FOLDER}) and archived_at is null
    `;
    if (had) return had.id;
    // Made by someone else a moment ago, the name is taken: then it is that one.
    const [made] = await tx<{ id: string }[]>`
      insert into drive_folders (company_id, parent_id, name, created_by)
      values (${scope.companyId}, null, ${STUDIO_FOLDER}, ${scope.userId})
      on conflict do nothing
      returning id
    `;
    if (made) return made.id;
    const [now] = await tx<{ id: string }[]>`
      select id from drive_folders
       where company_id = ${scope.companyId} and parent_id is null and lower(btrim(name)) = lower(${STUDIO_FOLDER}) and archived_at is null
    `;
    if (!now) throw new MediaRejected('The studio pictures folder could not be made. Try again.');
    return now.id;
  });
}

/** The picture, no bigger than it needs to be, its plain ground taken off when asked. */
async function prepared(bytes: Buffer, cut: boolean): Promise<{ png: Buffer; plain: Buffer | null; aspect: number; outcome: Cutout['outcome'] | 'kept' }> {
  const img = await loadImage(bytes).catch(() => null);
  if (!img || !img.width || !img.height) throw new MediaRejected('That file is not a picture CIP can read. Bring a PNG, JPG or WebP.');
  const k = Math.min(1, LONGEST / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * k));
  const h = Math.max(1, Math.round(img.height * k));
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);
  let outcome: Cutout['outcome'] | 'kept' = 'kept';
  let plain: Buffer | null = null;
  if (cut) {
    // The picture as it came, kept beside the cut-out: what a brush brings back.
    plain = await canvas.encode('png');
    const data = ctx.getImageData(0, 0, w, h);
    const done = cutPlainBackground(data.data, w, h);
    outcome = done.outcome;
    if (done.outcome === 'cut') {
      data.data.set(done.pixels);
      ctx.putImageData(data, 0, 0);
    }
  }
  return { png: await canvas.encode('png'), plain: outcome === 'cut' ? plain : null, aspect: h / w, outcome };
}

/**
 * A prepared picture kept in the studio folder - or the one already there with the same bytes.
 * An original kept for a cut-out is marked so: it is not offered as a picture of its own.
 */
async function keepPicture(scope: CompanyScope, folder: string, png: Buffer, name: string, meta: Record<string, unknown>): Promise<{ id: string; name: string }> {
  const checksum = createHash('sha256').update(png).digest('hex');
  const [same] = await withCompanyScope(scope, (tx) => tx<{ id: string; name: string }[]>`
    select id, name from drive_files
     where company_id = ${scope.companyId} and folder_id = ${folder} and checksum_sha256 = ${checksum} and archived_at is null
     limit 1
  `);
  if (same) return same;
  const id = randomUUID();
  const base = sanitiseFilename(name).replace(/\.[a-z0-9]+$/i, '').slice(0, 80) || 'picture';
  const kept = `${base} ${id.slice(0, 6)}.png`;
  const key = storageKeyFor(scope.companyId, id, 'png');
  await withCompanyScope(scope, (tx) => tx`
    insert into drive_files (id, company_id, folder_id, name, original_filename, file_type, mime_type, file_size, checksum_sha256, storage_path,
                             uploaded_by, processing_status, processed_at, metadata, source_type, knowledge_role, knowledge_role_chosen)
    values (${id}, ${scope.companyId}, ${folder}, ${kept}, ${name}, 'png', 'image/png', ${png.byteLength}, ${checksum}, ${key},
            ${scope.userId}, 'processed', now(), ${tx.json({ ...meta, noModel: true } as never)},
            'cip_drive', 'reference', true)
  `);
  await driveStorage().put(key, png, 'image/png');
  return { id, name: kept };
}

/** The picture a cut-out was cut from, when it was kept: what the brush brings back. */
export async function originalOf(scope: CompanyScope, fileId: string): Promise<string | null> {
  if (!UUID.test(fileId)) return null;
  const [row] = await withCompanyScope(scope, (tx) => tx<{ original: string | null }[]>`
    select f.metadata->>'original' as original from drive_files f
     where f.id = ${fileId} and f.company_id = ${scope.companyId} and f.archived_at is null
       and exists (select 1 from drive_files o where o.id::text = f.metadata->>'original' and o.company_id = f.company_id and o.archived_at is null)
  `);
  return row?.original ?? null;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A picture made ready for posts: brought from the computer, or taken from Drive. One from Drive
 * is used as it is unless its ground is to come off - then a cut-out copy is kept beside the others.
 */
export async function addStudioPicture(
  scope: CompanyScope,
  from: { upload: { bytes: Buffer; filename: string } } | { fileId: string },
  cut: boolean,
  /** A cut-out touched up by hand keeps the picture it was first cut from, for the brush to bring back. */
  original?: string | null,
  /** What else to keep with it: a glass made for a brand says which, so it is offered again for nothing. */
  extra?: Record<string, unknown>,
): Promise<{ picture: StudioPicture; outcome: Cutout['outcome'] | 'kept' }> {
  if (scope.role === 'viewer') throw new MediaRejected('Viewers cannot add pictures.');
  let bytes: Buffer;
  let name: string;
  if ('fileId' in from) {
    const file = await readFile(scope, from.fileId).catch(() => null);
    if (!file || !IMAGE_TYPES.includes(file.file.fileType.toLowerCase())) throw new MediaRejected('Choose a picture from Drive - a PNG, JPG or WebP.');
    bytes = file.body;
    name = file.filename;
    // One already made ready here is used as it is; anything else from Drive - a 6000-pixel
    // photo, say - is copied at a size a post needs, the way it will be drawn on the post.
    if (!cut) {
      const [own] = await withCompanyScope(scope, (tx) => tx<{ id: string }[]>`
        select id from drive_files where id = ${from.fileId} and company_id = ${scope.companyId} and metadata->>'from' = 'studio-picture'
      `);
      if (own) {
        const img = await loadImage(bytes).catch(() => null);
        if (!img?.width) throw new MediaRejected('That picture could not be read.');
        return { picture: { file: from.fileId, name, aspect: img.height / img.width }, outcome: 'kept' };
      }
    }
  } else {
    if (from.upload.bytes.byteLength > STUDIO_PICTURE_MAX_BYTES) throw new MediaRejected('That picture is over 15 MB. Bring a smaller one.');
    bytes = from.upload.bytes;
    name = from.upload.filename;
  }

  const ready = await prepared(bytes, cut);
  const folder = await studioFolder(scope);
  // Carried forward only when it is one of this company's kept originals.
  const carried = original && UUID.test(original)
    ? (await withCompanyScope(scope, (tx) => tx<{ id: string }[]>`
        select id from drive_files where id = ${original} and company_id = ${scope.companyId} and metadata->>'from' = 'studio-picture-original' and archived_at is null
      `))[0]?.id ?? null
    : null;
  const plain = ready.plain ? await keepPicture(scope, folder, ready.plain, `${name} (original)`, { from: 'studio-picture-original' }) : null;
  const kept = await keepPicture(scope, folder, ready.png, ready.outcome === 'cut' ? `${name.replace(/\.[a-z0-9]+$/i, '')} (cut out)` : name, {
    from: 'studio-picture', cut: ready.outcome === 'cut', ...((plain?.id ?? carried) ? { original: plain?.id ?? carried } : {}), ...(extra ?? {}),
  });
  return { picture: { file: kept.id, name: kept.name, aspect: ready.aspect }, outcome: ready.outcome };
}

/**
 * What can be laid on a post: the company's studio pictures first, newest first - then, when
 * looked for by name, pictures elsewhere in Drive, cut-outs (PNG) before photographs.
 */
export async function studioPictureChoices(scope: CompanyScope, query: string | null, brand: string | null = null): Promise<PictureChoice[]> {
  const q = query?.trim().slice(0, 60) ?? '';
  const forBrand = brand?.trim().slice(0, 80) || '';
  return withCompanyScope(scope, async (tx) => {
    // The post's own brand first, its glasses before anything else; then the newest.
    const mine = await tx<{ id: string; name: string; file_type: string; brand: string | null; glass: boolean }[]>`
      select f.id, f.name, f.file_type, coalesce(f.metadata->>'brand', f.brand) as brand, (f.metadata->>'made' = 'glass') is true as glass from drive_files f
        join drive_folders d on d.id = f.folder_id and d.company_id = f.company_id
       where f.company_id = ${scope.companyId} and f.archived_at is null and lower(btrim(d.name)) = lower(${STUDIO_FOLDER}) and d.parent_id is null and d.archived_at is null
         and coalesce(f.metadata->>'from', '') <> 'studio-picture-original'
         and (${q} = '' or f.name ilike ${'%' + q + '%'})
       order by (${forBrand} <> '' and lower(coalesce(f.metadata->>'brand', f.brand, '')) = lower(${forBrand})) desc,
                (f.metadata->>'made' = 'glass') is true desc, f.created_at desc
       limit 40
    `;
    const drive = q
      ? await tx<{ id: string; name: string; file_type: string; brand: string | null }[]>`
          select id, name, file_type, brand from drive_files
           where company_id = ${scope.companyId} and archived_at is null and lower(file_type) = any(${IMAGE_TYPES})
             and name ilike ${'%' + q + '%'} and not (id = any(${mine.map((m) => m.id)}::uuid[]))
             and coalesce(metadata->>'from', '') <> 'studio-picture-original'
           order by (lower(file_type) = 'png') desc, updated_at desc limit 36
        `
      : [];
    return [
      ...mine.map((f) => ({ id: f.id, name: f.name, type: f.file_type, mine: true, brand: f.brand, glass: f.glass })),
      ...drive.map((f) => ({ id: f.id, name: f.name, type: f.file_type, mine: false, brand: f.brand, glass: false })),
    ];
  });
}

/**
 * A brand's glasses, filed like its bottles and logos: a picture kept as its glass in the studio, one
 * its library files as a glass, or a picture in Drive under the brand whose name says it is one.
 */
export async function brandGlasses(scope: CompanyScope, brand: string): Promise<{ id: string; name: string }[]> {
  return withCompanyScope(scope, (tx) => tx<{ id: string; name: string }[]>`
    select id, name from drive_files
     where company_id = ${scope.companyId} and archived_at is null and lower(file_type) = any(${IMAGE_TYPES})
       and coalesce(metadata->>'from', '') <> 'studio-picture-original'
       and (
         (metadata->>'made' = 'glass' and lower(metadata->>'brand') = lower(${brand}))
         or (metadata->'asset'->>'kind' = 'glass' and lower(metadata->'asset'->>'brand') = lower(${brand}))
         -- A cut-out in Drive named as a glass - never a finished post that only mentions one.
         or (lower(coalesce(brand, '')) = lower(${brand}) and lower(file_type) = 'png'
             and name ~* '(glass|tumbler|highball|snifter)' and name !~* '(poster|static|motion|banner|post|story|reel)')
       )
     order by (metadata->>'seeThrough' = 'true') is true desc, updated_at desc
     limit 12
  `);
}

/** A picture kept as a brand's glass, offered beside every post of that brand from now on. Free. */
export async function keepAsBrandGlass(scope: CompanyScope, fileId: string, brand: string): Promise<boolean> {
  if (scope.role === 'viewer') throw new MediaRejected('Viewers cannot file pictures.');
  if (!UUID.test(fileId)) return false;
  const name = brand.trim().slice(0, 80);
  if (!name) throw new MediaRejected('Say which brand it is the glass of.');
  const rows = await withCompanyScope(scope, (tx) => tx`
    update drive_files set metadata = metadata || ${tx.json({ made: 'glass', brand: name } as never)}, updated_at = now()
     where id = ${fileId} and company_id = ${scope.companyId} and archived_at is null and lower(file_type) = any(${IMAGE_TYPES})
    returning id
  `);
  return rows.length > 0;
}

/** A studio picture taken away - only one the studio kept; it stays restorable from Drive's archive. */
export async function removeStudioPicture(scope: CompanyScope, fileId: string): Promise<boolean> {
  if (scope.role === 'viewer') throw new MediaRejected('Viewers cannot remove pictures.');
  if (!UUID.test(fileId)) return false;
  const rows = await withCompanyScope(scope, (tx) => tx`
    update drive_files set archived_at = now(), updated_at = now()
     where id = ${fileId} and company_id = ${scope.companyId} and archived_at is null
       and coalesce(metadata->>'from', '') = 'studio-picture'
    returning id
  `);
  return rows.length > 0;
}
