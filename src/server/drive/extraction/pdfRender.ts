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

/**
 * One strip of a rendered page.
 *
 * A page that fits is a single band covering all of it. A tall one is cut into
 * several, because a vision model shown a 1:8 strip resolves almost nothing
 * across its narrow axis.
 */
export type RenderedBand = {
  index: number;
  bytes: Buffer;
  mimeType: 'image/jpeg';
  width: number;
  height: number;
  /** Where this strip starts down the page, in rendered pixels. */
  offsetY: number;
};

export type RenderedPage = {
  pageNumber: number;
  /** The page as rendered, before any cutting. */
  width: number;
  height: number;
  bands: RenderedBand[];
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
   * What the *short* edge should measure, in pixels.
   *
   * Scaling by the long edge is what a page of ordinary proportions wants, and
   * it is exactly wrong for these files. India.pdf and nigeria.pdf are strips
   * of roughly 1:7.5 — a whole Instagram feed exported as one page — so
   * capping the long edge at 2,048 left the width at 273 px and every tile on
   * it about 90 px across. The model reported, correctly, that it could not
   * read them. Driving the short edge instead gives the narrow axis the
   * resolution it needs, and the height that follows is dealt with by cutting
   * the page into bands.
   */
  get targetShortEdgePixels(): number {
    return fromEnv('CIP_PDF_SHORT_EDGE_PIXELS', 1_400);
  },
  /** A ceiling for ordinary pages, so a poster does not render enormous. */
  get maxEdgePixels(): number {
    return fromEnv('CIP_PDF_MAX_EDGE_PIXELS', 2_048);
  },
  /**
   * The tallest strip sent to the model in one piece.
   *
   * Beyond roughly this, detail is lost to downsampling no matter how large
   * the image is, so more pixels buy nothing and cost tokens.
   */
  get maxBandHeightPixels(): number {
    return fromEnv('CIP_PDF_MAX_BAND_HEIGHT', 2_000);
  },
  /**
   * Overlap between neighbouring bands, as a fraction of band height.
   *
   * A cut lands wherever it lands, which is often through the middle of a
   * post. The overlap means anything sliced in half on one band appears whole
   * on the next; the duplicate is dealt with when the posts are merged.
   */
  get bandOverlap(): number {
    const raw = Number(process.env.CIP_PDF_BAND_OVERLAP);
    return Number.isFinite(raw) && raw >= 0 && raw < 0.5 ? raw : 0.12;
  },
  /** Total pixels for one page, so an enormous sheet cannot exhaust memory. */
  get maxPagePixels(): number {
    return fromEnv('CIP_PDF_MAX_PAGE_PIXELS', 24_000_000);
  },
  /** Total rendered bytes for one document, across all its pages. */
  get maxTotalBytes(): number {
    return fromEnv('CIP_PDF_MAX_TOTAL_RENDER_BYTES', 60 * 1024 * 1024);
  },
  /**
   * The whole render, not one page.
   *
   * Rendering happens for every page before any of them is looked at, so this
   * has to cover the document rather than a page. A real country deck is three
   * pages of 1400x10500 and 180 s was not enough for the third — it was
   * correctly recorded as skipped, which is the right behaviour and the wrong
   * outcome. The page count and pixel budgets are what actually bound the
   * work; this is only here so a pathological file cannot hold the queue open.
   */
  get timeoutMs(): number {
    return fromEnv('CIP_PDF_RENDER_TIMEOUT_MS', 600_000);
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

/**
 * How much to scale a page by.
 *
 * The short edge is what decides legibility, so it is what the scale targets.
 * Two things then hold it back: an ordinary page should not render past the
 * long-edge cap, and no page may exceed the total pixel budget however it is
 * shaped. Never below 1:1 either — upscaling a small page adds pixels without
 * adding information.
 */
export function scaleFor(widthPoints: number, heightPoints: number): number {
  const shortEdge = Math.min(widthPoints, heightPoints);
  const longEdge = Math.max(widthPoints, heightPoints);
  if (shortEdge <= 0 || longEdge <= 0) return 1;

  let scale = RENDER_LIMITS.targetShortEdgePixels / shortEdge;

  // A page of ordinary proportions is still bounded by its long edge. A strip
  // is not: its long edge is meant to be cut up, so letting it govern here
  // would reintroduce exactly the problem this is solving.
  const aspect = longEdge / shortEdge;
  if (aspect < 3) {
    scale = Math.min(scale, RENDER_LIMITS.maxEdgePixels / longEdge);
  }

  const pixels = widthPoints * heightPoints * scale * scale;
  if (pixels > RENDER_LIMITS.maxPagePixels) {
    scale = Math.sqrt(RENDER_LIMITS.maxPagePixels / (widthPoints * heightPoints));
  }

  return Math.max(Math.min(scale, 4), 0.1);
}

/** Where each band starts and how tall it is, for a page of this height. */
export function bandsFor(height: number): { offsetY: number; height: number }[] {
  const max = RENDER_LIMITS.maxBandHeightPixels;
  if (height <= max) return [{ offsetY: 0, height }];

  const overlap = Math.floor(max * RENDER_LIMITS.bandOverlap);
  const step = Math.max(max - overlap, 1);
  const bands: { offsetY: number; height: number }[] = [];

  for (let offsetY = 0; offsetY < height; offsetY += step) {
    const remaining = height - offsetY;
    bands.push({ offsetY, height: Math.min(max, remaining) });
    // The last band reaches the bottom; anything further would be empty.
    if (offsetY + max >= height) break;
  }

  return bands;
}

/** Cuts a rendered page into the strips that will be looked at. */
function cutIntoBands(
  source: { width: number; height: number },
  width: number,
  height: number,
  createCanvas: (w: number, h: number) => {
    getContext(kind: '2d'): { drawImage(...args: never[]): void };
    toBuffer(mime: 'image/jpeg', quality?: number): Buffer;
  },
): RenderedBand[] {
  const quality = RENDER_LIMITS.jpegQuality / 100;
  const plan = bandsFor(height);

  if (plan.length === 1) {
    return [
      {
        index: 0,
        bytes: (source as unknown as { toBuffer(m: 'image/jpeg', q?: number): Buffer })
          .toBuffer('image/jpeg', quality),
        mimeType: 'image/jpeg',
        width,
        height,
        offsetY: 0,
      },
    ];
  }

  return plan.map((band, index) => {
    const canvas = createCanvas(width, band.height);
    const context = canvas.getContext('2d');
    // Drawn at a negative offset, which is the cheapest way to take a
    // rectangle out of a canvas without an intermediate copy.
    (context.drawImage as unknown as (img: unknown, x: number, y: number) => void)(
      source,
      0,
      -band.offsetY,
    );

    return {
      index,
      bytes: canvas.toBuffer('image/jpeg', quality),
      mimeType: 'image/jpeg' as const,
      width,
      height: band.height,
      offsetY: band.offsetY,
    };
  });
}

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
        const viewport = page.getViewport({ scale: scaleFor(base.width, base.height) });

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

        const bands = cutIntoBands(canvas, width, height, createCanvas);
        const bandBytes = bands.reduce((sum, band) => sum + band.bytes.length, 0);

        if (totalBytes + bandBytes > RENDER_LIMITS.maxTotalBytes) {
          skipped.push(...budgeted.slice(budgeted.indexOf(n)));
          break;
        }

        totalBytes += bandBytes;
        pages.push({ pageNumber: n, width, height, bands });
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
