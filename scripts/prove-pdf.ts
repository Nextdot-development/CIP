import postgres from 'postgres';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { buildPdf } from '../tests/helpers/pdf';
import type { CompanyScope } from '../src/server/db';

/**
 * Reading a PDF by looking at it, against the real vision model.
 *
 *   npm run prove:pdf                 # a PDF built from this company's own assets
 *   npm run prove:pdf -- --file <id>  # a PDF already in the Drive
 *
 * The offline suite proves the machinery with a deterministic fake. This proves
 * the part a fake cannot: that a real model, shown a real rendered page of
 * social posts, reads them — captions, calls to action, hashtags — and that
 * what it read reaches Brand DNA with the page it was seen on.
 *
 * With no --file it composes one. The pictures are this company's own generated
 * images and the captions are its own brand language, laid out as an Instagram
 * grid and exported as an image-only PDF: exactly the shape that has no text
 * layer, which is the case the whole feature exists for. Nothing about the
 * result is simulated — only the arrangement of real assets into a document.
 */

const FILE_ARG = process.argv.indexOf('--file');
const EXISTING_FILE_ID = FILE_ARG > -1 ? process.argv[FILE_ARG + 1] : null;
const PROOF_FILENAME = 'brain-proof-instagram.pdf';

let failures = 0;
function check(label: string, pass: boolean, detail = ''): void {
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures += 1;
}

let blockers = 0;
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

/** Real generated images belonging to this company. */
async function brandImages(scope: CompanyScope): Promise<Buffer[]> {
  const rows = await admin<{ storage_path: string }[]>`
    select a.storage_path
      from media_generation_assets a
      join media_generations g on g.id = a.generation_id
     where g.company_id = ${scope.companyId}
       and a.mime_type like 'image/%'
     order by a.created_at desc
     limit 6
  `;

  const { driveStorage } = await import('../src/server/drive/storage');
  const out: Buffer[] = [];
  for (const row of rows) {
    try {
      out.push(await driveStorage().get(row.storage_path));
    } catch {
      // An asset whose bytes have gone is simply not used.
    }
  }
  return out;
}

/**
 * One page of an Instagram grid: two post cards, each a real image with a real
 * caption under it.
 *
 * Drawn rather than screenshotted because a screenshot of a real feed would
 * carry other people's content. The point is the shape — pictures with legible
 * text beneath, no text layer — which is what the pipeline has to cope with.
 */
async function postPage(
  images: Buffer[],
  posts: { caption: string; cta: string; tags: string }[],
): Promise<Buffer> {
  const width = 1200;
  const height = 1600;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#faf7f2';
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = '#1a1a1a';
  ctx.font = 'bold 44px sans-serif';
  ctx.fillText('@magicmoments.in', 60, 90);
  ctx.font = '28px sans-serif';
  ctx.fillStyle = '#666';
  ctx.fillText('India · Instagram', 60, 134);

  let y = 200;
  for (const [index, post] of posts.entries()) {
    const source = images[index % images.length];
    if (source) {
      const image = await loadImage(source);
      ctx.drawImage(image, 60, y, 620, 620);
    }

    ctx.fillStyle = '#1a1a1a';
    ctx.font = 'bold 32px sans-serif';
    ctx.fillText(post.caption.slice(0, 46), 60, y + 680);
    ctx.font = '28px sans-serif';
    ctx.fillStyle = '#444';
    ctx.fillText(post.cta, 60, y + 726);
    ctx.fillStyle = '#3b6ea5';
    ctx.fillText(post.tags, 60, y + 768);

    y += 830;
  }

  return canvas.toBuffer('image/jpeg', 0.9);
}

async function main() {
  console.log(`\nPDF visual understanding, against the real model — ${new Date().toISOString()}\n`);

  const { brainStatus } = await import('../src/server/brain/providers');
  const status = brainStatus();
  console.log(`  Brain provider: ${status.provider} / ${status.model} ` +
    `(${status.configured ? 'configured' : 'NOT configured'})\n`);

  if (!status.configured) {
    blocked('a real vision model read the pages', 'no OPENAI_API_KEY, so nothing real can be proved');
    console.log('\n1 check(s) BLOCKED externally.\n');
    await admin.end();
    process.exit(1);
  }
  if (status.provider === 'fake') {
    blocked('a real vision model read the pages',
      'CIP_FORCE_FAKE_BRAIN is set, so this would prove nothing');
    console.log('\n1 check(s) BLOCKED externally.\n');
    await admin.end();
    process.exit(1);
  }

  const mm = await scopeFor('magic-moments');
  const drive = await import('../src/server/drive/service');
  const understanding = await import('../src/server/brain/understanding');
  const pdfVisual = await import('../src/server/brain/pdfVisual');
  const pdfRender = await import('../src/server/drive/extraction/pdfRender');
  const extraction = await import('../src/server/drive/extraction');

  // --- 1. a real PDF with no text layer -----------------------------------
  let fileId: string;
  let filename: string;

  if (EXISTING_FILE_ID) {
    const rows = await admin<{ id: string; name: string }[]>`
      select id, name from drive_files
       where id = ${EXISTING_FILE_ID} and company_id = ${mm.companyId} and archived_at is null
    `;
    if (!rows[0]) {
      blocked('the named PDF was read', `no PDF ${EXISTING_FILE_ID} in this company Drive`);
      console.log('\n1 check(s) BLOCKED externally.\n');
      await admin.end();
      process.exit(1);
    }
    fileId = rows[0].id;
    filename = rows[0].name;
    console.log(`  reading "${filename}" from the Drive\n`);
  } else {
    const images = await brandImages(mm);
    if (images.length === 0) {
      blocked('a PDF of this company own posts was built',
        'no generated images to build one from — generate one first, or pass --file');
      console.log('\n1 check(s) BLOCKED externally.\n');
      await admin.end();
      process.exit(1);
    }

    const pageOne = await postPage(images, [
      {
        caption: 'Har lamha, ek nayi shuruaat',
        cta: 'Tag the friend who never misses a celebration',
        tags: '#MagicMoments #Diwali2025 #FestiveNights',
      },
      {
        caption: 'World Heart Day: beat for the ones you love',
        cta: 'Learn more at the link in bio',
        tags: '#WorldHeartDay #HealthyHearts #MagicMoments',
      },
    ]);

    const pageTwo = await postPage(images.slice(1).concat(images), [
      {
        caption: 'New Year, same warm gold',
        cta: 'Shop the festive gift pack now',
        tags: '#NewYear #GiftPack #MagicMoments',
      },
      {
        caption: 'Golden hour, every hour',
        cta: 'Discover the collection',
        tags: '#GoldenHour #Celebrate #MagicMoments',
      },
    ]);

    const pdf = buildPdf([
      { kind: 'image', jpeg: pageOne, width: 1200, height: 1600 },
      { kind: 'image', jpeg: pageTwo, width: 1200, height: 1600 },
    ]);

    // Replace only our own proof file. Nothing a person uploaded is touched.
    const previous = await admin<{ id: string }[]>`
      select id from drive_files
       where company_id = ${mm.companyId} and name = ${PROOF_FILENAME} and archived_at is null
    `;
    for (const old of previous) await drive.deleteFileForever(mm, old.id).catch(() => {});

    const file = await drive.uploadFile(mm, {
      folderId: null,
      filename: PROOF_FILENAME,
      mimeType: 'application/pdf',
      body: pdf,
    });
    fileId = file.id;
    filename = file.name;

    // The premise, verified rather than asserted: this file really is unreadable
    // as text, exactly like an Instagram page exported to PDF.
    const asText = await extraction.runExtraction('pdf', pdf);
    check('1. the PDF genuinely has no text layer',
      asText.content.trim().length === 0 && asText.warnings.includes('no-text-layer'),
      `${asText.content.trim().length} chars of text, warnings: ${asText.warnings.join(', ') || 'none'}`);

    const profile = await pdfRender.profilePdf(pdf);
    check('1. and CIP decides to look at it rather than read it',
      pdfVisual.needsVisualPass(profile),
      `${profile.pageCount} page(s), text layer: ${profile.hasTextLayer}`);
  }

  // --- 2. the real model reads the pages -----------------------------------
  console.log('\n  (analysing with the real vision model — this costs money)\n');

  // Re-read from scratch, so a rerun proves the work rather than a cache.
  await admin`delete from asset_understanding where file_id = ${fileId}`;
  await understanding.enqueueUnderstanding(mm);

  let outcome: Awaited<ReturnType<typeof understanding.understandClaimedAsset>> | null = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const claim = await understanding.claimAssetForUnderstanding();
    if (!claim) break;
    const result = await understanding.understandClaimedAsset(claim);
    if (claim.fileId === fileId) {
      outcome = result;
      if (result.status !== 'failed' || !result.willRetry) break;
    }
  }

  check('2. the PDF was understood visually',
    outcome?.status === 'understood' && outcome.kind === 'pdf_visual',
    outcome === null
      ? 'it was never claimed'
      : outcome.status === 'understood'
        ? `${outcome.kind}, ${outcome.facts} fact(s)`
        : outcome.status === 'failed'
          ? `failed: ${outcome.message}`
          : `unsupported: ${outcome.reason}`);

  const { pages, posts } = await pdfVisual.readPdfPages(mm, fileId);

  check('2. every page was rendered and looked at',
    pages.length > 0 && pages.every((page) => page.status === 'ready'),
    `${pages.filter((p) => p.status === 'ready').length}/${pages.length} page(s) ready` +
      (pages.some((p) => p.errorMessage) ? ` — ${pages.find((p) => p.errorMessage)?.errorMessage}` : ''));

  check('2. posts were found on the pages, separately',
    posts.length > 0,
    `${posts.length} post(s) across ${new Set(posts.map((p) => p.pageNumber)).size} page(s)`);

  // --- 3. what it actually read --------------------------------------------
  const withCaption = posts.filter((post) => post.caption && post.caption.trim().length > 0);
  check('3. captions were read off the page',
    withCaption.length > 0,
    `${withCaption.length}/${posts.length} post(s) carry a caption`);

  const withCta = posts.filter(
    (post) => typeof (post.structured as { cta?: unknown }).cta === 'string',
  );
  const withTags = posts.filter(
    (post) => ((post.structured as { hashtags?: string[] }).hashtags ?? []).length > 0,
  );
  check('3. calls to action and hashtags were read',
    withCta.length > 0 || withTags.length > 0,
    `${withCta.length} with a CTA, ${withTags.length} with hashtags`);

  for (const post of posts.slice(0, 4)) {
    const s = post.structured as { cta?: string | null; hashtags?: string[]; creativeFormat?: string | null };
    console.log(
      `\n     page ${post.pageNumber} post ${post.postIndex + 1}` +
        (post.country ? ` · ${post.country}` : '') +
        ` · confidence ${post.confidence.toFixed(2)}`,
    );
    if (post.caption) console.log(`       caption: ${post.caption.slice(0, 100)}`);
    if (s.cta) console.log(`       cta: ${s.cta.slice(0, 80)}`);
    if (s.hashtags?.length) console.log(`       hashtags: ${s.hashtags.slice(0, 6).join(' ')}`);
    if (s.creativeFormat) console.log(`       format: ${s.creativeFormat}`);
  }
  console.log('');

  // --- 4. it reached Brand DNA, with provenance ----------------------------
  const evidence = await admin<
    { attribute: string; value: string; page_number: number | null; source_type: string | null }[]
  >`
    select f.attribute, f.value, e.page_number, e.source_type
      from brand_dna_evidence e
      join brand_dna_facts f on f.id = e.fact_id
     where e.company_id = ${mm.companyId} and e.file_id = ${fileId}
     order by e.page_number
  `;

  check('4. what was seen became Brand DNA evidence',
    evidence.length > 0, `${evidence.length} fact(s) evidenced by this PDF`);

  check('4. and every visual claim names the page it was seen on',
    evidence.length > 0 &&
      evidence.every((row) => row.source_type === 'pdf_visual' && row.page_number !== null),
    evidence.length === 0
      ? 'no evidence to check'
      : `all ${evidence.length} carry a page number and source type`);

  for (const row of evidence.slice(0, 6)) {
    console.log(`     p${row.page_number}: ${row.attribute} = ${row.value.slice(0, 80)}`);
  }
  console.log('');

  // --- 5. it is retrievable ------------------------------------------------
  const retrieval = await import('../src/server/brain/retrieval');
  const found = await retrieval.similarPosts(mm, 'a festive Diwali Instagram post with a call to action');
  check('5. a past post can be retrieved by what it was about',
    found.length > 0,
    found.length > 0
      ? `${found.length} post(s), best ${found[0]!.score.toFixed(3)} — ${found[0]!.summary.slice(0, 60)}`
      : 'nothing matched, or this database has no pgvector');

  // --- 6. nothing sensitive leaves -----------------------------------------
  const payload = JSON.stringify({ pages, posts });
  const leaks = ['companies/', mm.companyId, 'storage_path', 'sk-'].filter((f) => payload.includes(f));
  check('6. the inspection view carries no path, company id or credential',
    leaks.length === 0,
    leaks.length === 0 ? 'checked every field' : leaks.join(', '));

  // --- 7. the three country PDFs -------------------------------------------
  const country = await admin<{ id: string; name: string }[]>`
    select id, name from drive_files
     where company_id = ${mm.companyId} and file_type = 'pdf' and archived_at is null
       and name <> ${PROOF_FILENAME}
  `;

  if (country.length === 0) {
    const connected = await admin<{ n: number }[]>`
      select count(*)::int as n from google_drive_connections where company_id = ${mm.companyId}
    `;
    blocked('7. the three Magic Moments country PDFs were read',
      connected[0]?.n === 0
        ? 'they are not in the CIP Drive and no Google Drive is connected, so they cannot be fetched'
        : 'they are not in the CIP Drive — run a Google Drive sync, or upload them directly');
  } else {
    console.log(`  ${country.length} other PDF(s) in the Drive:`);
    for (const pdf of country) console.log(`     ${pdf.name} — npm run prove:pdf -- --file ${pdf.id}`);
    console.log('');
  }

  await admin.end();

  const summary = failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`;
  console.log('');
  console.log(blockers === 0 ? summary : `${summary} ${blockers} check(s) BLOCKED externally.`);
  console.log('');
  if (failures > 0) process.exit(1);
}

main().catch(async (error) => {
  console.error('\nprove:pdf failed:', error instanceof Error ? error.message : error);
  await admin.end().catch(() => {});
  process.exit(1);
});
