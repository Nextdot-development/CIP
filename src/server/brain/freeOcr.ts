import 'server-only';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Worker } from 'tesseract.js';

/**
 * The words in a picture, read on this server with Tesseract - no model, nothing spent, and the picture
 * sent nowhere. English, with the language data fetched once and kept in the machine's temp folder.
 *
 * Small type on a busy photograph reads poorly, so only lines Tesseract is fairly sure of are kept: a
 * headline, a tagline, a warning line. What it could not read is simply not there - the rules about words
 * then say what was read, not that a line is missing for certain.
 */
const MIN_CONFIDENCE = 60;
/** The longest side a picture is read at: big enough for small print, small enough to be quick. */
const MAX_SIDE = 2200;

let worker: Promise<Worker> | null = null;
function ocr(): Promise<Worker> {
  if (!worker) {
    worker = import('tesseract.js').then(({ createWorker }) => createWorker('eng', 1, { cachePath: join(tmpdir(), 'cip-tesseract') }));
    worker.catch(() => { worker = null; });
  }
  return worker;
}

/** A picture brought to a size Tesseract reads well, as PNG. */
async function readable(bytes: Buffer): Promise<Buffer> {
  const { createCanvas, loadImage } = await import('@napi-rs/canvas');
  const img = await loadImage(bytes);
  const scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
  // Small pictures read better a little larger.
  const up = Math.max(img.width, img.height) < 1000 ? 2 : 1;
  const w = Math.max(1, Math.round(img.width * scale * up));
  const h = Math.max(1, Math.round(img.height * scale * up));
  const c = createCanvas(w, h);
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, w, h);
  g.drawImage(img, 0, 0, w, h);
  return c.toBuffer('image/png');
}

/** Lines Tesseract is fairly sure of, in reading order, from its text and per-line confidences. */
export function sureLines(lines: { text: string; confidence: number }[]): string[] {
  return lines
    .filter((l) => l.confidence >= MIN_CONFIDENCE)
    .map((l) => l.text.replace(/\s+/g, ' ').trim())
    // A line of real words: letters, not stray marks read off a texture.
    .filter((t) => t.length >= 3 && (t.match(/\p{L}/gu) ?? []).length >= Math.max(3, t.length * 0.5));
}

/** The words in one picture. Empty when nothing could be read. */
export async function wordsInPicture(bytes: Buffer): Promise<string[]> {
  const w = await ocr();
  const { data } = await w.recognize(await readable(bytes), {}, { blocks: true, text: true });
  const lines = (data.blocks ?? []).flatMap((b) => b.paragraphs.flatMap((p) => p.lines.map((l) => ({ text: l.text, confidence: l.confidence }))));
  return sureLines(lines);
}

/** The words on a PDF's pages that carry no text of their own, read from the pages as pictures - the first few only. */
export async function wordsInPdfPages(bytes: Buffer, pages = 4): Promise<string[]> {
  const { renderPdfPages } = await import('../drive/extraction/pdfRender');
  const { pages: rendered } = await renderPdfPages(bytes, Array.from({ length: pages }, (_, i) => i + 1));
  const out: string[] = [];
  for (const page of rendered) for (const band of page.bands) out.push(...(await wordsInPicture(band.bytes)));
  return out;
}
