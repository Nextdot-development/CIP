import 'server-only';
import { ExtractionFailed } from './types';

/**
 * Turning PDF pages into images.
 *
 * This sits in the extraction layer with the other readers because it is the
 * same kind of work: deterministic, no model, no interpretation. The same PDF
 * always renders to the same pixels. What those pixels *mean* is the Brain's
 * job, and it happens later against these images.
 *
 * It exists because the text extractor cannot read a screenshot. An Instagram
 * page exported to PDF is a picture of a post: pdf.js reports no text layer,
 * and everything downstream — Brand DNA, retrieval, the planner — sees an
 * empty document. Rendering the page gives the vision model something real to
 * look at.
 *
 * Rendering is far more expensive than reading text, so every dimension is
 * bounded: how many pages, how large each one, and how much in total. A
 * 400-page catalogue at full resolution would otherwise exhaust the worker.
 */

/** Page-level detail, so a caller can decide what is worth rendering. */
export type PdfPageProfile = {
  pageNumber: number;
  /** Characters of real text on this page, after trimming. */
  textLength: number;
  /**
   * That text, bounded. A page that carries both a caption and a picture is
   * worth reading *and* looking at, and the model reads the picture better
   * when it is shown what the page already says.
   */
  text: string;
  /** Whether the page draws any bitmap image. */
  hasImage: boolean;
  widthPoints: number;
  heightPoints: number;
};

export type PdfProfile = {
  pageCount: number;
  pages: PdfPageProfile[];
  /** True when the document as a whole carries text worth reading. */
  hasTextLayer: boolean;
  /** True when at least one page draws a bitmap. */
  hasImages: boolean;
};

export type RenderedPage = {
  pageNumber: number;
  bytes: Buffer;
  mimeType: 'image/jpeg';
  width: number;
  height: number;
};

/**
 * What a run is allowed to cost.
 *
 * Overridable so a deployment can lift them without a code change, and so the
 * tests can drive a limit without building a 200-page fixture.
 */
function fromEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

export const RENDER_LIMITS = {
  /** Pages rendered per document. The rest are recorded as skipped, not lost. */
  get maxPages(): number {
    return fromEnv('CIP_PDF_MAX_RENDER_PAGES', 40);
  },
  /**
   * The long edge, in pixels. 1,400 is comfortably above what a vision model
   * resolves and well below what a full-resolution render would produce.
   */
  get maxEdgePixels(): number {
    return fromEnv('CIP_PDF_MAX_EDGE_PIXELS', 1_400);
  },
  /** Total rendered bytes for one document, across all its pages. */
  get maxTotalBytes(): number {
    return fromEnv('CIP_PDF_MAX_TOTAL_RENDER_BYTES', 60 * 1024 * 1024);
  },
  /** The whole render, not one page. */
  get timeoutMs(): number {
    return fromEnv('CIP_PDF_RENDER_TIMEOUT_MS', 180_000);
  },
  /**
   * Below this a page's text is treated as incidental — a page number, a
   * footer, a watermark — rather than content worth reading.
   */
  get minTextChars(): number {
    return fromEnv('CIP_PDF_MIN_TEXT_CHARS', 120);
  },
  /** JPEG quality for rendered pages. Enough for text in a screenshot. */
  get jpegQuality(): number {
    return fromEnv('CIP_PDF_JPEG_QUALITY', 82);
  },
  /** Page text kept alongside the render, as a hint for reading the picture. */
  get maxPageTextChars(): number {
    return fromEnv('CIP_PDF_MAX_PAGE_TEXT_CHARS', 4_000);
  },
} as const;

/** Opens a PDF, normalising the ways pdf.js can refuse one. */
async function open(body: Buffer) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

  const task = pdfjs.getDocument({
    data: new Uint8Array(body),
    useWorkerFetch: false,
    useSystemFonts: false,
    disableFontFace: true,
    verbosity: 0,
  });

  try {
    return { task, doc: await task.promise };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await task.destroy().catch(() => {});
    if (/password/i.test(message)) {
      throw new ExtractionFailed('This PDF is password protected, so we cannot read it.');
    }
    throw new ExtractionFailed(`This file could not be read as a PDF: ${message.slice(0, 140)}`);
  }
}

/**
 * Reads what each page holds without rendering anything.
 *
 * Cheap enough to run on every PDF, which is the point: it decides whether a
 * document needs the expensive path at all. A brand guidelines PDF with a
 * proper text layer does not.
 */
export async function profilePdf(body: Buffer): Promise<PdfProfile> {
  const { task, doc } = await open(body);

  try {
    const pages: PdfPageProfile[] = [];
    const limit = Math.min(doc.numPages, RENDER_LIMITS.maxPages);

    for (let n = 1; n <= limit; n += 1) {
      const page = await doc.getPage(n);

      const content = await page.getTextContent();
      let text = '';
      for (const item of content.items) {
        if ('str' in item) text += item.str;
      }

      // An image on the page shows up as a paint operator naming an XObject.
      // Asking the operator list is the only way to know without rendering.
      let hasImage = false;
      try {
        const operators = await page.getOperatorList();
        const { OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs');
        hasImage = operators.fnArray.some(
          (fn: number) =>
            fn === OPS.paintImageXObject ||
            fn === OPS.paintImageXObjectRepeat ||
            fn === OPS.paintInlineImageXObject ||
            fn === OPS.paintImageMaskXObject,
        );
      } catch {
        // A page whose operators will not parse is still worth rendering, and
        // rendering is what settles the question anyway.
        hasImage = true;
      }

      const viewport = page.getViewport({ scale: 1 });
      const trimmed = text.trim();
      pages.push({
        pageNumber: n,
        textLength: trimmed.length,
        text: trimmed.slice(0, RENDER_LIMITS.maxPageTextChars),
        hasImage,
        widthPoints: Math.round(viewport.width),
        heightPoints: Math.round(viewport.height),
      });

      page.cleanup();
    }

    const totalText = pages.reduce((sum, page) => sum + page.textLength, 0);

    return {
      pageCount: doc.numPages,
      pages,
      // Judged across the document: a 20-page deck where one page happens to
      // carry a caption is still a document of pictures.
      hasTextLayer: totalText >= RENDER_LIMITS.minTextChars * Math.max(1, pages.length / 4),
      hasImages: pages.some((page) => page.hasImage),
    };
  } finally {
    await task.destroy().catch(() => {});
  }
}

/**
 * Renders pages to JPEGs.
 *
 * `only` names the pages worth the cost; omitting it renders every page up to
 * the limit. Rendering stops when the byte budget is spent rather than
 * failing, so a document that is mostly readable still yields its readable
 * part — the caller is told how far it got.
 */
export async function renderPdfPages(
  body: Buffer,
  only?: readonly number[],
): Promise<{ pages: RenderedPage[]; renderedAll: boolean; skipped: number[] }> {
  const { createCanvas } = await import('@napi-rs/canvas');
  const { task, doc } = await open(body);

  const deadline = Date.now() + RENDER_LIMITS.timeoutMs;

  try {
    const wanted = (only ?? Array.from({ length: doc.numPages }, (_, i) => i + 1))
      .filter((n) => n >= 1 && n <= doc.numPages)
      .sort((a, b) => a - b);

    const budgeted = wanted.slice(0, RENDER_LIMITS.maxPages);
    const skipped = wanted.slice(RENDER_LIMITS.maxPages);

    const pages: RenderedPage[] = [];
    let totalBytes = 0;

    for (const n of budgeted) {
      if (Date.now() > deadline) {
        skipped.push(...budgeted.slice(budgeted.indexOf(n)));
        break;
      }

      const page = await doc.getPage(n);

      try {
        const base = page.getViewport({ scale: 1 });
        // Scaled so the long edge lands on the cap. Never enlarged: a small
        // page upscaled is the same information with more pixels to pay for.
        const scale = Math.min(
          RENDER_LIMITS.maxEdgePixels / Math.max(base.width, base.height),
          2,
        );
        const viewport = page.getViewport({ scale: Math.max(scale, 0.1) });

        const width = Math.max(1, Math.floor(viewport.width));
        const height = Math.max(1, Math.floor(viewport.height));
        const canvas = createCanvas(width, height);
        const context = canvas.getContext('2d');

        // PDF pages assume paper. Without this, anything transparent renders
        // onto black and a screenshot comes back inverted.
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, width, height);

        await page.render({
          // pdf.js types describe the browser canvas; @napi-rs/canvas
          // implements the same drawing surface natively.
          canvas: canvas as unknown as HTMLCanvasElement,
          canvasContext: context as unknown as CanvasRenderingContext2D,
          viewport,
        }).promise;

        const bytes = canvas.toBuffer('image/jpeg', RENDER_LIMITS.jpegQuality / 100);

        if (totalBytes + bytes.length > RENDER_LIMITS.maxTotalBytes) {
          skipped.push(...budgeted.slice(budgeted.indexOf(n)));
          break;
        }

        totalBytes += bytes.length;
        pages.push({ pageNumber: n, bytes, mimeType: 'image/jpeg', width, height });
      } finally {
        page.cleanup();
      }
    }

    return {
      pages,
      renderedAll: skipped.length === 0 && pages.length === wanted.length,
      skipped: [...new Set(skipped)].sort((a, b) => a - b),
    };
  } finally {
    await task.destroy().catch(() => {});
  }
}
