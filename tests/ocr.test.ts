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
 * OCR - reading a scanned document by looking at it.
 *
 * Real PDFs, parsed and rendered by the same pdf.js the product uses; the
 * vision model is the deterministic fake. What is under test is that a scan's
 * words end up stored as text - searchable, and quotable by a market signal -
 * and that a document that already has text is never read twice.
 */

let db: TestDb;
let adminSql: postgres.Sql;
let storageDir: string;

type Scope = { companyId: string; userId: string; role: 'owner' };
let mm: Scope;
let nh: Scope;

let drive: typeof import('../src/server/drive/service');
let processing: typeof import('../src/server/drive/processing');
let ocr: typeof import('../src/server/brain/ocr');
let market: typeof import('../src/server/brain/market');
let types: typeof import('../src/server/brain/providers/types');
let fake: import('../src/server/brain/providers').FakeBrainProvider;

let redJpeg: Buffer;
let blueJpeg: Buffer;

async function extractAll(): Promise<void> {
  for (;;) {
    const file = await processing.claimNextFile();
    if (!file) break;
    await processing.processClaimedFile(file);
  }
}

async function ocrAll(): Promise<string[]> {
  const outcomes: string[] = [];
  for (let i = 0; i < 10; i += 1) {
    const job = await ocr.claimOcrJob();
    if (!job) break;
    outcomes.push((await ocr.runOcrJob(job)).status);
  }
  return outcomes;
}

async function marketAll(): Promise<string[]> {
  const outcomes: string[] = [];
  for (let i = 0; i < 10; i += 1) {
    const claim = await market.claimMarketSource();
    if (!claim) break;
    outcomes.push((await market.readClaimedMarketSource(claim)).status);
  }
  return outcomes;
}

const scannedPdf = () =>
  buildPdf([
    { kind: 'image', jpeg: redJpeg, width: 700, height: 700 },
    { kind: 'image', jpeg: blueJpeg, width: 700, height: 700 },
  ]);

before(async () => {
  db = await startTestDatabase();
  storageDir = mkdtempSync(join(tmpdir(), 'cip-ocr-'));

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
  drive = await import('../src/server/drive/service');
  processing = await import('../src/server/drive/processing');
  ocr = await import('../src/server/brain/ocr');
  market = await import('../src/server/brain/market');
  types = await import('../src/server/brain/providers/types');

  const providers = await import('../src/server/brain/providers');
  const { FakeBrainProvider } = await import('../src/server/brain/providers/fake');
  fake = new FakeBrainProvider();
  providers.__setBrain(fake);

  adminSql = postgres(db.adminUrl, { onnotice: () => {} });

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
  await adminSql`delete from file_ocr`;
  await adminSql`delete from market_signals`;
  await adminSql`delete from market_sources`;
  await adminSql`delete from pdf_post`;
  await adminSql`delete from pdf_page_understanding`;
  await adminSql`delete from asset_understanding`;
  await adminSql`delete from drive_files`;
});

after(async () => {
  await adminSql?.end({ timeout: 5 });
  await db?.stop();
  try {
    rmSync(storageDir, { recursive: true, force: true });
  } catch {
    /* temp dir */
  }
});

describe('OCR: a scan becomes text', () => {
  it('transcribes each page of a scanned PDF and stores it like any document', async () => {
    fake.ocrPages = [
      "Officer's Choice held 12.5% share in North India.",
      'Premiumisation continued across the metros.',
    ];
    const file = await drive.uploadFile(mm, { folderId: null, filename: 'scan.pdf', mimeType: 'application/pdf', body: scannedPdf() });
    await extractAll();

    assert.equal(await ocr.enqueueOcrEverywhere(), 1, 'a scanned PDF was not queued for OCR');
    assert.deepEqual(await ocrAll(), ['ready']);
    assert.equal(fake.calls.ocr, 2, 'each page should be transcribed once');

    const extraction = await processing.getExtraction(mm, file.id);
    assert.equal(extraction?.kind, 'ocr');
    assert.ok(extraction?.content.includes("Officer's Choice held 12.5% share in North India."));
    assert.ok(extraction?.content.includes('[Page 2]'), 'the page a line came from was lost');
    assert.ok((extraction?.chunkCount ?? 0) > 0, 'the text was not chunked for search');
  });

  it('leaves a PDF with a real text layer alone', async () => {
    const pdf = buildPdf([
      {
        kind: 'text',
        text:
          'Magic Moments brand guidelines. Our tone of voice is warm and celebratory.\n' +
          'We talk about the occasion, never about the alcohol itself.\n' +
          'Primary typeface is a humanist sans. Secondary is a serif for headlines.\n' +
          'Calls to action are gentle invitations rather than instructions.',
      },
    ]);
    await drive.uploadFile(mm, { folderId: null, filename: 'guidelines.pdf', mimeType: 'application/pdf', body: pdf });
    await extractAll();

    assert.equal(await ocr.enqueueOcrEverywhere(), 0, 'a PDF that already has text was queued for OCR');
    assert.deepEqual(await ocrAll(), []);
    assert.equal(fake.calls.ocr, 0);
  });

  it('queues a file once, however many passes see it', async () => {
    await drive.uploadFile(mm, { folderId: null, filename: 'scan.pdf', mimeType: 'application/pdf', body: scannedPdf() });
    await extractAll();
    assert.equal(await ocr.enqueueOcrEverywhere(), 1);
    assert.equal(await ocr.enqueueOcrEverywhere(), 0);
  });

  it('says so when the pages carry no text, and stores nothing', async () => {
    fake.ocrPages = ['', ''];
    const file = await drive.uploadFile(mm, { folderId: null, filename: 'photos.pdf', mimeType: 'application/pdf', body: scannedPdf() });
    await extractAll();
    await ocr.enqueueOcrEverywhere();

    assert.deepEqual(await ocrAll(), ['skipped']);
    const stored = await adminSql`select 1 from drive_file_extractions where file_id = ${file.id} and kind = 'ocr'`;
    assert.equal(stored.length, 0);
  });

  it('tries a file again after a temporary failure, rather than losing it', async () => {
    fake.ocrPages = ['A page of text worth reading about the market.', 'Another page of text.'];
    const file = await drive.uploadFile(mm, { folderId: null, filename: 'scan.pdf', mimeType: 'application/pdf', body: scannedPdf() });
    await extractAll();
    await ocr.enqueueOcrEverywhere();

    fake.failWith = new types.BrainFailed('PROVIDER_ERROR', 'transient', 'The Brain could not be reached.');
    assert.deepEqual(await ocrAll(), ['retry']);

    fake.failWith = null;
    await adminSql`update file_ocr set updated_at = now() - interval '5 minutes' where file_id = ${file.id}`;
    assert.deepEqual(await ocrAll(), ['ready']);
  });

  it('joins the overlapping strips of a tall page without repeating lines', () => {
    assert.equal(ocr.joinStrips(['Heading\nline one\nline two', 'line one\nline two\nline three']), 'Heading\nline one\nline two\nline three');
    assert.equal(ocr.joinStrips(['first', 'second']), 'first\nsecond');
  });

  it("never shows one company another company's scanned text", async () => {
    const file = await drive.uploadFile(mm, { folderId: null, filename: 'scan.pdf', mimeType: 'application/pdf', body: scannedPdf() });
    await extractAll();
    await ocr.enqueueOcrEverywhere();
    await ocrAll();

    await assert.rejects(() => processing.getExtraction(nh, file.id), /could not be found/i);
  });
});

describe('OCR and market intelligence', () => {
  it('quotes a scanned market report from the text read off its pages', async () => {
    fake.ocrPages = ["Officer's Choice held 12.5% share in North India.", 'Premiumisation continued across the metros.'];
    const file = await drive.uploadFile(mm, { folderId: null, filename: 'q2-report.pdf', mimeType: 'application/pdf', body: scannedPdf() });
    await market.registerSource(mm, file.id);
    await extractAll();
    await ocr.enqueueOcrEverywhere();

    // Not read yet, so the report waits rather than being called unreadable.
    assert.deepEqual(await marketAll(), ['retry']);

    assert.deepEqual(await ocrAll(), ['ready']);
    await adminSql`update market_sources set updated_at = now() - interval '5 minutes' where file_id = ${file.id}`;

    assert.deepEqual(await marketAll(), ['ready']);
    const { signals } = await market.marketOverview(mm, { brand: null });
    assert.equal(signals.length, 1);
    assert.equal(signals[0]!.value, 12.5);
    assert.ok(signals[0]!.excerpt.includes('12.5%'));
  });
});
