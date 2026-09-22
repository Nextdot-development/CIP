import 'server-only';
import type { AssetAnalysis } from './providers/types';

/**
 * The colours an asset is actually made of, read off its pixels.
 *
 * The Brain used to be asked for these. The prompt told it that `paletteHex`
 * "holds actual hex values read off the picture ... and is empty if you cannot
 * read them rather than approximated", and a vision model, correctly, can never
 * read a hex value off a picture by eye. So it always chose the honest answer:
 * across the first 195 assets CIP understood, `paletteHex` came back empty 195
 * times. The field existed, the schema required it, nothing ever filled it, and
 * "what is Whytehall Honey's gold?" had no answer.
 *
 * Asking harder would only have bought invented values. A colour is not a
 * judgement — it is in the file — so it is measured here instead, and the model
 * is left to do the part that genuinely needs looking: what the colours mean.
 *
 * What comes back is ordered by how much of the asset each colour covers, most
 * prominent first, as lowercase `#rrggbb`.
 */

/** How the palette is read. Every number here is a judgement worth stating. */
const PALETTE = {
  /**
   * The long edge the image is sampled at.
   *
   * Full resolution answers the same question a great deal slower: a 4000px
   * packshot has sixteen million pixels and about eight distinct colours. 160
   * keeps every region that covers a percent of the canvas while costing a
   * few milliseconds.
   */
  sampleEdge: 160,
  /**
   * Bits kept per channel when bucketing, so 5 bits is 32 levels a channel.
   *
   * Photographs have no flat colour in them at all: a gold cap spans hundreds
   * of neighbouring values, and counting exact triples returns hundreds of
   * buckets of one pixel each. Coarser than this and a brand's red and its
   * orange land in the same bucket.
   */
  bits: 5,
  /**
   * How far apart two returned colours must be, as squared RGB distance.
   *
   * Without it the answer for a photograph is six shades of the same brown.
   * 48 apart per channel is comfortably a different colour to the eye.
   */
  minDistanceSq: 48 * 48 * 3,
  /** A colour covering less than this share of the asset is noise, not palette. */
  minShare: 0.02,
  /** Pixels more transparent than this are not part of the picture. */
  minAlpha: 128,
  /** At most this many colours come back. */
  max: 6,
} as const;

/** What one measured colour is, and how much of the asset it covers. */
export type PaletteEntry = {
  /** Lowercase `#rrggbb`. */
  hex: string;
  /** Share of the opaque pixels this colour covers, 0 to 1. */
  share: number;
};

function hex(r: number, g: number, b: number): string {
  const part = (n: number): string => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${part(r)}${part(g)}${part(b)}`;
}

/**
 * Reads the dominant colours of an image.
 *
 * Never throws. A palette is an enrichment: an asset whose colours could not be
 * measured is still an asset the Brain has read, and failing the whole
 * understanding over a decode would lose the description too. Anything that
 * goes wrong returns an empty palette, which is exactly what the field meant
 * before this existed.
 */
export async function readPalette(bytes: Buffer, mimeType: string): Promise<PaletteEntry[]> {
  const type = mimeType.toLowerCase();
  if (!/^image\/(png|jpe?g|webp|gif)$/.test(type)) return [];

  try {
    const { createCanvas, loadImage } = await import('@napi-rs/canvas');
    const image = await loadImage(bytes);
    if (!image.width || !image.height) return [];

    const scale = Math.min(1, PALETTE.sampleEdge / Math.max(image.width, image.height));
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0, width, height);
    const { data } = ctx.getImageData(0, 0, width, height);

    // Each bucket keeps the running sum of the pixels that fell in it, so the
    // colour returned is their average rather than the corner of the bucket.
    // The difference is visible: a gold that averages #c9a227 is reported as
    // that, not as the #c0a020 the bucket starts at.
    const buckets = new Map<number, { r: number; g: number; b: number; n: number }>();
    const shift = 8 - PALETTE.bits;
    let opaque = 0;

    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3]!;
      if (a < PALETTE.minAlpha) continue;
      const r = data[i]!;
      const g = data[i + 1]!;
      const b = data[i + 2]!;
      opaque += 1;

      const key = ((r >> shift) << (PALETTE.bits * 2)) | ((g >> shift) << PALETTE.bits) | (b >> shift);
      const seen = buckets.get(key);
      if (seen) {
        seen.r += r;
        seen.g += g;
        seen.b += b;
        seen.n += 1;
      } else {
        buckets.set(key, { r, g, b, n: 1 });
      }
    }

    if (opaque === 0) return [];

    const ranked = [...buckets.values()]
      .sort((x, y) => y.n - x.n)
      .map((bucket) => ({
        r: bucket.r / bucket.n,
        g: bucket.g / bucket.n,
        b: bucket.b / bucket.n,
        share: bucket.n / opaque,
      }));

    const chosen: { r: number; g: number; b: number; share: number }[] = [];
    for (const candidate of ranked) {
      if (chosen.length >= PALETTE.max) break;
      if (candidate.share < PALETTE.minShare) break;

      // Neighbouring buckets of one gradient are separate buckets but one
      // colour. The share of a colour that is folded in belongs to the colour
      // it is folded into, or a palette of a photograph reports every entry as
      // covering far less than it does.
      const near = chosen.find((kept) => {
        const dr = kept.r - candidate.r;
        const dg = kept.g - candidate.g;
        const db = kept.b - candidate.b;
        return dr * dr + dg * dg + db * db < PALETTE.minDistanceSq;
      });
      if (near) {
        near.share += candidate.share;
        continue;
      }
      chosen.push({ ...candidate });
    }

    return chosen
      .sort((x, y) => y.share - x.share)
      .map((c) => ({ hex: hex(c.r, c.g, c.b), share: Math.round(c.share * 1000) / 1000 }));
  } catch {
    // The class name is not worth logging here: a palette that could not be
    // read changes nothing about what the asset is, and the understanding it
    // belongs to records its own failures.
    return [];
  }
}

/**
 * Puts the measured colours into an analysis, in the field that already meant
 * them.
 *
 * `paletteHex` is written rather than added to: what the model put there was
 * either nothing, which is what it always was, or a value it could not have
 * read. Measured pixels win over both. The shares are deliberately dropped —
 * the same gold covering 34% of one asset and 31% of another has to land on
 * one fact, or the fixed attribute names stop being comparable, which is the
 * whole reason they are fixed.
 *
 * An empty measurement leaves the field alone, so a decode that failed reads
 * exactly as it did before: absent, not wrong.
 *
 * It lives beside the measuring rather than in understanding.ts so that testing
 * it does not mean importing the database: understanding.ts pulls in db.ts,
 * which throws on import without DATABASE_URL, and the test runner does not
 * load .env.local.
 */
export function withMeasuredPalette(analysis: AssetAnalysis, palette: { hex: string }[]): void {
  if (palette.length === 0) return;

  const structured = analysis.structured as Record<string, unknown>;
  const design =
    structured.design && typeof structured.design === 'object'
      ? (structured.design as Record<string, unknown>)
      : {};

  design.paletteHex = palette.map((entry) => entry.hex);
  structured.design = design;
}
