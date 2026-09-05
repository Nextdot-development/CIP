import 'server-only';

/**
 * Turning a stored file into plain text.
 *
 * Every extractor is deterministic: the same bytes always produce the same
 * text. Nothing here calls a model, guesses, or interprets — that is the whole
 * point of doing this phase before any AI exists to depend on it.
 */

export type ExtractionOutcome = {
  content: string;
  pageCount: number | null;
  /** Things a person might want to know, e.g. a PDF with no text layer. */
  warnings: string[];
  /** True when a limit below cut the content short. */
  truncated: boolean;
};

export interface Extractor {
  readonly name: string;
  /** Bump to make the worker re-extract everything this extractor handles. */
  readonly version: string;
  readonly fileTypes: readonly string[];
  extract(body: Buffer): Promise<ExtractionOutcome>;
}

/** A file we cannot read is a normal outcome, not a crash. */
export class ExtractionFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExtractionFailed';
  }
}

/**
 * Guard rails. One pathological file must not be able to exhaust the worker's
 * memory or hold the queue open indefinitely.
 */
export const LIMITS = {
  /** Roughly a 1,500-page book. Beyond this the tail is dropped. */
  maxChars: 5_000_000,
  maxPages: 2_000,
  maxCsvRows: 50_000,
  perFileTimeoutMs: 60_000,
} as const;

/** Applies the character cap, reporting whether it bit. */
export function capContent(text: string): { content: string; truncated: boolean } {
  if (text.length <= LIMITS.maxChars) return { content: text, truncated: false };
  return { content: text.slice(0, LIMITS.maxChars), truncated: true };
}

/**
 * One normalisation for every extractor, so chunk offsets mean the same thing
 * whatever the file was. Line endings settle to \n, the BOM goes, runs of
 * blank lines collapse to one, and trailing spaces disappear.
 */
export function normalise(raw: string): string {
  const NL = String.fromCharCode(10);
  return raw
    .replace(new RegExp(String.fromCharCode(0xfeff), 'g'), '')
    .split(String.fromCharCode(13, 10)).join(NL)
    .split(String.fromCharCode(13)).join(NL)
    .split(NL)
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join(NL)
    .replace(new RegExp(`${NL}{3,}`, 'g'), NL + NL)
    .trim();
}

/** Rejects a run that overruns its budget rather than letting it hang. */
export async function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ExtractionFailed(`${label} took longer than ${ms / 1000}s`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
