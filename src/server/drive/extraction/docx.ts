import 'server-only';
import mammoth from 'mammoth';
import { ExtractionFailed, capContent, normalise } from './types';
import type { Extractor } from './types';

/**
 * DOCX via mammoth, which reads the document body and ignores styling.
 * Headers, footers and comments are deliberately left out: they repeat on
 * every page and would drown the actual content once chunked.
 */
export const docxExtractor: Extractor = {
  name: 'mammoth',
  version: '1',
  fileTypes: ['docx'],

  async extract(body) {
    let result: { value: string; messages: { message: string }[] };
    try {
      result = await mammoth.extractRawText({ buffer: body });
    } catch (error) {
      throw new ExtractionFailed(
        `This file could not be read as a Word document${
          error instanceof Error && error.message ? `: ${error.message.slice(0, 140)}` : '.'
        }`,
      );
    }

    const warnings = result.messages.slice(0, 10).map((m) => m.message.slice(0, 200));
    const { content, truncated } = capContent(normalise(result.value));
    if (content.length === 0) warnings.push('no-text-found');

    return { content, pageCount: null, warnings, truncated };
  },
};
