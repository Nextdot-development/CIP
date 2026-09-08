import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { startTestDatabase } from './harness';
import type { TestDb } from './harness';
import { buildPdf, solidJpeg } from './helpers/pdf';

/**
 * Reading a PDF by looking at it.
 *
 * Every PDF here is a real file, assembled byte by byte and parsed by the same
 * pdf.js the product uses — a fixture that merely claims to be a PDF would
 * prove nothing about a pipeline whose whole job is reading real ones. The
 * vision model is the deterministic fake, so the suite needs no key and no
 * bill; what it tests is the machinery around the model.
 *
 * The case that matters most is the one that motivated the feature: a PDF of
 * screenshots, which has no text layer at all and which the text extractor
 * reads as empty.
 */

let db: TestDb;
let appSql: postgres.Sql;
let adminSql: postgres.Sql;
let storageDir: string;

type Scope = { companyId: string; userId: string; role: 'owner' };
let mm: Scope;
let nh: Scope;

let understanding: typeof import('../src/server/brain/understanding');
let pdfVisual: typeof import('../src/server/brain/pdfVisual');
let pdfRender: typeof import('../src/server/drive/extraction/pdfRender');
let extraction: typeof import('../src/server/drive/extraction');
let providers: typeof import('../src/server/brain/providers');
let drive: typeof import('../src/server/drive/service');
let processing: typeof import('../src/server/drive/processing');

let fake: import('../src/server/brain/providers').FakeBrainProvider;

/** Two different pictures, so pages are not accidentally identical. */
let redJpeg: Buffer;
let blueJpeg: Buffer;

const uploadPdf = (scope: Scope, filename: string, body: Buffer) =>
  drive.uploadFile(scope, { folderId: null, filename, mimeType: 'application/pdf', body });

/** Runs the understanding queue to completion, as the worker does. */
async function understandAll(): Promise<
  Awaited<ReturnType<typeof understanding.understandClaimedAsset>>[]
> {
  const outcomes = [];
  for (let i = 0; i < 60; i += 1) {
    const claim = await understanding.claimAssetForUnderstanding();
    if (!claim) break;
    outcomes.push(await understanding.understandClaimedAsset(claim));
  }
  return outcomes;
}

/** Runs the Phase 3 text extractor, which the document path depends on. */
async function extractAll(): Promise<void> {
  for (;;) {
    const file = await processing.claimNextFile();
    if (!file) break;
    await processing.processClaimedFile(file);
  }
}

before(async () => {
  db = await startTestDatabase();
  storageDir = mkdtempSync(join(tmpdir(), 'cip-pdf-'));

  process.env.DATABASE_ADMIN_URL = db.adminUrl;
  process.env.CIP_APP_DB_PASSWORD = db.appPassword;
  process.env.SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.CIP_SEED_PASSWORD = 'cip-demo-password';
  process.env.CIP_STORAGE_DIR = storageDir;
  process.env.CIP_FORCE_LOCAL_STORAGE = 'true';
  process.env.CIP_FORCE_FAKE_BRAIN = 'true';
  process.env.CIP_FORCE_FAKE_PROVIDERS = 'true';

  const { migrate } = await import('../src/server/migrate');
  await migrate(() => {}, { skip: db.skipMigrations });
  const { seed } = await import('../src/server/seed');
  await seed(() => {});

  process.env.DATABASE_URL = db.appUrl;
  understanding = await import('../src/server/brain/understanding');
  pdfVisual = await import('../src/server/brain/pdfVisual');
  pdfRender = await import('../src/server/drive/extraction/pdfRender');
  extraction = await import('../src/server/drive/extraction');
  providers = await import('../src/server/brain/providers');
  drive = await import('../src/server/drive/service');
  processing = await import('../src/server/drive/processing');

  const { FakeBrainProvider } = await import('../src/server/brain/providers/fake');
  fake = new FakeBrainProvider();
  providers.__setBrain(fake);

  adminSql = postgres(db.adminUrl, { onnotice: () => {} });
  appSql = postgres(db.appUrl, { onnotice: () => {} });

  redJpeg = await solidJpeg(700, 700, { r: 210, g: 40, b: 60 });
  blueJpeg = await solidJpeg(700, 700, { r: 30, g: 60, b: 200 });

  const rows = await adminSql<{ slug: string; company_id: string; user_id: string }[]>`
    select c.slug, c.id as company_id, u.id as user_id
      from companies c
      join memberships m on m.company_id = c.id
      join users u on u.id = m.user_id
     where u.email in ('sneha@magicmoments.test', 'rahul@narayanahealth.test')
  `;
  const a = rows.find((r) => r.slug === 'magic-moments')!;
  const b = rows.find((r) => r.slug === 'narayana-health')!;
  mm = { companyId: a.company_id, userId: a.user_id, role: 'owner' };
  nh = { companyId: b.company_id, userId: b.user_id, role: 'owner' };
}, { timeout: 180_000 });

beforeEach(async () => {
  fake.reset();
  delete process.env.CIP_PDF_MAX_RENDER_PAGES;
  await adminSql`delete from pdf_post`;
  await adminSql`delete from pdf_page_understanding`;
  await adminSql`delete from brand_dna_evidence`;
  await adminSql`delete from brand_dna_facts`;
  await adminSql`delete from asset_understanding`;
  await adminSql`delete from drive_files`;
});

after(async () => {
  await appSql?.end({ timeout: 5 });
  await adminSql?.end({ timeout: 5 });
  await db?.stop();
  try {
    rmSync(storageDir, { recursive: true, force: true });
  } catch {
    /* temp dir */
  }
});

// ---------------------------------------------------------------------------

describe('deciding how to read a PDF', () => {
  it('reads a text PDF as text, and never renders it', async () => {
    const pdf = buildPdf([
      {
        kind: 'text',
        text:
          'Magic Moments brand guidelines. Our tone of voice is warm and celebratory.\n' +
          'We talk about the occasion, never about the alcohol itself.\n' +
          'Primary typeface is a humanist sans. Secondary is a serif for headlines.\n' +
          'Calls to action are gentle invitations rather than instructions.',
      },
      {
        kind: 'text',
        text:
          'Colour: deep amber and warm gold carry the brand across every market.\n' +
          'Photography is shot at golden hour with soft, practical light sources.\n' +
          'People are shown mid-conversation rather than posed to camera.',
      },
    ]);

    const profile = await pdfRender.profilePdf(pdf);
    assert.equal(profile.hasTextLayer, true, 'a text PDF should be seen to have text');
    assert.equal(profile.hasImages, false);
    assert.equal(pdfVisual.needsVisualPass(profile), false, 'text-only PDFs must not be rendered');

    const file = await uploadPdf(mm, 'guidelines.pdf', pdf);
    await extractAll();
    await understanding.enqueueUnderstanding(mm);
    const outcomes = await understandAll();

    assert.equal(outcomes[0]?.status, 'understood');
    assert.equal(fake.calls.document, 1, 'the document path should have been used');
    assert.equal(fake.calls.pdfPage, 0, 'a text PDF must not cost a vision call per page');

    const pages = await adminSql`select 1 from pdf_page_understanding where file_id = ${file.id}`;
    assert.equal(pages.length, 0, 'nothing should have been rendered');
  });

  it('reads a PDF of screenshots by looking at it', async () => {
    const pdf = buildPdf([
      { kind: 'image', jpeg: redJpeg, width: 700, height: 700 },
      { kind: 'image', jpeg: blueJpeg, width: 700, height: 700 },
    ]);

    // The premise of the whole feature: the text extractor finds nothing here.
    const text = await extraction.runExtraction('pdf', pdf);
    assert.equal(text.content, '', 'a screenshot PDF has no text to read');
    assert.ok(text.warnings.includes('no-text-layer'));

    const profile = await pdfRender.profilePdf(pdf);
    assert.equal(profile.hasTextLayer, false);
    assert.equal(pdfVisual.needsVisualPass(profile), true);

    const file = await uploadPdf(mm, 'instagram-india.pdf', pdf);
    await extractAll();
    await understanding.enqueueUnderstanding(mm);
    const outcomes = await understandAll();

    assert.equal(outcomes[0]?.status, 'understood');
    assert.equal(
      outcomes[0]?.status === 'understood' ? outcomes[0].kind : null,
      'pdf_visual',
      'a screenshot PDF must be understood visually',
    );
    assert.equal(fake.calls.pdfPage, 2, 'both pages should have been looked at');

    const pages = await adminSql<{ page_number: number; status: string; image_path: string }[]>`
      select page_number, status, image_path from pdf_page_understanding
       where file_id = ${file.id} order by page_number
    `;
    assert.equal(pages.length, 2);
    assert.deepEqual(pages.map((p) => p.page_number), [1, 2]);
    assert.ok(pages.every((p) => p.status === 'ready'));
    assert.ok(pages.every((p) => p.image_path && p.image_path.includes(mm.companyId)));

    const kind = await adminSql<{ kind: string }[]>`
      select kind from asset_understanding where file_id = ${file.id}
    `;
    assert.equal(kind[0]?.kind, 'pdf_visual');
  });

  it('renders the pictures in a mixed PDF, and passes their text along too', async () => {
    const pdf = buildPdf([
      {
        kind: 'text',
        text:
          'Magic Moments UAE — quarterly social review. This deck covers the festive\n' +
          'campaign, the New Year push and the always-on brand content that ran\n' +
          'between them across every owned channel in the market this quarter.',
      },
      { kind: 'mixed', text: 'Diwali carousel, 12 January', jpeg: redJpeg, width: 700, height: 700 },
    ]);

    const profile = await pdfRender.profilePdf(pdf);
    assert.equal(profile.hasTextLayer, true, 'the first page carries real text');
    assert.equal(profile.hasImages, true);
    assert.equal(
      pdfVisual.needsVisualPass(profile),
      true,
      'text plus pictures still needs looking at: the pictures are the brand',
    );

    // Only the page that shows something is worth the cost.
    assert.deepEqual(pdfVisual.pagesToRender(profile), [2]);

    const file = await uploadPdf(mm, 'uae-review.pdf', pdf);
    await extractAll();
    await understanding.enqueueUnderstanding(mm);
    await understandAll();

    assert.equal(fake.calls.pdfPage, 1, 'only the picture page should have been rendered');

    const pages = await adminSql<{ page_number: number; page_text: string | null }[]>`
      select page_number, page_text from pdf_page_understanding where file_id = ${file.id}
    `;
    assert.equal(pages.length, 1);
    assert.equal(pages[0]?.page_number, 2);
    assert.ok(
      pages[0]?.page_text?.includes('Diwali carousel'),
      'the text already read off the page should be kept with it',
    );
  });
});

describe('posts on a page', () => {
  it('records each post separately, not one blob per PDF', async () => {
    // Six pages, because how many posts the fake finds is derived from the
    // page bytes: one or two pages could legitimately yield none, and a test
    // that assumed otherwise would fail on the picture rather than the code.
    const pdf = buildPdf(
      Array.from({ length: 6 }, (_, n) => ({
        kind: 'image' as const,
        jpeg: n % 2 === 0 ? redJpeg : blueJpeg,
        width: 700,
        height: 700,
      })),
    );

    const file = await uploadPdf(mm, 'posts.pdf', pdf);
    await extractAll();
    await understanding.enqueueUnderstanding(mm);

    // What the provider actually reported, so the assertion is against the
    // real answer rather than a number written into the test twice.
    const reported = new Map<number, number>();
    const original = fake.analyzePdfPage.bind(fake);
    fake.analyzePdfPage = async (input) => {
      const analysis = await original(input);
      reported.set(input.pageNumber, analysis.posts.length);
      return analysis;
    };

    try {
      await understandAll();
    } finally {
      fake.analyzePdfPage = original;
    }

    const posts = await adminSql<
      { page_number: number; post_index: number; summary: string; confidence: string }[]
    >`
      select page_number, post_index, summary, confidence from pdf_post
       where file_id = ${file.id} order by page_number, post_index
    `;

    const expected = [...reported.values()].reduce((sum, n) => sum + n, 0);
    assert.ok(expected > 0, 'this fixture should produce posts on at least one page');
    assert.equal(posts.length, expected, 'every post the provider reported must be stored');

    // Each post is its own row, numbered from zero within its page.
    for (const [pageNumber, count] of reported) {
      const onPage = posts.filter((p) => p.page_number === pageNumber);
      assert.equal(onPage.length, count, `page ${pageNumber} stored the wrong number of posts`);
      assert.deepEqual(
        onPage.map((p) => p.post_index),
        onPage.map((_, index) => index),
        'posts should be indexed in reading order within their page',
      );
    }

    assert.ok(posts.every((p) => p.summary.length > 0), 'every post needs something to embed');
    assert.ok(
      posts.every((p) => Number(p.confidence) >= 0 && Number(p.confidence) <= 1),
      'confidence must stay in range',
    );

    const counted = await adminSql<{ posts_detected: number; page_number: number }[]>`
      select page_number, posts_detected from pdf_page_understanding where file_id = ${file.id}
    `;
    for (const page of counted) {
      assert.equal(
        page.posts_detected,
        posts.filter((p) => p.page_number === page.page_number).length,
        'the page count must match the posts actually stored',
      );
    }
  });

  it('accepts a page with no posts on it rather than inventing one', async () => {
    // The fake returns no posts for some pages, standing for a cover or a
    // divider. Those pages are still understood; they simply have no posts.
    const pdf = buildPdf(
      Array.from({ length: 6 }, (_, n) => ({
        kind: 'image' as const,
        jpeg: n % 2 === 0 ? redJpeg : blueJpeg,
        width: 700,
        height: 700,
      })),
    );

    const file = await uploadPdf(mm, 'mixed-pages.pdf', pdf);
    await extractAll();
    await understanding.enqueueUnderstanding(mm);
    await understandAll();

    const pages = await adminSql<{ status: string; posts_detected: number }[]>`
      select status, posts_detected from pdf_page_understanding where file_id = ${file.id}
    `;
    assert.equal(pages.length, 6);
    assert.ok(pages.every((p) => p.status === 'ready'), 'every page should be understood');
  });
});

describe('provenance', () => {
  it('records which page a fact was seen on', async () => {
    const pdf = buildPdf([
      { kind: 'image', jpeg: redJpeg, width: 700, height: 700 },
      { kind: 'image', jpeg: blueJpeg, width: 700, height: 700 },
    ]);

    const file = await uploadPdf(mm, 'evidence.pdf', pdf);
    await extractAll();
    await understanding.enqueueUnderstanding(mm);
    await understandAll();

    const evidence = await adminSql<
      { file_id: string; page_number: number | null; source_type: string | null }[]
    >`
      select file_id, page_number, source_type from brand_dna_evidence
       where company_id = ${mm.companyId}
    `;

    assert.ok(evidence.length > 0, 'a visually-read PDF should produce evidence');
    assert.ok(
      evidence.every((row) => row.source_type === 'pdf_visual'),
      'evidence from a rendered page must say so',
    );
    assert.ok(
      evidence.every((row) => row.page_number !== null && row.page_number >= 1),
      'every visual claim must name the page it was seen on',
    );
    assert.ok(evidence.every((row) => row.file_id === file.id));
  });

  it('counts two pages showing the same thing as two pieces of evidence', async () => {
    // Both pages carry the same picture, so the fake reports the same facts
    // for each. That is genuinely stronger evidence than seeing it once.
    const pdf = buildPdf([
      { kind: 'image', jpeg: redJpeg, width: 700, height: 700 },
      { kind: 'image', jpeg: redJpeg, width: 700, height: 700 },
    ]);

    await uploadPdf(mm, 'repeated.pdf', pdf);
    await extractAll();
    await understanding.enqueueUnderstanding(mm);
    await understandAll();

    const facts = await adminSql<{ value: string; evidence_count: number }[]>`
      select value, evidence_count from brand_dna_facts where company_id = ${mm.companyId}
    `;
    assert.ok(
      facts.some((fact) => fact.evidence_count >= 2),
      'a pattern seen on two pages should be evidenced twice',
    );

    const rows = await adminSql<{ n: number }[]>`
      select count(distinct page_number)::int as n from brand_dna_evidence
       where company_id = ${mm.companyId}
    `;
    assert.equal(rows[0]?.n, 2, 'evidence should be recorded once per page');
  });

  it('does not record an absence as a fact', async () => {
    const pdf = buildPdf([{ kind: 'image', jpeg: redJpeg, width: 700, height: 700 }]);
    await uploadPdf(mm, 'absences.pdf', pdf);
    await extractAll();
    await understanding.enqueueUnderstanding(mm);
    await understandAll();

    const facts = await adminSql<{ value: string }[]>`
      select value from brand_dna_facts where company_id = ${mm.companyId}
    `;

    for (const fact of facts) {
      assert.doesNotMatch(
        fact.value,
        /^(none|n\/a|not specified|not visible|no logo|unknown)/i,
        `"${fact.value}" records an absence, which is not a fact about the brand`,
      );
    }
  });
});

describe('limits and failure', () => {
  it('refuses a file that is not a PDF at all', async () => {
    await assert.rejects(
      () => pdfRender.profilePdf(Buffer.from('this is not a PDF, it is a sentence')),
      /could not be read as a PDF/,
    );
  });

  it('refuses an empty file', async () => {
    await assert.rejects(() => pdfRender.profilePdf(Buffer.alloc(0)));
  });

  it('renders no more pages than the limit allows, and says which it skipped', async () => {
    process.env.CIP_PDF_MAX_RENDER_PAGES = '2';

    const pdf = buildPdf(
      Array.from({ length: 5 }, () => ({
        kind: 'image' as const, jpeg: redJpeg, width: 700, height: 700,
      })),
    );

    const rendered = await pdfRender.renderPdfPages(pdf);
    assert.equal(rendered.pages.length, 2, 'the page limit must actually bite');
    assert.equal(rendered.renderedAll, false);
    assert.deepEqual(rendered.skipped, [3, 4, 5], 'skipped pages are reported, not lost');
  });

  it('bounds the size of a rendered page', async () => {
    const pdf = buildPdf([{ kind: 'image', jpeg: redJpeg, width: 700, height: 700 }]);
    const rendered = await pdfRender.renderPdfPages(pdf);
    const page = rendered.pages[0]!;

    assert.ok(
      Math.max(page.width, page.height) <= pdfRender.RENDER_LIMITS.maxEdgePixels,
      `a page rendered at ${page.width}x${page.height}, past the cap`,
    );
  });

  it('a page the model refuses is recorded as failed, and the rest still work', async () => {
    const pdf = buildPdf([
      { kind: 'image', jpeg: redJpeg, width: 700, height: 700 },
      { kind: 'image', jpeg: blueJpeg, width: 700, height: 700 },
    ]);
    const file = await uploadPdf(mm, 'one-bad-page.pdf', pdf);
    await extractAll();
    await understanding.enqueueUnderstanding(mm);

    // Fail only the first page the provider is asked about.
    const { BrainFailed } = await import('../src/server/brain/providers/types');
    const original = fake.analyzePdfPage.bind(fake);
    let seen = 0;
    fake.analyzePdfPage = async (input) => {
      seen += 1;
      if (seen === 1) {
        throw new BrainFailed('PROVIDER_ERROR', 'transient', 'This page could not be read.');
      }
      return original(input);
    };

    try {
      const outcomes = await understandAll();
      assert.equal(
        outcomes[0]?.status,
        'understood',
        'one bad page must not cost the whole document',
      );
    } finally {
      fake.analyzePdfPage = original;
    }

    const pages = await adminSql<{ page_number: number; status: string; error_message: string | null }[]>`
      select page_number, status, error_message from pdf_page_understanding
       where file_id = ${file.id} order by page_number
    `;
    assert.equal(pages[0]?.status, 'failed');
    assert.match(pages[0]?.error_message ?? '', /could not be read/);
    assert.equal(pages[1]?.status, 'ready', 'the good page should still be understood');
  });

  it('a document where every page fails is a failure, and retryable', async () => {
    const pdf = buildPdf([{ kind: 'image', jpeg: redJpeg, width: 700, height: 700 }]);
    await uploadPdf(mm, 'all-bad.pdf', pdf);
    await extractAll();
    await understanding.enqueueUnderstanding(mm);

    const { BrainFailed } = await import('../src/server/brain/providers/types');
    const original = fake.analyzePdfPage.bind(fake);
    fake.analyzePdfPage = async () => {
      throw new BrainFailed('PROVIDER_ERROR', 'transient', 'No.');
    };

    try {
      const outcomes = await understandAll();
      assert.equal(outcomes[0]?.status, 'failed');
      assert.equal(
        outcomes[0]?.status === 'failed' ? outcomes[0].willRetry : false,
        true,
        'a transient failure should be retried, not abandoned',
      );
    } finally {
      fake.analyzePdfPage = original;
    }
  });
});

describe('reprocessing', () => {
  it('lands on the same rows rather than accumulating a second set', async () => {
    const pdf = buildPdf([
      { kind: 'image', jpeg: redJpeg, width: 700, height: 700 },
      { kind: 'image', jpeg: blueJpeg, width: 700, height: 700 },
    ]);
    const file = await uploadPdf(mm, 'again.pdf', pdf);
    await extractAll();
    await understanding.enqueueUnderstanding(mm);
    await understandAll();

    const first = await adminSql<{ pages: number; posts: number }[]>`
      select (select count(*) from pdf_page_understanding where file_id = ${file.id})::int as pages,
             (select count(*) from pdf_post where file_id = ${file.id})::int as posts
    `;

    // An unchanged file is not re-queued at all: the content hash already has
    // a ready row, which is what keeps a Drive sync from paying twice.
    assert.equal(await understanding.enqueueUnderstanding(mm), 0);

    // Force the work to happen again, as a reprocess would.
    await adminSql`delete from asset_understanding where file_id = ${file.id}`;
    await understanding.enqueueUnderstanding(mm);
    await understandAll();

    const second = await adminSql<{ pages: number; posts: number }[]>`
      select (select count(*) from pdf_page_understanding where file_id = ${file.id})::int as pages,
             (select count(*) from pdf_post where file_id = ${file.id})::int as posts
    `;

    assert.deepEqual(second[0], first[0], 'reprocessing must not duplicate pages or posts');
  });
});

describe('isolation', () => {
  it('one company cannot see another company PDF pages or posts', async () => {
    const ourPdf = buildPdf([{ kind: 'image', jpeg: redJpeg, width: 700, height: 700 }]);
    const theirPdf = buildPdf([{ kind: 'image', jpeg: blueJpeg, width: 700, height: 700 }]);

    const ours = await uploadPdf(mm, 'ours.pdf', ourPdf);
    const theirs = await uploadPdf(nh, 'theirs.pdf', theirPdf);
    await extractAll();
    await understanding.enqueueUnderstanding(mm);
    await understanding.enqueueUnderstanding(nh);
    await understandAll();

    // Asking with our scope for their file returns nothing at all — the same
    // answer as a file that never existed, so ids cannot be probed.
    const theirsThroughUs = await pdfVisual.readPdfPages(mm, theirs.id);
    assert.equal(theirsThroughUs.pages.length, 0);
    assert.equal(theirsThroughUs.posts.length, 0);

    const oursThroughUs = await pdfVisual.readPdfPages(mm, ours.id);
    assert.ok(oursThroughUs.pages.length > 0, 'we should see our own');

    // And row-level security holds underneath, not merely the WHERE clause.
    const leaked = await adminSql<{ n: number }[]>`
      select count(*)::int as n from pdf_post
       where company_id = ${mm.companyId} and file_id = ${theirs.id}
    `;
    assert.equal(leaked[0]?.n, 0);

    const crossFacts = await adminSql<{ n: number }[]>`
      select count(*)::int as n from brand_dna_evidence e
       where e.company_id = ${mm.companyId} and e.file_id = ${theirs.id}
    `;
    assert.equal(crossFacts[0]?.n, 0, 'their pages must not become our evidence');
  });

  it('a page image cannot be read through another company scope', async () => {
    const pdf = buildPdf([{ kind: 'image', jpeg: redJpeg, width: 700, height: 700 }]);
    const file = await uploadPdf(mm, 'private.pdf', pdf);
    await extractAll();
    await understanding.enqueueUnderstanding(mm);
    await understandAll();

    const { pages } = await pdfVisual.readPdfPages(mm, file.id);
    const pageId = pages[0]!.id;

    assert.ok(await pdfVisual.readPageImage(mm, pageId), 'we can read our own page');
    assert.equal(
      await pdfVisual.readPageImage(nh, pageId),
      null,
      'another company must not be able to read the bytes',
    );
  });
});

describe('what the visual pass must never do', () => {
  it('leaves Google Drive connections and synced files untouched', async () => {
    // Nothing in this pipeline has any business deleting integration state.
    // A proof script once did, and destroyed a real connection.
    await adminSql`
      insert into google_drive_connections
        (company_id, google_account_email, access_token_encrypted, refresh_token_encrypted,
         granted_scope, status, connected_by)
      values
        (${mm.companyId}, 'someone@example.test', 'x', 'y',
         'https://www.googleapis.com/auth/drive.readonly', 'connected', ${mm.userId})
    `;

    const pdf = buildPdf([{ kind: 'image', jpeg: redJpeg, width: 700, height: 700 }]);
    await uploadPdf(mm, 'harmless.pdf', pdf);
    await extractAll();
    await understanding.enqueueUnderstanding(mm);
    await understandAll();

    const still = await adminSql<{ n: number }[]>`
      select count(*)::int as n from google_drive_connections where company_id = ${mm.companyId}
    `;
    assert.equal(still[0]?.n, 1, 'the visual pass must not touch a Drive connection');

    await adminSql`delete from google_drive_connections where company_id = ${mm.companyId}`;
  });

  it('sends the provider the page and its name, and nothing identifying', async () => {
    const pdf = buildPdf([{ kind: 'image', jpeg: redJpeg, width: 700, height: 700 }]);
    const file = await uploadPdf(mm, 'privacy.pdf', pdf);
    await extractAll();
    await understanding.enqueueUnderstanding(mm);

    const original = fake.analyzePdfPage.bind(fake);
    const seen: unknown[] = [];
    fake.analyzePdfPage = async (input) => {
      seen.push(input);
      return original(input);
    };

    try {
      await understandAll();
    } finally {
      fake.analyzePdfPage = original;
    }

    assert.equal(seen.length, 1);
    const payload = JSON.stringify(seen[0], (key, value) =>
      key === 'bytes' ? '<bytes>' : (value as unknown),
    );

    for (const secret of [mm.companyId, mm.userId, file.id, 'companies/']) {
      assert.ok(!payload.includes(secret), `the provider was sent ${secret}`);
    }
    assert.ok(payload.includes('privacy.pdf'), 'the display name is allowed, and useful');
  });
});
