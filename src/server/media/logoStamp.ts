import 'server-only';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { withCompanyScope } from '../db';
import type { CompanyScope } from '../db';
import { driveStorage } from '../drive/storage';

/**
 * The brand's own logo, put on a picture CIP made.
 *
 * An image model asked for a logo draws its impression of one - near enough to
 * recognise, never right. The approved file is placed instead, after the
 * picture is made, where Radico's rule puts it on an image: the top-right
 * corner (RADICO-GLOBAL-002-IMG). The generator is told to leave that corner
 * clear and draw no logo of its own.
 *
 * Which file: a logo in the Drive tagged with the brand, or named after it.
 * Which version: the one that stands out against the corner it lands on - a
 * white logo on a dark corner, a dark one on a light corner.
 */

/** How wide the logo sits, as a share of the picture's width, and how far in from the edges. */
const LOGO_WIDTH = 0.18;
const MARGIN = 0.045;

type LogoFile = { id: string; name: string; storagePath: string; mimeType: string };

/** The brand's logo files, best candidates first. Empty when it has none. */
export async function brandLogos(scope: CompanyScope, brand: string): Promise<LogoFile[]> {
  return withCompanyScope(scope, async (tx) => {
    const [known] = await tx<{ aliases: string[] | null }[]>`
      select aliases from company_brands where company_id = ${scope.companyId} and lower(name) = lower(${brand})
    `;
    // "Magic Moments" also matches magic-moments-logo.png and magic_moments_logo.png.
    const names = [brand, ...(known?.aliases ?? [])]
      .map((n) => n.toLowerCase().replace(/[^a-z0-9]+/g, '%'))
      .filter((n) => n.length >= 2);
    const rows = await tx<{ id: string; name: string; storage_path: string; mime_type: string; tagged: boolean }[]>`
      select id, name, storage_path, mime_type, (lower(brand) = lower(${brand})) as tagged
        from drive_files
       where company_id = ${scope.companyId}
         and archived_at is null and bytes_retained and storage_path is not null
         and mime_type in ('image/png', 'image/webp', 'image/jpeg')
         and name ~* '(logo|lockup|wordmark)'
         and (lower(brand) = lower(${brand})
              or exists (select 1 from unnest(${names}::text[]) n where lower(name) like '%' || n || '%'))
       -- A tagged file before a matching name, a PNG (which can be transparent) before a JPEG.
       order by (lower(brand) = lower(${brand})) desc nulls last, (mime_type = 'image/png') desc, updated_at desc
       limit 6
    `;
    return rows.map((r) => ({ id: r.id, name: r.name, storagePath: r.storage_path, mimeType: r.mime_type }));
  });
}

/** Mean brightness, 0 (black) to 1 (white), of the opaque pixels in a region. */
function brightness(data: Uint8ClampedArray): number {
  let sum = 0;
  let weight = 0;
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3]! / 255;
    if (alpha < 0.2) continue;
    sum += alpha * (0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!) / 255;
    weight += alpha;
  }
  return weight === 0 ? 0.5 : sum / weight;
}

export type StampOutcome =
  | { status: 'stamped'; logo: string }
  | { status: 'no_logo' }
  | { status: 'unreadable'; reason: string };

/**
 * Places the brand's logo in the top-right corner. Returns the picture
 * unchanged, and says why, when there is no logo to place: this step makes a
 * result better and must never remove one.
 */
export async function stampLogo(
  scope: CompanyScope,
  brand: string,
  image: { bytes: Buffer; mimeType: string },
): Promise<{ bytes: Buffer; mimeType: string; outcome: StampOutcome }> {
  const unchanged = (outcome: StampOutcome) => ({ bytes: image.bytes, mimeType: image.mimeType, outcome });
  const files = await brandLogos(scope, brand).catch(() => []);
  if (files.length === 0) return unchanged({ status: 'no_logo' });

  try {
    const picture = await loadImage(image.bytes);
    const width = picture.width;
    const height = picture.height;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(picture, 0, 0);

    const logoWidth = Math.round(width * LOGO_WIDTH);
    const margin = Math.round(Math.min(width, height) * MARGIN);
    const corner = ctx.getImageData(width - logoWidth - margin, margin, logoWidth, Math.max(1, Math.round(logoWidth * 0.6)));
    const cornerBrightness = brightness(corner.data);

    // Every readable version, scored by how far its brightness is from the corner's.
    const versions: { name: string; logo: Awaited<ReturnType<typeof loadImage>>; contrast: number }[] = [];
    let lastError = '';
    for (const file of files) {
      try {
        const logo = await loadImage(await driveStorage().get(file.storagePath));
        const probe = createCanvas(logo.width, logo.height).getContext('2d');
        probe.drawImage(logo, 0, 0);
        const own = brightness(probe.getImageData(0, 0, logo.width, logo.height).data);
        versions.push({ name: file.name, logo, contrast: Math.abs(own - cornerBrightness) });
      } catch (error) {
        lastError = error instanceof Error ? error.message : 'could not be read';
      }
    }
    if (versions.length === 0) return unchanged({ status: 'unreadable', reason: lastError.slice(0, 160) });

    const best = versions.sort((a, b) => b.contrast - a.contrast)[0]!;
    const logoHeight = Math.round((best.logo.height / best.logo.width) * logoWidth);
    ctx.drawImage(best.logo, width - logoWidth - margin, margin, logoWidth, logoHeight);

    return { bytes: canvas.toBuffer('image/png'), mimeType: 'image/png', outcome: { status: 'stamped', logo: best.name } };
  } catch (error) {
    return unchanged({ status: 'unreadable', reason: error instanceof Error ? error.message.slice(0, 160) : 'unknown' });
  }
}
