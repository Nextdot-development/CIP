import 'server-only';
import { LIMITS, capContent, normalise } from './types';
import type { Extractor } from './types';

/**
 * CSV, rendered as readable text rather than left as a grid.
 *
 * A row reads "Column: value" so that a sentence of context survives into a
 * chunk. A bare comma-separated line loses its header the moment it is split,
 * which would make the text useless to anything reading it later.
 */
export const csvExtractor: Extractor = {
  name: 'csv',
  version: '1',
  fileTypes: ['csv'],

  async extract(body) {
    const warnings: string[] = [];
    const rows = parseCsv(body.toString('utf8'));

    if (rows.length === 0) {
      return { content: '', pageCount: null, warnings: ['no-rows-found'], truncated: false };
    }

    const header = rows[0]!;
    let dataRows = rows.slice(1);

    if (dataRows.length > LIMITS.maxCsvRows) {
      dataRows = dataRows.slice(0, LIMITS.maxCsvRows);
      warnings.push(`only-first-${LIMITS.maxCsvRows}-rows-read`);
    }
    if (dataRows.length === 0) warnings.push('header-only');

    const NL = String.fromCharCode(10);
    const lines = [
      `Columns: ${header.join(', ')}`,
      '',
      ...dataRows.map((row, i) =>
        `Row ${i + 1}. ` +
        header
          .map((col, c) => `${col || `Column ${c + 1}`}: ${row[c] ?? ''}`)
          .join('; '),
      ),
    ];

    const { content, truncated } = capContent(normalise(lines.join(NL)));
    return { content, pageCount: null, warnings, truncated };
  },
};

/**
 * A small RFC 4180 reader: quoted fields, doubled quotes inside them, and
 * newlines within quotes. Enough for spreadsheet exports, and no dependency.
 */
function parseCsv(input: string): string[][] {
  const NL = String.fromCharCode(10);
  const CR = String.fromCharCode(13);
  const QUOTE = String.fromCharCode(34);

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]!;

    if (inQuotes) {
      if (ch === QUOTE) {
        if (input[i + 1] === QUOTE) {
          field += QUOTE;
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === QUOTE) inQuotes = true;
    else if (ch === ',') {
      row.push(field.trim());
      field = '';
    } else if (ch === NL || ch === CR) {
      if (ch === CR && input[i + 1] === NL) i += 1;
      row.push(field.trim());
      field = '';
      if (row.some((c) => c !== '')) rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }

  row.push(field.trim());
  if (row.some((c) => c !== '')) rows.push(row);
  return rows;
}
