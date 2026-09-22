import postgres from 'postgres';
import { driveStorage } from '../src/server/drive/storage';
import { fitForVision } from '../src/server/brain/fitImage';
import { readPalette } from '../src/server/brain/palette';

/**
 * Measures the colours of assets the Brain already read.
 *
 *   npm run backfill:palette -- [<company-slug>] [--dry]
 *
 * `paletteHex` was asked of the model and the model, correctly, always left it
 * empty — see src/server/brain/palette.ts. Assets understood before the colours
 * were measured therefore carry no palette at all, and a library where half the
 * work has colours and half does not answers "what is this brand's gold?" with
 * whichever half it happened to look at.
 *
 * This reads the pixels of those assets and writes the palette in, then records
 * the same `palette` facts that understanding would have recorded. It does not
 * call the Brain: nothing here needs a model, and re-running understanding to
 * get a colour would cost a full vision pass per asset and rewrite descriptions
 * that were fine.
 *
 * Safe to run twice: only assets whose palette is still empty are touched, so a
 * second run finds nothing and inflates no evidence.
 *
 * --dry reports what it would measure and writes nothing.
 */

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { ssl: 'require', max: 1, onnotice: () => {} });

/** Image types whose pixels can be read. Video and PDF are not this job. */
const READABLE = /^image\/(png|jpe?g|webp|gif)$/;

type Row = {
  understanding_id: string;
  file_id: string;
  company_id: string;
  name: string;
  mime_type: string;
  storage_path: string;
  brand: string | null;
};

function args(): { slug: string | null; dry: boolean } {
  const argv = process.argv.slice(2);
  return {
    slug: argv.find((a) => !a.startsWith('--')) ?? null,
    dry: argv.includes('--dry'),
  };
}

async function main(): Promise<void> {
  const { slug, dry } = args();

  const scoped = slug
    ? await admin<{ id: string; name: string }[]>`select id, name from companies where slug = ${slug}`
    : [];
  if (slug && !scoped[0]) throw new Error(`no company with slug "${slug}"`);
  const companyId = scoped[0]?.id ?? null;

  // Only what is already understood and still has no palette. An asset the
  // Brain has not read yet will get its palette from the worker on the way
  // through, and does not belong in a backfill.
  const rows = await admin<Row[]>`
    select a.id            as understanding_id,
           d.id            as file_id,
           d.company_id    as company_id,
           d.name          as name,
           d.mime_type     as mime_type,
           d.storage_path  as storage_path,
           d.brand         as brand
      from asset_understanding a
      join drive_files d on d.id = a.file_id
     where a.status = 'ready'
       and d.archived_at is null
       and d.storage_path is not null
       and jsonb_array_length(coalesce(a.structured->'design'->'paletteHex', '[]'::jsonb)) = 0
       ${companyId ? admin`and d.company_id = ${companyId}` : admin``}
     order by d.name
  `;

  const readable = rows.filter((row) => READABLE.test((row.mime_type ?? '').toLowerCase()));
  console.log(
    `\n${readable.length} asset(s) understood without a palette` +
      (rows.length - readable.length > 0 ? `, ${rows.length - readable.length} not images` : '') +
      `${dry ? ' (dry run)' : ''}\n`,
  );

  let measured = 0;
  let blank = 0;
  let failed = 0;
  let facts = 0;

  for (const row of readable) {
    let palette: { hex: string }[] = [];
    try {
      const bytes = await driveStorage().get(row.storage_path);
      const fitted = await fitForVision(bytes, row.mime_type);
      palette = await readPalette(fitted.bytes, fitted.mimeType);
    } catch (error) {
      failed += 1;
      // The name only. The message can quote storage paths and the asset is
      // the company's, not the log's.
      console.log(`  !  ${row.name.slice(0, 64)}  (${error instanceof Error ? error.name : 'failed'})`);
      continue;
    }

    if (palette.length === 0) {
      blank += 1;
      continue;
    }

    measured += 1;
    const hexes = palette.map((entry) => entry.hex);
    console.log(`  +  ${row.name.slice(0, 58).padEnd(58)} ${hexes.join(' ')}`);
    if (dry) continue;

    await admin.begin(async (tx) => {
      // Merged rather than jsonb_set: jsonb_set only creates the last step of
      // a path, so '{design,paletteHex}' silently did nothing on the assets
      // where the model returned no `design` block at all — which was most of
      // them. The array is built with to_jsonb over a text[] because passing a
      // JSON string and casting produced a jsonb *string* holding JSON, not an
      // array, and 32 assets were written that way before it was caught.
      await tx`
        update asset_understanding
           set structured = coalesce(structured, '{}'::jsonb) || jsonb_build_object(
                 'design',
                 case
                   when jsonb_typeof(structured->'design') = 'object' then structured->'design'
                   else '{}'::jsonb
                 end || jsonb_build_object('paletteHex', to_jsonb(${hexes}::text[]))
               ),
               updated_at = now()
         where id = ${row.understanding_id}
      `;

      // The same facts understanding would have written: one fact per colour,
      // one piece of evidence per file.
      //
      // The count is set from the evidence rather than incremented. A backfill
      // is run again — after a bug, after more assets land — and an increment
      // on every pass counts the same asset twice while the evidence table,
      // which is unique per (fact, file), correctly does not. Deriving the
      // count from the evidence makes a second run change nothing, and repairs
      // a count that a first run already inflated.
      for (const hex of hexes) {
        const factRows = await tx<{ id: string }[]>`
          insert into brand_dna_facts
            (company_id, section, attribute, value, brand, kind, confidence, evidence_count)
          values
            (${row.company_id}, 'visual', 'palette', ${hex}, ${row.brand}, 'observed', 0.2, 1)
          on conflict (company_id, section, attribute, value, coalesce(brand, '')) do update
             set updated_at = now()
          returning id
        `;
        const factId = factRows[0]?.id;
        if (!factId) continue;

        await tx`
          insert into brand_dna_evidence (company_id, fact_id, file_id)
          select ${row.company_id}, ${factId}, ${row.file_id}
           where not exists (
             select 1 from brand_dna_evidence
              where fact_id = ${factId} and file_id = ${row.file_id}
           )
        `;

        await tx`
          update brand_dna_facts
             set evidence_count = (
                   select count(*) from brand_dna_evidence where fact_id = ${factId}
                 )
           where id = ${factId}
        `;
        facts += 1;
      }
    });
  }

  console.log(
    `\n  ${measured} measured, ${facts} colour fact(s) recorded` +
      (blank ? `, ${blank} produced no palette` : '') +
      (failed ? `, ${failed} could not be read` : '') +
      `${dry ? ' (dry run — nothing written)' : ''}\n`,
  );
}

main()
  .then(() => admin.end())
  .catch(async (error) => {
    console.error('\nbackfill failed:', error instanceof Error ? error.message : error);
    await admin.end();
    process.exit(1);
  });
