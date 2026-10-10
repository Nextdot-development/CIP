import 'server-only';
import { adminSql } from '../db-admin';
import type { CompanyScope } from '../db';
import { downloadFiling } from '../brain/filings';
import { googleDrive } from '../integrations/googleDrive';
import { requireConnected } from '../integrations/googleDrive/connection';
import { driveStorage } from './storage';

/**
 * Puts files back into the object store from where they came from.
 *
 * Written when the Supabase project ran past its free storage and was
 * restricted - it would neither hand files back nor delete them - and CIP
 * moved to a new store. A file that came from Google Drive or the stock
 * exchange still exists there, so it is fetched again and written under the
 * key its row already holds. What was uploaded by hand exists nowhere else and
 * has to be uploaded again.
 *
 * Each file is marked once it is back (metadata.restored), or why it could not
 * be (metadata.restoreFailed), so a run picks up where the last one stopped.
 */

export type RestoreTally = { restored: number; failed: number; left: number };

type Candidate = {
  id: string;
  company_id: string;
  storage_path: string;
  mime_type: string;
  source_type: 'google_drive' | 'exchange_filing';
  external_id: string | null;
  exported_mime: string | null;
  filing_url: string | null;
};

export async function restoreFromSources(options: { limit: number; outOfTime: () => boolean }): Promise<RestoreTally> {
  const sql = adminSql();
  let rows: Candidate[];
  let left = 0;
  try {
    const pending = (where: string) => `
      from drive_files f
      left join google_drive_files g on g.file_id = f.id and g.company_id = f.company_id
      left join market_feed_items i on i.file_id = f.id and i.company_id = f.company_id
     where f.archived_at is null and f.bytes_retained and f.storage_path is not null
       and f.source_type in ('google_drive', 'exchange_filing')
       and coalesce(f.metadata->>'restored', '') = '' and coalesce(f.metadata->>'restoreFailed', '') = ''
       ${where}`;
    rows = await sql.unsafe<Candidate[]>(
      `select f.id, f.company_id, f.storage_path, f.mime_type, f.source_type,
              g.external_id, g.exported_mime, i.url as filing_url
         ${pending('')}
        order by f.created_at desc
        limit $1`,
      [options.limit],
    );
    const [count] = await sql.unsafe<{ n: number }[]>(`select count(*)::int as n ${pending('')}`);
    left = count?.n ?? 0;
  } finally {
    await sql.end();
  }

  const tally: RestoreTally = { restored: 0, failed: 0, left };
  const tokens = new Map<string, string | Error>();
  const store = driveStorage();
  const mark = adminSql();

  try {
  for (const row of rows) {
    if (options.outOfTime()) break;
    let bytes: Buffer | null = null;
    let failure: string | null = null;
    try {
      if (row.source_type === 'google_drive') {
        if (!row.external_id) {
          failure = 'No longer linked to a file in Google Drive.';
        } else {
          if (!tokens.has(row.company_id)) {
            const scope: CompanyScope = { companyId: row.company_id, userId: '00000000-0000-0000-0000-000000000000', role: 'owner' };
            tokens.set(row.company_id, await requireConnected(scope).then((c) => c.accessToken).catch((e: unknown) => e as Error));
          }
          const token = tokens.get(row.company_id)!;
          if (token instanceof Error) {
            // The whole company waits for its connection, rather than every file failing.
            continue;
          }
          bytes = row.exported_mime
            ? await googleDrive().exportFile(token, row.external_id, row.exported_mime)
            : await googleDrive().download(token, row.external_id);
        }
      } else if (!row.filing_url) {
        failure = 'The exchange no longer lists this filing.';
      } else {
        bytes = await downloadFiling(row.filing_url);
        if (!bytes) failure = 'The exchange no longer has this filing as a PDF.';
      }
      if (bytes) await store.put(row.storage_path, bytes, row.mime_type);
    } catch (error) {
      failure = error instanceof Error ? error.message.slice(0, 200) : 'It could not be fetched again.';
    }

    await mark`
      update drive_files
         set metadata = coalesce(metadata, '{}'::jsonb) || ${mark.json(bytes && !failure ? { restored: new Date().toISOString() } : { restoreFailed: failure ?? 'unknown' })}
       where id = ${row.id}
    `;
    if (bytes && !failure) tally.restored += 1;
    else tally.failed += 1;
  }
  } finally {
    await mark.end();
  }
  tally.left = Math.max(0, left - tally.restored - tally.failed);
  return tally;
}
