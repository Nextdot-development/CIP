import 'server-only';
import { withCompanyScope } from '../db';
import type { CompanyScope } from '../db';

/**
 * What this database can actually do.
 *
 * The Brain's vector columns exist only where pgvector does. Everything else
 * works without them — assets are understood, Brand DNA is derived with
 * evidence, feedback still becomes scoped lessons — and only "find me something
 * similar" is unavailable.
 *
 * Checked rather than assumed, because writing to a column that is not there
 * fails the whole operation instead of skipping the one part that needs it.
 * Asked once per process: it is a schema fact and cannot change while we run.
 */

let similarity: boolean | null = null;

export async function similaritySupported(scope: CompanyScope): Promise<boolean> {
  if (similarity !== null) return similarity;

  similarity = await withCompanyScope(scope, async (tx) => {
    const rows = await tx<{ present: boolean }[]>`
      select exists (
        select 1 from information_schema.columns
         where table_name = 'asset_understanding' and column_name = 'embedding'
      ) as present
    `;
    return rows[0]?.present ?? false;
  });

  return similarity;
}

/** Tests reset it after migrating a fresh database. */
export function __resetBrainCapabilities(): void {
  similarity = null;
}
