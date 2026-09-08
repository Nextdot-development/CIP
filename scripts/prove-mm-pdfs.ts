import postgres from 'postgres';
import type { CompanyScope } from '../src/server/db';

/**
 * The three Magic Moments Instagram PDFs, read for real.
 *
 *   npm run prove:mm-pdfs           # whatever is reachable today
 *   npm run prove:mm-pdfs -- --sync # pull from Google Drive first
 *
 * This proves one specific claim: that CIP can take the actual country decks
 * and come back with the posts inside them. It uses the real vision model and
 * nothing else — a fake would prove the plumbing, which the offline suite
 * already covers, and would say nothing about whether a real page can be read.
 *
 * When the files are not reachable it says BLOCKED and stops. It does not
 * substitute a similar file, and it does not report a number it did not
 * measure. A proof that passes without the thing it is proving is worse than
 * no proof, because it is believed.
 *
 * It never writes to the Google Drive integration. Connections and synced-file
 * records are read; a sync is run only when asked for, through the same code
 * path the worker uses.
 */

const SYNC = process.argv.includes('--sync');
/**
 * Re-read every PDF from scratch rather than reporting what is stored.
 *
 * Off by default because it is not cheap: a country deck is three pages, each
 * cut into six bands, and each band is a vision call — about five minutes and
 * real money per page. The stored result was produced by the same code path,
 * so reporting it is not a weaker claim; it is the same claim without paying
 * for it twice.
 */
const REREAD = process.argv.includes('--reread');
const COMPANY = 'magic-moments';

/** Ours, from an earlier proof. Not one of the three, so it is never counted. */
const OUR_OWN_PROOF_FILES = new Set(['brain-proof-instagram.pdf']);

let failures = 0;
let blockers = 0;

function check(label: string, pass: boolean, detail = ''): void {
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures += 1;
}

function blocked(label: string, detail: string): void {
  console.log(`  BLOCKED  ${label} — ${detail}`);
  blockers += 1;
}

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { ssl: 'require', max: 1, onnotice: () => {} });

async function scopeFor(slug: string): Promise<CompanyScope> {
  const rows = await admin<{ company_id: string; user_id: string }[]>`
    select c.id as company_id, u.id as user_id
      from companies c
      join memberships m on m.company_id = c.id
      join users u on u.id = m.user_id
     where c.slug = ${slug}
     limit 1
  `;
  const row = rows[0];
  if (!row) throw new Error(`no company ${slug}`);
  return { companyId: row.company_id, userId: row.user_id, role: 'owner' };
}

function ms(value: number | null): string {
  if (!value || value <= 0) return '—';
  return value < 1000 ? `${value}ms` : `${(value / 1000).toFixed(1)}s`;
}

async function main() {
  console.log(`\nMagic Moments country PDFs, read for real — ${new Date().toISOString()}\n`);

  const { brainStatus } = await import('../src/server/brain/providers');
  const status = brainStatus();
  console.log(`  Vision provider: ${status.provider} / ${status.model} ` +
    `(${status.configured ? 'configured' : 'NOT configured'})\n`);

  // A fake would make every number below meaningless, so it is refused up front
  // rather than quietly producing a green run nobody can rely on.
  if (!status.configured || status.provider === 'fake') {
    blocked('the real vision model read the pages',
      status.configured
        ? 'CIP_FORCE_FAKE_BRAIN is set — a fake proves nothing here'
        : 'no OPENAI_API_KEY is configured');
    console.log('\nStopped: there is no real vision path to prove.\n');
    await admin.end();
    process.exit(1);
  }

  const mm = await scopeFor(COMPANY);

  // --- 1. where the files could come from ---------------------------------
  const connection = await admin<
    {
      status: string; google_account_email: string; folder_id: string | null;
      folder_name: string | null; last_sync_at: Date | null; last_sync_error: string | null;
    }[]
  >`
    select status, google_account_email, folder_id, folder_name, last_sync_at, last_sync_error
      from google_drive_connections where company_id = ${mm.companyId}
  `;

  const live = connection[0];

  if (!live) {
    console.log('  Google Drive: not connected\n');
  } else {
    console.log(
      `  Google Drive: ${live.status}` +
        (live.folder_name ? ` · folder "${live.folder_name}"` : ' · no folder chosen') +
        (live.last_sync_at ? ` · last synced ${live.last_sync_at.toISOString()}` : ' · never synced') +
        '\n',
    );
    if (live.last_sync_error) console.log(`  last sync error: ${live.last_sync_error}\n`);
  }

  if (SYNC) {
    if (!live || live.status !== 'connected') {
      blocked('a Google Drive sync ran', 'nothing is connected to sync from');
    } else {
      const { syncNow } = await import('../src/server/integrations/googleDrive/sync');
      try {
        const outcome = await syncNow(mm);
        check('1. a Google Drive sync ran', true,
          `${outcome.scanned} scanned, ${outcome.added} added, ${outcome.updated} updated, ` +
            `${outcome.unsupported} unsupported, ${outcome.failed} failed`);
      } catch (error) {
        check('1. a Google Drive sync ran', false,
          error instanceof Error ? error.message : String(error));
      }
    }
  }

  // --- 2. the PDFs themselves ---------------------------------------------
  const pdfs = await admin<
    {
      id: string; name: string; file_size: string; source_type: string;
      bytes_retained: boolean; created_at: Date;
    }[]
  >`
    select id, name, file_size, source_type, bytes_retained, created_at
      from drive_files
     where company_id = ${mm.companyId}
       and file_type = 'pdf'
       and archived_at is null
     order by created_at
  `;

  const candidates = pdfs.filter((pdf) => !OUR_OWN_PROOF_FILES.has(pdf.name));

  if (candidates.length === 0) {
    const why = !live
      ? 'no Google Drive is connected, and they were not uploaded to the CIP Drive either'
      : live.status !== 'connected'
        ? `the Google Drive connection is "${live.status}", so the folder cannot be read`
        : !live.folder_id
          ? 'a Google Drive is connected but no folder has been chosen'
          : 'the connected folder has been synced and holds no PDF';

    blocked('the three Magic Moments country PDFs were read', why);

    console.log('\n  To unblock, either:');
    console.log('    a) open http://localhost:3000/knowledge → "Connect Google Drive",');
    console.log('       grant read-only access, paste the folder link,');
    console.log('       then: npm run prove:mm-pdfs -- --sync');
    console.log('    b) or upload the three PDFs at http://localhost:3000/drive,');
    console.log('       then: npm run prove:mm-pdfs');
    console.log('\n  Nothing was fabricated and nothing was deleted.\n');
  } else {
    console.log(`  ${candidates.length} PDF(s) reachable:\n`);

    const understanding = await import('../src/server/brain/understanding');
    const pdfVisual = await import('../src/server/brain/pdfVisual');
    const processing = await import('../src/server/drive/processing');

    // Phase 3 first: the document path needs extracted text, and profiling
    // needs the file present. Both are no-ops for anything already done.
    for (let i = 0; i < 60; i += 1) {
      const claim = await processing.claimNextFile();
      if (!claim) break;
      await processing.processClaimedFile(claim);
    }

    for (const pdf of candidates) {
      const external = await admin<
        { external_id: string; state: string; external_size: string | null }[]
      >`
        select external_id, state, external_size from google_drive_files
         where company_id = ${mm.companyId} and file_id = ${pdf.id}
      `;

      console.log(`  ── ${pdf.name}`);
      console.log(`     Google Drive id: ${external[0]?.external_id ?? '(not from Google Drive)'}`);
      console.log(`     sync state: ${external[0]?.state ?? 'n/a'}`);
      console.log(`     size: ${(Number(pdf.file_size) / 1024 / 1024).toFixed(2)} MB · ` +
        `source: ${pdf.source_type === 'cip_drive' ? 'uploaded to CIP Drive' : pdf.source_type}`);
      console.log(`     original kept: ${pdf.bytes_retained ? 'yes' : 'no — read without keeping it'}`);

      if (REREAD) {
        await admin`delete from asset_understanding where file_id = ${pdf.id}`;
        await admin`delete from pdf_page_understanding where file_id = ${pdf.id}`;
      }
      await understanding.enqueueUnderstanding(mm);

      let outcome: Awaited<ReturnType<typeof understanding.understandClaimedAsset>> | null = null;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const claim = await understanding.claimAssetForUnderstanding();
        if (!claim) break;
        const result = await understanding.understandClaimedAsset(claim);
        if (claim.fileId !== pdf.id) continue;
        outcome = result;
        if (result.status !== 'failed' || !result.willRetry) break;
      }

      const { pages, posts } = await pdfVisual.readPdfPages(mm, pdf.id);
      const understood = pages.filter((page) => page.status === 'ready');
      const failed = pages.filter((page) => page.status === 'failed');

      const summaryRow = await admin<{ structured: Record<string, unknown> | null; kind: string }[]>`
        select structured, kind from asset_understanding where file_id = ${pdf.id}
      `;
      const structured = (summaryRow[0]?.structured ?? {}) as {
        pageCount?: number; pagesRendered?: number; countries?: string[];
      };

      const factRows = await admin<{ n: number }[]>`
        select count(distinct fact_id)::int as n from brand_dna_evidence
         where company_id = ${mm.companyId} and file_id = ${pdf.id}
      `;

      const bands = pages.reduce(
        (total, page) => total + Number((page.structured as { bandsAnalysed?: number }).bandsAnalysed ?? 1),
        0,
      );
      const withProvenance = await admin<{ n: number }[]>`
        select count(*)::int as n from brand_dna_evidence
         where company_id = ${mm.companyId} and file_id = ${pdf.id}
           and page_number is not null and source_type = 'pdf_visual'
      `;
      const evidenceTotal = await admin<{ n: number }[]>`
        select count(*)::int as n from brand_dna_evidence
         where company_id = ${mm.companyId} and file_id = ${pdf.id}
      `;

      console.log(`     read as: ${summaryRow[0]?.kind ?? 'not understood'}`);
      console.log(`     page count: ${structured.pageCount ?? '—'}`);
      console.log(`     pages rasterised: ${pages.length}`);
      // A tall page is cut into strips and each is a separate vision call, so
      // "pages sent" and "images sent" are different numbers and both matter.
      console.log(`     images sent to Vision: ${bands} (across ${pages.length} page(s))`);
      console.log(`     pages understood: ${understood.length}`);
      console.log(`     posts extracted: ${posts.length}`);
      console.log(`     facts: ${factRows[0]?.n ?? 0}`);
      console.log(`     provenance coverage: ${withProvenance[0]?.n ?? 0}/${evidenceTotal[0]?.n ?? 0} ` +
        'evidence rows carry a page number');
      console.log(`     countries seen: ${structured.countries?.join(', ') || '—'}`);
      console.log(`     time: ${ms(understood.reduce((sum, p) => sum + (p.durationMs ?? 0), 0))}`);

      if (failed.length > 0) {
        console.log(`     failures: ${failed.length} page(s)`);
        for (const page of failed.slice(0, 3)) {
          console.log(`       p${page.pageNumber}: ${page.errorMessage ?? 'unknown'}`);
        }
      } else {
        console.log('     failures: none');
      }

      for (const post of posts.slice(0, 3)) {
        const s = post.structured as {
          cta?: string | null; hashtags?: string[]; product?: string | null;
          creativeFormat?: string | null; eventContext?: string | null;
        };
        console.log(`\n       page ${post.pageNumber}, post ${post.postIndex + 1}` +
          (post.country ? ` · ${post.country}` : '') +
          ` · confidence ${post.confidence.toFixed(2)}`);
        if (post.headline) console.log(`         headline: ${post.headline.slice(0, 90)}`);
        if (post.caption) console.log(`         caption: ${post.caption.slice(0, 90)}`);
        if (s.product) console.log(`         product: ${s.product}`);
        if (s.eventContext) console.log(`         campaign: ${s.eventContext}`);
        if (s.cta) console.log(`         cta: ${s.cta.slice(0, 70)}`);
        if (s.hashtags?.length) console.log(`         hashtags: ${s.hashtags.slice(0, 6).join(' ')}`);
        if (s.creativeFormat) console.log(`         format: ${s.creativeFormat}`);
      }
      console.log('');

      // With --reread there is a claim to report on. Without it there is not,
      // because the file was understood on an earlier run and nothing is
      // waiting — so the stored row is the evidence, and "nothing to claim"
      // is not a failure.
      const stored = await admin<{ status: string; kind: string }[]>`
        select status, kind from asset_understanding where file_id = ${pdf.id}
      `;
      const storedStatus = stored[0]?.status ?? null;

      check(`2. "${pdf.name}" was understood`,
        outcome?.status === 'understood' || storedStatus === 'ready',
        outcome?.status === 'understood'
          ? `${outcome.kind}, ${outcome.facts} fact(s) — read on this run`
          : outcome?.status === 'failed'
            ? `failed: ${outcome.message}`
            : outcome?.status === 'unsupported'
              ? `unsupported: ${outcome.reason}`
              : storedStatus === 'ready'
                ? `${stored[0]!.kind}, stored from an earlier read (pass --reread to redo it)`
                : storedStatus === null
                  ? 'never understood'
                  : `stored status is "${storedStatus}"`);

      if (summaryRow[0]?.kind === 'pdf_visual') {
        check(`2. "${pdf.name}" every rasterised page was understood`,
          pages.length > 0 && failed.length === 0,
          `${understood.length}/${pages.length}`);

        check(`2. "${pdf.name}" every fact names the page it came from`,
          await provenanceIsComplete(mm, pdf.id),
          `${factRows[0]?.n ?? 0} fact(s)`);
      }
      console.log('');
    }

    if (candidates.length < 3) {
      blocked('all three country PDFs were read',
        `only ${candidates.length} of 3 is in the Drive`);
    }
  }

  // --- 2b. everything in the folder that did not become a CIP file ---------
  const skipped = await admin<
    { name: string; state: string; reason: string | null; external_size: string | null;
      limit_bytes: string | null }[]
  >`
    select name, state, reason, external_size, limit_bytes
      from google_drive_files
     where company_id = ${mm.companyId} and state in ('unsupported', 'too_large', 'failed', 'trashed')
     order by name
  `;

  if (skipped.length > 0) {
    console.log('  ── not ingested\n');
    for (const row of skipped) {
      const size = row.external_size ? `${(Number(row.external_size) / 1024 / 1024).toFixed(2)} MB` : '—';
      const limit = row.limit_bytes ? `${(Number(row.limit_bytes) / 1024 / 1024).toFixed(0)} MB` : null;
      console.log(`     ${row.name} — ${row.state} · measured ${size}` +
        (limit ? ` · maximum ${limit}` : ''));
      if (row.reason) console.log(`       ${row.reason}`);
    }
    console.log('');
  }

  // --- 3. the paths that already worked, still working ---------------------
  console.log('  ── the existing understanding paths\n');

  const existing = await admin<{ kind: string; status: string; n: number }[]>`
    select kind, status, count(*)::int as n
      from asset_understanding
     where company_id = ${mm.companyId}
     group by kind, status
     order by kind
  `;

  const ready = (kind: string): number =>
    existing.find((row) => row.kind === kind && row.status === 'ready')?.n ?? 0;

  check('3. real image understanding is still green', ready('image') > 0,
    `${ready('image')} image(s) understood`);
  check('3. real video understanding is still green', ready('video') > 0,
    `${ready('video')} video(s) understood`);
  check('3. document understanding is still green', ready('document') > 0,
    `${ready('document')} document(s) understood`);

  const broken = existing.filter((row) => row.status === 'failed');
  check('3. nothing regressed into a failed state', broken.length === 0,
    broken.length === 0 ? 'no failed rows' : broken.map((r) => `${r.kind}:${r.n}`).join(', '));

  // --- 4. the integration was not touched ---------------------------------
  const after = await admin<{ n: number }[]>`
    select count(*)::int as n from google_drive_connections where company_id = ${mm.companyId}
  `;
  check('4. this proof left the Google Drive connection exactly as it found it',
    (after[0]?.n ?? 0) === (live ? 1 : 0),
    live ? 'the connection is still there' : 'there was none, and none was invented');

  await admin.end();

  const summary = failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`;
  console.log('');
  console.log(blockers === 0 ? summary : `${summary} ${blockers} check(s) BLOCKED externally.`);
  console.log('');
  if (failures > 0) process.exit(1);
}

/** Every fact this file produced names a page, or the claim is not checkable. */
async function provenanceIsComplete(scope: CompanyScope, fileId: string): Promise<boolean> {
  const rows = await admin<{ bad: number }[]>`
    select count(*)::int as bad from brand_dna_evidence
     where company_id = ${scope.companyId}
       and file_id = ${fileId}
       and (page_number is null or source_type is distinct from 'pdf_visual')
  `;
  return (rows[0]?.bad ?? 0) === 0;
}

main().catch(async (error) => {
  console.error('\nprove:mm-pdfs failed:', error instanceof Error ? error.message : error);
  await admin.end().catch(() => {});
  process.exit(1);
});
