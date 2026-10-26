import 'server-only';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { withCompanyScope } from '../db';
import type { CompanyScope } from '../db';

/**
 * A brand's own pieces, as a designer keeps them: the bottles cut out on
 * transparent ground, the logo in its light and dark versions, and finished
 * posts to learn the look from.
 *
 * What a file is, is read from the picture itself - a bottle is a tall thing
 * standing alone on transparency, a logo a small mark, a post fills its frame
 * - and its brand and variant from where it was filed and what it is called.
 * A generated post uses these as they are: the bottle exactly as designed,
 * scaled evenly and never redrawn.
 */

export type AssetKind = 'bottle' | 'logo' | 'creative' | 'other';
export type LogoTone = 'light' | 'dark' | 'colour';

export type BrandAsset = {
  kind: AssetKind;
  brand: string | null;
  /** A flavour, size or edition, as named: "Chocolate", "Honey", "1L". */
  variant: string | null;
  /** For a logo: white (for dark grounds), dark (for light grounds) or in colour. */
  tone: LogoTone | null;
  /** Stands alone on transparency, ready to place. */
  cutout: boolean;
  /** Where the thing itself sits in the file, in fractions: [x, y, w, h]. */
  bbox: [number, number, number, number];
  width: number;
  height: number;
};

/** What a picture is, read from its pixels. */
export async function readPicture(bytes: Buffer): Promise<{
  width: number; height: number; transparent: number; bbox: [number, number, number, number]; luminance: number; saturation: number;
}> {
  const img = await loadImage(bytes);
  const scale = Math.min(1, 400 / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);
  let clear = 0;
  let x0 = w; let y0 = h; let x1 = -1; let y1 = -1;
  let lum = 0; let sat = 0; let solid = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const a = data[i + 3]!;
      if (a < 16) { clear += 1; continue; }
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (a > 200) {
        const r = data[i]! / 255; const g = data[i + 1]! / 255; const b = data[i + 2]! / 255;
        lum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
        sat += Math.max(r, g, b) - Math.min(r, g, b);
        solid += 1;
      }
    }
  }
  const bbox: [number, number, number, number] = x1 < 0 ? [0, 0, 1, 1] : [x0 / w, y0 / h, (x1 - x0 + 1) / w, (y1 - y0 + 1) / h];
  return {
    width: img.width, height: img.height, transparent: clear / (w * h), bbox,
    luminance: solid ? lum / solid : 0, saturation: solid ? sat / solid : 0,
  };
}

/** The roster's names, as they are written in folders and files. */
const BRAND_WORDS: [RegExp, string][] = [
  [/magic\s*moments|\bmm\b|\bmm[ _-]/i, 'Magic Moments'],
  [/\b8\s*pm\b|8pm/i, '8PM'],
  [/whyte\s*hall|whythall|whtehall|whytehall/i, 'Whytehall'],
  [/royal\s*ranthambore|ranth?ombore|\brr\b|rr-logo/i, 'Royal Ranthambore'],
  [/rampur|asava/i, 'Rampur'],
  [/morpheus|marpheus/i, 'Morpheus'],
  [/afri\s*-?\s*bull/i, 'Afri Bull'],
  [/jaisalmer/i, 'Jaisalmer'],
  [/sangam/i, 'Sangam'],
  [/kohinoor/i, 'Kohinoor Reserve'],
];

/** Flavours, editions and sizes, as the files name them. */
const VARIANTS: [RegExp, string][] = [
  [/chocolate|choc\b/i, 'Chocolate'], [/lemongrass/i, 'Lemongrass & Ginger'], [/green\s*apple|greenapple/i, 'Green Apple'],
  [/raspberry/i, 'Raspberry'], [/orange/i, 'Orange'], [/\blemon\b/i, 'Lemon'], [/plain/i, 'Plain'],
  [/honey/i, 'Honey'], [/\bfire\b/i, 'Fire'], [/royal(?!\s*ranth)/i, 'Royal'], [/select/i, 'Select'],
  [/\bdc\b|double\s*cask/i, 'Double Cask'], [/asava/i, 'Asava'], [/master'?s?\s*reserve/i, "Master's Reserve"],
  [/pocket/i, 'Pocket Pack'], [/hipster/i, 'Hipster Pack'], [/\bmini\b/i, 'Mini'], [/\b1\s*l\b|1l\b/i, '1L'], [/750\s*ml/i, '750ml'],
  [/blue\s*vodka|^blue\b/i, 'Blue'], [/white\s*vodka/i, 'White'],
];

/** Brand, by the file's own name first and then the folders it sits in. */
export function brandFromPath(path: string, roster: readonly string[]): string | null {
  const parts = path.split('/').filter(Boolean).reverse();
  for (const part of parts) {
    for (const [re, brand] of BRAND_WORDS) if (re.test(part) && roster.includes(brand)) return brand;
  }
  return null;
}

export function variantFromName(name: string): string | null {
  const base = name.replace(/\.[^.]+$/, '');
  for (const [re, variant] of VARIANTS) if (re.test(base)) return variant;
  return null;
}

/**
 * What a file is. Its name is believed when it says so ("logo", "bottle",
 * "packshot"); otherwise the picture decides: on transparency, a tall thing
 * is a bottle and anything else a logo; a picture that fills its frame is a
 * finished post.
 */
export function kindOf(name: string, picture: Awaited<ReturnType<typeof readPicture>>): { kind: AssetKind; cutout: boolean } {
  const cutout = picture.transparent > 0.12;
  const [, , bw, bh] = picture.bbox;
  const tall = (bh * picture.height) / Math.max(1, bw * picture.width);
  if (/logo|wordmark|emblem/i.test(name)) return { kind: 'logo', cutout };
  if (cutout && /bottle|packshot|pack\b|render|png cut/i.test(name)) return { kind: 'bottle', cutout };
  if (cutout) return { kind: tall >= 1.6 ? 'bottle' : 'logo', cutout };
  if (/bottle|packshot/i.test(name)) return { kind: 'bottle', cutout: false };
  return { kind: 'creative', cutout: false };
}

export function toneOf(picture: Awaited<ReturnType<typeof readPicture>>): LogoTone {
  if (picture.saturation > 0.25) return 'colour';
  if (picture.luminance > 0.7) return 'light';
  if (picture.luminance < 0.35) return 'dark';
  return 'colour';
}

/**
 * The brand's pieces of one kind, best first: a cut-out before a photograph,
 * the variant asked for before the rest.
 */
export async function brandAssets(
  scope: CompanyScope,
  options: { brand: string; kind: AssetKind; variant?: string | null; tone?: LogoTone | null },
): Promise<{ fileId: string; name: string; asset: BrandAsset }[]> {
  const rows = await withCompanyScope(scope, (tx) => tx<{ id: string; name: string; asset: BrandAsset }[]>`
    select id, name, metadata->'asset' as asset from drive_files
     where company_id = ${scope.companyId} and archived_at is null and bytes_retained
       and metadata->'asset'->>'kind' = ${options.kind}
       and metadata->'asset'->>'brand' = ${options.brand}
  `);
  const wanted = options.variant?.toLowerCase() ?? null;
  return rows
    .map((r) => ({ fileId: r.id, name: r.name, asset: r.asset }))
    .sort((a, b) => score(b) - score(a));
  function score(x: { asset: BrandAsset }) {
    let s = 0;
    if (x.asset.cutout) s += 4;
    if (wanted && x.asset.variant?.toLowerCase() === wanted) s += 8;
    // Nothing asked for: the standard pack, not an edition or a range shot.
    if (!wanted && !x.asset.variant) s += 3;
    if (options.tone && x.asset.tone === options.tone) s += 6;
    s += Math.min(2, (x.asset.width * x.asset.height) / 4e6);
    return s;
  }
}
