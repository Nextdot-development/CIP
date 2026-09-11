import 'server-only';
import { BRAIN_LIMITS } from './providers/types';

/**
 * Making an image small enough to look at.
 *
 * A brand's own asset library is full of print-resolution artwork: the four
 * Whytehall bottle shots that arrived from Google Drive were 49, 52, 71 and
 * 90 MB. Every one of them was refused with "that image is too large to
 * analyse", which is a fact about the HTTP request and not about the asset. A
 * 90 MB bottle shot is still a bottle shot, and the Brain had nothing to say
 * about four of this company's brands because of it.
 *
 * So an oversized image is scaled to fit instead of being turned away. Nothing
 * is lost by doing so: a vision model downsamples to around 1500 pixels on the
 * long edge before it looks at anything, so sending 9000 buys no extra detail
 * and costs a rejection.
 *
 * Deterministic, and no model — the same bytes always give the same bytes
 * back. This is the same kind of work as rasterising a PDF page, and sits next
 * to the Brain for the same reason: it exists only to make something
 * lookable-at.
 */

/** What a provider will be shown, once it fits. */
export type FittedImage = {
  bytes: Buffer;
  mimeType: string;
  /** Whether anything actually changed, so a caller can say so. */
  resized: boolean;
};

/**
 * Types that can be decoded and re-encoded here.
 *
 * Deliberately not every type the Brain accepts: a GIF is an animation, and
 * flattening it to its first frame is a decision with a wrong answer. Anything
 * not listed is passed through untouched, and the provider's own size check
 * still stands behind it.
 */
const FITTABLE = new Set(['image/png', 'image/jpeg', 'image/webp']);

/** JPEG qualities tried, in order, when PNG is still too heavy. */
const JPEG_QUALITIES = [82, 70, 58] as const;

/**
 * Scales an image down until it is within both bounds, or returns it unchanged.
 *
 * Two separate bounds, because they fail differently. Bytes are what the API
 * rejects outright; pixels are what it silently throws away, and also what
 * makes a 4.5 MB file fail when a 19 MB one succeeds — the dimensions were
 * absurd, not the weight.
 *
 * Failure here is never fatal. If the image cannot be decoded, the original
 * bytes go on to the provider exactly as before: this step can only improve
 * the outcome, never replace a real analysis with an error of its own.
 */
export async function fitForVision(
  bytes: Buffer,
  mimeType: string,
  limits = {
    maxBytes: BRAIN_LIMITS.maxImageBytes,
    maxEdge: BRAIN_LIMITS.visionEdgePixels,
  },
): Promise<FittedImage> {
  const type = mimeType.toLowerCase();
  if (!FITTABLE.has(type)) return { bytes, mimeType, resized: false };

  try {
    const { createCanvas, loadImage } = await import('@napi-rs/canvas');
    const image = await loadImage(bytes);
    const longEdge = Math.max(image.width, image.height);

    const withinBytes = bytes.byteLength <= limits.maxBytes;
    const withinPixels = longEdge <= limits.maxEdge;
    if (withinBytes && withinPixels) return { bytes, mimeType, resized: false };

    // Never scale up. An image that is only over on bytes — a lightly
    // compressed photograph at a sensible size — keeps its dimensions and is
    // re-encoded instead.
    const scale = Math.min(1, limits.maxEdge / longEdge);
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0, width, height);

    const png = canvas.toBuffer('image/png');
    if (png.byteLength <= limits.maxBytes) {
      return { bytes: png, mimeType: 'image/png', resized: true };
    }

    // PNG keeps transparency, which matters for a logo — so it is tried first,
    // and JPEG is the fallback rather than the default. A logo cut out against
    // nothing becomes a logo on white, which is where it would be placed
    // anyway, and is a far better answer than not looking at it at all.
    const flat = createCanvas(width, height);
    const flatCtx = flat.getContext('2d');
    flatCtx.fillStyle = '#ffffff';
    flatCtx.fillRect(0, 0, width, height);
    flatCtx.drawImage(image, 0, 0, width, height);

    for (const quality of JPEG_QUALITIES) {
      const jpeg = flat.toBuffer('image/jpeg', quality);
      if (jpeg.byteLength <= limits.maxBytes) {
        return { bytes: jpeg, mimeType: 'image/jpeg', resized: true };
      }
    }

    // Nothing fit. The original goes on, and the provider refuses it with the
    // reason it always did — which is now true, rather than a limit nobody
    // tried to work within.
    return { bytes, mimeType, resized: false };
  } catch {
    // A corrupt or exotic image is the provider's to judge, not this step's.
    return { bytes, mimeType, resized: false };
  }
}
