import 'server-only';
import { withCompanyScope } from '../db';
import type { CompanyScope } from '../db';
import { adminSql } from '../db-admin';
import { driveStorage } from '../drive/storage';
import { renderPdfPages } from '../drive/extraction/pdfRender';
import { ExtractionFailed, capContent, normalise } from '../drive/extraction/types';
import { CHUNKER_VERSION, chunkText } from '../drive/extraction/chunk';
import { brain } from './providers';
import { BrainFailed } from './providers/types';
import { fitForVision } from './fitImage';

/**
 * OCR: reading a scanned document by looking at it.
 *
 * A scanned report is a PDF of pictures of pages. Text extraction reads its text
 * layer, finds nothing, and the words on those pages could not be searched,
 * asked about, or quoted by a market signal. Here each page is rendered and
 * transcribed word for word by the vision model, and the result is stored as an
 * ordinary extraction of kind 'ocr' - chunked, and embedded by the same queue
 * that embeds everything else. From there on a scanned report is just text.
 *
 * Transcription, not understanding. The model is told to copy what is written
 * and nothing more, because the text is what everything downstream relies on
 * being exact: a market signal is only kept if its quote is found in it.
 *
 * What is read: PDFs whose text layer came back (nearly) empty, and pictures of
 * pages that were added as market data. Not every image in the library - a
 * bottle shot has no text worth a vision call, and the Brain already reads the
 * words on a creative when it looks at it.
 */

const EXTRACTOR = 'vision-ocr';
const EXTRACTOR_VERSION = '1';
const MAX_ATTEMPTS = 3;
/** A claim this old belongs to a worker that stopped. */
const STALE_MINUTES = 30;
/** Fewer characters than this in a PDF's own text layer, and it is a scan. */
const SCANNED_BELOW_CHARS = 200;
const ZERO_USER = '00000000-0000-0000-0000-000000000000';

export type ClaimedOcrJob = {
  id: string;
  companyId: string;
  fileId: string;
  attempts: number;
};

export type OcrOutcome =
  | { status: 'ready'; pages: number; chars: number }
  | { status: 'skipped' | 'retry' | 'failed'; message: string };

/** Queues every file that needs reading by looking. Returns how many were new. */
export async function enqueueOcrEverywhere(): Promise<number> {
  const sql = adminSql();
  try {
    const rows = await sql<{ id: string }[]>`
      insert into file_ocr (company_id, file_id)
      select f.company_id, f.id
        from drive_files f
       where f.archived_at is null
         and f.bytes_retained
         and f.storage_path is not null
         and (
           -- A PDF whose text layer came back (nearly) empty: a scan.
           (lower(f.file_type) = 'pdf'
             and f.processing_status = 'processed'
             and not exists (
               select 1 from drive_file_extractions e
                where e.company_id = f.company_id and e.file_id = f.id
                  and e.kind = 'text' and e.content_chars >= ${SCANNED_BELOW_CHARS}
             ))
           -- A picture of a page, added as market data.
           or (lower(f.mime_type) in ('image/png', 'image/jpeg', 'image/webp')
             and exists (
               select 1 from market_sources m
                where m.company_id = f.company_id and m.file_id = f.id
             ))
         )
      on conflict (company_id, file_id) do nothing
      returning id
    `;
    return rows.length;
  } finally {
    await sql.end();
  }
}

/** Takes the next file to read, across companies, under a lease. */
export async function claimOcrJob(): Promise<ClaimedOcrJob | null> {
  const sql = adminSql();
  try {
    const rows = await sql<{ id: string; company_id: string; file_id: string; attempts: number }[]>`
      update file_ocr o
         set status = 'reading', claimed_at = now(), attempts = o.attempts + 1, updated_at = now()
       where o.id = (
         select id from file_ocr
          where attempts < ${MAX_ATTEMPTS}
            -- A file that failed once waits a moment before it is tried again.
            and ((status = 'pending' and (error_message is null or updated_at < now() - interval '2 minutes'))
                 or (status = 'reading' and claimed_at < now() - make_interval(mins => ${STALE_MINUTES})))
          order by created_at
          for update skip locked
          limit 1
       )
      returning o.id, o.company_id, o.file_id, o.attempts
    `;
    const row = rows[0];
    return row ? { id: row.id, companyId: row.company_id, fileId: row.file_id, attempts: row.attempts } : null;
  } finally {
    await sql.end();
  }
}

/**
 * Strips of a tall page overlap, so the lines where one strip ends and the next
 * begins are transcribed twice. The repeated lines at the start of each strip
 * are dropped.
 */
export function joinStrips(texts: readonly string[]): string {
  const lines: string[] = [];
  for (const text of texts) {
    const next = text.split('\n');
    let overlap = 0;
    for (let n = Math.min(next.length, lines.length, 12); n > 0; n -= 1) {
      if (next.slice(0, n).join('\n').trim() === lines.slice(-n).join('\n').trim()) {
        overlap = n;
        break;
      }
    }
    lines.push(...next.slice(overlap));
  }
  return lines.join('\n').trim();
}

export async function runOcrJob(job: ClaimedOcrJob): Promise<OcrOutcome> {
  const scope: CompanyScope = { companyId: job.companyId, userId: ZERO_USER, role: 'owner' };
  const provider = brain();

  const settle = (status: 'pending' | 'failed' | 'skipped', message: string) =>
    withCompanyScope(scope, (tx) => tx`
      update file_ocr set status = ${status}, error_message = ${message.slice(0, 500)}, updated_at = now()
       where id = ${job.id} and company_id = ${scope.companyId}
    `);

  try {
    const rows = await withCompanyScope(scope, (tx) =>
      tx<{ name: string; file_type: string; mime_type: string; storage_path: string | null; checksum_sha256: string | null }[]>`
        select name, file_type, mime_type, storage_path, checksum_sha256
          from drive_files
         where id = ${job.fileId} and company_id = ${scope.companyId} and archived_at is null
      `,
    );
    const file = rows[0];
    if (!file?.storage_path) {
      const message = 'The file is no longer there.';
      await settle('failed', message);
      return { status: 'failed', message };
    }

    const bytes = await driveStorage().get(file.storage_path);

    type Page = { pageNumber: number; images: { bytes: Buffer; mimeType: string }[] };
    let pages: Page[];
    let pageCount: number;
    const warnings: string[] = [];

    if (file.file_type.toLowerCase() === 'pdf') {
      const rendered = await renderPdfPages(bytes);
      pages = rendered.pages.map((page) => ({
        pageNumber: page.pageNumber,
        images: page.bands.map((band) => ({ bytes: band.bytes, mimeType: band.mimeType })),
      }));
      pageCount = rendered.pages.length + rendered.skipped.length;
      if (rendered.skipped.length > 0) warnings.push(`pages-not-read:${rendered.skipped.length}`);
    } else {
      const fitted = await fitForVision(bytes, file.mime_type);
      pages = [{ pageNumber: 1, images: [{ bytes: fitted.bytes, mimeType: fitted.mimeType }] }];
      pageCount = 1;
    }

    if (pages.length === 0) {
      const message = 'No page of this file could be rendered to read.';
      await settle('failed', message);
      return { status: 'failed', message };
    }

    const parts: string[] = [];
    for (const page of pages) {
      const strips: string[] = [];
      for (const [index, image] of page.images.entries()) {
        const result = await provider.transcribePage({
          bytes: image.bytes,
          mimeType: image.mimeType,
          filename: file.name,
          pageNumber: page.pageNumber,
          pageCount,
          part: index + 1,
          parts: page.images.length,
        });
        if (result.text) strips.push(result.text);
      }
      const text = joinStrips(strips);
      // The page number stays with its text, so a quote can be traced to a page.
      if (text) parts.push(`[Page ${page.pageNumber}]\n${text}`);
    }

    const content = normalise(parts.join('\n\n'));
    if (content.replace(/\[Page \d+\]/g, '').trim().length < 20) {
      const message = 'Its pages have no readable text.';
      await settle('skipped', message);
      return { status: 'skipped', message };
    }

    const capped = capContent(content);
    const chunks = chunkText(capped.content);

    await withCompanyScope(scope, async (tx) => {
      // Replaced, never accumulated: reading a file again leaves one reading.
      await tx`
        delete from drive_file_extractions
         where company_id = ${scope.companyId} and file_id = ${job.fileId} and kind = 'ocr'
      `;
      const inserted = await tx<{ id: string }[]>`
        insert into drive_file_extractions (
          company_id, file_id, kind, content, content_chars, extractor,
          extractor_version, source_checksum, page_count, warnings
        ) values (
          ${scope.companyId}, ${job.fileId}, 'ocr', ${capped.content}, ${capped.content.length},
          ${EXTRACTOR}, ${EXTRACTOR_VERSION}, ${file.checksum_sha256}, ${pageCount},
          ${capped.truncated ? [...warnings, 'content-truncated'] : warnings}
        )
        returning id
      `;
      const extractionId = inserted[0]!.id;

      for (const chunk of chunks) {
        await tx`
          insert into drive_file_chunks (
            company_id, file_id, extraction_id, ordinal, content,
            char_start, char_end, token_estimate, heading, chunker_version
          ) values (
            ${scope.companyId}, ${job.fileId}, ${extractionId}, ${chunk.ordinal}, ${chunk.content},
            ${chunk.charStart}, ${chunk.charEnd}, ${chunk.tokenEstimate}, ${chunk.heading}, ${CHUNKER_VERSION}
          )
        `;
      }

      await tx`
        update file_ocr
           set status = 'ready', pages = ${pageCount}, pages_read = ${pages.length}, error_message = null,
               provider = ${provider.name}, model = ${provider.model}, updated_at = now()
         where id = ${job.id} and company_id = ${scope.companyId}
      `;
    });

    return { status: 'ready', pages: pages.length, chars: capped.content.length };
  } catch (error) {
    const failure = error instanceof BrainFailed ? error : null;
    const retry = (failure ? failure.kind !== 'permanent' : !(error instanceof ExtractionFailed)) && job.attempts < MAX_ATTEMPTS;
    const message =
      failure?.message ??
      (error instanceof ExtractionFailed ? error.message : 'Reading this file by looking at it failed.');
    await settle(retry ? 'pending' : 'failed', message).catch(() => {});
    return { status: retry ? 'retry' : 'failed', message };
  }
}
