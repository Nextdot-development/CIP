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

/**
 * A block of on-screen text, laid out like a slide: a panel down the right of
 * the frame with a bold heading and a bullet a line. Transparent elsewhere, so
 * the doctor stays in view.
 */
export function ostPanel(
  size: { width: number; height: number },
  style: CardStyle,
  heading: string,
  bullets: readonly string[],
): Buffer {
  ensureFonts();
  const { width, height } = size;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  const unit = Math.min(width, height);
  const panelWidth = width * (width > height ? 0.4 : 0.86);
  const pad = unit * 0.04;
  const inner = panelWidth - pad * 2;
  const headSize = Math.round(unit * 0.046);
  const bodySize = Math.round(unit * 0.034);
  const headLine = headSize * 1.25;
  const bodyLine = bodySize * 1.35;

  ctx.font = `bold ${headSize}px "${FONT}"`;
  const headLines = wrap(ctx, heading, inner);
  ctx.font = `${bodySize}px "${FONT}"`;
  const bulletLines = bullets.map((b) => wrap(ctx, b, inner - bodySize * 1.1));
  const bodyHeight = bulletLines.reduce((n, lines) => n + lines.length * bodyLine + bodySize * 0.35, 0);
  const panelHeight = pad * 2 + headLines.length * headLine + (bullets.length ? unit * 0.02 + bodyHeight : 0);

  const x = width > height ? width - panelWidth - width * 0.04 : (width - panelWidth) / 2;
  const y = width > height ? (height - panelHeight) / 2 : height - panelHeight - height * 0.08;

  ctx.globalAlpha = 0.9;
  ctx.fillStyle = style.background;
  ctx.fillRect(x, y, panelWidth, panelHeight);
  ctx.globalAlpha = 1;
  ctx.fillStyle = style.accent;
  ctx.fillRect(x, y, unit * 0.008, panelHeight);

  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  let ty = y + pad;
  ctx.font = `bold ${headSize}px "${FONT}"`;
  ctx.fillStyle = style.ink;
  for (const line of headLines) { ctx.fillText(line, x + pad, ty); ty += headLine; }
  ty += unit * 0.02;
  ctx.font = `${bodySize}px "${FONT}"`;
  for (const lines of bulletLines) {
    ctx.fillStyle = style.accent;
    ctx.fillText('•', x + pad, ty);
    ctx.fillStyle = style.ink;
    for (const line of lines) { ctx.fillText(line, x + pad + bodySize * 1.1, ty); ty += bodyLine; }
    ty += bodySize * 0.35;
  }
  return canvas.toBuffer('image/png');
}

// --- Narayana Health's video template ("Video Template NH 2026") -------------
// Sizes are the template's own, given on a 1920 x 1080 frame (1080 x 1920
// vertical) and scaled to whatever the film is. Helvetica Neue is the house
// face; Lato stands in until the font files are supplied.

export type HouseColours = { blue: string; red: string; white: string };

/** A measure from the template, scaled to this frame. */
const px = (size: { width: number; height: number }, n: number) =>
  (n / (size.width > size.height ? 1920 : 1080)) * size.width;

function roundedTopLeft(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x, y + h);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.lineTo(x + w, y);
  ctx.lineTo(x + w, y + h);
  ctx.closePath();
}

/** The logo in a white card in one top corner, 300 of 1920 wide. */
export async function logoBadge(
  size: { width: number; height: number },
  logo: Buffer,
  corner: 'top-left' | 'top-right',
): Promise<Buffer> {
  const { width, height } = size;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  const img = await loadImage(logo);
  const w = px(size, 300);
  const h = (img.height / img.width) * w;
  const pad = px(size, 18);
  const margin = px(size, 40);
  const x = corner === 'top-left' ? margin : width - margin - w - pad * 2;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.roundRect(x, margin, w + pad * 2, h + pad * 2, px(size, 12));
  ctx.fill();
  ctx.drawImage(img, x + pad, margin + pad, w, h);
  return canvas.toBuffer('image/png');
}

/**
 * The doctor's name plate: a white box in an NH-blue frame with a rounded top
 * corner - the name in red bold, the designation in blue - over a blue band
 * carrying "Hospital | City" in white. Bottom-left of a horizontal frame, to
 * the right and low on a vertical one.
 */
export function namePlate(
  size: { width: number; height: number },
  colours: HouseColours,
  name: string,
  designation: string | null,
  hospitalLine: string | null,
): Buffer {
  ensureFonts();
  const { width, height } = size;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  const vertical = height > width;
  const nameSize = px(size, vertical ? 52 : 46);
  const subSize = px(size, vertical ? 30 : 24);
  const lineSize = px(size, 34);
  const pad = px(size, 22);
  const border = px(size, 16);

  ctx.font = `bold ${nameSize}px "${FONT}"`;
  const nameWidth = ctx.measureText(name).width;
  ctx.font = `${subSize}px "${FONT}"`;
  const subLines = designation ? wrap(ctx, designation, px(size, vertical ? 760 : 900)) : [];
  const subWidth = Math.max(0, ...subLines.map((l) => ctx.measureText(l).width));
  ctx.font = `${lineSize}px "${FONT}"`;
  const lineWidth = hospitalLine ? ctx.measureText(hospitalLine).width : 0;

  const innerW = Math.max(nameWidth, subWidth, lineWidth) + pad * 2;
  const innerH = pad * 0.8 + nameSize * 1.15 + subLines.length * subSize * 1.3 + pad * 0.6;
  const bandH = hospitalLine ? lineSize * 1.9 : border;
  const plateW = innerW + border * 2;
  const plateH = border + innerH + bandH;
  const x = vertical ? width - plateW : px(size, 110);
  const y = vertical ? height * 0.62 : height - plateH;

  ctx.fillStyle = colours.blue;
  roundedTopLeft(ctx, x, y, plateW, plateH, px(size, 34));
  ctx.fill();
  ctx.fillStyle = colours.white;
  ctx.fillRect(x + border, y + border, innerW, innerH);

  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  let ty = y + border + pad * 0.8;
  ctx.font = `bold ${nameSize}px "${FONT}"`;
  ctx.fillStyle = colours.red;
  ctx.fillText(name, x + border + pad, ty);
  ty += nameSize * 1.15;
  ctx.font = `${subSize}px "${FONT}"`;
  ctx.fillStyle = colours.blue;
  for (const l of subLines) { ctx.fillText(l, x + border + pad, ty); ty += subSize * 1.3; }
  if (hospitalLine) {
    ctx.font = `${lineSize}px "${FONT}"`;
    ctx.fillStyle = colours.white;
    ctx.fillText(hospitalLine, x + border + pad * 0.6, y + border + innerH + (bandH - lineSize) / 2);
  }
  return canvas.toBuffer('image/png');
}

/** The disclaimer: white text centred low on a band fading to black at the foot of the frame. */
export function disclaimerBand(size: { width: number; height: number }, text: string): Buffer {
  ensureFonts();
  const { width, height } = size;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  const bandTop = height * (height > width ? 0.84 : 0.7);
  const fade = ctx.createLinearGradient(0, bandTop, 0, height);
  fade.addColorStop(0, 'rgba(0,0,0,0)');
  fade.addColorStop(0.55, 'rgba(0,0,0,0.6)');
  fade.addColorStop(1, 'rgba(0,0,0,0.95)');
  ctx.fillStyle = fade;
  ctx.fillRect(0, bandTop, width, height - bandTop);

  const fontSize = px(size, 21);
  const label = 'Disclaimer: ';
  const body = text.replace(/^\s*Disclaimer:\s*/i, '');
  ctx.font = `${fontSize}px "${FONT}"`;
  const lines = wrap(ctx, `${label}${body}`, width * 0.88);
  const lh = fontSize * 1.3;
  let y = height - px(size, 30) - lines.length * lh;
  ctx.textBaseline = 'top';
  ctx.fillStyle = '#ffffff';
  lines.forEach((line, i) => {
    if (i === 0 && line.startsWith(label.trim())) {
      // "Disclaimer:" in bold, the rest of the line regular, centred together.
      ctx.font = `bold ${fontSize}px "${FONT}"`;
      const labelW = ctx.measureText(label).width;
      ctx.font = `${fontSize}px "${FONT}"`;
      const rest = line.slice(label.length);
      const start = (width - labelW - ctx.measureText(rest).width) / 2;
      ctx.textAlign = 'left';
      ctx.font = `bold ${fontSize}px "${FONT}"`;
      ctx.fillText(label, start, y);
      ctx.font = `${fontSize}px "${FONT}"`;
      ctx.fillText(rest, start + labelW, y);
    } else {
      ctx.textAlign = 'center';
      ctx.font = `${fontSize}px "${FONT}"`;
      ctx.fillText(line, width / 2, y);
    }
    y += lh;
  });
  return canvas.toBuffer('image/png');
}

/**
 * On-screen text in the house panel. Horizontal: the right half of the frame
 * in NH blue, a red bar beside a white bold heading, the points below in white.
 * Vertical: a blue strip across the lower middle with the red bar and heading.
 */
export function housePanel(
  size: { width: number; height: number },
  colours: HouseColours,
  heading: string,
  bullets: readonly string[],
): Buffer {
  ensureFonts();
  const { width, height } = size;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';

  if (height > width) {
    const headSize = px(size, 62);
    const bodySize = px(size, 34);
    const x = px(size, 60);
    const w = width - x;
    ctx.font = `bold ${headSize}px "${FONT}"`;
    const headLines = wrap(ctx, heading, w - px(size, 160));
    ctx.font = `${bodySize}px "${FONT}"`;
    const bodyLines = bullets.flatMap((b) => wrap(ctx, b, w - px(size, 160)));
    const h = px(size, 50) * 2 + headLines.length * headSize * 1.15 + (bodyLines.length ? px(size, 20) + bodyLines.length * bodySize * 1.45 : 0);
    const y = height * 0.66 - h / 2;
    ctx.fillStyle = colours.blue;
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = colours.red;
    ctx.fillRect(x, y + px(size, 30), px(size, 30), h - px(size, 60));
    let ty = y + px(size, 50);
    ctx.fillStyle = colours.white;
    ctx.font = `bold ${headSize}px "${FONT}"`;
    for (const l of headLines) { ctx.fillText(l, x + px(size, 110), ty); ty += headSize * 1.15; }
    ty += px(size, 20);
    ctx.font = `${bodySize}px "${FONT}"`;
    for (const l of bodyLines) { ctx.fillText(l, x + px(size, 110), ty); ty += bodySize * 1.45; }
    return canvas.toBuffer('image/png');
  }

  const left = width / 2;
  ctx.fillStyle = colours.blue;
  ctx.fillRect(left, 0, width - left, height);
  const headSize = px(size, 62);
  const bodySize = px(size, 30);
  const textX = left + px(size, 110);
  const textW = width - textX - px(size, 90);
  ctx.font = `bold ${headSize}px "${FONT}"`;
  const headLines = wrap(ctx, heading, textW);
  ctx.font = `${bodySize}px "${FONT}"`;
  const bodyLines = bullets.map((b) => wrap(ctx, b, textW));
  const headH = headLines.length * headSize * 1.12;
  const bodyH = bodyLines.reduce((n, ls) => n + ls.length * bodySize * 1.3 + bodySize * 0.95, 0);
  let ty = Math.max(px(size, 140), (height - headH - px(size, 70) - bodyH) / 2);
  ctx.fillStyle = colours.red;
  ctx.fillRect(left, ty - px(size, 6), px(size, 46), headH + px(size, 6));
  ctx.fillStyle = colours.white;
  ctx.font = `bold ${headSize}px "${FONT}"`;
  for (const l of headLines) { ctx.fillText(l, textX, ty); ty += headSize * 1.12; }
  ty += px(size, 70);
  ctx.font = `${bodySize}px "${FONT}"`;
  for (const ls of bodyLines) {
    for (const l of ls) { ctx.fillText(l, textX, ty); ty += bodySize * 1.3; }
    ty += bodySize * 0.95;
  }
  return canvas.toBuffer('image/png');
}

/** The end frame, drawn when the hospital's own end screen is not supplied: the logo and the tagline, on white. */
export async function houseEndCard(
  size: { width: number; height: number },
  colours: HouseColours,
  logo: Buffer | null,
  tagline: string | null,
  companyName: string,
): Promise<Buffer> {
  ensureFonts();
  const { width, height } = size;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  const vertical = height > width;
  const tagSize = px(size, vertical ? 64 : 58);
  ctx.textBaseline = 'middle';
  if (logo) {
    const img = await loadImage(logo);
    const w = px(size, vertical ? 700 : 760);
    const h = (img.height / img.width) * w;
    if (!vertical && tagline) {
      ctx.font = `italic bold ${tagSize}px "${FONT}"`;
      const tagW = ctx.measureText(tagline).width;
      const gap = px(size, 60);
      const x = (width - (w + gap * 2 + tagW)) / 2;
      ctx.drawImage(img, x, (height - h) / 2, w, h);
      ctx.fillStyle = colours.red;
      ctx.fillRect(x + w + gap - px(size, 2), height / 2 - h * 0.45, px(size, 4), h * 0.9);
      ctx.fillStyle = colours.blue;
      ctx.textAlign = 'left';
      ctx.fillText(tagline, x + w + gap * 2, height / 2);
    } else {
      ctx.drawImage(img, (width - w) / 2, height * 0.42 - h / 2, w, h);
      if (tagline) {
        ctx.font = `italic bold ${tagSize}px "${FONT}"`;
        ctx.fillStyle = colours.blue;
        ctx.textAlign = 'center';
        ctx.fillText(tagline, width / 2, height * 0.42 + h / 2 + tagSize * 1.2);
      }
    }
  } else {
    ctx.font = `bold ${tagSize * 1.4}px "${FONT}"`;
    ctx.fillStyle = colours.blue;
    ctx.textAlign = 'center';
    ctx.fillText(companyName, width / 2, height * 0.45);
    if (tagline) {
      ctx.font = `italic bold ${tagSize}px "${FONT}"`;
      ctx.fillText(tagline, width / 2, height * 0.45 + tagSize * 1.6);
    }
  }
  return canvas.toBuffer('image/png');
}
