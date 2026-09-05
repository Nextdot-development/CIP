import 'server-only';
import { capContent, normalise } from './types';
import type { Extractor } from './types';

/**
 * Plain text. The only real work is deciding the encoding, and the only two
 * answers worth supporting are UTF-8 and UTF-16 with a byte-order mark.
 */
export const textExtractor: Extractor = {
  name: 'utf8',
  version: '1',
  fileTypes: ['txt'],

  async extract(body) {
    const warnings: string[] = [];
    let decoded: string;

    if (body.length >= 2 && body[0] === 0xff && body[1] === 0xfe) {
      decoded = body.subarray(2).toString('utf16le');
      warnings.push('decoded-as-utf16le');
    } else if (body.length >= 2 && body[0] === 0xfe && body[1] === 0xff) {
      // Big-endian: swap pairs, then read as little-endian.
      const swapped = Buffer.from(body.subarray(2));
      swapped.swap16();
      decoded = swapped.toString('utf16le');
      warnings.push('decoded-as-utf16be');
    } else {
      decoded = body.toString('utf8');
      // U+FFFD is what Buffer produces for bytes that are not valid UTF-8.
      if (decoded.includes(String.fromCharCode(0xfffd))) {
        warnings.push('some-characters-could-not-be-decoded');
      }
    }

    const { content, truncated } = capContent(normalise(decoded));
    if (content.length === 0) warnings.push('no-text-found');
    return { content, pageCount: null, warnings, truncated };
  },
};
