import 'server-only';

/**
 * Delivering the shape that was actually asked for.
 *
 * A generator offers a handful of shapes and no more: gpt-image-2 makes 1:1,
 * 3:2 and 2:3, and nothing else. Asked for a 4:5 banner, CIP used to produce
 * the nearest of those and print "crop it to size afterwards" — which is the
 * software handing its own job back to the person who asked.
 *
 * So the nearest shape is generated and then cropped to the one that was
 * wanted. Deterministic, no model: the same picture cropped to the same ratio
 * is the same bytes every time.
 *
 * Cropped rather than stretched, because a stretched bottle is the wrong
 * bottle. Cropped from the centre, because that is where a generator puts the
 * subject when it has not been told otherwise — and the shape chosen to
 * generate from is always the closest one available, so the crop takes as
 * little as it possibly can.
 */

/** A shape somebody asked for, as a number and as they wrote it. */
export type TargetShape = {
  /** width / height */
  ratio: number;
  /** How it was asked for — "4:5", or "1080x1350". */
  label: string;
  /** Exact pixels, when those were named rather than a bare ratio. */
  pixels: { width: number; height: number } | null;
};

/**
 * Ratios worth recognising without being told they are ratios.
 *
 * A bare "4:5" in a sentence means an aspect ratio. A bare "8:30" does not,
 * and this library is full of a brand called 8PM, so guessing from the shape
 * of the text alone would read times and prices as crops. Only proportions
 * people actually brief in are taken without a keyword.
 */
const KNOWN_RATIOS = new Set([
  '1:1', '4:5', '5:4', '9:16', '16:9', '2:3', '3:2', '3:4', '4:3',
  '1:2', '2:1', '21:9', '9:21', '16:10', '10:16', '3:1', '4:1',
]);

/** Words that mean the numbers after them are a shape. */
const MARKERS = /\b(?:ar|a\.r\.|aspect(?:\s+ratio)?|ratio|size|dimensions?|format|shape|crop)\b[\s:=-]*/i;

/** A colon as it actually arrives: typed, the ratio sign, or a full-width one from pasted text. */
const COLON = '[:∶：]';

/**
 * "Square" said in words. Only with a word beside it that makes it a shape — a
 * square post, square mein, in a square — so a billboard in Times Square is not
 * a crop.
 */
const SQUARE =
  /\bsquare\s+(?:posts?|images?|pictures?|creatives?|format|frame|size|shape|crop|ratio|banners?|posters?|ads?|version|m|me|mein|main|mai)\b|\b(?:in|as)\s+(?:a\s+)?square\b/i;

/**
 * The shape a request asks for, if it asks for one.
 *
 * Every way it turned up: "ar 4:5" with a marker, a bare "4:5" or "1 : 1",
 * "4:4" for a square, "1x1", "1080x1080px" in pixels, and "square post" in
 * words. A miss is not a small miss: an unstated shape is decided from the
 * format, and a banner is 3:1, so "banner 4:4" came back a strip. Still returns
 * null rather than guessing when nothing here is a shape.
 */
export function requestedShape(text: string): TargetShape | null {
  // Pixels first: the most specific thing anyone can say. Lookarounds rather
  // than \b, which fails between a digit and a unit, so "1080x1080px" was lost.
  for (const match of text.matchAll(/(?<![\d.])(\d{2,5})\s*[x×*]\s*(\d{2,5})(?![\d.])/gi)) {
    const width = Number(match[1]);
    const height = Number(match[2]);
    // Under a hundred a side is not a canvas: "16x9" is a ratio written with
    // an x, and "12 x 750" is a case of bottles.
    if (width >= 100 && height >= 100) {
      return { ratio: width / height, label: `${width}x${height}`, pixels: { width, height } };
    }
  }

  // A ratio introduced by a word that says it is one. Anything goes here,
  // because the person has said what they mean.
  const marked = new RegExp(
    `${MARKERS.source}(\\d{1,3})\\s*(?:${COLON}|[x×*/]|by)\\s*(\\d{1,3})(?!\\d)`,
    'i',
  ).exec(text);
  if (marked) {
    const shape = ratioShape(Number(marked[1]), Number(marked[2]));
    if (shape) return shape;
  }

  // A bare ratio, but only one that is unmistakably a ratio. A clock always
  // writes its minutes in two digits, so a single digit after the colon is
  // never a time: "4:4" is a square typed loosely. Two digits are taken only
  // when the ratio is a well-known one, which "8:30" is not.
  const bare = new RegExp(
    `(?<![\\d.:])(\\d{1,2})\\s*(?:${COLON}|[x×*])\\s*(\\d{1,2})(?![\\d.:])(?!\\s*grid)`,
    'gi',
  );
  for (const match of text.matchAll(bare)) {
    const shape = ratioShape(Number(match[1]), Number(match[2]));
    if (!shape) continue;
    const raw = `${Number(match[1])}:${Number(match[2])}`;
    if (KNOWN_RATIOS.has(raw) || (match[2]!.length === 1 && KNOWN_RATIOS.has(shape.label))) {
      return shape;
    }
  }

  if (SQUARE.test(text)) return { ratio: 1, label: '1:1', pixels: null };

  return null;
}

/** A ratio in its lowest terms, so "4:4" reads back as the 1:1 it is. */
function ratioShape(w: number, h: number): TargetShape | null {
  if (!(w > 0 && h > 0)) return null;
  const divisor = gcd(w, h);
  return { ratio: w / h, label: `${w / divisor}:${h / divisor}`, pixels: null };
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/** Two shapes nobody looking at them could tell apart. */
export function sameShape(a: number, b: number): boolean {
  return Math.abs(Math.log(a / b)) < 0.02;
}

/**
 * Crops an image to a target shape, and to exact pixels when those were named.
 *
 * Never enlarges to reach a pixel size: scaling a generated image up invents
 * detail that is not there, and a slightly smaller file of the right
 * proportions is an honest answer where a blurry one is not. Exact pixels
 * larger than what was generated are matched in proportion only.
 *
 * Returns the original bytes untouched when it cannot decode them, when the
 * shape already matches, or when anything goes wrong. This step improves a
 * result; it must never be the reason there is no result.
 */
export async function reframe(
  bytes: Buffer,
  mimeType: string,
  target: TargetShape,
): Promise<{ bytes: Buffer; mimeType: string; width: number; height: number; changed: boolean } | null> {
  try {
    const { createCanvas, loadImage } = await import('@napi-rs/canvas');
    const image = await loadImage(bytes);

    const have = image.width / image.height;

    // What the crop can take from the source, at the target proportions.
    let cropWidth = image.width;
    let cropHeight = image.height;
    if (have > target.ratio) {
      cropWidth = Math.round(image.height * target.ratio);
    } else if (have < target.ratio) {
      cropHeight = Math.round(image.width / target.ratio);
    }
    cropWidth = Math.max(1, Math.min(cropWidth, image.width));
    cropHeight = Math.max(1, Math.min(cropHeight, image.height));

    const sx = Math.round((image.width - cropWidth) / 2);
    const sy = Math.round((image.height - cropHeight) / 2);

    // The size delivered. Named pixels win, but only downwards.
    let outWidth = cropWidth;
    let outHeight = cropHeight;
    if (target.pixels && target.pixels.width <= cropWidth && target.pixels.height <= cropHeight) {
      outWidth = target.pixels.width;
      outHeight = target.pixels.height;
    }

    const nothingToDo =
      sameShape(have, target.ratio) && outWidth === image.width && outHeight === image.height;
    if (nothingToDo) {
      return { bytes, mimeType, width: image.width, height: image.height, changed: false };
    }

    const canvas = createCanvas(outWidth, outHeight);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, sx, sy, cropWidth, cropHeight, 0, 0, outWidth, outHeight);

    // PNG throughout: a generated image may carry transparency, and re-encoding
    // it as JPEG to save bytes would put a black square behind a cut-out logo.
    return {
      bytes: canvas.toBuffer('image/png'),
      mimeType: 'image/png',
      width: outWidth,
      height: outHeight,
      changed: true,
    };
  } catch {
    return null;
  }
}
