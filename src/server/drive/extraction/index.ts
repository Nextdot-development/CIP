import 'server-only';
import { pdfExtractor } from './pdf';
import { docxExtractor } from './docx';
import { textExtractor } from './text';
import { csvExtractor } from './csv';
import { ExtractionFailed, LIMITS, withTimeout } from './types';
import type { ExtractionOutcome, Extractor } from './types';
import { EXTRACTABLE_FILE_TYPES } from '@/lib/fileTypes';

export { ExtractionFailed, LIMITS } from './types';
export type { ExtractionOutcome, Extractor } from './types';

/**
 * The formats Phase 3 reads. Images, audio and video are stored and listed as
 * normal; they simply are not extracted yet, and their files stay pending.
 */
const EXTRACTORS: Extractor[] = [pdfExtractor, docxExtractor, textExtractor, csvExtractor];

const BY_TYPE = new Map<string, Extractor>();
for (const extractor of EXTRACTORS) {
  for (const type of extractor.fileTypes) BY_TYPE.set(type, extractor);
}

/** The file types the worker will claim. Everything else is left alone. */
export const EXTRACTABLE_TYPES: string[] = [...BY_TYPE.keys()].sort();

// The browser needs this list too, and a list that drifts would show people a
// status that is not true. One source of truth, checked when this module loads.
const declared = [...EXTRACTABLE_FILE_TYPES].sort();
if (declared.join(',') !== EXTRACTABLE_TYPES.join(',')) {
  throw new Error(
    `Extractor registry (${EXTRACTABLE_TYPES.join(', ')}) does not match ` +
      `EXTRACTABLE_FILE_TYPES (${declared.join(', ')}) in src/lib/fileTypes.ts.`,
  );
}

export function extractorFor(fileType: string): Extractor | null {
  return BY_TYPE.get(fileType.toLowerCase()) ?? null;
}

export type ExtractionRun = ExtractionOutcome & {
  extractor: string;
  extractorVersion: string;
};

/**
 * Runs the right extractor, under a timeout, and normalises whatever goes
 * wrong into ExtractionFailed so the caller only has one failure shape.
 */
export async function runExtraction(fileType: string, body: Buffer): Promise<ExtractionRun> {
  const extractor = extractorFor(fileType);
  if (!extractor) {
    throw new ExtractionFailed(`We do not read .${fileType} files yet.`);
  }

  const outcome = await withTimeout(
    extractor.extract(body).catch((error) => {
      if (error instanceof ExtractionFailed) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new ExtractionFailed(`Could not read this file: ${message.slice(0, 140)}`);
    }),
    LIMITS.perFileTimeoutMs,
    `Reading this ${fileType.toUpperCase()}`,
  );

  return { ...outcome, extractor: extractor.name, extractorVersion: extractor.version };
}
