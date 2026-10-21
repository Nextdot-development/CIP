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

/** Arimo ships with CIP (OFL): Helvetica's proportions, for a house set in Helvetica. */
function ensureFonts(): void {
  if (registered) return;
  const dir = join(process.cwd(), 'src', 'server', 'video', 'fonts');
  GlobalFonts.registerFromPath(join(dir, 'Arimo-Regular.ttf'), FONT);
  GlobalFonts.registerFromPath(join(dir, 'Arimo-Bold.ttf'), FONT);
  registered = true;
}

export type CardStyle = { background: string; accent: string; ink: string };

/** Breaks text into lines that fit a width. */
function wrap(ctx: SKRSContext2D, text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  // Ordinary spaces only: a no-break space holds words together.
  for (const word of text.split(/[ \t\r\n]+/).filter(Boolean)) {
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

// --- Narayana Health's video template -----------------------------------------
// Measured from the hospital's own published films (a 1920 x 1080 long video
// and a 1080 x 1920 Short) and scaled to whatever the film is. Arimo, with
// Helvetica's proportions, stands in for the house face.

export type HouseColours = { blue: string; red: string; white: string };

/** A measure from the template, scaled to this frame. */
const px = (size: { width: number; height: number }, n: number) =>
  (n / (size.width > size.height ? 1920 : 1080)) * size.width;

/** Where the panel starts on a horizontal frame; the doctor has the rest. */
export const PANEL_LEFT = 935 / 1920;

function roundedTopLeft(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x, y + h);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.lineTo(x + w, y);
  ctx.lineTo(x + w, y + h);
  ctx.closePath();
}

/** The opening card: the logo alone, centred on white. */
export async function introCard(size: { width: number; height: number }, logo: Buffer | null, companyName: string): Promise<Buffer> {
  ensureFonts();
  const { width, height } = size;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  if (logo) {
    const img = await loadImage(logo);
    const w = height > width ? width * 0.62 : px(size, 561);
    const h = (img.height / img.width) * w;
    ctx.drawImage(img, (width - w) / 2, height * (height > width ? 0.5 : 0.453) - h / 2, w, h);
  } else {
    ctx.font = `bold ${px(size, 72)}px "${FONT}"`;
    ctx.fillStyle = '#0b4f9c';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(companyName, width / 2, height / 2);
  }
  return canvas.toBuffer('image/png');
}

/** The disclaimer card: "Disclaimer" in bold over the hospital's wording, centred in black on white. */
export function disclaimerCard(size: { width: number; height: number }, text: string): Buffer {
  ensureFonts();
  const { width, height } = size;
  const vertical = height > width;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  const fontSize = px(size, vertical ? 34 : 32);
  const lh = fontSize * 1.8;
  const body = text.replace(/^\s*Disclaimer\s*:?\s*/i, '');
  ctx.font = `${fontSize}px "${FONT}"`;
  const lines = wrap(ctx, body, vertical ? width * 0.8 : px(size, 1420));
  let y = height / 2 - ((lines.length + 1) * lh) / 2;
  ctx.fillStyle = '#000000';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.font = `bold ${fontSize}px "${FONT}"`;
  ctx.fillText('Disclaimer', width / 2, y);
  y += lh * 0.95;
  ctx.font = `${fontSize}px "${FONT}"`;
  for (const line of lines) { ctx.fillText(line, width / 2, y); y += lh; }
  return canvas.toBuffer('image/png');
}

/** The logo in a white card hanging from the top edge, rounded below. */
export async function logoBadge(
  size: { width: number; height: number },
  logo: Buffer,
  corner: 'top-left' | 'top-right',
): Promise<Buffer> {
  const { width, height } = size;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  const img = await loadImage(logo);
  const h = px(size, 96);
  const w = (img.width / img.height) * h;
  const padX = px(size, 20);
  const cardW = w + padX * 2;
  const cardH = px(size, 125);
  const margin = px(size, 65);
  const x = corner === 'top-left' ? margin : width - margin - cardW;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.roundRect(x, -px(size, 20), cardW, cardH + px(size, 20), px(size, 16));
  ctx.fill();
  ctx.drawImage(img, x + padX, (cardH - h) / 2, w, h);
  return canvas.toBuffer('image/png');
}

/**
 * The doctor's name plate: a white box in an NH-blue frame rounded at the top
 * left - the name in red, the designation in blue - over a blue band with the
 * hospital line in white. On the bottom edge at the left of a horizontal
 * frame; on the right edge, low, on a vertical one.
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
  const nameSize = px(size, vertical ? 64 : 52);
  const subSize = px(size, vertical ? 37 : 34);
  const lineSize = px(size, vertical ? 34 : 27);
  const border = px(size, vertical ? 12 : 17);
  const padX = px(size, vertical ? 52 : 30);
  const plateW = vertical ? width * (1 - 118 / 608) : px(size, 710);
  const innerW = plateW - border * 2;
  const textW = innerW - padX * 1.5;

  ctx.font = `bold ${subSize}px "${FONT}"`;
  const subLines = designation ? wrap(ctx, designation, textW) : [];
  ctx.font = `${lineSize}px "${FONT}"`;
  const bandLines = hospitalLine ? wrap(ctx, hospitalLine, textW) : [];

  const innerH = nameSize * 0.45 + nameSize * 1.05 + subLines.length * subSize * 0.98 + nameSize * 0.3;
  const bandH = bandLines.length ? bandLines.length * lineSize * 1.2 + lineSize * 0.9 : border;
  const plateH = border + innerH + bandH;
  const x = vertical ? width - plateW : px(size, 75);
  const y = vertical ? height * 0.625 : height - plateH;

  ctx.fillStyle = colours.blue;
  roundedTopLeft(ctx, x, y, plateW, plateH, px(size, vertical ? 25 : 40));
  ctx.fill();
  ctx.fillStyle = colours.white;
  ctx.fillRect(x + border, y + border, innerW, innerH);

  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  let ty = y + border + nameSize * 0.35;
  ctx.font = `bold ${nameSize}px "${FONT}"`;
  ctx.fillStyle = colours.red;
  ctx.fillText(name, x + border + padX, ty);
  ty += nameSize * 1.1;
  ctx.font = `bold ${subSize}px "${FONT}"`;
  ctx.fillStyle = colours.blue;
  for (const l of subLines) { ctx.fillText(l, x + border + padX, ty); ty += subSize * 0.98; }
  ctx.font = `${lineSize}px "${FONT}"`;
  ctx.fillStyle = colours.white;
  let by = y + border + innerH + lineSize * 0.45;
  for (const l of bandLines) { ctx.fillText(l, x + border + padX, by); by += lineSize * 1.2; }
  return canvas.toBuffer('image/png');
}

/**
 * On-screen text in the house panel, with the first `shown` points drawn - so
 * the points can appear one at a time as the doctor makes them, the panel the
 * same size throughout.
 *
 * Horizontal: NH blue from PANEL_LEFT to the right edge, full height; a red bar
 * beside the white bold heading near the top; the points below, each "- ".
 * Vertical: a blue box in the lower half from near the left edge to the right
 * edge, a red bar down its left side.
 */
export function housePanel(
  size: { width: number; height: number },
  colours: HouseColours,
  heading: string,
  bullets: readonly string[],
  shown: number = bullets.length,
): Buffer {
  ensureFonts();
  const { width, height } = size;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  const vertical = height > width;

  const headSize = px(size, vertical ? 58 : 66);
  const bodySize = px(size, vertical ? 43 : 48);
  const headLh = headSize * 1.2;
  const bodyLh = bodySize * 1.3;
  const bulletGap = bodySize * (vertical ? 0.65 : 0.75);
  const boxX = vertical ? px(size, 44) : width * PANEL_LEFT;
  const barW = px(size, vertical ? 83 : 47);
  const headX = vertical ? px(size, 155) : boxX + barW + px(size, 11);
  const dashX = vertical ? px(size, 169) : boxX + px(size, 80);
  const textX = dashX + px(size, vertical ? 33 : 35);
  const rightPad = px(size, vertical ? 40 : 80);

  ctx.font = `bold ${headSize}px "${FONT}"`;
  // "(1st - 7th August)" stays on one line.
  const held = heading.replace(/\(([^()]{1,32})\)/g, (m) => m.replace(/ /g, '\u00a0'));
  const headLines = wrap(ctx, held, width - headX - rightPad);
  ctx.font = `${bodySize}px "${FONT}"`;
  const bodyLines = bullets.map((b) => wrap(ctx, b, width - textX - rightPad));
  const headH = headLines.length * headLh;
  const gapAfterHead = bodySize * (vertical ? 1.0 : 2.4);
  const bodyH = bodyLines.reduce((n, ls) => n + ls.length * bodyLh, 0) + Math.max(0, bodyLines.length - 1) * bulletGap;

  let boxY = 0;
  let boxH = height;
  let headY: number;
  if (vertical) {
    const top = px(size, 76);
    const bottom = px(size, 80);
    boxH = top + headH + (bodyLines.length ? gapAfterHead + bodyH : 0) + bottom;
    boxY = Math.min(height * 0.92 - boxH, Math.max(height * 0.47, height * 0.7 - boxH / 2));
    headY = boxY + top;
  } else {
    headY = height * (195 / 1080);
  }

  ctx.fillStyle = colours.blue;
  ctx.fillRect(boxX, boxY, width - boxX, boxH);
  ctx.fillStyle = colours.red;
  if (vertical) ctx.fillRect(boxX + px(size, 6), boxY + px(size, 66), barW, boxH - px(size, 66) - px(size, 36));
  else ctx.fillRect(boxX, headY - headSize * 0.6, barW, headH + headSize * 1.0);

  ctx.fillStyle = colours.white;
  ctx.font = `bold ${headSize}px "${FONT}"`;
  let ty = headY;
  for (const l of headLines) { ctx.fillText(l, headX, ty); ty += headLh; }
  ty += gapAfterHead;
  ctx.font = `${bodySize}px "${FONT}"`;
  bodyLines.slice(0, shown).forEach((ls) => {
    ctx.fillText('-', dashX, ty);
    for (const l of ls) { ctx.fillText(l, textX, ty); ty += bodyLh; }
    ty += bulletGap;
  });
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

