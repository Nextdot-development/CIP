import 'server-only';
import { ExtractionFailed, LIMITS, capContent, normalise } from './types';
import type { Extractor } from './types';

/**
 * PDF via pdf.js.
 *
 * Text-layer only. A scanned page has no text layer, so it comes back empty
 * with a `no-text-layer` warning rather than an error — that warning is
 * precisely the signal an OCR phase would look for later.
 */
export const pdfExtractor: Extractor = {
  name: 'pdfjs',
  version: '1',
  fileTypes: ['pdf'],

  async extract(body) {
    // The legacy build is the one that runs under Node without a DOM.
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

    const task = pdfjs.getDocument({
      // pdf.js takes ownership of the buffer, so it gets a copy.
      data: new Uint8Array(body),
      // No font files fetched, no worker: this runs on a server and should
      // reach for nothing beyond the bytes it was handed. (pdf.js 6 dropped
      // isEvalSupported — it no longer evaluates anything.)
      useWorkerFetch: false,
      useSystemFonts: false,
      disableFontFace: true,
      verbosity: 0,
    });

    let doc;
    try {
      doc = await task.promise;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/password/i.test(message)) {
        throw new ExtractionFailed('This PDF is password protected, so we cannot read it.');
      }
      throw new ExtractionFailed(`This file could not be read as a PDF: ${message.slice(0, 140)}`);
    }

    const warnings: string[] = [];

    try {
      let pages = doc.numPages;
      if (pages > LIMITS.maxPages) {
        warnings.push(`only-first-${LIMITS.maxPages}-pages-read`);
        pages = LIMITS.maxPages;
      }

      const NL = String.fromCharCode(10);
      const parts: string[] = [];

      for (let n = 1; n <= pages; n += 1) {
        const page = await doc.getPage(n);
        const text = await page.getTextContent();

        // pdf.js emits positioned runs; hasEOL marks a real line break, and
        // everything else on a line is joined with a space.
        let pageText = '';
        for (const item of text.items) {
          if (!('str' in item)) continue;
          pageText += item.str;
          pageText += item.hasEOL ? NL : ' ';
        }
        parts.push(pageText.trim());
        page.cleanup();
      }

      const joined = normalise(parts.join(NL + NL));
      if (joined.length === 0) {
        // Almost always a scan. Say so plainly rather than failing.
        warnings.push('no-text-layer');
      }

      const { content, truncated } = capContent(joined);
      return { content, pageCount: doc.numPages, warnings, truncated };
    } finally {
      await task.destroy();
    }
  },
};
