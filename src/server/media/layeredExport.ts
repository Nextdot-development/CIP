import 'server-only';
import { STACK, type StackGroup } from '../brain/layouts';
import { readFileSync } from 'node:fs';
import { PDFDocument, createCanvas, loadImage, type SKRSContext2D } from '@napi-rs/canvas';
import { writePsdBuffer, type Layer, type Psd } from 'ag-psd';
import type { PostLayers } from './composePost';
import type { SetLine } from './typography';

/**
 * A composed post handed over as a designer works with it.
 *
 *   PSD  every part its own layer - background, shadow, bottle, logo - and each
 *        headline line a live text layer in the brand's face, for Photoshop.
 *   SVG  the same parts, the headline as real text, for Illustrator, Figma and Canva.
 *   PDF  one page, the headline as real, selectable text, for print.
 *   PNG  the post itself.
 *
 * Nothing here asks a model for anything: the parts are the ones the post was
 * built from, set again from its kept scene.
 */

export type ExportFormat = 'png' | 'psd' | 'svg' | 'pdf';

export const EXPORT_TYPES: Record<ExportFormat, string> = {
  png: 'image/png',
  psd: 'image/vnd.adobe.photoshop',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
};

type Post = { bytes: Buffer; width: number; height: number; layers: PostLayers };

export async function exportPost(post: Post, format: ExportFormat): Promise<Buffer> {
  if (format === 'png') return post.bytes;
  if (format === 'psd') return toPsd(post);
  if (format === 'svg') return Buffer.from(toSvg(post), 'utf8');
  return toPdf(post);
}

// --- Photoshop ----------------------------------------------------------------------

async function pixels(png: Buffer, crop?: { x: number; y: number; w: number; h: number }) {
  const img = await loadImage(png);
  const area = crop ?? { x: 0, y: 0, w: img.width, h: img.height };
  const c = createCanvas(Math.max(1, area.w), Math.max(1, area.h));
  c.getContext('2d').drawImage(img, area.x, area.y, area.w, area.h, 0, 0, area.w, area.h);
  const data = c.getContext('2d').getImageData(0, 0, c.width, c.height);
  return { width: data.width, height: data.height, data: new Uint8ClampedArray(data.data) };
}

const rgb = (hex: string) => {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex);
  return m ? { r: parseInt(m[1]!, 16), g: parseInt(m[2]!, 16), b: parseInt(m[3]!, 16) } : { r: 255, g: 255, b: 255 };
};

/** The patch one line of words covers, with room for its tails and its shadow. */
function lineArea(line: SetLine, W: number, H: number) {
  const pad = Math.round(line.px * 0.45);
  const x = Math.max(0, Math.floor(line.box.x - pad));
  const y = Math.max(0, Math.floor(line.box.y - pad));
  return { x, y, w: Math.min(W, Math.ceil(line.box.x + line.box.w + pad)) - x, h: Math.min(H, Math.ceil(line.box.y + line.box.h * 1.3 + pad)) - y };
}

async function toPsd(post: Post): Promise<Buffer> {
  const { width: W, height: H, layers } = post;
  const raster = async (name: string, png: Buffer | null): Promise<Layer | null> =>
    png ? { name, left: 0, top: 0, imageData: await pixels(png) } : null;

  // Each line a text layer: live words in the brand's face, carrying the
  // pixels they were set as, so it shows as made until Photoshop redraws it.
  const words: Layer[] = [];
  const added: Layer[] = [];
  for (const [i, line] of layers.lines.entries()) {
    const area = lineArea(line, W, H);
    // An added block's line is on the added text's layer, the headline's on its own.
    const onTexts = line.layer === 'texts' && layers.texts;
    (onTexts ? added : words).push({
      name: onTexts ? `Text: ${line.text}` : `Headline ${i + 1}: ${line.text}`,
      left: area.x,
      top: area.y,
      imageData: await pixels(onTexts ? layers.texts! : layers.headline, area),
      text: {
        text: line.text,
        // Photoshop places text by its baseline.
        transform: [1, 0, 0, 1, line.box.x, line.box.y + line.px * 0.8],
        style: {
          font: { name: line.font.replace(/\s+/g, '') },
          fontSize: line.px,
          fillColor: rgb(line.colour),
          tracking: line.px ? Math.round((line.spacing / line.px) * 1000) : 0,
        },
      },
    });
  }

  // In the order the pieces lie on the post, from the bottom up - the person's, when they changed it.
  const groups: Record<StackGroup, (Layer | null)[]> = {
    bottle: [await raster('Bottle shadow', layers.shadow), await raster('Bottle reflection', layers.reflection ?? null), await raster('Bottle', layers.bottle)],
    headline: [words.length ? { name: 'Headline', opened: true, children: words.reverse() } : null],
    texts: [added.length ? { name: 'Text', opened: true, children: added.reverse() } : null],
    logo: [await raster('Logo', layers.logo)],
  };
  const children = [await raster('Background', layers.background), ...(layers.order ?? STACK).flatMap((g) => groups[g])]
    .filter((l): l is Layer => l !== null);

  const psd: Psd = { width: W, height: H, imageData: await pixels(post.bytes), children };
  return writePsdBuffer(psd, { invalidateTextLayers: true, generateThumbnail: false });
}

// --- SVG ------------------------------------------------------------------------------

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const dataUri = (png: Buffer) => `data:image/png;base64,${png.toString('base64')}`;

/** The faces the words were set in, carried inside the file so it shows as set anywhere. */
function fontFaces(lines: SetLine[]): string {
  const seen = new Map<string, string>();
  for (const line of lines) if (!seen.has(line.font)) seen.set(line.font, line.file);
  return [...seen].map(([font, file]) => {
    try {
      const type = file.toLowerCase().endsWith('.otf') ? 'opentype' : 'truetype';
      return `@font-face{font-family:"${escape(font)}";src:url(data:font/${type === 'opentype' ? 'otf' : 'ttf'};base64,${readFileSync(file).toString('base64')}) format("${type}");}`;
    } catch {
      return '';
    }
  }).join('');
}

function toSvg(post: Post): string {
  const { width: W, height: H, layers } = post;
  // Both spellings of the link: browsers and Figma read href, Illustrator
  // and older tools only xlink:href.
  const image = (id: string, png: Buffer | null) => {
    if (!png) return '';
    const uri = dataUri(png);
    return `<image id="${id}" x="0" y="0" width="${W}" height="${H}" href="${uri}" xlink:href="${uri}"/>`;
  };
  const svgLines = (which: 'headline' | 'texts') => layers.lines.filter((l) => (l.layer ?? 'headline') === which).map((line, i) => {
    const box = line.boxFill
      ? `<rect x="${(line.box.x - line.px * 0.2).toFixed(1)}" y="${(line.box.y - line.px * 0.14).toFixed(1)}" width="${(line.box.w + line.px * 0.4).toFixed(1)}" height="${(line.px * 1.28).toFixed(1)}" fill="${line.boxFill}"/>`
      : '';
    return `${box}<text id="headline-${i + 1}" x="${line.box.x.toFixed(1)}" y="${(line.box.y + line.px * 0.8).toFixed(1)}" ` +
      `font-family="${escape(line.font)}, ${escape(line.face)}" font-size="${line.px.toFixed(1)}" fill="${line.colour}" ` +
      `letter-spacing="${line.spacing.toFixed(2)}"${line.shadow ? ' filter="url(#soft)"' : ''}>${escape(line.text)}</text>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<defs><style>${fontFaces(layers.lines)}</style>` +
    '<filter id="soft" x="-20%" y="-40%" width="140%" height="180%"><feDropShadow dx="0" dy="2" stdDeviation="6" flood-color="#000" flood-opacity="0.55"/></filter></defs>' +
    `<g id="Background">${image('background', layers.background)}</g>` +
    (layers.order ?? STACK).map((g) => ({
      bottle: `<g id="Bottle-shadow">${image('bottle-shadow', layers.shadow)}</g>` +
        `<g id="Bottle-reflection">${image('bottle-reflection', layers.reflection ?? null)}</g>` +
        `<g id="Bottle">${image('bottle', layers.bottle)}</g>`,
      headline: `<g id="Headline">${svgLines('headline')}</g>`,
      texts: `<g id="Text">${svgLines('texts')}</g>`,
      logo: `<g id="Logo">${image('logo', layers.logo)}</g>`,
    })[g]).join('') +
    '</svg>';
}

// --- PDF ------------------------------------------------------------------------------

/**
 * One page at the post's size: the pictures drawn as pictures, and every line
 * of the headline set again as text in its own face, so it stays sharp at any
 * print size and can be selected and edited.
 */
async function toPdf(post: Post): Promise<Buffer> {
  const { width: W, height: H, layers } = post;
  const doc = new PDFDocument({ title: layers.lines.map((l) => l.text).join(' ') || 'Post', creator: 'CIP' });
  const ctx = doc.beginPage(W, H) as unknown as SKRSContext2D;
  const draw = async (png: Buffer | null | undefined) => { if (png) ctx.drawImage(await loadImage(png), 0, 0, W, H); };
  const write = (which: 'headline' | 'texts') => {
  for (const line of layers.lines.filter((l) => (l.layer ?? 'headline') === which)) {
    if (line.boxFill) {
      ctx.fillStyle = line.boxFill;
      ctx.fillRect(line.box.x - line.px * 0.2, line.box.y - line.px * 0.14, line.box.w + line.px * 0.4, line.px * 1.28);
    }
    if (line.shadow) {
      ctx.shadowColor = 'rgba(0,0,0,0.55)';
      ctx.shadowBlur = line.px * 0.35;
      ctx.shadowOffsetY = line.px * 0.04;
    }
    ctx.font = `${line.px.toFixed(1)}px "CIP ${line.face}"`;
    (ctx as unknown as { letterSpacing: string }).letterSpacing = `${line.spacing}px`;
    ctx.fillStyle = line.colour;
    ctx.textBaseline = 'top';
    ctx.fillText(line.text, line.box.x, line.box.y);
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
  }
  };
  await draw(layers.background);
  // In the order the pieces lie on the post, from the bottom up.
  for (const g of layers.order ?? STACK) {
    if (g === 'bottle') for (const png of [layers.shadow, layers.reflection ?? null, layers.bottle]) await draw(png);
    if (g === 'headline') write('headline');
    if (g === 'texts') write('texts');
    if (g === 'logo') await draw(layers.logo);
  }
  doc.endPage();
  return doc.close();
}
