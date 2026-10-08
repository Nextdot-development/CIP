import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { startTestDatabase } from './harness';
import type { TestDb } from './harness';

/**
 * Market intelligence and Chat with the Brain.
 *
 * Both run against the deterministic fake Brain. What is under test is not the
 * model but the machinery that keeps it honest: a market signal survives only
 * if its quote is really in the report, a name is ours only if it is on the
 * roster, an answer's citation survives only if that source was sent, and
 * none of it crosses a brand or a company boundary.
 */

let db: TestDb;
let adminSql: postgres.Sql;
let storageDir: string;

type Scope = { companyId: string; userId: string; role: 'owner' };
let mm: Scope;
let nh: Scope;

let drive: typeof import('../src/server/drive/service');
let processing: typeof import('../src/server/drive/processing');
let market: typeof import('../src/server/brain/market');
let chat: typeof import('../src/server/brain/chat');
let fake: import('../src/server/brain/providers').FakeBrainProvider;

const REPORT = [
  'Indian Spirits Review, FY24.',
  'The Indian whisky market grew 7% by volume in FY24.',
  "Officer's Choice held 12.5% share in North India.",
  '8PM Premium Black gained 3% share in Kerala.',
  'Premiumisation continued across metros.',
].join(' ');

async function extractAll(): Promise<void> {
  for (;;) {
    const file = await processing.claimNextFile();
    if (!file) break;
    await processing.processClaimedFile(file);
  }
}

async function readAll(): Promise<string[]> {
  const outcomes: string[] = [];
  for (let i = 0; i < 20; i += 1) {
    const claim = await market.claimMarketSource();
    if (!claim) break;
    outcomes.push((await market.readClaimedMarketSource(claim)).status);
  }
  return outcomes;
}

async function addReport(scope: Scope, name = 'spirits-review.txt', body = REPORT) {
  const file = await drive.uploadFile(scope, { folderId: null, filename: name, mimeType: 'text/plain', body: Buffer.from(body) });
  await market.registerSource(scope, file.id);
  await extractAll();
  return file;
}

async function roster(scope: Scope, ...names: string[]): Promise<void> {
  for (const [position, name] of names.entries()) {
    await adminSql`
      insert into company_brands (company_id, name, position, aliases)
      values (${scope.companyId}, ${name}, ${position}, ${[]})
    `;
  }
}

async function fact(scope: Scope, brand: string | null, attribute: string, value: string): Promise<void> {
  await adminSql`
    insert into brand_dna_facts (company_id, section, attribute, value, brand, kind, confidence, evidence_count)
    values (${scope.companyId}, 'content', ${attribute}, ${value}, ${brand}, 'derived', 0.8, 6)
  `;
}

before(async () => {
  db = await startTestDatabase();
  storageDir = mkdtempSync(join(tmpdir(), 'cip-market-'));

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
  market = await import('../src/server/brain/market');
  chat = await import('../src/server/brain/chat');

  const providers = await import('../src/server/brain/providers');
  const { FakeBrainProvider } = await import('../src/server/brain/providers/fake');
  fake = new FakeBrainProvider();
  providers.__setBrain(fake);

  adminSql = postgres(db.adminUrl, { onnotice: () => {} });

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
  await adminSql`delete from chat_messages`;
  await adminSql`delete from chat_threads`;
  await adminSql`delete from market_signals`;
  await adminSql`delete from market_feed_items`;
  await adminSql`delete from market_feeds`;
  await adminSql`delete from market_sources`;
  await adminSql`delete from brain_lesson_evidence`;
  await adminSql`delete from brain_lessons`;
  await adminSql`delete from generation_feedback`;
  await adminSql`delete from generation_briefs`;
  await adminSql`delete from brand_dna_evidence`;
  await adminSql`delete from brand_dna_facts`;
  await adminSql`delete from asset_understanding`;
  await adminSql`delete from media_generations`;
  await adminSql`delete from drive_files`;
  await adminSql`delete from drive_folders`;
  await adminSql`delete from company_brands`;
  await adminSql`delete from content_calendar`;
  await adminSql`delete from compliance_rules`;
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

describe('MARKET INTELLIGENCE: only what a report actually says', () => {
  it('keeps a signal only when its quote is really in the report', async () => {
    await addReport(mm);
    fake.marketSignals = [
      {
        kind: 'share', subject: "Officer's Choice", subjectType: 'competitor', market: 'North India',
        category: 'whisky', metric: 'share', value: 12.5, unit: '%', period: 'FY24',
        statement: "Officer's Choice holds 12.5% of North India.",
        excerpt: "Officer's Choice held 12.5% share in North India.",
      },
      {
        // Plausible, and nowhere in the report.
        kind: 'share', subject: 'Royal Stag', subjectType: 'competitor', market: 'India',
        category: 'whisky', metric: 'share', value: 30, unit: '%', period: 'FY24',
        statement: 'Royal Stag holds 30% nationally.',
        excerpt: 'Royal Stag held 30% share nationally.',
      },
    ];

    assert.deepEqual(await readAll(), ['ready']);
    const { signals, sources } = await market.marketOverview(mm, { brand: null });

    assert.equal(signals.length, 1, 'a signal whose quote is not in the report was kept');
    assert.equal(signals[0]!.subject, "Officer's Choice");
    assert.equal(signals[0]!.value, 12.5);
    assert.equal(sources[0]!.signals, 1);
  });

  it("decides what is the house's own brand from the roster, not from the model", async () => {
    await roster(mm, '8PM');
    await addReport(mm);
    fake.marketSignals = [
      {
        kind: 'share', subject: '8PM Premium Black', subjectType: 'competitor', market: 'Kerala',
        category: null, metric: 'share gain', value: 3, unit: '%', period: null,
        statement: '8PM Premium Black gained 3 points of share in Kerala.',
        excerpt: '8PM Premium Black gained 3% share in Kerala.',
      },
      {
        kind: 'share', subject: "Officer's Choice", subjectType: 'own_brand', market: 'North India',
        category: null, metric: 'share', value: 12.5, unit: '%', period: null,
        statement: "Officer's Choice holds 12.5% of North India.",
        excerpt: "Officer's Choice held 12.5% share in North India.",
      },
    ];

    await readAll();
    const { signals } = await market.marketOverview(mm, { brand: null });
    const ours = signals.find((s) => s.subject === '8PM');
    const theirs = signals.find((s) => s.subject === "Officer's Choice");

    assert.ok(ours, 'a roster brand was not recognised as ours');
    assert.equal(ours.subjectType, 'own_brand');
    assert.equal(theirs?.subjectType, 'competitor', "a competitor was filed as one of the house's brands");
  });

  it('reads a report again without duplicating it, and a removed signal stays removed', async () => {
    const file = await addReport(mm);
    await readAll();
    let { signals, sources } = await market.marketOverview(mm, { brand: null });
    assert.equal(signals.length, 3, 'the fake reads every sentence with a percentage');

    const wrong = signals.find((s) => s.statement.includes('Kerala'))!;
    assert.equal(await market.setSignalStatus(mm, wrong.id, 'rejected'), true);

    assert.equal(await market.rereadSource(mm, sources[0]!.id), true);
    await readAll();

    ({ signals, sources } = await market.marketOverview(mm, { brand: null }));
    assert.equal(signals.length, 3, 'reading again duplicated signals');
    assert.equal(signals.filter((s) => s.status === 'active').length, 2);
    assert.equal(signals.find((s) => s.id === wrong.id)?.status, 'rejected', 'a removed signal came back');
    assert.equal(sources[0]!.fileId, file.id);
    assert.equal(sources[0]!.signals, 2);
  });

  it('says so when a file has no text to read, without asking the Brain', async () => {
    const file = await drive.uploadFile(mm, { folderId: null, filename: 'note.txt', mimeType: 'text/plain', body: Buffer.from('Q2 notes') });
    await market.registerSource(mm, file.id);
    await extractAll();

    assert.deepEqual(await readAll(), ['no_text']);
    assert.equal(fake.calls.market, 0, 'the Brain was asked to read a file with no text');
    const { sources } = await market.marketOverview(mm, { brand: null });
    assert.equal(sources[0]!.status, 'no_text');
    assert.ok(sources[0]!.errorMessage);
  });

  it('waits for CIP to look at a scanned file, then reads what it saw', async () => {
    const image = await drive.uploadFile(mm, { folderId: null, filename: 'share-chart.png', mimeType: 'image/png', body: Buffer.from('stored as an image') });
    await market.registerSource(mm, image.id);

    assert.deepEqual(await readAll(), ['retry'], 'a picture was called unreadable before anyone looked at it');
    assert.equal(fake.calls.market, 0);

    // The Brain has now looked at the chart and read its labels.
    await adminSql`
      insert into asset_understanding (company_id, file_id, kind, provider, model, content_hash, status, summary, extracted_text)
      values (${mm.companyId}, ${image.id}, 'image', 'fake', 'fake-brain-1', 'test-hash', 'ready', 'A share chart.',
              ${"Officer's Choice held 12.5% share in North India."})
    `;
    await adminSql`update market_sources set updated_at = now() - interval '5 minutes' where file_id = ${image.id}`;

    assert.deepEqual(await readAll(), ['ready']);
    const { signals } = await market.marketOverview(mm, { brand: null });
    assert.equal(signals.length, 1);
    assert.equal(signals[0]!.value, 12.5);
  });

  it('picks up files dropped in a Market Intelligence folder, once', async () => {
    const folder = await drive.createFolder(mm, null, 'Market Intelligence 2025');
    await drive.uploadFile(mm, { folderId: folder.id, filename: 'q2.txt', mimeType: 'text/plain', body: Buffer.from(REPORT) });
    await drive.uploadFile(mm, { folderId: null, filename: 'unrelated.txt', mimeType: 'text/plain', body: Buffer.from(REPORT) });

    assert.equal(await market.sweepMarketFolders(mm), 1);
    assert.equal(await market.sweepMarketFolders(mm), 0, 'a sweep registered the same report twice');
  });

  // Kotler and Ogilvy sat in the market folder and were read as market
  // reports: 689 "signals", a toy company's Christmas ads among them.
  it('never reads a reference book for market signals, even in the market folder', async () => {
    const folder = await drive.createFolder(mm, null, 'Market Intelligence');
    const book = await drive.uploadFile(mm, { folderId: folder.id, filename: 'kotler.txt', mimeType: 'text/plain', body: Buffer.from(REPORT) });
    // Read and ready, so only its role can be what keeps it out.
    await adminSql`update drive_files set knowledge_role = 'reference', processing_status = 'processed' where id = ${book.id}`;
    assert.equal(await market.sweepMarketFolders(mm), 0, 'a reference book was registered as market data');

    // One registered before it was marked is not read either.
    await adminSql`insert into market_sources (company_id, file_id) values (${mm.companyId}, ${book.id})`;
    assert.equal(await readAll().then((s) => s.length), 0, 'a reference book was read for signals');
    const [row] = await adminSql<{ knowledge_role: string }[]>`select knowledge_role from drive_files where id = ${book.id}`;
    assert.equal(row!.knowledge_role, 'reference', 'the sweep turned the book back into market data');
  });

  describe('stock exchange filings arrive by themselves', () => {
    const PDF = Buffer.from('%PDF-1.4\n% a filing\n%%EOF\n');
    const today = new Date();
    const nseDay = `${String(today.getUTCDate()).padStart(2, '0')}-${today.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })}-${today.getUTCFullYear()} 10:00:00`;
    const LISTING = [
      { seq_id: '1', an_dt: nseDay, desc: 'Financial Result Updates', attchmntText: 'Radico Khaitan has submitted its financial results for the quarter.', attchmntFile: 'https://nsearchives.nseindia.com/corporate/RADICO_results.pdf', sm_name: 'Radico Khaitan Limited', symbol: 'RADICO' },
      { seq_id: '2', an_dt: nseDay, desc: 'Trading Window', attchmntText: 'Trading window closure pursuant to SEBI regulations.', attchmntFile: 'https://nsearchives.nseindia.com/corporate/RADICO_window.pdf', sm_name: 'Radico Khaitan Limited', symbol: 'RADICO' },
      { seq_id: '3', an_dt: nseDay, desc: 'Analysts/Institutional Investor Meet/Con. Call Updates', attchmntText: 'Transcript of the earnings conference call.', attchmntFile: 'https://nsearchives.nseindia.com/corporate/RADICO_transcript.pdf', sm_name: 'Radico Khaitan Limited', symbol: 'RADICO' },
    ];
    let refuse = false;
    const fakeNse = (async (input: string | URL | Request) => {
      const url = String(input);
      if (refuse) return new Response('Access Denied', { status: 403 });
      if (url.includes('/api/corporate-announcements')) return Response.json(LISTING);
      return new Response(PDF, { status: 200, headers: { 'content-type': 'application/pdf' } });
    }) as typeof fetch;

    it('reads a filing worth reading, and leaves the paperwork', async () => {
      const { worthReading } = await import('../src/server/brain/filings');
      assert.equal(worthReading({ desc: 'Financial Result Updates', attchmntText: 'quarterly results' }), true);
      assert.equal(worthReading({ desc: 'Analysts/Institutional Investor Meet/Con. Call Updates', attchmntText: 'transcript' }), true);
      assert.equal(worthReading({ desc: 'Press Release', attchmntText: 'launch in the UK' }), true);
      assert.equal(worthReading({ desc: 'Trading Window', attchmntText: 'closure' }), false);
      assert.equal(worthReading({ desc: 'Copy of Newspaper Publication', attchmntText: 'results published in newspapers' }), false);
    });

    it('fetches new filings once each, files them as market data, and records the rest', async () => {
      const filings = await import('../src/server/brain/filings');
      filings.__setFilingsFetch(fakeNse);
      try {
        await filings.addFeed(mm, { symbol: 'radico', name: 'Radico Khaitan' });
        const [feed] = await filings.listFeeds(mm);
        assert.equal(feed!.symbol, 'RADICO');

        const after = (await filings.checkFeedNow(mm, feed!.id))!;
        assert.equal(after[0]!.recent.length, 2, 'the results and the transcript were not both fetched');
        assert.equal(after[0]!.lastError, null);

        const files = await adminSql<{ name: string; source_type: string; knowledge_role: string }[]>`
          select name, source_type, knowledge_role from drive_files where company_id = ${mm.companyId} and source_type = 'exchange_filing'`;
        assert.equal(files.length, 2);
        assert.ok(files.every((f) => f.knowledge_role === 'market'), 'a filing was not filed as market data');
        assert.ok(files.some((f) => f.name.startsWith('Radico Khaitan - Financial Result Updates')));
        const sources = await adminSql`select m.id from market_sources m join drive_files f on f.id = m.file_id where f.source_type = 'exchange_filing'`;
        assert.equal(sources.length, 2, 'a filing was not queued to be read');

        // Looked at again: nothing new, nothing fetched twice.
        await adminSql`update market_feeds set last_checked_at = now() - interval '1 day' where id = ${feed!.id}`;
        await filings.checkFeedNow(mm, feed!.id);
        const again = await adminSql`select id from drive_files where source_type = 'exchange_filing' and company_id = ${mm.companyId}`;
        assert.equal(again.length, 2, 'a filing was fetched twice');
      } finally {
        filings.__setFilingsFetch(null);
      }
    });

    // Radico's July results were behind three newer filings on the first look,
    // and the next look only reached back a fortnight: they never came.
    it('keeps fetching an older backlog until it is all in, before narrowing to recent filings', async () => {
      const filings = await import('../src/server/brain/filings');
      const day = (daysAgo: number) => {
        const d = new Date(Date.now() - daysAgo * 86_400_000);
        return `${String(d.getUTCDate()).padStart(2, '0')}-${d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })}-${d.getUTCFullYear()} 10:00:00`;
      };
      const many = [1, 5, 9, 40, 60].map((ago, i) => ({
        seq_id: `b${i}`, an_dt: day(ago), desc: 'Press Release', attchmntText: `Press release number ${i}`,
        attchmntFile: `https://nsearchives.nseindia.com/corporate/RADICO_pr${i}.pdf`, sm_name: 'Radico', symbol: 'RADICO',
      }));
      filings.__setFilingsFetch((async (input: string | URL | Request) =>
        String(input).includes('/api/') ? Response.json(many) : new Response(PDF, { status: 200 })) as typeof fetch);
      try {
        await filings.addFeed(mm, { symbol: 'RADICO', name: 'Radico Khaitan' });
        const [feed] = await filings.listFeeds(mm);
        await filings.checkFeedNow(mm, feed!.id);
        const [first] = await adminSql<{ caught_up: boolean }[]>`select caught_up from market_feeds where id = ${feed!.id}`;
        assert.equal(first!.caught_up, false, 'three of five fetched, and the feed thought it was done');

        await filings.checkFeedNow(mm, feed!.id);
        const fetched = await adminSql`select external_id from market_feed_items where feed_id = ${feed!.id} and status = 'fetched'`;
        assert.equal(fetched.length, 5, 'the filings 40 and 60 days old were never fetched');
        const [second] = await adminSql<{ caught_up: boolean }[]>`select caught_up from market_feeds where id = ${feed!.id}`;
        assert.equal(second!.caught_up, true);
      } finally {
        filings.__setFilingsFetch(null);
      }
    });

    it('says so when NSE refuses, rather than going quiet', async () => {
      const filings = await import('../src/server/brain/filings');
      filings.__setFilingsFetch(fakeNse);
      refuse = true;
      try {
        await filings.addFeed(mm, { symbol: 'UNITDSPR', name: 'United Spirits' });
        const feed = (await filings.listFeeds(mm)).find((f) => f.symbol === 'UNITDSPR')!;
        const after = (await filings.checkFeedNow(mm, feed.id))!;
        assert.match(after.find((f) => f.symbol === 'UNITDSPR')!.lastError ?? '', /refused/i);
      } finally {
        refuse = false;
        filings.__setFilingsFetch(null);
      }
    });

    it("keeps one company's feeds from another", async () => {
      const filings = await import('../src/server/brain/filings');
      await filings.addFeed(mm, { symbol: 'RADICO', name: 'Radico Khaitan' });
      const [feed] = await filings.listFeeds(mm);
      assert.deepEqual(await filings.listFeeds(nh), []);
      assert.equal(await filings.setFeedEnabled(nh, feed!.id, false), false);
      assert.equal(await filings.checkFeedNow(nh, feed!.id), null);
      await assert.rejects(() => filings.addFeed(mm, { symbol: 'not a symbol!', name: 'x' }), /NSE symbol/);
    });

    it('writes the week up from what was read off the filings, and only once they are read', async () => {
      const filings = await import('../src/server/brain/filings');
      filings.__setFilingsFetch(fakeNse);
      try {
        await adminSql`delete from market_digests`;
        await filings.addFeed(mm, { symbol: 'RADICO', name: 'Radico Khaitan' });
        const [feed] = await filings.listFeeds(mm);
        await filings.checkFeedNow(mm, feed!.id);

        // Fetched, not yet read: a note now would only be titles.
        assert.equal(await filings.writeDigest(mm), null);

        await adminSql`
          update market_sources m set status = 'ready', read_at = now(), summary = 'Volumes up 12% in Q1.'
            from drive_files f where f.id = m.file_id and f.source_type = 'exchange_filing' and f.company_id = ${mm.companyId}`;
        const digest = (await filings.writeDigest(mm))!;
        assert.equal(digest.filings, 2);
        assert.equal(digest.points.length, 2);
        assert.equal(digest.points[0]!.company, 'Radico Khaitan');
        assert.ok(digest.points.every((p) => p.fileId), 'a point does not link to its filing');

        // Nothing read since: no second note, and the other company sees none.
        assert.equal(await filings.writeDigest(mm), null);
        assert.equal(await filings.latestDigest(nh), null);
      } finally {
        filings.__setFilingsFetch(null);
      }
    });
  });

  describe('a book is recognised as one, and a person always has the last word', () => {
    const BOOK = [
      'Hey, Whipple, Squeeze This. Copyright © 2012 by Luke Sullivan. All rights reserved.',
      'Published by John Wiley & Sons. ISBN 978-1-118-10192-4. Library of Congress Cataloging.',
      'Contents. Foreword. Preface. Acknowledgments.',
      'Chapter 1 Salad as a Metaphor. Chapter 2 Kicking Doors. Chapter 3 Writing a Headline.',
      'Think of a headline as a promise. '.repeat(200),
    ].join('\n');
    const REPORT_TEXT = [
      'Radico Khaitan Limited. Annual Report 2025-26. Report of the Board of Directors.',
      'Standalone financial statements. Balance sheet as at 31 March. SEBI listing regulations.',
      'Copyright © 2026 Radico Khaitan. All rights reserved. Chapter 1 Corporate overview. Chapter 2 Strategy.',
      'Revenue grew 18 percent. '.repeat(200),
    ].join('\n');

    it('tells a book from a company report, and a short note from either', async () => {
      const { looksLikeBook } = await import('../src/server/drive/knowledgeRole');
      assert.equal(looksLikeBook({ name: 'Hey_Whipple.pdf', pageCount: 348, text: BOOK }), true);
      assert.equal(looksLikeBook({ name: 'Annual-Report.pdf', pageCount: 324, text: REPORT_TEXT }), false, 'an annual report was taken for a book');
      assert.equal(looksLikeBook({ name: 'brief.pdf', pageCount: 4, text: BOOK }), false, 'four pages are not a book');
      assert.equal(looksLikeBook({ name: 'Confessions-by-Ogilvy-z-lib.org.pdf', pageCount: 42, text: 'scanned' }), true);
    });

    it('files a book read in the market folder as reference, and retires what it said', async () => {
      const { recogniseBook } = await import('../src/server/drive/knowledgeRole');
      const { withCompanyScope } = await import('../src/server/db');
      // Read as a market report first, as the books were, so it has signals.
      const file = await addReport(mm, 'whipple.txt');
      await readAll();
      const before = await adminSql`select id from market_signals where file_id = ${file.id} and status = 'active'`;
      assert.ok(before.length > 0, 'the fixture gave no signals to retire');

      const changed = await withCompanyScope(mm, (tx) =>
        recogniseBook(tx, mm.companyId, { id: file.id, name: 'whipple.pdf' }, { pageCount: 348, text: BOOK }));
      assert.equal(changed, true);
      const [row] = await adminSql<{ knowledge_role: string }[]>`select knowledge_role from drive_files where id = ${file.id}`;
      assert.equal(row!.knowledge_role, 'reference');
      const active = await adminSql`select id from market_signals where file_id = ${file.id} and status = 'active'`;
      assert.equal(active.length, 0, "a book's signals were left standing");
      assert.equal(await market.sweepMarketFolders(mm), 0);
    });

    it("never overrides what a person chose", async () => {
      const { recogniseBook, setKnowledgeRole, getKnowledgeRole } = await import('../src/server/drive/knowledgeRole');
      const { withCompanyScope } = await import('../src/server/db');
      const file = await drive.uploadFile(mm, { folderId: null, filename: 'house-style.txt', mimeType: 'text/plain', body: Buffer.from('Our style.') });

      assert.equal(await setKnowledgeRole(mm, file.id, 'brand'), true);
      const changed = await withCompanyScope(mm, (tx) =>
        recogniseBook(tx, mm.companyId, { id: file.id, name: 'house-style.pdf' }, { pageCount: 300, text: BOOK }));
      assert.equal(changed, false, "CIP's guess overrode a person's choice");
      assert.deepEqual(await getKnowledgeRole(mm, file.id), { role: 'brand', chosen: true });

      // Nobody else's file can be read or set.
      assert.equal(await getKnowledgeRole(nh, file.id), null);
      assert.equal(await setKnowledgeRole(nh, file.id, 'market'), false);
    });
  });

  it("never shows one company another company's market", async () => {
    await addReport(mm);
    await readAll();
    const { signals } = await market.marketOverview(mm, { brand: null });
    assert.ok(signals.length > 0);

    assert.equal((await market.marketOverview(nh, { brand: null })).signals.length, 0);
    assert.equal(await market.setSignalStatus(nh, signals[0]!.id, 'rejected'), false);
    assert.equal(await market.rereadSource(nh, (await market.marketOverview(mm, { brand: null })).sources[0]!.id), false);
  });

  it('reads a long report where the market figures are, not only its first pages', () => {
    const preamble = 'This section sets out the board, its committees and the duties of each director. '.repeat(400);
    const figures = "Indian whisky volumes grew 7% in FY26 while Officer's Choice held 12.5% share. ";
    const text = preamble.repeat(6) + figures.repeat(40) + preamble;

    const { parts, total } = market.chooseParts(text);
    assert.ok(total > parts.length, 'the fixture is not long enough to need choosing');
    assert.ok(parts.some((part) => part.includes('12.5% share')), 'the section with the figures was not read');
  });

  it('keeps a market report out of Brand DNA', async () => {
    const understanding = await import('../src/server/brain/understanding');
    const file = await addReport(mm);

    assert.equal(await understanding.enqueueUnderstanding(mm), 0, 'a market report was queued to be read as brand material');
    const [row] = await adminSql<{ knowledge_role: string }[]>`select knowledge_role from drive_files where id = ${file.id}`;
    assert.equal(row?.knowledge_role, 'market');
  });

  it("shows a brand its own numbers and its competitors', not a sibling brand's", async () => {
    await roster(mm, '8PM', 'Magic Moments');
    await addReport(mm, 'mixed.txt', 'Magic Moments held 40% of vodka in Delhi. 8PM held 9% of whisky in Kerala. Smirnoff held 20% of vodka in Delhi.');
    await readAll();

    const subjects = (await market.marketOverview(mm, { brand: '8PM' })).signals.map((s) => s.subject);
    assert.ok(subjects.includes('8PM'));
    assert.ok(!subjects.includes('Magic Moments'), "a sibling brand's numbers reached 8PM's market view");
  });
});

describe('CHAT WITH THE BRAIN: answers from what CIP stores, and says which', () => {
  it('drops a citation to a source that was never sent', async () => {
    await fact(mm, null, 'tone', 'warm and unhurried');
    fake.chatAnswer = { answer: 'The tone is warm [F1] and loud [F9].', citations: ['F1', 'F9'], followUps: ['Why?'] };

    const { messages, thread } = await chat.askBrain(mm, { threadId: null, message: 'What is our tone?', activeBrand: null });
    const answer = messages[1]!;

    assert.equal(answer.role, 'assistant');
    assert.deepEqual(answer.sources.map((s) => s.ref), ['F1']);
    assert.ok(!answer.content.includes('[F9]'), 'an invented citation reached the person');
    assert.equal(answer.grounded, true);
    assert.equal(thread.title, 'What is our tone?');
  });

  it('marks an answer that cites nothing as ungrounded', async () => {
    fake.chatAnswer = { answer: 'Probably blue.', citations: [], followUps: [] };
    const { messages } = await chat.askBrain(mm, { threadId: null, message: 'What colour is the logo?', activeBrand: null });
    assert.equal(messages[1]!.grounded, false);
    assert.equal(messages[1]!.sources.length, 0);
  });

  it("asked about one brand, is not given another brand's knowledge", async () => {
    await roster(mm, '8PM', 'Magic Moments');
    await fact(mm, '8PM', 'palette', 'deep purple and gold');
    await fact(mm, 'Magic Moments', 'palette', 'electric blue and silver');
    await fact(mm, null, 'legal', 'never show anyone under 25');

    // Magic Moments is selected in the sidebar; the question names 8PM.
    await chat.askBrain(mm, { threadId: null, message: 'What colours does 8PM use?', activeBrand: 'Magic Moments' });
    const given = fake.lastChatInput!.sources.map((s) => s.text).join('\n');

    assert.ok(given.includes('deep purple and gold'), "8PM's own knowledge was not given");
    assert.ok(given.includes('never show anyone under 25'), 'house-wide knowledge was not given');
    assert.ok(!given.includes('electric blue and silver'), "Magic Moments' knowledge leaked into an 8PM answer");
    assert.equal(fake.lastChatInput!.brand, '8PM');
  });

  it('answers from market reports, and keeps a conversation together', async () => {
    await addReport(mm);
    await readAll();

    const first = await chat.askBrain(mm, { threadId: null, message: "How is Officer's Choice doing?", activeBrand: null });
    assert.ok(fake.lastChatInput!.sources.some((s) => s.kind === 'signal'), 'market signals did not reach the Brain');

    const second = await chat.askBrain(mm, { threadId: first.thread.id, message: 'And in Kerala?', activeBrand: null });
    assert.equal(second.thread.id, first.thread.id);
    assert.equal(fake.lastChatInput!.history.length, 2, 'the earlier turn was not carried into the follow-up');

    const opened = await chat.getThread(mm, first.thread.id);
    assert.equal(opened?.messages.length, 4);
  });

  it("keeps a person's conversations to their own company", async () => {
    const { thread } = await chat.askBrain(mm, { threadId: null, message: 'What is our tone?', activeBrand: null });

    assert.equal(await chat.getThread(nh, thread.id), null);
    assert.equal((await chat.listThreads(nh)).length, 0);
    await assert.rejects(
      () => chat.askBrain(nh, { threadId: thread.id, message: 'Continue', activeBrand: null }),
      /not here/i,
    );
  });

  it('refuses an empty question without calling the Brain', async () => {
    await assert.rejects(() => chat.askBrain(mm, { threadId: null, message: '   ', activeBrand: null }), /ask something/i);
    assert.equal(fake.calls.chat, 0);
  });

  it('puts the facts that answer the question first', async () => {
    for (let i = 0; i < 40; i += 1) await fact(mm, null, `palette ${i}`, `colour number ${i}`);
    await fact(mm, null, 'tagline', 'Make it magic');

    await chat.askBrain(mm, { threadId: null, message: 'What is our tagline?', activeBrand: null });
    const facts = fake.lastChatInput!.sources.filter((s) => s.kind === 'fact');
    assert.ok(facts.length <= 30);
    assert.ok(facts[0]!.text.includes('Make it magic'), 'the fact that answers the question was not sent first');
  });
});

describe('A RULE SAID IN CHAT: proposed back, kept only when the person keeps it', () => {
  const said = 'Magic Moments ka black logo bhi approved hai, usko flag mat karna.';
  const blackLogo = {
    brand: 'Magic Moments',
    market: null,
    kind: 'allowed' as const,
    statement: 'The black version of the Magic Moments logo is approved.',
    allowed: ['Black logo'],
    prohibited: [],
    quote: 'Magic Moments ka black logo bhi approved hai',
  };

  it('offers a stated rule back, in the words it was said in', async () => {
    await roster(mm, 'Magic Moments', '8PM');
    fake.chatAnswer = { answer: 'Noted.', citations: [], followUps: [], proposedRules: [blackLogo] };

    const { messages } = await chat.askBrain(mm, { threadId: null, message: said, activeBrand: null });
    const answer = messages.find((m) => m.role === 'assistant')!;
    assert.equal(answer.proposedRules.length, 1);
    assert.equal(answer.proposedRules[0]!.status, 'proposed');
    assert.equal(answer.proposedRules[0]!.kind, 'allowed');
    // The Brain is told the roster, so it can file the rule under the right brand.
    assert.deepEqual([...fake.lastChatInput!.brands].sort(), ['8PM', 'Magic Moments']);
    // Proposing is not keeping: nothing reaches the checker until the person decides.
    const rules = await adminSql`select id from compliance_rules where company_id = ${mm.companyId}`;
    assert.equal(rules.length, 0);
  });

  it('drops a proposal that quotes words the person never wrote', async () => {
    await roster(mm, 'Magic Moments');
    fake.chatAnswer = {
      answer: 'Noted.', citations: [], followUps: [],
      proposedRules: [{ ...blackLogo, quote: 'the gold logo must never be used' }],
    };
    const { messages } = await chat.askBrain(mm, { threadId: null, message: said, activeBrand: null });
    assert.equal(messages.find((m) => m.role === 'assistant')!.proposedRules.length, 0);
  });

  it('never files a rule under a brand the company does not have', async () => {
    await roster(mm, 'Magic Moments');
    fake.chatAnswer = {
      answer: 'Noted.', citations: [], followUps: [],
      proposedRules: [{ ...blackLogo, brand: 'Smirnoff' }],
    };
    const { messages } = await chat.askBrain(mm, { threadId: null, message: said, activeBrand: null });
    assert.equal(messages.find((m) => m.role === 'assistant')!.proposedRules[0]!.brand, null);
  });

  // "Logo is centred for video" was saved for every creative, and then failed
  // every banner for not having its logo in the middle.
  it('keeps a rule for the creatives it was said about', async () => {
    await roster(mm, 'Magic Moments');
    const videoRule = {
      ...blackLogo, kind: 'mandatory' as const, format: 'video' as const,
      statement: 'The logo is centred on the end card.', quote: 'Magic Moments ka black logo bhi approved hai',
    };
    fake.chatAnswer = { answer: 'Noted - for videos.', citations: [], followUps: [], proposedRules: [videoRule] };
    const { messages } = await chat.askBrain(mm, { threadId: null, message: said, activeBrand: null });
    const answer = messages.find((m) => m.role === 'assistant')!;
    assert.equal(answer.proposedRules[0]!.format, 'video');

    await chat.decideProposedRule(mm, { messageId: answer.id, index: 0, keep: true });
    const [rule] = await adminSql<{ format: string }[]>`select format from compliance_rules where rule = ${videoRule.statement}`;
    assert.equal(rule!.format, 'video', 'a video rule was saved for every creative');
  });

  it('reads the scope from the words when the Brain did not say', async () => {
    await roster(mm, 'Magic Moments');
    const unsaid = { ...blackLogo, statement: 'The voiceover ends with the brand name.' } as Record<string, unknown>;
    delete unsaid.format;
    fake.chatAnswer = { answer: 'Noted.', citations: [], followUps: [], proposedRules: [unsaid as never] };
    const { messages } = await chat.askBrain(mm, { threadId: null, message: said, activeBrand: null });
    assert.equal(messages.find((m) => m.role === 'assistant')!.proposedRules[0]!.format, 'video');
  });

  it('keeps it as a verified QC rule, with where it came from', async () => {
    await roster(mm, 'Magic Moments');
    fake.chatAnswer = { answer: 'Noted.', citations: [], followUps: [], proposedRules: [blackLogo] };
    const { messages, thread } = await chat.askBrain(mm, { threadId: null, message: said, activeBrand: null });
    const answer = messages.find((m) => m.role === 'assistant')!;

    const decided = await chat.decideProposedRule(mm, { messageId: answer.id, index: 0, keep: true });
    assert.equal(decided.proposedRules[0]!.status, 'added');
    assert.ok(decided.proposedRules[0]!.ruleId);

    const [rule] = await adminSql<{
      rule: string; brand: string | null; rule_type: string; requirement: string; source: string;
      verified_at: Date | null; allowed: string[]; note: string;
    }[]>`
      select rule, brand, rule_type, requirement, source, verified_at, allowed, note
        from compliance_rules where id = ${decided.proposedRules[0]!.ruleId}
    `;
    assert.equal(rule!.rule, blackLogo.statement);
    assert.equal(rule!.brand, 'Magic Moments');
    assert.equal(rule!.rule_type, 'allowed');
    assert.equal(rule!.source, 'manual');
    assert.ok(rule!.verified_at, 'a rule the person kept is confirmed by them');
    assert.deepEqual(rule!.allowed, ['Black logo']);
    assert.ok(rule!.note.includes(blackLogo.quote), 'the rule remembers what was said');

    // Deciding twice changes nothing: the first answer stands.
    const again = await chat.decideProposedRule(mm, { messageId: answer.id, index: 0, keep: false });
    assert.equal(again.proposedRules[0]!.status, 'added');

    // And it survives the conversation being opened again.
    const reopened = await chat.getThread(mm, thread.id);
    assert.equal(reopened!.messages.find((m) => m.id === answer.id)!.proposedRules[0]!.status, 'added');
  });

  it('keeps nothing when the person says it is not a rule', async () => {
    await roster(mm, 'Magic Moments');
    fake.chatAnswer = { answer: 'Noted.', citations: [], followUps: [], proposedRules: [blackLogo] };
    const { messages } = await chat.askBrain(mm, { threadId: null, message: said, activeBrand: null });
    const answer = messages.find((m) => m.role === 'assistant')!;

    const decided = await chat.decideProposedRule(mm, { messageId: answer.id, index: 0, keep: false });
    assert.equal(decided.proposedRules[0]!.status, 'dismissed');
    const rules = await adminSql`select id from compliance_rules where company_id = ${mm.companyId}`;
    assert.equal(rules.length, 0);
  });

  it('only the person whose conversation it is can decide', async () => {
    await roster(mm, 'Magic Moments');
    fake.chatAnswer = { answer: 'Noted.', citations: [], followUps: [], proposedRules: [blackLogo] };
    const { messages } = await chat.askBrain(mm, { threadId: null, message: said, activeBrand: null });
    const answer = messages.find((m) => m.role === 'assistant')!;
    await assert.rejects(
      () => chat.decideProposedRule(nh, { messageId: answer.id, index: 0, keep: true }),
      (error: unknown) => error instanceof chat.ChatNotFound,
    );
  });
});

describe('CAMPAIGN IDEATION: concepts that stand on what CIP knows', () => {
  it('drops a grounding nobody sent, and a concept left standing on nothing', async () => {
    await fact(mm, null, 'tone', 'warm and unhurried');
    fake.ideaConcepts = [
      { title: 'The Long Pour', pitch: 'A slow film about the wait.', format: 'Film + Social', groundedIn: ['F1', 'F9'] },
      { title: 'Generic Party', pitch: 'People dancing.', format: 'Social', groundedIn: ['F7'] },
    ];
    const { ideate } = await import('../src/server/brain/ideas');
    const result = await ideate(mm, { brief: 'Diwali gifting, digital first', activeBrand: null });

    assert.equal(result.concepts.length, 1, 'a concept grounded in nothing CIP sent was offered');
    assert.equal(result.concepts[0]!.title, 'The Long Pour');
    assert.deepEqual(result.concepts[0]!.groundedIn.map((s) => s.ref), ['F1']);
  });

  it("builds one brand's concepts from that brand's knowledge only", async () => {
    await roster(mm, '8PM', 'Magic Moments');
    await fact(mm, '8PM', 'palette', 'deep purple and gold');
    await fact(mm, 'Magic Moments', 'palette', 'electric blue and silver');
    const { ideate } = await import('../src/server/brain/ideas');

    await ideate(mm, { brief: 'A Holi post for 8PM', activeBrand: null });
    const given = fake.lastIdeationInput!.sources.map((s) => s.text).join('\n');
    assert.ok(given.includes('deep purple and gold'));
    assert.ok(!given.includes('electric blue and silver'), "another brand's knowledge reached 8PM's concepts");
  });
});

describe('COMPLIANCE RULES NOBODY HAS VERIFIED', () => {
  it('lets an unverified suggestion warn but not fail, while a regulation still fails', async () => {
    const { groundFindings } = await import('../src/server/brain/checker');
    const refs = new Map([
      ['R1', { kind: 'rule', id: 'a', dimension: 'compliance', requirement: 'required', advisory: true }],
      ['R2', { kind: 'rule', id: 'b', dimension: 'compliance', requirement: 'required', advisory: false }],
    ]) as never;

    const kept = groundFindings(
      [
        { ref: 'R1', dimension: 'compliance', severity: 'critical', message: 'No statutory warning.' },
        { ref: 'R2', dimension: 'compliance', severity: 'critical', message: 'No age line.' },
      ],
      refs,
    );
    assert.equal(kept.find((f) => f.ref === 'R1')?.severity, 'warning');
    assert.equal(kept.find((f) => f.ref === 'R2')?.severity, 'critical');
  });

  it('records a verification, within one company only', async () => {
    const [rule] = await adminSql<{ id: string }[]>`
      insert into compliance_rules (company_id, category, requirement, rule, source)
      values (${mm.companyId}, 'disclaimer', 'required', 'Carry a statutory warning.', 'suggested')
      returning id
    `;
    const checker = await import('../src/server/brain/checker');

    assert.equal(await checker.setRuleVerified(nh, rule!.id, true), false, "one company verified another company's rule");
    assert.equal(await checker.setRuleVerified(mm, rule!.id, true), true);
    const listed = (await checker.listRules(mm)).find((r) => r.id === rule!.id);
    assert.ok(listed?.verifiedAt, 'the verification was not recorded');
  });
});

describe('MARKETS FROM NAMES AND FOLDERS', () => {
  it('places a file from its folder, and does not take "us" for America', async () => {
    const { marketFromFilename, suggestMarkets } = await import('../src/server/brain/markets');
    assert.equal(marketFromFilename('Contact us.pdf'), null);
    assert.equal(marketFromFilename('Accra launch deck.pdf'), 'Ghana');

    const country = await drive.createFolder(mm, null, 'Nigeria');
    const quarter = await drive.createFolder(mm, country.id, 'Q2 posts');
    const file = await drive.uploadFile(mm, { folderId: quarter.id, filename: 'post-3.txt', mimeType: 'text/plain', body: Buffer.from('a post') });

    const changed = await suggestMarkets(mm);
    assert.deepEqual(changed.map((c) => [c.fileId, c.market]), [[file.id, 'Nigeria']]);
  });
});
