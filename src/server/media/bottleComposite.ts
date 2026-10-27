import 'server-only';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import type { Canvas, Image, SKRSContext2D } from '@napi-rs/canvas';

/**
 * The brand's own bottle, placed into a scene so it looks photographed there.
 *
 * The bottle is the brand's cut-out, exactly as designed: scaled evenly,
 * never redrawn, never distorted. What makes it belong is what a retoucher
 * adds around it -
 *
 *   a contact shadow  where it meets the surface, so it stands rather than floats;
 *   a cast shadow     falling away from the light;
 *   a reflection      on a gloss surface - a bar top, wet stone, glass;
 *   a light match     the scene's exposure and colour, a little, over the whole bottle;
 *   a rim light       on the side the light comes from;
 *   a light wrap      the scene's glow softly over the bottle's edge, which takes
 *                     away the hard line of a cut-out.
 *
 * The light match is held small on purpose: a label is never recoloured, only
 * lit as the scene lights it.
 */

export type BottlePlacement = {
  /** Centre across, the line it stands on, and its height - fractions of the scene. */
  cx: number;
  base: number;
  height: number;
};

export type Surface = 'matte' | 'gloss';
export type LightFrom = 'left' | 'right' | 'front';

export type PlacedBottle = {
  bytes: Buffer;
  /** Where the bottle landed, in pixels of the scene. */
  box: { x: number; y: number; w: number; h: number };
  light: LightFrom;
};

/**
 * Never more than this much brighter or darker, or tinted, than the bottle as
 * designed. A dark scene may dim it more than a bright one - a bottle lit like
 * a packshot at dusk is the first thing that looks pasted - but never so far
 * that the label loses its colours.
 */
const MAX_EXPOSURE = { bright: 0.1, dark: 0.22 };
const MAX_TINT = 0.12;
/** How much darker the side away from the light falls, at its edge. */
const FAR_SIDE = { bright: 0.18, dark: 0.34 };

export async function placeBottle(input: {
  scene: Buffer;
  bottle: Buffer;
  place: BottlePlacement;
  surface?: Surface;
  light?: LightFrom | 'auto';
}): Promise<PlacedBottle> {
  const scene = await loadImage(input.scene);
  const W = scene.width;
  const H = scene.height;
  // A packshot is often three thousand pixels tall and lands a thousand tall:
  // scaled down evenly first - the same pack, never redrawn - so the work below
  // is done on what will be seen rather than on nine times as many pixels.
  const source = await loadImage(input.bottle);
  const enough = Math.min(1, (input.place.height * H * 1.25) / source.height);
  const cut = await trimmed(enough < 1 ? scaledCopy(source, enough) : source);

  // Scaled evenly to the height asked for, standing on its line.
  const h = Math.max(8, Math.round(input.place.height * H));
  const w = Math.max(2, Math.round((cut.width / cut.height) * h));
  const x = Math.round(input.place.cx * W - w / 2);
  const y = Math.round(input.place.base * H - h);

  const out = createCanvas(W, H);
  const ctx = out.getContext('2d');
  ctx.drawImage(scene, 0, 0);
  const sceneData = ctx.getImageData(0, 0, W, H);

  const light = input.light && input.light !== 'auto' ? input.light : lightFrom(sceneData, W, H, { x, y, w, h });
  const around = averageAround(sceneData, W, H, { x: x - w * 0.6, y: y - h * 0.1, w: w * 2.2, h: h * 1.2 });

  // The silhouette, once: the shadows and the reflection are all made from it.
  const bottle = createCanvas(w, h);
  bottle.getContext('2d').drawImage(cut.canvas, 0, 0, w, h);

  drawContactShadow(ctx, { x, y, w, h });
  drawCastShadow(ctx, bottle, { x, y, w, h }, light);
  if ((input.surface ?? 'matte') === 'gloss') drawReflection(ctx, bottle, { x, y, w, h });

  const lit = lightMatched(bottle, around, light);
  wrapLight(lit, sceneData, W, H, { x, y, w, h });
  ctx.drawImage(lit, x, y);

  return { bytes: out.toBuffer('image/png'), box: { x, y, w, h }, light };
}

/** The cut-out without its transparent margins, so its height is the bottle's. */
/** An even, smaller copy: every proportion kept, high-quality resampling. */
function scaledCopy(img: Image, scale: number): Canvas {
  const c = createCanvas(Math.max(1, Math.round(img.width * scale)), Math.max(1, Math.round(img.height * scale)));
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return c;
}

async function trimmed(img: Image | Canvas) {
  const c = createCanvas(img.width, img.height);
  const cx = c.getContext('2d');
  cx.drawImage(img, 0, 0);
  const { data } = cx.getImageData(0, 0, img.width, img.height);
  let x0 = img.width; let y0 = img.height; let x1 = -1; let y1 = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (data[(y * img.width + x) * 4 + 3]! < 24) continue;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return { canvas: c, width: img.width, height: img.height };
  // The foot is the last row that is solidly glass: a soft shadow baked in
  // under the pack is faint, and standing on it leaves the bottle hovering.
  const solid = (y: number) => {
    let n = 0;
    for (let x = x0; x <= x1; x++) if (data[(y * img.width + x) * 4 + 3]! > 160) n += 1;
    return n;
  };
  let widest = 0;
  for (let y = y0; y <= y1; y += Math.max(1, Math.floor((y1 - y0) / 200))) widest = Math.max(widest, solid(y));
  while (y1 > y0 && solid(y1) < widest * 0.3) y1 -= 1;
  const tw = x1 - x0 + 1;
  const th = y1 - y0 + 1;
  const t = createCanvas(tw, th);
  t.getContext('2d').drawImage(c, x0, y0, tw, th, 0, 0, tw, th);
  return { canvas: t, width: tw, height: th };
}

type Box = { x: number; y: number; w: number; h: number };
type Pixels = { data: Uint8ClampedArray };

const lum = (r: number, g: number, b: number) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

/**
 * Where the light comes from: the brighter side of the scene above the
 * bottle's foot, when one side is plainly brighter; otherwise from the front.
 */
function lightFrom(scene: Pixels, W: number, H: number, box: Box): LightFrom {
  const top = Math.max(0, Math.round(box.y - box.h * 0.2));
  const bottom = Math.min(H, Math.round(box.y + box.h));
  const left = averageAround(scene, W, H, { x: 0, y: top, w: Math.max(1, box.x), h: bottom - top }).lum;
  const right = averageAround(scene, W, H, { x: box.x + box.w, y: top, w: Math.max(1, W - box.x - box.w), h: bottom - top }).lum;
  if (Math.abs(left - right) < 0.04) return 'front';
  return left > right ? 'left' : 'right';
}

function averageAround(scene: Pixels, W: number, H: number, box: Box) {
  const x0 = Math.max(0, Math.round(box.x)); const y0 = Math.max(0, Math.round(box.y));
  const x1 = Math.min(W, Math.round(box.x + box.w)); const y1 = Math.min(H, Math.round(box.y + box.h));
  let r = 0; let g = 0; let b = 0; let n = 0;
  const step = Math.max(1, Math.round(Math.sqrt(((x1 - x0) * (y1 - y0)) / 20000)));
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const i = (y * W + x) * 4;
      r += scene.data[i]!; g += scene.data[i + 1]!; b += scene.data[i + 2]!; n += 1;
    }
  }
  if (n === 0) return { r: 128, g: 128, b: 128, lum: 0.5 };
  return { r: r / n, g: g / n, b: b / n, lum: lum(r / n, g / n, b / n) };
}

/** A soft dark ellipse where the bottle meets the surface. */
function drawContactShadow(ctx: SKRSContext2D, box: Box) {
  // Two: a wide soft one, and a tight dark one right under the foot, where no
  // light gets in at all. Set a little below the foot so the bottle does not
  // hide them.
  const cx = box.x + box.w / 2;
  const foot = box.y + box.h + box.w * 0.015;
  ctx.save();
  ctx.globalCompositeOperation = 'multiply';
  ctx.filter = `blur(${Math.max(3, box.w * 0.08)}px)`;
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.beginPath();
  ctx.ellipse(cx, foot, box.w * 0.62, Math.max(4, box.w * 0.11), 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.filter = `blur(${Math.max(1.5, box.w * 0.02)}px)`;
  ctx.fillStyle = 'rgba(0,0,0,0.85)';
  ctx.beginPath();
  ctx.ellipse(cx, foot - box.w * 0.01, box.w * 0.47, Math.max(2, box.w * 0.035), 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** The bottle's own shape laid on the surface, away from the light, softening as it goes. */
function drawCastShadow(ctx: SKRSContext2D, bottle: Canvas, box: Box, light: LightFrom) {
  const shape = createCanvas(bottle.width, bottle.height);
  const s = shape.getContext('2d');
  s.drawImage(bottle, 0, 0);
  s.globalCompositeOperation = 'source-in';
  s.fillStyle = '#000';
  s.fillRect(0, 0, shape.width, shape.height);

  ctx.save();
  ctx.globalCompositeOperation = 'multiply';
  ctx.globalAlpha = light === 'front' ? 0.22 : 0.34;
  ctx.filter = `blur(${Math.max(3, box.w * 0.14)}px)`;
  // From the foot: flattened onto the surface and leaned away from the light.
  const lean = light === 'left' ? 1.1 : light === 'right' ? -1.1 : 0;
  ctx.translate(box.x + box.w / 2, box.y + box.h);
  ctx.transform(1, 0, -lean * 0.9, light === 'front' ? 0.12 : 0.22, 0, 0);
  ctx.drawImage(shape, -box.w / 2, -box.h);
  ctx.restore();
}

/** The bottle mirrored below its foot, faint, fading into the surface. */
function drawReflection(ctx: SKRSContext2D, bottle: Canvas, box: Box) {
  const depth = Math.round(box.h * 0.35);
  const mirror = createCanvas(box.w, depth);
  const m = mirror.getContext('2d');
  m.save();
  m.translate(0, box.h);
  m.scale(1, -1);
  m.drawImage(bottle, 0, 0);
  m.restore();
  m.globalCompositeOperation = 'destination-in';
  const fade = m.createLinearGradient(0, 0, 0, depth);
  fade.addColorStop(0, 'rgba(0,0,0,0.30)');
  fade.addColorStop(1, 'rgba(0,0,0,0)');
  m.fillStyle = fade;
  m.fillRect(0, 0, box.w, depth);
  ctx.save();
  ctx.filter = 'blur(1.5px)';
  ctx.drawImage(mirror, box.x, box.y + box.h + 1);
  ctx.restore();
}

/**
 * The bottle lit as the scene is lit: its exposure moved a little towards the
 * scene's, the scene's colour laid softly over it, a rim of light on the side
 * the light comes from, and a touch of shade where it stands.
 */
function lightMatched(bottle: Canvas, around: { r: number; g: number; b: number; lum: number }, light: LightFrom) {
  const w = bottle.width;
  const h = bottle.height;
  const out = createCanvas(w, h);
  const c = out.getContext('2d');
  c.drawImage(bottle, 0, 0);

  const own = averageAround(c.getImageData(0, 0, w, h), w, h, { x: w * 0.2, y: h * 0.2, w: w * 0.6, h: h * 0.7 });
  // How dark the scene is, 0 (bright) to 1 (night): it sets how far the bottle may be dimmed.
  const dusk = Math.max(0, Math.min(1, (0.35 - around.lum) / 0.25));
  const cap = MAX_EXPOSURE.bright + (MAX_EXPOSURE.dark - MAX_EXPOSURE.bright) * dusk;
  // Exposure: towards the scene, never past the cap.
  const shift = Math.max(-cap, Math.min(cap * 0.6, (around.lum - own.lum) * 0.5));
  c.globalCompositeOperation = 'source-atop';
  if (shift < 0) {
    c.fillStyle = `rgba(0,0,0,${-shift})`;
    c.fillRect(0, 0, w, h);
  } else if (shift > 0) {
    c.fillStyle = `rgba(255,255,255,${shift * 0.6})`;
    c.globalCompositeOperation = 'soft-light';
    c.fillRect(0, 0, w, h);
    c.globalCompositeOperation = 'destination-in';
    c.drawImage(bottle, 0, 0);
  }

  // The scene's colour, softly: its hue at full strength, laid at MAX_TINT.
  const top = Math.max(around.r, around.g, around.b, 1);
  const hue = `rgb(${Math.round((around.r / top) * 255)},${Math.round((around.g / top) * 255)},${Math.round((around.b / top) * 255)})`;
  c.globalCompositeOperation = 'soft-light';
  c.globalAlpha = MAX_TINT;
  c.fillStyle = hue;
  c.fillRect(0, 0, w, h);
  c.globalAlpha = 1;

  if (light !== 'front') {
    const fromLeft = light === 'left';
    // The far side in shade, falling off across the bottle; the middle of the
    // label stays as it was.
    const far = FAR_SIDE.bright + (FAR_SIDE.dark - FAR_SIDE.bright) * dusk;
    const shade = c.createLinearGradient(fromLeft ? w * 0.45 : w * 0.55, 0, fromLeft ? w : 0, 0);
    shade.addColorStop(0, 'rgba(0,0,0,0)');
    shade.addColorStop(1, `rgba(0,0,0,${far})`);
    c.globalCompositeOperation = 'multiply';
    c.fillStyle = shade;
    c.fillRect(0, 0, w, h);

    // A rim of the scene's own light on the near edge.
    const rim = c.createLinearGradient(fromLeft ? 0 : w, 0, fromLeft ? w * 0.26 : w * 0.74, 0);
    const warm = (v: number, add: number) => Math.round(Math.min(255, v * 1.5 + add));
    rim.addColorStop(0, `rgba(${warm(around.r, 70)},${warm(around.g, 55)},${warm(around.b, 35)},${0.42 + 0.18 * dusk})`);
    rim.addColorStop(0.35, `rgba(${warm(around.r, 70)},${warm(around.g, 55)},${warm(around.b, 35)},${0.12 + 0.08 * dusk})`);
    rim.addColorStop(1, 'rgba(255,255,255,0)');
    c.globalCompositeOperation = 'screen';
    c.fillStyle = rim;
    c.fillRect(0, 0, w, h);
  }

  // A little shade at the foot, where little light reaches.
  const foot = c.createLinearGradient(0, h * 0.9, 0, h);
  foot.addColorStop(0, 'rgba(0,0,0,0)');
  foot.addColorStop(1, 'rgba(0,0,0,0.28)');
  c.globalCompositeOperation = 'multiply';
  c.fillStyle = foot;
  c.fillRect(0, h * 0.9, w, h * 0.1);

  // Whatever was laid over, only where the bottle is.
  c.globalCompositeOperation = 'destination-in';
  c.drawImage(bottle, 0, 0);
  c.globalCompositeOperation = 'source-over';
  return out;
}

/**
 * The scene's light over the bottle's edge: near the edge, inside, the
 * bottle takes a little of the blurred scene behind it. It is what makes a
 * cut-out stop looking cut out.
 */
function wrapLight(lit: Canvas, scene: Pixels, W: number, H: number, box: Box) {
  const w = lit.width;
  const h = lit.height;
  const radius = Math.max(2, Math.round(w * 0.025));
  const soft = createCanvas(w, h);
  const s = soft.getContext('2d');
  s.filter = `blur(${radius}px)`;
  s.drawImage(lit, 0, 0);
  const inner = s.getImageData(0, 0, w, h).data;

  const c = lit.getContext('2d');
  const img = c.getImageData(0, 0, w, h);
  const d = img.data;
  for (let y = 0; y < h; y++) {
    const sy = Math.min(H - 1, Math.max(0, box.y + y));
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const a = d[i + 3]!;
      if (a === 0) continue;
      // How near the edge: the blurred alpha falls off there.
      const edge = Math.max(0, (a - inner[i + 3]!) / 255) * 2.2;
      if (edge <= 0.01) continue;
      const sx = Math.min(W - 1, Math.max(0, box.x + x + (x < w / 2 ? -radius * 2 : radius * 2)));
      const j = (sy * W + sx) * 4;
      const k = Math.min(0.45, edge * 0.45);
      for (let ch = 0; ch < 3; ch++) {
        const own = d[i + ch]!;
        const bg = scene.data[j + ch]!;
        const screen = 255 - ((255 - own) * (255 - bg)) / 255;
        d[i + ch] = Math.round(own + (screen - own) * k);
      }
    }
  }
  c.putImageData(img, 0, 0);
}
