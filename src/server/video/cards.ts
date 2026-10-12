import 'server-only';
import { join } from 'node:path';
import { createCanvas, GlobalFonts, loadImage } from '@napi-rs/canvas';
import type { SKRSContext2D } from '@napi-rs/canvas';

/**
 * The still frames of the house template, drawn: the intro, the title card,
 * a key point, the disclaimer and the end screen.
 *
 * Drawn here rather than by an image model, because every one is fixed - the
 * logo in its place, the doctor's name spelled as given, the disclaimer in
 * the wording the hospital supplied. Nothing on them is invented.
 */

const FONT = 'CIP Video Sans';
let registered = false;

/** Lato ships with CIP (OFL); a hospital's own typeface can replace it later. */
function ensureFonts(): void {
  if (registered) return;
  const dir = join(process.cwd(), 'src', 'server', 'video', 'fonts');
  GlobalFonts.registerFromPath(join(dir, 'Lato-Regular.ttf'), FONT);
  GlobalFonts.registerFromPath(join(dir, 'Lato-Bold.ttf'), FONT);
  registered = true;
}

export type CardStyle = { background: string; accent: string; ink: string };

/** Breaks text into lines that fit a width. */
function wrap(ctx: SKRSContext2D, text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width > width && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * A full-frame card: the intro, the disclaimer or the end screen. The logo, if
 * there is one, above the text, centred.
 */
export async function fullCard(
  size: { width: number; height: number },
  style: CardStyle,
  content: { logo?: Buffer | null; heading?: string | null; body?: string | null },
): Promise<Buffer> {
  ensureFonts();
  const { width, height } = size;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = style.background;
  ctx.fillRect(0, 0, width, height);

  const unit = Math.min(width, height);
  let y = height * 0.5;
  const blocks: (() => void)[] = [];
  let total = 0;

  if (content.logo) {
    const logo = await loadImage(content.logo);
    const w = Math.min(width * 0.4, (logo.width / logo.height) * unit * 0.22);
    const h = (logo.height / logo.width) * w;
    total += h + unit * 0.04;
    blocks.push(() => {
      ctx.drawImage(logo, (width - w) / 2, y, w, h);
      y += h + unit * 0.04;
    });
  }
  if (content.heading) {
    ctx.font = `bold ${Math.round(unit * 0.065)}px "${FONT}"`;
    const lines = wrap(ctx, content.heading, width * 0.8);
    const lh = unit * 0.08;
    total += lines.length * lh;
    blocks.push(() => {
      ctx.font = `bold ${Math.round(unit * 0.065)}px "${FONT}"`;
      ctx.fillStyle = style.ink;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      for (const line of lines) { ctx.fillText(line, width / 2, y); y += lh; }
    });
  }
  if (content.body) {
    ctx.font = `${Math.round(unit * 0.034)}px "${FONT}"`;
    const lines = wrap(ctx, content.body, width * 0.78);
    const lh = unit * 0.048;
    total += lines.length * lh + unit * 0.02;
    blocks.push(() => {
      y += unit * 0.02;
      ctx.font = `${Math.round(unit * 0.034)}px "${FONT}"`;
      ctx.fillStyle = style.ink;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      for (const line of lines) { ctx.fillText(line, width / 2, y); y += lh; }
    });
  }

  y = (height - total) / 2;
  for (const draw of blocks) draw();
  return canvas.toBuffer('image/png');
}

/**
 * A lower third over the film: transparent, with a band near the bottom
 * carrying a heading and, below it, a smaller line - the title and the
 * doctor's name, or a key point.
 */
export function lowerThird(
  size: { width: number; height: number },
  style: CardStyle,
  heading: string,
  sub?: string | null,
): Buffer {
  ensureFonts();
  const { width, height } = size;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  const unit = Math.min(width, height);
  const pad = unit * 0.035;
  const maxWidth = width * 0.8 - pad * 2;

  ctx.font = `bold ${Math.round(unit * 0.05)}px "${FONT}"`;
  const lines = wrap(ctx, heading, maxWidth);
  const headLine = unit * 0.062;
  const subSize = Math.round(unit * 0.032);
  const boxHeight = pad * 2 + lines.length * headLine + (sub ? subSize * 1.5 : 0);
  const boxWidth = Math.min(
    width * 0.8,
    pad * 2 + Math.max(...lines.map((l) => ctx.measureText(l).width), sub ? (ctx.font = `${subSize}px "${FONT}"`, ctx.measureText(sub).width) : 0),
  );
  const x = width * 0.06;
  const y = height - boxHeight - height * 0.08;

  ctx.globalAlpha = 0.88;
  ctx.fillStyle = style.background;
  ctx.fillRect(x, y, boxWidth, boxHeight);
  ctx.globalAlpha = 1;
  ctx.fillStyle = style.accent;
  ctx.fillRect(x, y, unit * 0.008, boxHeight);

  ctx.fillStyle = style.ink;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.font = `bold ${Math.round(unit * 0.05)}px "${FONT}"`;
  let ty = y + pad;
  for (const line of lines) { ctx.fillText(line, x + pad, ty); ty += headLine; }
  if (sub) {
    ctx.font = `${subSize}px "${FONT}"`;
    ctx.fillStyle = style.accent;
    ctx.fillText(sub, x + pad, ty + subSize * 0.2);
  }
  return canvas.toBuffer('image/png');
}
