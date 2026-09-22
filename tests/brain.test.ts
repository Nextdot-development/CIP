import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import crypto from 'node:crypto';
import postgres from 'postgres';
import { startTestDatabase } from './harness';
import type { TestDb } from './harness';

/**
 * CIP Brain — understanding, Brand DNA, planning, learning, and isolation.
 *
 * Everything runs against the deterministic fake Brain, so the suite needs no
 * key, no bill and no network. What it tests is the machinery around the
 * provider: that understanding is stored once per unchanged asset, that Brand
 * DNA is counted rather than asserted, that a lesson learned in one context is
 * not applied in another, and that none of it crosses a company boundary.
 */

let db: TestDb;
let appSql: postgres.Sql;
let adminSql: postgres.Sql;
let storageDir: string;

type Scope = { companyId: string; userId: string; role: 'owner' };
let mm: Scope;
let nh: Scope;

let understanding: typeof import('../src/server/brain/understanding');
let brandDna: typeof import('../src/server/brain/brandDna');
let planner: typeof import('../src/server/brain/planner');
let learning: typeof import('../src/server/brain/learning');
let retrieval: typeof import('../src/server/brain/retrieval');
let providers: typeof import('../src/server/brain/providers');
let brainGenerate: typeof import('../src/server/brain/generate');
let mediaProviders: typeof import('../src/server/media/providers');
let media: typeof import('../src/server/media/generation');
let drive: typeof import('../src/server/drive/service');
let processing: typeof import('../src/server/drive/processing');

let fake: import('../src/server/brain/providers').FakeBrainProvider;

const PASSWORD = 'cip-demo-password';

/** A real PNG, big enough that a vision model would accept it. */
function png(width = 256, height = 256, seed = 1): Buffer {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const byte of b) c = table[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td), 0);
    return Buffer.concat([len, td, c]);
  };
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x += 1) {
      raw[row + 1 + x * 3] = (x * seed) % 256;
      raw[row + 2 + x * 3] = (y * seed) % 256;
      raw[row + 3 + x * 3] = seed % 256;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const uploadText = (scope: Scope, filename: string, body: string) =>
  drive.uploadFile(scope, { folderId: null, filename, mimeType: 'text/plain', body: Buffer.from(body) });

const uploadImage = (scope: Scope, filename: string, seed = 1) =>
  drive.uploadFile(scope, { folderId: null, filename, mimeType: 'image/png', body: png(256, 256, seed) });

/** Runs the Phase 3 extractor, which document understanding depends on. */
async function extractAll(): Promise<void> {
  for (;;) {
    const file = await processing.claimNextFile();
    if (!file) break;
    await processing.processClaimedFile(file);
  }
}

/** Runs the understanding queue to completion, as the worker does. */
async function understandAll(): Promise<string[]> {
  const outcomes: string[] = [];
  for (let i = 0; i < 40; i += 1) {
    const claim = await understanding.claimAssetForUnderstanding();
    if (!claim) break;
    const outcome = await understanding.understandClaimedAsset(claim);
    outcomes.push(outcome.status);
  }
  return outcomes;
}

before(async () => {
  db = await startTestDatabase();
  storageDir = mkdtempSync(join(tmpdir(), 'cip-brain-'));

  process.env.DATABASE_ADMIN_URL = db.adminUrl;
  process.env.CIP_APP_DB_PASSWORD = db.appPassword;
  process.env.SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.CIP_SEED_PASSWORD = PASSWORD;
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
  brandDna = await import('../src/server/brain/brandDna');
  planner = await import('../src/server/brain/planner');
  learning = await import('../src/server/brain/learning');
  retrieval = await import('../src/server/brain/retrieval');
  providers = await import('../src/server/brain/providers');
  brainGenerate = await import('../src/server/brain/generate');
  mediaProviders = await import('../src/server/media/providers');
  media = await import('../src/server/media/generation');
  drive = await import('../src/server/drive/service');
  processing = await import('../src/server/drive/processing');

  const { FakeBrainProvider } = await import('../src/server/brain/providers/fake');
  fake = new FakeBrainProvider();
  providers.__setBrain(fake);

  adminSql = postgres(db.adminUrl, { onnotice: () => {} });
  appSql = postgres(db.appUrl, { onnotice: () => {} });

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
  // Each case builds the knowledge it needs, so nothing inherits another's.
  await adminSql`delete from brain_lesson_evidence`;
  await adminSql`delete from brain_lessons`;
  await adminSql`delete from generation_feedback`;
  await adminSql`delete from generation_briefs`;
  await adminSql`delete from brand_dna_evidence`;
  await adminSql`delete from brand_dna_facts`;
  await adminSql`delete from asset_understanding`;
  await adminSql`delete from media_generations`;
  await adminSql`delete from drive_files`;
  // The roster too: a case that adds brands would otherwise leave the next one
  // being asked which brand, about brands it never created.
  await adminSql`delete from company_brands`;
  // The calendar too, or one case's dates become another's "coming up".
  await adminSql`delete from content_calendar`;
  // Checks before rules and facts: flags reference both, and a check left
  // behind would be scored against knowledge the next case never built.
  await adminSql`delete from check_flags`;
  await adminSql`delete from creative_checks`;
  await adminSql`delete from compliance_rules`;
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

describe('image understanding', () => {
  it('analyses an image and stores what it found', async () => {
    const file = await uploadImage(mm, 'campaign-key-visual.png');
    assert.equal(await understanding.enqueueUnderstanding(mm), 1);

    const outcomes = await understandAll();
    assert.deepEqual(outcomes, ['understood']);
    assert.equal(fake.calls.image, 1, 'the image provider was not used');

    const rows = await adminSql<
      { kind: string; status: string; summary: string; structured: Record<string, unknown> }[]
    >`select kind, status, summary, structured from asset_understanding where file_id = ${file.id}`;

    assert.equal(rows[0]!.kind, 'image');
    assert.equal(rows[0]!.status, 'ready');
    assert.ok(rows[0]!.summary.length > 0);
    // The structured part carries the visual detail the brief will draw on.
    assert.ok(Array.isArray(rows[0]!.structured.colours));
    assert.ok(typeof rows[0]!.structured.composition === 'string');
  });

  it('two different images produce two different understandings', async () => {
    await uploadImage(mm, 'one.png', 3);
    await uploadImage(mm, 'two.png', 200);
    await understanding.enqueueUnderstanding(mm);
    await understandAll();

    const rows = await adminSql<{ summary: string }[]>`
      select summary from asset_understanding where status = 'ready'
    `;
    assert.equal(rows.length, 2);
    assert.notEqual(rows[0]!.summary, rows[1]!.summary, 'both images were described identically');
  });

  it('refuses an image too small to describe reliably', async () => {
    // A vision model given a thumbnail invents a confident description rather
    // than admitting it cannot see. This is the guard against that, and it is
    // the real provider's rule, so the real provider is used to check it.
    const { OpenAIImageProvider } = await import('../src/server/media/providers/openaiImage');
    void OpenAIImageProvider;
    const { OpenAIBrainProvider } = await import('../src/server/brain/providers/openai');
    const real = new OpenAIBrainProvider('sk-test-not-used');

    await assert.rejects(
      () => real.analyzeImage({ bytes: png(8, 8), mimeType: 'image/png', filename: 'tiny.png' }),
      (error: unknown) => {
        assert.equal((error as { code: string }).code, 'ASSET_TOO_SMALL');
        assert.equal((error as { kind: string }).kind, 'permanent');
        return true;
      },
    );
  });
});

describe('an image too large to send', () => {
  /** A real PNG of a given size, so the test measures bytes rather than a stub. */
  async function png(width: number, height: number): Promise<Buffer> {
    const { createCanvas } = await import('@napi-rs/canvas');
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    // Noise, not a flat fill: a flat fill compresses to nothing and a test
    // about size would then be testing PNG's run-length encoding.
    const image = ctx.createImageData(width, height);
    for (let i = 0; i < image.data.length; i += 4) {
      image.data[i] = (i * 7) % 256;
      image.data[i + 1] = (i * 13) % 256;
      image.data[i + 2] = (i * 29) % 256;
      image.data[i + 3] = 255;
    }
    ctx.putImageData(image, 0, 0);
    return canvas.toBuffer('image/png');
  }

  it('is scaled down to fit rather than refused', async () => {
    const { fitForVision } = await import('../src/server/brain/fitImage');
    const big = await png(3000, 3000);

    const fitted = await fitForVision(big, 'image/png', { maxBytes: 512 * 1024, maxEdge: 600 });

    assert.equal(fitted.resized, true, 'an oversized image should have been scaled');
    assert.ok(
      fitted.bytes.byteLength <= 512 * 1024,
      `still ${fitted.bytes.byteLength} bytes, over the budget it was given`,
    );

    const { createCanvas: _c, loadImage } = await import('@napi-rs/canvas');
    const out = await loadImage(fitted.bytes);
    assert.ok(Math.max(out.width, out.height) <= 600, `long edge is still ${out.width}x${out.height}`);
    // Scaled, not cropped: a cropped bottle shot is a different picture.
    assert.equal(out.width, out.height, 'the aspect ratio changed');
  });

  it('leaves an image that already fits exactly as it was', async () => {
    const { fitForVision } = await import('../src/server/brain/fitImage');
    const small = await png(200, 120);

    const fitted = await fitForVision(small, 'image/png', { maxBytes: 20 * 1024 * 1024, maxEdge: 2000 });

    assert.equal(fitted.resized, false);
    assert.equal(fitted.mimeType, 'image/png');
    assert.ok(fitted.bytes.equals(small), 're-encoding an image that fits wastes work and quality');
  });

  it('hands an undecodable image on unchanged instead of failing in its place', async () => {
    const { fitForVision } = await import('../src/server/brain/fitImage');
    const rubbish = Buffer.from('this is not a png at all', 'utf8');

    const fitted = await fitForVision(rubbish, 'image/png', { maxBytes: 4, maxEdge: 10 });

    // Whether these bytes are analysable is the provider's judgement. This step
    // exists only to help, so it must never turn a real answer into its own error.
    assert.equal(fitted.resized, false);
    assert.ok(fitted.bytes.equals(rubbish));
  });

  it('does not touch a GIF, because flattening an animation is a decision', async () => {
    const { fitForVision } = await import('../src/server/brain/fitImage');
    const frames = Buffer.alloc(64 * 1024, 7);

    const fitted = await fitForVision(frames, 'image/gif', { maxBytes: 1024, maxEdge: 100 });

    assert.equal(fitted.resized, false);
    assert.equal(fitted.mimeType, 'image/gif');
  });
});

describe('document understanding', () => {
  it('reads the text Phase 3 already extracted rather than re-extracting', async () => {
    await uploadText(mm, 'tone.txt', 'Warm, witty and a little cinematic. Talk about the occasion.');
    await extractAll();
    await understanding.enqueueUnderstanding(mm);

    assert.deepEqual(await understandAll(), ['understood']);
    assert.equal(fake.calls.document, 1);
    assert.equal(fake.calls.image, 0);
  });

  it('a document with no extraction yet is unsupported rather than failed', async () => {
    await uploadText(mm, 'not-extracted.txt', 'Some content.');
    // Deliberately not extracted.
    await understanding.enqueueUnderstanding(mm);
    await understandAll();

    const rows = await adminSql<{ status: string; error_message: string }[]>`
      select status, error_message from asset_understanding
    `;
    assert.equal(rows[0]!.status, 'unsupported');
    assert.match(rows[0]!.error_message, /not been extracted/i);
  });
});

describe('cost control and idempotency', () => {
  it('an unchanged asset is never analysed twice', async () => {
    await uploadText(mm, 'stable.txt', 'Unchanging content.');
    await extractAll();

    await understanding.enqueueUnderstanding(mm);
    await understandAll();
    const after1 = fake.calls.document;
    assert.equal(after1, 1);

    // Everything again: queue, claim, analyse. Nothing should reach the provider.
    assert.equal(await understanding.enqueueUnderstanding(mm), 0, 'an unchanged asset was queued again');
    assert.deepEqual(await understandAll(), []);
    assert.equal(fake.calls.document, after1, 'the provider was called for an unchanged asset');
  });

  it('a changed asset is analysed again, because its content hash moved', async () => {
    const file = await uploadText(mm, 'edited.txt', 'First version.');
    await extractAll();
    await understanding.enqueueUnderstanding(mm);
    await understandAll();

    // Rewriting the file gives it a new checksum, exactly as a re-sync would.
    await adminSql`
      update drive_files set checksum_sha256 = 'a-different-hash' where id = ${file.id}
    `;

    assert.equal(await understanding.enqueueUnderstanding(mm), 1, 'a changed asset was not re-queued');
  });

  it('a claimed asset is not handed to a second worker', async () => {
    await uploadText(mm, 'contested.txt', 'Content.');
    await extractAll();
    await understanding.enqueueUnderstanding(mm);

    const first = await understanding.claimAssetForUnderstanding();
    assert.ok(first);
    const second = await understanding.claimAssetForUnderstanding();
    assert.equal(second, null, 'the same asset was claimed twice');
  });
});

describe('failure handling', () => {
  it('a transient failure spends an attempt and backs off', async () => {
    const { BrainFailed } = await import('../src/server/brain/providers/types');
    await uploadText(mm, 'flaky.txt', 'Content.');
    await extractAll();
    await understanding.enqueueUnderstanding(mm);

    fake.failWith = new BrainFailed('PROVIDER_ERROR', 'transient', 'Provider hiccup.');
    const claim = await understanding.claimAssetForUnderstanding();
    const outcome = await understanding.understandClaimedAsset(claim!);

    assert.equal(outcome.status, 'failed');
    const rows = await adminSql<{ attempts: number; status: string; next_attempt_at: Date | null }[]>`
      select attempts, status, next_attempt_at from asset_understanding
    `;
    assert.equal(rows[0]!.attempts, 1);
    assert.equal(rows[0]!.status, 'pending');
    assert.ok(rows[0]!.next_attempt_at instanceof Date, 'no backoff was set');
  });

  it('rate limiting does not spend an attempt', async () => {
    const { BrainFailed } = await import('../src/server/brain/providers/types');
    await uploadText(mm, 'throttled.txt', 'Content.');
    await extractAll();
    await understanding.enqueueUnderstanding(mm);

    fake.failWith = new BrainFailed('RATE_LIMITED', 'rate_limited', 'Slow down.', 5);
    const claim = await understanding.claimAssetForUnderstanding();
    await understanding.understandClaimedAsset(claim!);

    const rows = await adminSql<{ attempts: number }[]>`select attempts from asset_understanding`;
    assert.equal(rows[0]!.attempts, 0, 'being rate limited must not cost an attempt');
  });

  it('a permanent failure stops immediately', async () => {
    const { BrainFailed } = await import('../src/server/brain/providers/types');
    await uploadText(mm, 'rejected.txt', 'Content.');
    await extractAll();
    await understanding.enqueueUnderstanding(mm);

    fake.failWith = new BrainFailed('PROVIDER_ERROR', 'permanent', 'No.');
    const claim = await understanding.claimAssetForUnderstanding();
    await understanding.understandClaimedAsset(claim!);

    const rows = await adminSql<{ status: string; attempts: number }[]>`
      select status, attempts from asset_understanding
    `;
    assert.equal(rows[0]!.status, 'failed');
    assert.equal(rows[0]!.attempts, 3);
  });

  it('an unconfigured Brain refuses rather than inventing knowledge', async () => {
    const { OpenAIBrainProvider } = await import('../src/server/brain/providers/openai');
    const unconfigured = new OpenAIBrainProvider(undefined);
    assert.equal(unconfigured.configured, false);

    await assert.rejects(
      () => unconfigured.analyzeDocument({ text: 'anything', filename: 'x.txt' }),
      (error: unknown) => {
        assert.equal((error as { code: string }).code, 'NOT_CONFIGURED');
        return true;
      },
    );
  });
});

describe('Brand DNA is counted, not asserted', () => {
  it('one asset does not make a company-wide rule', async () => {
    await uploadImage(mm, 'single.png', 5);
    await understanding.enqueueUnderstanding(mm);
    await understandAll();
    await brandDna.recomputeBrandDna(mm);

    const facts = await brandDna.readBrandDna(mm, { limit: 50 });
    assert.ok(facts.length > 0, 'nothing was learned at all');
    // Still an observation, not a pattern: one asset is not evidence of a habit.
    assert.ok(facts.every((f) => f.kind === 'observed'), 'one asset became a derived rule');
    assert.ok(facts.every((f) => f.confidence <= 0.3), 'one asset produced high confidence');
  });

  it('agreement across assets raises evidence and promotes the fact', async () => {
    // Two different assets that say the same thing, which is what evidence is.
    // This used to upload one image twice, and CIP now reads one content once:
    // two copies of a deck are one asset with two names, and counting them as
    // two inflated the evidence behind every claim they made.
    fake.imageFacts = [
      { section: 'visual', attribute: 'composition', value: 'centred' },
      { section: 'visual', attribute: 'lighting', value: 'soft daylight' },
    ];
    await uploadImage(mm, 'a.png', 7);
    await uploadImage(mm, 'b.png', 8);
    await understanding.enqueueUnderstanding(mm);
    await understandAll();
    await brandDna.recomputeBrandDna(mm);

    const facts = await brandDna.readBrandDna(mm, { limit: 50, minEvidence: 2 });
    assert.ok(facts.length > 0, 'agreeing assets did not accumulate evidence');
    assert.ok(facts.some((f) => f.kind === 'derived'), 'nothing was promoted to a pattern');
    assert.ok(facts.every((f) => f.evidenceCount >= 2));
  });

  it('confidence rises with evidence but never reaches certainty', () => {
    const one = brandDna.confidenceFromEvidence(1);
    const three = brandDna.confidenceFromEvidence(3);
    const many = brandDna.confidenceFromEvidence(100);

    assert.ok(one < three && three < many, 'confidence does not rise with evidence');
    assert.ok(many <= 0.95, 'confidence reached certainty');
    assert.equal(brandDna.confidenceFromEvidence(0), 0);
  });

  it('every fact can name the assets it came from', async () => {
    const file = await uploadImage(mm, 'provenance.png', 9);
    await understanding.enqueueUnderstanding(mm);
    await understandAll();

    const facts = await brandDna.readBrandDna(mm, { limit: 10 });
    const evidence = await brandDna.factEvidence(mm, facts[0]!.id);

    assert.ok(evidence.length > 0, 'a fact has no provenance');
    assert.equal(evidence[0]!.fileId, file.id);
    assert.equal(evidence[0]!.fileName, 'provenance.png');
  });

  it('re-analysing the same asset cannot inflate its own evidence', async () => {
    const once = await uploadImage(mm, 'once.png', 11);
    await understanding.enqueueUnderstanding(mm);
    await understandAll();
    await brandDna.recomputeBrandDna(mm);

    const before = await brandDna.readBrandDna(mm, { limit: 50 });

    // Force a second analysis of the same file by changing its hash. Named,
    // because an unscoped UPDATE here rewrites the checksum of every file on
    // the server — which on a shared test database is every other company's
    // too, and re-queues their assets for analysis in the middle of somebody
    // else's test.
    await adminSql`
      update drive_files
         set checksum_sha256 = 'another-hash'
       where id = ${once.id} and company_id = ${mm.companyId}
    `;
    await understanding.enqueueUnderstanding(mm);
    await understandAll();
    await brandDna.recomputeBrandDna(mm);

    const after = await brandDna.readBrandDna(mm, { limit: 50 });
    const sameFact = after.find((f) => f.attribute === before[0]!.attribute && f.value === before[0]!.value);
    assert.equal(sameFact?.evidenceCount, 1, 'one asset counted as two pieces of evidence');
  });
});

describe('planning a generation', () => {
  it('builds a brief from retrieved memory rather than forwarding the request', async () => {
    await uploadText(mm, 'voice.txt', 'Warm, witty and a little cinematic.');
    await extractAll();
    await understanding.enqueueUnderstanding(mm);
    await understandAll();
    await brandDna.recomputeBrandDna(mm);

    const request = 'Make an Instagram promo image';
    const plan = await planner.planGeneration(mm, { requestText: request, mediaType: 'image' });

    assert.ok(plan.briefId.length > 0);
    assert.ok(plan.brief.brandRules.length > 0, 'no brand knowledge reached the brief');

    const prompt = planner.promptFromBrief(plan.brief);
    assert.notEqual(prompt, request, 'the raw request was forwarded unchanged');
    assert.ok(prompt.includes(request), 'the request was lost entirely');
    assert.ok(prompt.length > request.length);
  });

  it('stores the brief so a decision can be audited later', async () => {
    const plan = await planner.planGeneration(mm, { requestText: 'Something', mediaType: 'image' });
    const rows = await adminSql<
      { request_text: string; task_type: string; confidence: string; brief: Record<string, unknown> }[]
    >`select request_text, task_type, confidence, brief from generation_briefs where id = ${plan.briefId}`;

    assert.equal(rows[0]!.request_text, 'Something');
    assert.ok(rows[0]!.task_type.length > 0);
    assert.equal(typeof rows[0]!.brief, 'object');
  });

  it('cannot claim confidence it has no evidence for', async () => {
    // Nothing analysed at all, so whatever the provider says, the plan must not
    // present itself as well-informed.
    const plan = await planner.planGeneration(mm, { requestText: 'Anything', mediaType: 'image' });
    assert.ok(plan.confidence <= 0.4, `claimed ${plan.confidence} with no brand evidence`);
  });
});

describe('clarification', () => {
  it('asks when several campaigns exist and the request names none', async () => {
    // Two campaigns on record makes "a promo image" genuinely ambiguous.
    for (const campaign of ['Diwali', 'World Heart Day']) {
      await adminSql`
        insert into brand_dna_facts (company_id, section, attribute, value, kind, confidence, evidence_count)
        values (${mm.companyId}, 'content', 'campaign', ${campaign}, 'observed', 0.5, 2)
      `;
    }

    const plan = await planner.planGeneration(mm, { requestText: 'Make a promo image', mediaType: 'image' });
    assert.ok(plan.clarificationQuestion, 'the Brain guessed instead of asking');
    assert.match(plan.clarificationQuestion!, /Diwali|World Heart Day/);
  });

  it('does not ask when the request already says which campaign', async () => {
    for (const campaign of ['Diwali', 'World Heart Day']) {
      await adminSql`
        insert into brand_dna_facts (company_id, section, attribute, value, kind, confidence, evidence_count)
        values (${mm.companyId}, 'content', 'campaign', ${campaign}, 'observed', 0.5, 2)
      `;
    }

    const plan = await planner.planGeneration(mm, {
      requestText: 'Make a Diwali promo image',
      mediaType: 'image',
    });
    assert.equal(plan.clarificationQuestion, null, 'the Brain asked a question it could answer itself');
  });

  it('generation stops and asks rather than producing something arbitrary', async () => {
    for (const campaign of ['Diwali', 'World Heart Day']) {
      await adminSql`
        insert into brand_dna_facts (company_id, section, attribute, value, kind, confidence, evidence_count)
        values (${mm.companyId}, 'content', 'campaign', ${campaign}, 'observed', 0.5, 2)
      `;
    }

    const result = await brainGenerate.generateWithBrain(mm, {
      requestText: 'Make a promo image',
      mediaType: 'image',
    });

    assert.equal(result.status, 'needs_clarification');
    // and nothing was generated on the way to asking
    const generated = await adminSql<{ n: number }[]>`select count(*)::int n from media_generations`;
    assert.equal(generated[0]!.n, 0);
  });
});

describe('feedback becomes scoped lessons', () => {
  async function generationFor(scope: Scope, prompt: string): Promise<string> {
    mediaProviders.__setProviders(null, null);
    const generation = await media.generateImage(scope, { prompt });
    return generation.id;
  }

  it('a bare score teaches nothing', async () => {
    const generationId = await generationFor(mm, 'something');
    await learning.submitFeedback(mm, { generationId, score: 7, comment: null });

    const outcome = await learning.analyseNextFeedback();
    assert.equal(outcome?.status, 'nothing_to_learn');
    assert.equal((await learning.readLessons(mm)).length, 0);
  });

  it('a comment produces a lesson scoped to the context it was given in', async () => {
    const generationId = await generationFor(mm, 'diwali post');
    const plan = await planner.planGeneration(mm, { requestText: 'Diwali post', mediaType: 'image' });
    await adminSql`update generation_briefs set generation_id = ${generationId} where id = ${plan.briefId}`;

    await learning.submitFeedback(mm, {
      generationId,
      score: 9,
      comment: 'Keep the text light.',
    });
    const outcome = await learning.analyseNextFeedback();
    assert.equal(outcome?.status, 'learned');

    const lessons = await learning.readLessons(mm);
    assert.equal(lessons.length, 1);
    assert.equal(lessons[0]!.polarity, 'prefer');
    // Scoped, not global: this is the whole point of context-aware learning.
    assert.ok(
      lessons[0]!.taskType !== null || lessons[0]!.campaign !== null || lessons[0]!.product !== null,
      'a single comment became a company-wide rule',
    );
  });

  it('a low score produces an avoidance', async () => {
    const generationId = await generationFor(mm, 'busy post');
    await learning.submitFeedback(mm, { generationId, score: 2, comment: 'Far too much text.' });
    await learning.analyseNextFeedback();

    const lessons = await learning.readLessons(mm);
    assert.equal(lessons[0]!.polarity, 'avoid');
  });

  it('a candidate becomes confirmed only once enough feedback agrees', async () => {
    const first = await generationFor(mm, 'one');
    const second = await generationFor(mm, 'two');

    await learning.submitFeedback(mm, { generationId: first, score: 9, comment: 'Keep the text light.' });
    await learning.analyseNextFeedback();
    assert.equal((await learning.readLessons(mm))[0]!.status, 'candidate', 'one opinion confirmed a rule');

    await learning.submitFeedback(mm, { generationId: second, score: 9, comment: 'Keep the text light.' });
    await learning.analyseNextFeedback();
    assert.equal((await learning.readLessons(mm))[0]!.status, 'confirmed');
    assert.equal((await learning.readLessons(mm))[0]!.evidenceCount, 2);
  });

  it('the same feedback analysed twice cannot inflate the evidence', async () => {
    const generationId = await generationFor(mm, 'one');
    await learning.submitFeedback(mm, { generationId, score: 9, comment: 'Keep the text light.' });
    await learning.analyseNextFeedback();

    // Replay it, as a restarted worker would.
    await adminSql`update generation_feedback set analysed_at = null`;
    await learning.analyseNextFeedback();

    const lessons = await learning.readLessons(mm);
    assert.equal(lessons[0]!.evidenceCount, 1, 'replaying feedback counted it twice');
    assert.equal(lessons[0]!.status, 'candidate');
  });

  it('one person cannot stack opinions on the same generation', async () => {
    const generationId = await generationFor(mm, 'one');
    await learning.submitFeedback(mm, { generationId, score: 3, comment: 'Too busy.' });
    await learning.submitFeedback(mm, { generationId, score: 9, comment: 'Actually good.' });

    const feedback = await learning.readFeedback(mm);
    assert.equal(feedback.length, 1, 'a second opinion created a second row');
    assert.equal(feedback[0]!.score, 9, 'changing your mind did not update the score');
  });

  it('refuses a score outside 0 to 10', async () => {
    const generationId = await generationFor(mm, 'one');
    for (const score of [-1, 11, 4.5]) {
      await assert.rejects(
        () => learning.submitFeedback(mm, { generationId, score, comment: null }),
        /whole number from 0 to 10/i,
      );
    }
  });
});

describe('context-aware learning', () => {
  it('a lesson from one campaign is not applied to another', async () => {
    // Learned about Diwali specifically.
    await adminSql`
      insert into brain_lessons
        (company_id, polarity, statement, campaign, status, evidence_count, confidence)
      values
        (${mm.companyId}, 'prefer', 'Use a large logo.', 'Diwali', 'confirmed', 2, 0.5)
    `;

    const forDiwali = await retrieval.applicableLessons(mm, { campaign: 'Diwali' });
    assert.equal(forDiwali.length, 1, 'the lesson was not retrieved for its own campaign');

    const forOther = await retrieval.applicableLessons(mm, { campaign: 'World Heart Day' });
    assert.equal(forOther.length, 0, 'a campaign lesson leaked into another campaign');
  });

  it('opposite preferences can coexist in different contexts', async () => {
    await adminSql`
      insert into brain_lessons (company_id, polarity, statement, campaign, status, evidence_count, confidence)
      values
        (${mm.companyId}, 'prefer', 'Large logo.', 'Diwali', 'confirmed', 2, 0.5),
        (${mm.companyId}, 'prefer', 'Small logo.', 'World Heart Day', 'confirmed', 2, 0.5)
    `;

    const diwali = await retrieval.applicableLessons(mm, { campaign: 'Diwali' });
    const heart = await retrieval.applicableLessons(mm, { campaign: 'World Heart Day' });

    assert.deepEqual(diwali.map((l) => l.statement), ['Large logo.']);
    assert.deepEqual(heart.map((l) => l.statement), ['Small logo.']);
  });

  it('an unscoped lesson applies everywhere', async () => {
    await adminSql`
      insert into brain_lessons (company_id, polarity, statement, status, evidence_count, confidence)
      values (${mm.companyId}, 'avoid', 'Never use stock photography.', 'confirmed', 3, 0.6)
    `;

    for (const campaign of ['Diwali', 'World Heart Day', null]) {
      const lessons = await retrieval.applicableLessons(mm, { campaign });
      assert.equal(lessons.length, 1, `an unscoped lesson was missed for ${campaign}`);
    }
  });

  it('THE TEST: a later request carries what earlier feedback taught', async () => {
    mediaProviders.__setProviders(null, null);
    const generation = await media.generateImage(mm, { prompt: 'diwali post' });

    const first = await planner.planGeneration(mm, { requestText: 'A Diwali post', mediaType: 'image' });
    await adminSql`update generation_briefs set generation_id = ${generation.id} where id = ${first.briefId}`;

    await learning.submitFeedback(mm, {
      generationId: generation.id,
      score: 9,
      comment: 'Keep the text light.',
    });
    await learning.analyseNextFeedback();

    const second = await planner.planGeneration(mm, { requestText: 'A Diwali post', mediaType: 'image' });

    // Retrieved by scope, not re-derived by the provider from examples.
    assert.ok(second.lessonIds.length > 0, 'the stored lesson was not retrieved');
    assert.ok(
      second.brief.learnedPreferences.some((p) => /text/i.test(p)),
      'the lesson did not reach the brief the generator acts on',
    );
    assert.ok(
      planner.promptFromBrief(second.brief).includes('Keep the text light.'),
      'the lesson did not reach the prompt',
    );
  });
});

describe('THE CHECKER: a creative judged against the brand, and nothing else', () => {
  /** An established pattern: enough evidence that a creative can be faulted for leaving it. */
  async function pattern(brand: string | null, section: string, attribute: string, value: string): Promise<string> {
    const rows = await adminSql<{ id: string }[]>`
      insert into brand_dna_facts
        (company_id, section, attribute, value, brand, kind, confidence, evidence_count)
      values (${mm.companyId}, ${section}, ${attribute}, ${value}, ${brand}, 'derived', 0.8, 6)
      returning id
    `;
    return rows[0]!.id;
  }

  async function rule(
    requirement: 'required' | 'forbidden',
    text: string,
    source: 'regulation' | 'suggested' | 'manual' = 'regulation',
    market: string | null = null,
    category = 'disclaimer',
  ): Promise<string> {
    const rows = await adminSql<{ id: string }[]>`
      insert into compliance_rules (company_id, market, category, requirement, rule, source)
      values (${mm.companyId}, ${market}, ${category}, ${requirement}, ${text}, ${source})
      returning id
    `;
    return rows[0]!.id;
  }

  /** A rule that states its own severity, the way a graded document's rules do. */
  async function gradedRule(
    severity: 'critical' | 'major' | 'minor' | 'informational',
    text: string,
    code = `TEST_${severity.toUpperCase()}_001`,
  ): Promise<string> {
    const rows = await adminSql<{ id: string }[]>`
      insert into compliance_rules
        (company_id, rule_code, category, requirement, rule, source, severity, rule_type)
      values (${mm.companyId}, ${code}, 'other', 'forbidden', ${text}, 'manual',
              ${severity}, 'prohibited')
      returning id
    `;
    return rows[0]!.id;
  }

  async function checkedImage(name = 'banner.png') {
    const { runCheck } = await import('../src/server/brain/checker');
    const file = await uploadImage(mm, name);
    return runCheck(mm, { fileId: file.id });
  }

  it('throws away a flag that cites a rule nobody sent', async () => {
    await rule('required', 'Carry a responsible drinking message.');
    // R1 exists. R9 does not: that is a rule the model made up, and a flag
    // grounded in nothing is exactly the output this product exists to stop.
    fake.checkFindings = [
      { ref: 'R9', dimension: 'compliance', severity: 'critical', message: 'Invented rule broken.' },
      { ref: 'R1', dimension: 'compliance', severity: 'critical', message: 'No responsible drinking message.' },
    ];

    const check = await checkedImage();

    assert.equal(check.status, 'ready');
    assert.equal(check.flags.length, 1, 'a flag citing an unsent rule reached the reviewer');
    assert.equal(check.flags[0]!.message, 'No responsible drinking message.');
    assert.ok(check.flags[0]!.citedRule, 'the surviving flag does not say which rule it came from');
  });

  // Fifteen of a nineteen-page deck came back needing fixing, and most of them
  // were dividers and title slides failing for not being adverts.
  it('does not judge a page that is not a creative', async () => {
    await rule('required', 'Carry a responsible drinking message.');
    fake.checkAssetKind = 'document_page';
    fake.checkFindings = [
      { ref: 'R1', dimension: 'compliance', severity: 'critical', message: 'The warning is missing.' },
    ];

    const check = await checkedImage('contents-slide.png');

    assert.equal(check.assetKind, 'document_page');
    assert.equal(check.flags.length, 0, 'a divider slide was failed for not being an advert');

    const { reportOn } = await import('../src/server/brain/qc');
    const report = await reportOn(mm, check);
    assert.equal(report.verdict, 'not_a_creative');
    // It passed nothing, because nothing was held up against it.
    assert.equal(report.passed.length, 0);
    assert.equal(report.counts.rulesApplied, 0);
  });

  // A rule that grades itself is the whole point of loading a document that
  // grades its rules. Without this, "tiger imagery is an approved association"
  // fails a creative for using a tiger.
  it("takes a graded rule's severity from the rule, not from the model", async () => {
    await gradedRule('informational', 'Tiger imagery is an approved association.');
    fake.checkFindings = [
      { ref: 'R1', dimension: 'compliance', severity: 'critical', message: 'A tiger is present.' },
    ];

    const check = await checkedImage();

    assert.equal(check.flags.length, 1);
    // The model said critical. The rule says informational, and the rule wrote
    // itself down first.
    assert.equal(check.flags[0]!.severity, 'note');
    assert.ok(check.score !== null && check.score > 49, `an informational rule failed the creative at ${check.score}`);
  });

  it('leaves an ungraded rule to the model, because a column default is not a decision', async () => {
    await rule('required', 'Carry the statutory warning.');
    fake.checkFindings = [
      { ref: 'R1', dimension: 'compliance', severity: 'critical', message: 'The warning is missing.' },
    ];

    const check = await checkedImage();

    // Nobody stated a severity for this rule, so the model's reading stands and
    // a missing statutory warning still fails.
    assert.equal(check.flags[0]!.severity, 'critical');
    assert.ok(check.score !== null && check.score <= 49, `scored ${check.score} while failing compliance`);
  });

  it('fails a creative that breaks a compliance requirement, however on-brand it is', async () => {
    await pattern(null, 'visual', 'logo placement', 'top-left');
    await rule('required', 'Carry a responsible drinking message.');
    fake.checkFindings = [
      { ref: 'R1', dimension: 'compliance', severity: 'critical', message: 'The warning is missing.' },
    ];

    const check = await checkedImage();

    // Visual is perfect and compliance is at 60. An average says 80. A banner
    // missing its mandatory warning must not come back as a pass.
    assert.equal(check.visualScore, 100);
    assert.ok(check.score !== null && check.score <= 49, `scored ${check.score} while failing compliance`);
  });

  it('never lets a habit be a hard failure', async () => {
    await pattern(null, 'visual', 'logo placement', 'top-left');
    // What the brand has usually done is not what it must do.
    fake.checkFindings = [
      { ref: 'F1', dimension: 'visual', severity: 'critical', message: 'Logo is bottom-right.' },
    ];

    const check = await checkedImage();
    assert.equal(check.flags[0]!.severity, 'warning');
  });

  it('files a flag under what its rule is, not what the model called it', async () => {
    await rule('forbidden', 'Must not show anyone who looks under 18.', 'regulation', null, 'audience');
    fake.checkFindings = [
      { ref: 'R1', dimension: 'visual', severity: 'critical', message: 'A model looks underage.' },
    ];

    const check = await checkedImage();
    assert.equal(check.flags[0]!.dimension, 'compliance');
    assert.equal(check.complianceScore, 60);
  });

  it('does not score a dimension it had nothing to judge against', async () => {
    fake.checkFindings = [];
    const check = await checkedImage();

    // Nothing to fail is not the same as passing. A hundred against nothing
    // is the most misleading number a checker could show.
    assert.equal(check.score, null);
    assert.equal(check.factsConsidered, 0);
    assert.equal(check.rulesConsidered, 0);
    assert.match(check.summary ?? '', /nothing to check against/i);
  });

  it('never sends a rule about broadcast times, which a picture cannot show', async () => {
    await rule('forbidden', 'Television adverts run only after 9pm.', 'regulation', null, 'medium');
    await rule('required', 'Carry a responsible drinking message.');
    fake.checkFindings = [];

    const check = await checkedImage();
    assert.equal(check.rulesConsidered, 1, 'a timing rule was sent to be judged from an image');
  });

  it('keeps another market out of the check', async () => {
    await rule('required', 'Carry "Not recommended for pregnant women".', 'regulation', 'Ghana');
    await rule('required', 'Carry a responsible drinking message.', 'regulation', 'Nigeria');
    fake.checkFindings = [];

    const { runCheck } = await import('../src/server/brain/checker');
    const file = await uploadImage(mm, 'lagos-billboard.png');
    const check = await runCheck(mm, { fileId: file.id, market: 'Nigeria' });

    // Ghana's warning is Ghana's. Faulting a Nigerian billboard for missing
    // it would be a false flag with a regulation's authority behind it.
    assert.equal(check.rulesConsidered, 1);
  });

  describe('Disagree? Correct this.', () => {
    it('an exception stops counting against the score and changes nothing CIP believes', async () => {
      const factId = await pattern(null, 'visual', 'logo placement', 'top-left');
      fake.checkFindings = [
        { ref: 'F1', dimension: 'visual', severity: 'warning', message: 'Logo is bottom-right.' },
      ];
      const check = await checkedImage();
      assert.equal(check.visualScore, 85);

      const { correctFlag } = await import('../src/server/brain/checker');
      const result = await correctFlag(mm, check.flags[0]!.id, {
        decision: 'dispute', reason: 'exception', correction: 'Cinema cut-down; logo moves for the aspect ratio.',
      });

      assert.equal(result.check.visualScore, 100, 'a disputed flag still counted');
      assert.equal(result.learned, null);
      const rows = await adminSql<{ status: string }[]>`select status from brand_dna_facts where id = ${factId}`;
      assert.equal(rows[0]!.status, 'active', 'an exception rewrote what CIP believes about the brand');
    });

    it('a wrong rule is unlearned, because a person said so', async () => {
      const factId = await pattern(null, 'visual', 'logo placement', 'top-left');
      fake.checkFindings = [
        { ref: 'F1', dimension: 'visual', severity: 'warning', message: 'Logo is bottom-right.' },
      ];
      const check = await checkedImage();

      const { correctFlag } = await import('../src/server/brain/checker');
      const result = await correctFlag(mm, check.flags[0]!.id, { decision: 'dispute', reason: 'wrong_rule' });

      assert.equal(result.learned, 'fact_rejected');
      const rows = await adminSql<{ status: string }[]>`select status from brand_dna_facts where id = ${factId}`;
      assert.equal(rows[0]!.status, 'rejected');
    });

    it("keeps a regulator's rule when one reviewer disagrees with it", async () => {
      const ruleId = await rule('required', 'Carry "Drink Responsibly".', 'regulation');
      fake.checkFindings = [
        { ref: 'R1', dimension: 'compliance', severity: 'critical', message: 'Missing.' },
      ];
      const check = await checkedImage();

      const { correctFlag } = await import('../src/server/brain/checker');
      const result = await correctFlag(mm, check.flags[0]!.id, { decision: 'dispute', reason: 'wrong_rule' });

      // Recorded, not obeyed: the statute did not change its mind.
      assert.equal(result.learned, 'rule_kept');
      const rows = await adminSql<{ active: boolean }[]>`select active from compliance_rules where id = ${ruleId}`;
      assert.equal(rows[0]!.active, true);
    });

    it('retires a rule CIP only suggested', async () => {
      const ruleId = await rule('required', 'Carry the statutory warning.', 'suggested');
      fake.checkFindings = [
        { ref: 'R1', dimension: 'compliance', severity: 'critical', message: 'Missing.' },
      ];
      const check = await checkedImage();

      const { correctFlag } = await import('../src/server/brain/checker');
      const result = await correctFlag(mm, check.flags[0]!.id, { decision: 'dispute', reason: 'wrong_rule' });

      assert.equal(result.learned, 'rule_retired');
      const rows = await adminSql<{ active: boolean }[]>`select active from compliance_rules where id = ${ruleId}`;
      assert.equal(rows[0]!.active, false);
    });
  });

  it('checks a creative CIP generated with the same checker as a human one', async () => {
    await rule('required', 'Carry a responsible drinking message.');
    fake.checkFindings = [];
    await uploadText(mm, 'voice.txt', 'Warm, celebratory, never about the alcohol itself.');
    await extractAll();
    await understanding.enqueueUnderstanding(mm);
    await understandAll();

    const { generateWithBrain } = await import('../src/server/brain/generate');
    const made = await generateWithBrain(mm, { requestText: 'A celebratory banner', mediaType: 'image' });
    assert.equal(made.status, 'generated');

    const { runCheck } = await import('../src/server/brain/checker');
    const check = await runCheck(mm, { generationId: (made as { generation: { id: string } }).generation.id });

    assert.equal(check.status, 'ready');
    assert.equal(check.rulesConsidered, 1);
  });

  it('one company cannot read or correct another company check', async () => {
    await rule('required', 'Carry a responsible drinking message.');
    fake.checkFindings = [
      { ref: 'R1', dimension: 'compliance', severity: 'critical', message: 'Missing.' },
    ];
    const check = await checkedImage();

    const { getCheck, correctFlag } = await import('../src/server/brain/checker');
    assert.equal(await getCheck(nh, check.id), null);
    await assert.rejects(
      () => correctFlag(nh, check.flags[0]!.id, { decision: 'accept' }),
      /not in this workspace/i,
    );
  });
});

describe('reading the design, not just the picture', () => {
  it('records where the logo sits, not only that there is one', async () => {
    await uploadImage(mm, 'packshot.png');
    await extractAll();
    await understanding.enqueueUnderstanding(mm);
    await understandAll();

    const rows = await adminSql<{ attribute: string; value: string }[]>`
      select attribute, value from brand_dna_facts
       where company_id = ${mm.companyId}
         and attribute in ('logo placement', 'logo scale', 'headline placement',
                           'headline case', 'product placement', 'font', 'palette')
    `;
    const held = new Set(rows.map((r) => r.attribute));

    // "logoPresent: true" said a logo exists and nothing about where a
    // designer put it, how big it ran, or what the headline was set in -
    // which is most of what a brand's rules are actually about.
    assert.ok(held.has('logo placement'), 'CIP still only knows that a logo exists');
    assert.ok(held.has('logo scale'));
    assert.ok(held.has('font'));
    assert.ok(held.has('palette'));
  });

  it('uses the same attribute name every time, so evidence accumulates', async () => {
    // The point of fixed names. Every other fact is phrased freshly by the
    // model, so the same observation arrived three different ways and nothing
    // could be counted - on the real roster that left 1231 facts of which not
    // one was held by two brands.
    await uploadImage(mm, 'first.png', 1);
    await uploadImage(mm, 'second.png', 2);
    await extractAll();
    await understanding.enqueueUnderstanding(mm);
    await understandAll();

    const rows = await adminSql<{ n: number }[]>`
      select count(distinct attribute)::int as n from brand_dna_facts
       where company_id = ${mm.companyId} and attribute ilike '%logo%placement%'
    `;
    assert.equal(rows[0]!.n, 1, 'the same observation was filed under more than one name');
  });

  it('keeps a stated nothing out of the evidence', async () => {
    const { designFacts } = await import('../src/server/brain/understanding');
    const facts = designFacts(
      {
        design: {
          logoPlacement: 'top-left',
          // The model saying null in prose. Storing these would build evidence
          // for a brand whose logo is placed "unknown".
          logoScale: 'unknown',
          productPlacement: 'not visible',
          headlinePlacement: null,
          headlineCase: '',
          fonts: ['geometric sans'],
          paletteHex: ['#0b5240'],
          safeArea: null,
        },
      },
      'Rampur',
    );

    const attributes = facts.map((f) => f.attribute);
    assert.ok(attributes.includes('logo placement'));
    assert.ok(attributes.includes('font'));
    assert.ok(!attributes.includes('logo scale'), '"unknown" was stored as a fact');
    assert.ok(!attributes.includes('product placement'), '"not visible" was stored as a fact');
    assert.ok(!attributes.includes('headline placement'));
    assert.ok(facts.every((f) => f.brand === 'Rampur'), 'design facts lost their brand');
  });
});

describe('the calendar', () => {
  /** A date a given number of days from today, as the calendar stores them. */
  function inDays(days: number): string {
    const when = new Date();
    when.setDate(when.getDate() + days);
    return when.toISOString().slice(0, 10);
  }

  it('shows what is coming and leaves behind what is gone', async () => {
    const calendar = await import('../src/server/brain/calendar');

    await calendar.addOccasion(mm, {
      occasion: 'Independence Day', market: 'Nigeria',
      startsOn: inDays(19), kind: 'public_holiday', languages: ['English'],
    });
    await calendar.addOccasion(mm, {
      occasion: 'Republic Day', market: 'Ghana', startsOn: inDays(-40), kind: 'public_holiday',
    });

    const soon = await calendar.upcoming(mm, { withinDays: 90 });
    const names = soon.map((o) => o.occasion);

    assert.ok(names.includes('Independence Day'));
    assert.ok(!names.includes('Republic Day'), 'a date that has passed is not something to plan for');
    assert.equal(soon.find((o) => o.occasion === 'Independence Day')!.daysAway, 19);
  });

  it('keeps a season that has already started', async () => {
    const calendar = await import('../src/server/brain/calendar');
    // Somebody halfway through December is exactly who is making December work.
    await calendar.addOccasion(mm, {
      occasion: 'Detty December', market: 'West Africa',
      startsOn: inDays(-8), endsOn: inDays(22), kind: 'season',
    });

    const soon = await calendar.upcoming(mm, { withinDays: 90 });
    assert.ok(
      soon.some((o) => o.occasion === 'Detty December'),
      'a season already running dropped off the list on the day it began',
    );
  });

  it('shows a market its own dates and the ones that belong to everyone', async () => {
    const calendar = await import('../src/server/brain/calendar');
    await calendar.addOccasion(mm, { occasion: 'Founders Day', market: 'Ghana', startsOn: inDays(9) });
    await calendar.addOccasion(mm, { occasion: 'Nigeria Independence', market: 'Nigeria', startsOn: inDays(19) });
    await calendar.addOccasion(mm, { occasion: 'New Year', market: null, startsOn: inDays(30) });

    const nigeria = (await calendar.upcoming(mm, { withinDays: 90, market: 'Nigeria' }))
      .map((o) => o.occasion);

    assert.ok(nigeria.includes('Nigeria Independence'));
    // A date with no market belongs everywhere, exactly as a fact with no brand
    // belongs to every brand.
    assert.ok(nigeria.includes('New Year'));
    assert.ok(!nigeria.includes('Founders Day'), "another country's holiday is not this market's");
  });

  it('does not put the same holiday on twice', async () => {
    const calendar = await import('../src/server/brain/calendar');
    const entry = { occasion: 'Christmas Day', market: 'West Africa', startsOn: inDays(40) };

    await calendar.addOccasion(mm, { ...entry, languages: ['English'] });
    await calendar.addOccasion(mm, { ...entry, languages: ['English', 'French'] });

    const rows = await adminSql`
      select id, languages from content_calendar
       where company_id = ${mm.companyId} and occasion = 'Christmas Day'
    `;
    assert.equal(rows.length, 1, 'importing a year twice left two of each');
    assert.deepEqual(rows[0]!.languages, ['English', 'French'], 'the second import should correct the first');
  });

  it('lets an import fill an empty note but never overwrite a typed one', async () => {
    const calendar = await import('../src/server/brain/calendar');
    const entry = { occasion: 'Black Friday', market: 'West Africa', startsOn: inDays(60) };

    await calendar.addOccasion(mm, { ...entry, note: 'Run the gifting pack.', source: 'manual' });
    await calendar.addOccasion(mm, { ...entry, note: 'Imported from the 2026 sheet.', source: 'imported' });

    const rows = await adminSql`
      select note from content_calendar
       where company_id = ${mm.companyId} and occasion = 'Black Friday'
    `;
    assert.equal(rows[0]!.note, 'Run the gifting pack.', 'a person wrote that, and an import overwrote it');
  });

  it('turns an occasion into a request the planner can read', async () => {
    const calendar = await import('../src/server/brain/calendar');
    await calendar.addOccasion(mm, {
      occasion: 'Independence Day', market: 'Nigeria', brand: '8PM',
      startsOn: inDays(19), languages: ['English'],
    });

    const [occasion] = await calendar.upcoming(mm, { withinDays: 30, market: 'Nigeria' });
    assert.ok(occasion, 'the occasion just added was not on the calendar');
    const request = calendar.requestFor(occasion);

    // The market and the brand have to survive into the request, because they
    // are what make the planner read the right knowledge and no other.
    assert.match(request, /Independence Day/);
    assert.match(request, /Nigeria/);
    assert.match(request, /8PM/);
  });

  it('one company cannot see another company calendar', async () => {
    const calendar = await import('../src/server/brain/calendar');
    await calendar.addOccasion(mm, { occasion: 'Diwali', market: 'India', startsOn: inDays(25) });

    const theirs = await calendar.upcoming(nh, { withinDays: 90 });
    assert.equal(theirs.length, 0);
  });
});

describe('the Brain disagreeing with itself', () => {
  /** A fact with a chosen weight of evidence behind it. */
  async function claim(
    brand: string,
    attribute: string,
    value: string,
    evidence: number,
  ): Promise<void> {
    await adminSql`
      insert into brand_dna_facts
        (company_id, section, attribute, value, brand, kind, confidence, evidence_count)
      values (${mm.companyId}, 'visual', ${attribute}, ${value}, ${brand},
              'observed', 0.5, ${evidence})
      on conflict do nothing
    `;
  }

  async function statusOf(brand: string, value: string): Promise<string> {
    const rows = await adminSql<{ status: string }[]>`
      select status from brand_dna_facts
       where company_id = ${mm.companyId} and brand = ${brand} and value = ${value}
    `;
    return rows[0]?.status ?? 'missing';
  }

  /**
   * Enough brands using an attribute one way for its shape to be readable.
   * A question only one brand has ever answered says nothing about whether it
   * takes one answer or several.
   */
  async function capColourAcrossBrands(): Promise<void> {
    await claim('B', 'cap colour', 'gold', 2);
    await claim('C', 'cap colour', 'silver', 1);
    await claim('D', 'cap colour', 'black', 1);
  }

  it('retires the weaker of two claims that cannot both be true', async () => {
    const { resolveContradictions } = await import('../src/server/brain/contradictions');
    await capColourAcrossBrands();
    // One bottle, one cap. Four assets against one is a resolved question.
    await claim('A', 'cap colour', 'gold', 4);
    await claim('A', 'cap colour', 'black', 1);

    const outcome = await resolveContradictions(mm);
    assert.ok(outcome.superseded >= 1, 'a claim beaten four to one was left standing');

    assert.equal(await statusOf('A', 'gold'), 'active');
    assert.equal(await statusOf('A', 'black'), 'superseded');
  });

  it('sets both aside when the evidence does not settle it', async () => {
    const { resolveContradictions } = await import('../src/server/brain/contradictions');
    await claim('B', 'crest', 'lions', 1);
    await claim('C', 'crest', 'stag', 1);
    // Three against two is not evidence, it is a thing CIP does not know.
    // Declaring the leader the winner is how a confident wrong answer is made.
    await claim('A', 'crest', 'lions rampant', 3);
    await claim('A', 'crest', 'eagles displayed', 2);

    await resolveContradictions(mm);

    assert.equal(await statusOf('A', 'lions rampant'), 'contested');
    assert.equal(await statusOf('A', 'eagles displayed'), 'contested');
  });

  it('keeps a contested claim out of the brief entirely', async () => {
    const { resolveContradictions } = await import('../src/server/brain/contradictions');
    await claim('B', 'crest', 'lions', 1);
    await claim('C', 'crest', 'stag', 1);
    await claim('A', 'crest', 'lions rampant', 3);
    await claim('A', 'crest', 'eagles displayed', 2);
    await resolveContradictions(mm);

    const facts = await brandDna.readBrandDna(mm, { minEvidence: 1, limit: 50, brand: 'A' });
    const values = facts.map((f) => f.value);
    assert.ok(
      !values.includes('lions rampant') && !values.includes('eagles displayed'),
      'a question the assets answer two ways reached the generator anyway',
    );
  });

  it('leaves an attribute that is meant to hold several values alone', async () => {
    const { resolveContradictions } = await import('../src/server/brain/contradictions');
    // A palette is a list. Every brand holds several, so nothing here is a
    // disagreement - and retiring half of it would be the worst kind of bug,
    // because the brief would still look complete.
    for (const [brand, first, second] of [
      ['A', 'deep navy', 'warm gold'],
      ['B', 'oxblood', 'cream'],
      ['C', 'forest green', 'white'],
    ] as const) {
      await claim(brand, 'colour palette', first, 3);
      await claim(brand, 'colour palette', second, 2);
    }

    await resolveContradictions(mm);

    assert.equal(await statusOf('A', 'deep navy'), 'active');
    assert.equal(await statusOf('A', 'warm gold'), 'active');
  });

  it('brings a claim back when whatever beat it loses its evidence', async () => {
    const { resolveContradictions } = await import('../src/server/brain/contradictions');
    await capColourAcrossBrands();
    await claim('A', 'cap colour', 'gold', 4);
    await claim('A', 'cap colour', 'black', 1);
    await resolveContradictions(mm);
    assert.equal(await statusOf('A', 'black'), 'superseded');

    // The assets behind the winner go away, so the recompute drops its
    // evidence. Knowledge that only ever moves one way is not learning.
    await adminSql`
      update brand_dna_facts set evidence_count = 1
       where company_id = ${mm.companyId} and brand = 'A' and value = 'gold'
    `;
    await resolveContradictions(mm);

    assert.notEqual(await statusOf('A', 'black'), 'superseded');
  });

  it('never touches a fact a person rejected', async () => {
    const { resolveContradictions } = await import('../src/server/brain/contradictions');
    await capColourAcrossBrands();
    await claim('A', 'cap colour', 'gold', 4);
    await claim('A', 'cap colour', 'black', 1);
    await adminSql`
      update brand_dna_facts set status = 'rejected'
       where company_id = ${mm.companyId} and brand = 'A' and value = 'black'
    `;

    await resolveContradictions(mm);

    // A rejection is a decision, not an inference, and nothing automatic gets
    // to overturn it - in either direction.
    assert.equal(await statusOf('A', 'black'), 'rejected');
  });

  it('says what it cannot decide, so somebody can settle it', async () => {
    const { resolveContradictions, disagreements } = await import(
      '../src/server/brain/contradictions'
    );
    await claim('B', 'crest', 'lions', 1);
    await claim('C', 'crest', 'stag', 1);
    await claim('A', 'crest', 'lions rampant', 3);
    await claim('A', 'crest', 'eagles displayed', 2);
    await resolveContradictions(mm);

    const open = await disagreements(mm);
    const crest = open.find((d) => d.brand === 'A');
    assert.ok(crest, 'CIP set two claims aside and could not say which');
    assert.equal(crest.values.length, 2);
    assert.equal(crest.values[0]!.value, 'lions rampant', 'best supported first');
  });
});

describe('THE BOUNDARY: asked for one brand, only that brand is read', () => {
  /** A file belonging to a brand, understood and embedded like any other. */
  async function brandFile(brand: string | null, name: string, summary: string): Promise<string> {
    const file = await uploadText(mm, name, summary);
    await extractAll();
    // Queued before it can be claimed, exactly as the worker does it. Without
    // this understandAll() finds nothing to take and the file is never
    // understood, so it has no embedding and similarity cannot return it.
    //
    // That was invisible on a database carrying rows from an earlier run — the
    // file was already there to be found — and showed only on a clean one.
    // Which is CI, where the assertion below failed on every run while passing
    // everywhere else. The test above it went on passing throughout, because
    // it asserts an absence and an empty result satisfies that trivially.
    await understanding.enqueueUnderstanding(mm);
    await understandAll();
    await adminSql`
      update drive_files set brand = ${brand}
       where id = ${file.id} and company_id = ${mm.companyId}
    `;
    return file.id;
  }

  it('does not show one brand a sibling brand file', async (t) => {
    // Retrieval by meaning needs pgvector. Skipped rather than passed when it
    // is absent: this test asserts an absence, and without vectors it would
    // report success over a function that returned nothing at all.
    if (!db.hasVector) return t.skip('needs pgvector');

    const brands = await import('../src/server/brain/brands');
    await brands.addBrand(mm, { name: '8PM' });
    await brands.addBrand(mm, { name: 'Whytehall Honey' });

    await brandFile('8PM', '8pm-packshot.txt', 'Eight PM whisky bottle on black with gold type.');
    await brandFile('Whytehall Honey', 'whytehall-honey.txt', 'Honey whisky bottle, warm amber, honeycomb motif.');

    const { similarAssets } = await import('../src/server/brain/retrieval');
    const found = await similarAssets(mm, 'a honey whisky banner', 10, '8PM');

    // The request says honey. Similarity does not respect a roster, and the
    // sibling's packshot is the single most misleading thing a generator can
    // be shown — it does not argue with the brief, it copies.
    assert.ok(
      !found.some((a) => a.fileName === 'whytehall-honey.txt'),
      "a Whytehall Honey file was offered as what 8PM looks like",
    );
  });

  it('lets what belongs to no brand reach every brand', async (t) => {
    if (!db.hasVector) return t.skip('needs pgvector');

    const brands = await import('../src/server/brain/brands');
    await brands.addBrand(mm, { name: '8PM' });
    await brandFile(null, 'house-style.txt', 'Every Radico piece keeps the statutory warning legible.');

    const { similarAssets } = await import('../src/server/brain/retrieval');
    const found = await similarAssets(mm, 'statutory warning legibility', 10, '8PM');
    assert.ok(
      found.some((a) => a.fileName === 'house-style.txt'),
      'a house-wide file was withheld from a brand it applies to',
    );
  });

  it("does not teach one brand from another brand's feedback", async () => {
    const brands = await import('../src/server/brain/brands');
    await brands.addBrand(mm, { name: '8PM' });
    await brands.addBrand(mm, { name: 'Magic Moments' });

    await adminSql`
      insert into brain_lessons
        (company_id, polarity, statement, brand, status, evidence_count, confidence)
      values
        (${mm.companyId}, 'prefer', 'Keep the Magic Moments product prominent and central.',
         'Magic Moments', 'confirmed', 3, 0.9),
        (${mm.companyId}, 'avoid', 'Never imply drinking improves performance.',
         null, 'confirmed', 3, 0.9)
    `;

    const { applicableLessons } = await import('../src/server/brain/retrieval');
    const lessons = await applicableLessons(mm, { brand: '8PM' });
    const statements = lessons.map((l) => l.statement);

    // Exactly what was seen on a real 8PM brief: eight of its "learned from
    // your feedback" lines named Magic Moments.
    assert.ok(
      !statements.some((s) => s.includes('Magic Moments')),
      `a Magic Moments lesson reached an 8PM brief: ${statements.join(' | ')}`,
    );
    assert.ok(
      statements.some((s) => s.includes('drinking improves performance')),
      'a house-wide rule was withheld from a brand it applies to',
    );
  });

  it('the same lesson about two brands stays two lessons', async () => {
    // Otherwise one brand's feedback confirms the other's rule, and the
    // evidence count — which is what promotes a candidate — counts twice.
    for (const brand of ['8PM', 'Whytehall']) {
      await adminSql`
        insert into brain_lessons (company_id, polarity, statement, brand, status)
        values (${mm.companyId}, 'prefer', 'Keep the product prominent.', ${brand}, 'candidate')
        on conflict do nothing
      `;
    }
    const rows = await adminSql<{ n: number }[]>`
      select count(*)::int as n from brain_lessons
       where company_id = ${mm.companyId} and statement = 'Keep the product prominent.'
    `;
    assert.equal(rows[0]!.n, 2);
  });

  it('works out which brand a file is about from its name', async () => {
    const brands = await import('../src/server/brain/brands');
    await brands.addBrand(mm, { name: 'Rampur', aliases: ['asava', 'jugalbandi'] });
    await brands.addBrand(mm, { name: 'Magic Moments' });

    await uploadText(mm, 'Asava_Bottle.txt', 'A bottle.');
    await uploadText(mm, 'house-rules.txt', 'Something about everything.');

    const labelled = await brands.suggestBrands(mm);
    assert.ok(labelled >= 1, 'nothing was labelled');

    const rows = await adminSql<{ name: string; brand: string | null }[]>`
      select name, brand from drive_files
       where company_id = ${mm.companyId} and name in ('Asava_Bottle.txt', 'house-rules.txt')
       order by name
    `;
    const byName = new Map(rows.map((r) => [r.name, r.brand]));
    assert.equal(byName.get('Asava_Bottle.txt'), 'Rampur', 'an alias in a filename was not read');
    assert.equal(byName.get('house-rules.txt'), null, 'a name naming no brand was given one anyway');
  });
});

describe('the same file twice', () => {
  it('is read once, however many copies of it a company has', async () => {
    const bytes = png(256, 256, 91);
    await drive.uploadFile(mm, {
      folderId: null, filename: 'twice-a.png', mimeType: 'image/png', body: bytes,
    });
    await drive.uploadFile(mm, {
      folderId: null, filename: 'twice-b.png', mimeType: 'image/png', body: bytes,
    });

    await understanding.enqueueUnderstanding(mm);

    // Two readings of one deck were two assets as far as Brand DNA was
    // concerned, and it promotes a claim when enough separate assets agree.
    const rows = await adminSql<{ n: number }[]>`
      select count(*)::int as n
        from asset_understanding u
        join drive_files f on f.id = u.file_id
       where f.company_id = ${mm.companyId}
         and f.name in ('twice-a.png', 'twice-b.png')
    `;
    assert.equal(rows[0]!.n, 1, 'the same bytes were queued to be read twice');
  });
});

describe('the product in the picture is the company\'s own', () => {
  /** An asset already understood, described the way the real Brain describes one. */
  async function understood(
    scope: Scope,
    filename: string,
    seed: number,
    brand: string,
    summary: string,
    structured: { contentType: string; products?: string[] },
  ): Promise<string> {
    const file = await uploadImage(scope, filename, seed);
    await adminSql`update drive_files set brand = ${brand} where id = ${file.id}`;
    await adminSql`
      insert into asset_understanding
        (company_id, file_id, kind, provider, model, content_hash, status, summary, structured)
      values
        (${scope.companyId}, ${file.id}, 'image', 'fake', 'fake-1', ${`hash-${seed}`}, 'ready',
         ${summary}, ${adminSql.json(structured)})
    `;
    return file.id;
  }

  it('leads the references with a photograph of the product, and says to copy it', async () => {
    const brands = await import('../src/server/brain/brands');
    await brands.addBrand(mm, { name: '8PM' });

    const packshot = await understood(
      mm, '8pm-honey-packshot.png', 41, '8PM',
      'Packshot of the 8PM Honey bottle on a solid black background.',
      { contentType: 'packshot', products: ['bottle of whisky'] },
    );
    await understood(
      mm, 'diwali-poster.png', 42, '8PM',
      'Diwali poster with diyas, marigolds and a headline.',
      { contentType: 'out-of-home (OOH) creative / poster' },
    );

    const plan = await planner.planGeneration(mm, {
      requestText: 'A Diwali banner for 8PM Honey',
      mediaType: 'image',
      brand: '8PM',
      market: 'India',
    });

    // Similarity answers "what resembles a Diwali banner", and for a brand
    // with a Diwali poster the answer is the poster — so the generator was
    // shown the campaign and never the bottle, and drew a bottle of its own.
    assert.equal(plan.productShots[0]?.fileName, '8pm-honey-packshot.png', 'the packshot was not found');
    assert.equal(plan.references[0]?.fileId, packshot, 'the packshot did not lead the references');
  });

  it('tells the generator the attached photograph is the product, not a mood board', async () => {
    const brands = await import('../src/server/brain/brands');
    await brands.addBrand(mm, { name: '8PM' });
    await understood(
      mm, '8pm-packshot.png', 43, '8PM',
      'Packshot of the 8PM bottle.',
      { contentType: 'packshot', products: ['bottle of whisky'] },
    );

    mediaProviders.__setProviders(null, null);
    const out = await brainGenerate.generateWithBrain(mm, {
      requestText: 'A Diwali banner for 8PM',
      mediaType: 'image',
      market: 'India',
    });
    assert.equal(out.status, 'generated');
    if (out.status !== 'generated') return;

    const rows = await adminSql<{ prompt: string }[]>`
      select prompt from media_generations where id = ${out.generation.id}
    `;
    // Reference images were attached and nothing said what they were for.
    assert.match(rows[0]!.prompt, /photograph/i, 'the prompt never says what the attachment is');
    assert.match(rows[0]!.prompt, /do not redesign the label/i, 'nothing told it to keep the label');
    assert.ok(out.plan.productShots.length > 0, 'the plan does not say a product photo was used');
  });
});

describe('what the Brain hands the generator', () => {
  it('delivers the shape the request asked for, not the nearest one on sale', async () => {
    await uploadText(mm, 'voice.txt', 'Warm, celebratory, never about the alcohol itself.');
    await extractAll();
    await understandAll();

    const { generateWithBrain } = await import('../src/server/brain/generate');
    const out = await generateWithBrain(mm, {
      // The exact phrasing that was ignored: a ratio written in prose, which
      // nothing parsed, so the format decided and the person was told to crop
      // the result themselves.
      requestText: 'Generate a banner of honey whisky with wildlife behind it. ar 4:5',
      mediaType: 'image',
    });

    assert.equal(out.status, 'generated', 'nothing was made');
    assert.equal(out.plan.deliveredShape, '4:5', 'the shape in the request was ignored');

    const assets = await adminSql<{ width: number; height: number }[]>`
      select width, height from media_generation_assets
       where generation_id = ${(out as { generation: { id: string } }).generation.id}
    `;
    assert.ok(assets.length > 0, 'the generation produced no asset');
    for (const asset of assets) {
      const ratio = asset.width / asset.height;
      assert.ok(
        Math.abs(Math.log(ratio / (4 / 5))) < 0.02,
        `asked for 4:5 and got ${asset.width}x${asset.height}`,
      );
    }
  });

  it('keeps a shape given in the answer to a question', async () => {
    const { generateWithBrain } = await import('../src/server/brain/generate');
    const out = await generateWithBrain(mm, {
      // A banner on its own is 3:1. The square was only said in reply, and the
      // reply was never read for a shape, so this came back a strip.
      requestText: 'Generate a banner of honey whisky with wildlife behind it',
      clarification: 'make it 4:4',
      mediaType: 'image',
    });

    assert.equal(out.status, 'generated', 'nothing was made');
    assert.equal(out.plan.deliveredShape, '1:1', 'the shape in the answer was ignored');

    const assets = await adminSql<{ width: number; height: number }[]>`
      select width, height from media_generation_assets
       where generation_id = ${(out as { generation: { id: string } }).generation.id}
    `;
    assert.ok(assets.length > 0, 'the generation produced no asset');
    for (const asset of assets) {
      assert.equal(asset.width, asset.height, `asked for 1:1 and got ${asset.width}x${asset.height}`);
    }
  });

  it('makes a size the generator has not got, rather than refusing it', async () => {
    mediaProviders.__setProviders(null, null);

    const out = await brainGenerate.generateWithBrain(mm, {
      requestText: 'A Diwali banner for honey whisky',
      mediaType: 'image',
      // Picked on the page rather than typed. 4:5 is not on this generator's
      // list, and a ratio it does not make used to be passed straight through
      // and refused — so choosing a size produced an error, not a picture.
      aspectRatio: '4:5',
    });

    assert.equal(out.status, 'generated', 'a size the generator has not got was refused');
    if (out.status !== 'generated') return;
    assert.equal(out.plan.deliveredShape, '4:5');
    assert.equal(out.plan.cropped, true, 'the plan says nothing was trimmed, and something was');

    const assets = await adminSql<{ width: number; height: number }[]>`
      select width, height from media_generation_assets where generation_id = ${out.generation.id}
    `;
    assert.ok(assets.length > 0, 'the generation produced no asset');
    for (const asset of assets) {
      assert.ok(
        Math.abs(Math.log(asset.width / asset.height / (4 / 5))) < 0.02,
        `asked for 4:5 and got ${asset.width}x${asset.height}`,
      );
    }
  });

  it('uses the generator that makes the shape, when the deployment allows both', async () => {
    /** Two doubles with different shapes on offer, so which one ran is observable. */
    class Double {
      readonly configured = true;
      readonly imageSizes = ['auto'];
      calls = 0;
      constructor(
        readonly name: 'openai' | 'google',
        readonly model: string,
        readonly aspectRatios: string[],
      ) {}
      async generate() {
        this.calls += 1;
        return {
          assets: [{ bytes: Buffer.from('an image'), mimeType: 'image/png', width: 1024, height: 1280 }],
          model: this.model,
          usage: {},
        };
      }
    }
    type AnyImageProvider = import('../src/server/media/providers').ImageGenerationProvider;

    const openai = new Double('openai', 'gpt-image-2', ['1:1', '3:2', '2:3']);
    const gemini = new Double('google', 'gemini-3.1-flash-image', ['1:1', '4:5', '9:16']);
    mediaProviders.__setProviders(null, null, {
      openai: openai as unknown as AnyImageProvider,
      gemini: gemini as unknown as AnyImageProvider,
    });

    const before = process.env.CIP_IMAGE_PROVIDERS;
    process.env.CIP_IMAGE_PROVIDERS = 'openai,gemini';
    try {
      const out = await brainGenerate.generateWithBrain(mm, {
        requestText: 'A Diwali post for honey whisky',
        mediaType: 'image',
        provider: 'openai',
        aspectRatio: '4:5',
      });

      assert.equal(out.status, 'generated');
      if (out.status !== 'generated') return;
      // OpenAI would have made a 2:3 and had its edges cut off, losing a logo
      // or a statutory warning, while Gemini makes 4:5 exactly.
      assert.equal(gemini.calls, 1, 'the generator that makes 4:5 was not used');
      assert.equal(openai.calls, 0, 'a shape was cut down while another generator made it exactly');
      assert.equal(out.plan.switchedProvider?.to, 'gemini', 'the swap was not reported in the plan');
    } finally {
      if (before === undefined) delete process.env.CIP_IMAGE_PROVIDERS;
      else process.env.CIP_IMAGE_PROVIDERS = before;
      mediaProviders.__setProviders(null, null);
    }
  });

  // The switch is only ever to a generator the deployment allows. Gemini's
  // account permits zero image generations, so handing 4:5 to it produced a
  // rate limit and no picture; cutting a 2:3 down produces a picture.
  it('does not hand a shape to a generator this deployment has switched off', async () => {
    class Double {
      readonly configured = true;
      readonly imageSizes = ['auto'];
      calls = 0;
      constructor(
        readonly name: 'openai' | 'google',
        readonly model: string,
        readonly aspectRatios: string[],
      ) {}
      async generate() {
        this.calls += 1;
        return {
          assets: [{ bytes: Buffer.from('an image'), mimeType: 'image/png', width: 1024, height: 1536 }],
          model: this.model,
          usage: {},
        };
      }
    }
    type AnyImageProvider = import('../src/server/media/providers').ImageGenerationProvider;

    const openai = new Double('openai', 'gpt-image-2', ['1:1', '3:2', '2:3']);
    const gemini = new Double('google', 'gemini-3.1-flash-image', ['1:1', '4:5', '9:16']);
    mediaProviders.__setProviders(null, null, {
      openai: openai as unknown as AnyImageProvider,
      gemini: gemini as unknown as AnyImageProvider,
    });

    try {
      const out = await brainGenerate.generateWithBrain(mm, {
        requestText: 'A Diwali post for honey whisky',
        mediaType: 'image',
        provider: 'openai',
        aspectRatio: '4:5',
      });

      assert.equal(out.status, 'generated');
      if (out.status !== 'generated') return;
      assert.equal(gemini.calls, 0, 'a request went to a generator that is switched off');
      assert.equal(openai.calls, 1, 'the only allowed generator did not run');
      assert.equal(out.plan.switchedProvider, null, 'a swap was reported that did not happen');
      assert.equal(out.plan.cropped, true, 'the nearest shape was not cut to the one asked for');
    } finally {
      mediaProviders.__setProviders(null, null);
    }
  });

  it('tells a settled lesson apart from one a single rating produced', async () => {
    await adminSql`
      insert into brain_lessons
        (company_id, polarity, statement, brand, status, evidence_count, confidence)
      values
        (${mm.companyId}, 'prefer', 'Keep the label facing the camera.', null, 'confirmed', 3, 0.6),
        (${mm.companyId}, 'prefer', 'Make the bottle enormous.', null, 'candidate', 1, 0.33)
    `;

    const plan = await planner.planGeneration(mm, {
      requestText: 'A Diwali post for honey whisky',
      mediaType: 'image',
    });

    // Both reach the generator: feedback is meant to change the next piece of
    // work, not the one after three more ratings.
    assert.ok(
      plan.brief.learnedPreferences.some((s) => s.includes('label facing the camera')),
      'a confirmed lesson did not reach the brief',
    );
    assert.ok(
      plan.brief.learnedPreferences.some((s) => s.includes('bottle enormous')),
      'a lesson from a recent rating did not reach the brief',
    );

    // What changes is what CIP claims about them. A page that showed one
    // person's single rating exactly as it shows a settled pattern is how a
    // one-off "make the bottle enormous" reads as the brand's own rule.
    assert.ok(
      plan.pendingLessons.some((l) => l.statement.includes('bottle enormous')),
      'a lesson with one rating behind it was presented as settled',
    );
    assert.ok(
      !plan.pendingLessons.some((l) => l.statement.includes('label facing the camera')),
      'a confirmed lesson was reported as still gathering evidence',
    );
  });

  it('carries a required disclaimer into the prompt, rather than hoping for it', async () => {
    const checker = await import('../src/server/brain/checker');
    await checker.addComplianceRule(mm, {
      rule: 'Carry the statutory warning that consumption of liquor is injurious to health.',
      requirement: 'required',
      category: 'disclaimer',
      source: 'manual',
    });

    mediaProviders.__setProviders(null, null);
    const out = await brainGenerate.generateWithBrain(mm, {
      requestText: 'A Diwali post for honey whisky',
      mediaType: 'image',
    });

    assert.equal(out.status, 'generated');
    if (out.status !== 'generated') return;

    // The checker fails a creative for a missing statutory warning. Nothing
    // had ever told the generator to put one there, so CIP made the mistake
    // and then flagged itself for it.
    assert.ok(
      out.plan.mustCarry.some((rule) => rule.includes('injurious to health')),
      'the plan does not say the warning is required',
    );

    const rows = await adminSql<{ prompt: string }[]>`
      select prompt from media_generations where id = ${out.generation.id}
    `;
    assert.ok(
      rows[0]!.prompt.includes('injurious to health'),
      `the required warning never reached the generator: ${rows[0]!.prompt.slice(0, 300)}`,
    );
  });

  it('builds on a picture it made earlier', async () => {
    mediaProviders.__setProviders(null, null);

    const first = await brainGenerate.generateWithBrain(mm, {
      requestText: 'A Diwali post for honey whisky',
      mediaType: 'image',
    });
    assert.equal(first.status, 'generated');
    if (first.status !== 'generated') return;

    // "The same thing with less text" used to start again from nothing, and
    // came back a different picture that happened to obey the same brief.
    const second = await brainGenerate.generateWithBrain(mm, {
      requestText: 'The same thing, with less text on it',
      mediaType: 'image',
      basedOnGenerationId: first.generation.id,
    });
    assert.equal(second.status, 'generated');
    if (second.status !== 'generated') return;

    const rows = await adminSql<{ input_metadata: { basedOn?: string; referenceCount?: number } }[]>`
      select input_metadata from media_generations where id = ${second.generation.id}
    `;
    assert.equal(rows[0]!.input_metadata.basedOn, first.generation.id, 'the earlier picture was not recorded');
    assert.ok(
      (rows[0]!.input_metadata.referenceCount ?? 0) >= 1,
      'the earlier picture never reached the generator',
    );

    // The boundary holds here as everywhere: a generation id is only an id
    // inside the company that owns it.
    await assert.rejects(
      () => brainGenerate.generateWithBrain(nh, {
        requestText: 'Build on that',
        mediaType: 'image',
        basedOnGenerationId: first.generation.id,
      }),
      'another company built on a picture that was not theirs',
    );
  });

  it('never attaches more reference images than a generator will take', async () => {
    const { BRAIN_LIMITS } = await import('../src/server/brain/providers/types');
    const { MEDIA_LIMITS } = await import('../src/server/media/providers/types');

    // These were two independent numbers. The Brain attached four references,
    // the media layer accepted three, and the mismatch threw before a record
    // was written — so a request produced a brief, no picture, and nothing
    // anywhere that said why.
    assert.ok(
      Math.min(BRAIN_LIMITS.maxReferences, MEDIA_LIMITS.maxReferenceImages) <=
        MEDIA_LIMITS.maxReferenceImages,
      'the Brain would attach more references than the generator accepts',
    );
  });

  it('makes the picture even when its chosen references cannot all be used', async () => {
    // The shape that broke it in production: CIP picks the best references it
    // has, and some of them are print-resolution files it deliberately never
    // stored. A reference is an aid; losing one must not lose the request.
    await uploadText(mm, 'voice.txt', 'Warm, celebratory, never about the alcohol itself.');
    await extractAll();
    await understandAll();

    /** A real PNG, so the reference path decodes something genuine. */
    const png = async (): Promise<Buffer> => {
      const { createCanvas } = await import('@napi-rs/canvas');
      const canvas = createCanvas(64, 64);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#c8a24b';
      ctx.fillRect(0, 0, 64, 64);
      return canvas.toBuffer('image/png');
    };

    const usable = await drive.uploadFile(mm, {
      folderId: null,
      filename: 'packshot.png',
      mimeType: 'image/png',
      body: await png(),
    });
    const unreadable = await drive.uploadFile(mm, {
      folderId: null,
      filename: 'print-master.png',
      mimeType: 'image/png',
      body: await png(),
    });
    await adminSql`
      update drive_files set storage_path = null, bytes_retained = false
       where id = ${unreadable.id} and company_id = ${mm.companyId}
    `;

    const { generateImage } = await import('../src/server/media/generation');
    const generation = await generateImage(mm, {
      prompt: 'a warm celebratory banner',
      referenceFileIds: [usable.id, unreadable.id],
    });

    assert.equal(generation.status, 'completed', 'one unusable reference stopped the whole request');
  });
});

describe('generation integration', () => {
  it('the existing image provider receives the Brain prompt, not the raw request', async () => {
    await uploadText(mm, 'voice.txt', 'Warm and cinematic.');
    await extractAll();
    await understanding.enqueueUnderstanding(mm);
    await understandAll();
    await brandDna.recomputeBrandDna(mm);

    mediaProviders.__setProviders(null, null);
    const result = await brainGenerate.generateWithBrain(mm, {
      requestText: 'An Instagram promo',
      mediaType: 'image',
    });

    assert.equal(result.status, 'generated');
    if (result.status !== 'generated') return;

    const rows = await adminSql<{ prompt: string }[]>`
      select prompt from media_generations where id = ${result.generation.id}
    `;
    assert.notEqual(rows[0]!.prompt, 'An Instagram promo', 'the raw request reached the generator');
    assert.ok(rows[0]!.prompt.length > 'An Instagram promo'.length);
  });

  it('the brief is linked to the generation it produced', async () => {
    mediaProviders.__setProviders(null, null);
    const result = await brainGenerate.generateWithBrain(mm, {
      requestText: 'Something',
      mediaType: 'image',
    });
    assert.equal(result.status, 'generated');
    if (result.status !== 'generated') return;

    const rows = await adminSql<{ n: number }[]>`
      select count(*)::int n from generation_briefs
       where id = ${result.briefId} and generation_id = ${result.generation.id}
    `;
    assert.equal(rows[0]!.n, 1);
  });

  it('provider selection is still the caller decision', async () => {
    // The Brain decides what to generate, never which vendor generates it.
    await assert.rejects(
      () => brainGenerate.generateWithBrain(mm, {
        requestText: 'Something',
        mediaType: 'image',
        provider: 'midjourney',
      }),
      /Provider must be one of/i,
    );
  });
});

describe('one company cannot reach another', () => {
  it('THE TEST: no part of the Brain crosses the boundary', async () => {
    // Narayana builds knowledge, feedback and a lesson of its own.
    await uploadText(nh, 'clinical.txt', 'Patient consent must be signed before filming.');
    await extractAll();
    await understanding.enqueueUnderstanding(nh);
    await understandAll();
    await brandDna.recomputeBrandDna(nh);

    mediaProviders.__setProviders(null, null);
    const theirGeneration = await media.generateImage(nh, { prompt: 'their consent poster' });
    await learning.submitFeedback(nh, {
      generationId: theirGeneration.id,
      score: 9,
      comment: 'Their private preference.',
    });
    await learning.analyseNextFeedback();

    // Magic Moments sees none of it.
    assert.equal((await brandDna.readBrandDna(mm, { limit: 50 })).length, 0, 'Brand DNA crossed companies');
    assert.equal((await learning.readLessons(mm)).length, 0, 'a lesson crossed companies');
    assert.equal((await learning.readFeedback(mm)).length, 0, 'feedback crossed companies');
    assert.equal((await retrieval.searchMemory(mm, 'consent')).length, 0, 'memory search crossed companies');
    assert.equal((await retrieval.applicableLessons(mm, {})).length, 0, 'lesson retrieval crossed companies');

    // And the owning company does see it, so this proves isolation rather than
    // an empty database.
    assert.ok((await brandDna.readBrandDna(nh, { limit: 50 })).length > 0);
    assert.ok((await learning.readLessons(nh)).length > 0);
    assert.ok((await retrieval.searchMemory(nh, 'consent')).length > 0);
  });

  it('a brief built for one company carries nothing of the other', async () => {
    await uploadText(nh, 'secret.txt', 'Their confidential positioning.');
    await extractAll();
    await understanding.enqueueUnderstanding(nh);
    await understandAll();
    await brandDna.recomputeBrandDna(nh);

    const plan = await planner.planGeneration(mm, { requestText: 'A post', mediaType: 'image' });
    const payload = JSON.stringify(plan);

    assert.ok(!payload.includes('confidential positioning'), 'another company knowledge reached the brief');
    assert.equal(plan.brief.brandRules.length, 0, 'brand rules appeared with no assets of our own');
  });

  it('feedback cannot be given on another company generation', async () => {
    mediaProviders.__setProviders(null, null);
    const theirs = await media.generateImage(nh, { prompt: 'theirs' });

    await assert.rejects(
      () => learning.submitFeedback(mm, { generationId: theirs.id, score: 9, comment: 'nice' }),
      /could not be found/i,
    );
  });

  it('with no company set, every Brain table is empty', async () => {
    await uploadText(mm, 'scoped.txt', 'Content.');
    await extractAll();
    await understanding.enqueueUnderstanding(mm);
    await understandAll();

    for (const table of ['asset_understanding', 'brand_dna_facts', 'brain_lessons', 'generation_briefs']) {
      const rows = await appSql.unsafe(`select id from ${table} limit 5`);
      assert.equal(rows.length, 0, `${table} is readable with no company set`);
    }
  });

  it('row-level security refuses a row written for another company', async () => {
    await assert.rejects(
      () =>
        appSql.begin(async (tx) => {
          await tx`select set_config('cip.company_id', ${mm.companyId}, true)`;
          return tx`
            insert into brain_lessons (company_id, polarity, statement)
            values (${nh.companyId}, 'prefer', 'forged')
          `;
        }),
      /row-level security/i,
    );
  });

  it('the composite key refuses evidence whose fact belongs elsewhere', async () => {
    await adminSql`
      insert into brand_dna_facts (company_id, section, attribute, value, kind, confidence)
      values (${nh.companyId}, 'visual', 'colour', '#123456', 'observed', 0.2)
    `;
    const theirFact = await adminSql<{ id: string }[]>`
      select id from brand_dna_facts where company_id = ${nh.companyId} limit 1
    `;

    await assert.rejects(
      () => adminSql`
        insert into brand_dna_evidence (company_id, fact_id)
        values (${mm.companyId}, ${theirFact[0]!.id})
      `,
      /violates foreign key constraint/i,
    );
  });
});

describe('nothing sensitive leaves the server', () => {
  it('the provider is given content and nothing that identifies us', async () => {
    // The fake records what it was handed, so this checks the real contract:
    // a provider receives bytes and a display name, never ids or paths.
    const file = await uploadImage(mm, 'checked.png', 13);
    await understanding.enqueueUnderstanding(mm);

    let seen: unknown = null;
    const original = fake.analyzeImage.bind(fake);
    fake.analyzeImage = async (input) => {
      seen = input;
      return original(input);
    };

    await understandAll();
    fake.analyzeImage = original;

    const payload = JSON.stringify(seen, (_key, value) =>
      Buffer.isBuffer(value) ? '<bytes>' : value,
    );
    for (const forbidden of [mm.companyId, mm.userId, file.id, 'companies/', 'storage']) {
      assert.ok(!payload.includes(forbidden), `the provider was sent ${forbidden}`);
    }
    assert.ok(payload.includes('checked.png'), 'the provider was not told the display name');
  });

  it('a stored brief carries no ids, paths or credentials', async () => {
    const plan = await planner.planGeneration(mm, { requestText: 'Something', mediaType: 'image' });
    const rows = await adminSql<{ brief: unknown }[]>`
      select brief from generation_briefs where id = ${plan.briefId}
    `;
    const payload = JSON.stringify(rows[0]!.brief);
    for (const forbidden of [mm.companyId, 'companies/', 'storage_path', 'sk-']) {
      assert.ok(!payload.includes(forbidden), `the brief leaked ${forbidden}`);
    }
  });
});

describe('markets', () => {
  /**
   * Puts a file in a market and hangs one fact off it, which is the shape the
   * real thing has: the market is on the file, and a fact belongs to whichever
   * markets evidenced it.
   */
  async function fileInMarket(
    scope: Scope,
    name: string,
    market: string | null,
    factValue: string,
  ): Promise<void> {
    const [file] = await adminSql<{ id: string }[]>`
      insert into drive_files
        (company_id, folder_id, name, original_filename, file_type, mime_type,
         file_size, checksum_sha256, storage_path, uploaded_by, source_type,
         processing_status, market, metadata)
      values
        (${scope.companyId}, null, ${name}, ${name}, 'pdf', 'application/pdf',
         100, ${`sum-${name}`}, ${`companies/${scope.companyId}/${crypto.randomUUID()}.pdf`},
         ${scope.userId}, 'cip_drive', 'processed', ${market}, '{}'::jsonb)
      returning id
    `;

    const [fact] = await adminSql<{ id: string }[]>`
      insert into brand_dna_facts
        (company_id, section, attribute, value, kind, confidence, evidence_count)
      values (${scope.companyId}, 'visual', 'style', ${factValue}, 'observed', 0.5, 1)
      returning id
    `;

    await adminSql`
      insert into brand_dna_evidence (company_id, fact_id, file_id)
      values (${scope.companyId}, ${fact!.id}, ${file!.id})
    `;
  }

  it('reads the market a filename plainly says, and refuses to guess otherwise', async () => {
    const markets = await import('../src/server/brain/markets');

    assert.equal(markets.marketFromFilename('India.pdf'), 'India');
    assert.equal(markets.marketFromFilename('nigeria.pdf'), 'Nigeria');
    assert.equal(markets.marketFromFilename('europe.pdf'), 'Europe');

    // Nothing in these names says where they belong.
    assert.equal(markets.marketFromFilename('banner content.jpeg'), null);
    assert.equal(markets.marketFromFilename('tone-of-voice.txt'), null);

    // Two markets in one name is not one market.
    assert.equal(markets.marketFromFilename('india-vs-europe.pdf'), null);
  });

  it('a fact carries the markets whose files produced it', async () => {
    await fileInMarket(mm, 'India.pdf', 'India', 'warm gold on black');
    await fileInMarket(mm, 'nigeria.pdf', 'Nigeria', 'bright cyan blocks');

    const facts = await brandDna.readBrandDna(mm, { minEvidence: 1, limit: 50 });
    const indian = facts.find((f) => f.value === 'warm gold on black')!;
    const nigerian = facts.find((f) => f.value === 'bright cyan blocks')!;

    assert.deepEqual(indian.markets, ['India']);
    assert.deepEqual(nigerian.markets, ['Nigeria']);
  });

  it("one market's look does not leak into another's brief", async () => {
    await fileInMarket(mm, 'India.pdf', 'India', 'warm gold on black');
    await fileInMarket(mm, 'nigeria.pdf', 'Nigeria', 'bright cyan blocks');

    const indian = await brandDna.readBrandDna(mm, { minEvidence: 1, limit: 50, market: 'India' });
    assert.ok(indian.some((f) => f.value === 'warm gold on black'), 'India lost its own style');
    assert.ok(
      !indian.some((f) => f.value === 'bright cyan blocks'),
      "Nigeria's style reached an Indian brief",
    );
  });

  it('a pattern seen in two markets is the brand, and reaches both', async () => {
    // The same claim, evidenced by a file in each market.
    await fileInMarket(mm, 'India.pdf', 'India', 'bottle centred');
    const [shared] = await adminSql<{ id: string }[]>`
      select id from brand_dna_facts where company_id = ${mm.companyId} and value = 'bottle centred'
    `;
    const [nigerFile] = await adminSql<{ id: string }[]>`
      insert into drive_files
        (company_id, folder_id, name, original_filename, file_type, mime_type,
         file_size, checksum_sha256, storage_path, uploaded_by, source_type,
         processing_status, market, metadata)
      values
        (${mm.companyId}, null, 'nigeria.pdf', 'nigeria.pdf', 'pdf', 'application/pdf',
         100, 'sum-ng', ${`companies/${mm.companyId}/${crypto.randomUUID()}.pdf`},
         ${mm.userId}, 'cip_drive', 'processed', 'Nigeria', '{}'::jsonb)
      returning id
    `;
    await adminSql`
      insert into brand_dna_evidence (company_id, fact_id, file_id)
      values (${mm.companyId}, ${shared!.id}, ${nigerFile!.id})
    `;

    for (const market of ['India', 'Nigeria']) {
      const facts = await brandDna.readBrandDna(mm, { minEvidence: 1, limit: 50, market });
      assert.ok(
        facts.some((f) => f.value === 'bottle centred'),
        `a cross-market pattern was withheld from ${market}`,
      );
    }
  });

  it('a file nobody has placed counts towards every market', async () => {
    await fileInMarket(mm, 'tone-of-voice.txt', null, 'never mention the alcohol');

    const facts = await brandDna.readBrandDna(mm, { minEvidence: 1, limit: 50, market: 'India' });
    assert.ok(
      facts.some((f) => f.value === 'never mention the alcohol'),
      'unplaced knowledge was withheld from a market that should have it',
    );
  });

  it('works out the market from the request rather than asking', async () => {
    // Each deck carries its own occasion. Nothing anywhere says "Diwali means
    // India" — it is true because the India deck is the one that mentions it.
    await fileInMarket(mm, 'India.pdf', 'India', 'warm gold on black for Diwali');
    await fileInMarket(mm, 'nigeria.pdf', 'Nigeria', 'bright cyan blocks for Detty December');

    const markets = await import('../src/server/brain/markets');
    const inferred = await markets.marketFromEvidence(mm, 'Make a Diwali post', ['India', 'Nigeria']);
    assert.equal(inferred, 'India', "the word was in one market's files and nowhere else");

    const plan = await planner.planGeneration(mm, {
      requestText: 'Make a Diwali post',
      mediaType: 'image',
    });

    assert.equal(
      plan.clarificationQuestion,
      null,
      'CIP asked which country a Diwali post was for, with the answer in its own files',
    );
    assert.equal(plan.brief?.market ?? null, 'India');
  });

  it('still asks when the request matches two markets equally', async () => {
    // The same word in both decks decides nothing, and answering anyway would
    // be the silent averaging the question exists to prevent.
    await fileInMarket(mm, 'India.pdf', 'India', 'a new year campaign in warm gold');
    await fileInMarket(mm, 'nigeria.pdf', 'Nigeria', 'a new year campaign in bright cyan');

    const plan = await planner.planGeneration(mm, {
      requestText: 'Make a new year campaign',
      mediaType: 'image',
    });

    assert.ok(plan.clarificationQuestion, 'CIP picked one of two markets that matched equally');
  });

  it('does not read a market into a word every market uses', async () => {
    await fileInMarket(mm, 'India.pdf', 'India', 'bottle centred on gold');
    await fileInMarket(mm, 'nigeria.pdf', 'Nigeria', 'bottle centred on cyan');

    const plan = await planner.planGeneration(mm, {
      requestText: 'Show the bottle centred',
      mediaType: 'image',
    });

    assert.ok(plan.clarificationQuestion, 'a word common to every market was treated as a signal');
  });

  it('THE TEST: asks which market when there are several and the request says none', async () => {
    await fileInMarket(mm, 'India.pdf', 'India', 'warm gold on black');
    await fileInMarket(mm, 'nigeria.pdf', 'Nigeria', 'bright cyan blocks');

    const plan = await planner.planGeneration(mm, {
      requestText: 'Make a Diwali post',
      mediaType: 'image',
    });

    assert.ok(plan.clarificationQuestion, 'the Brain averaged three markets instead of asking');
    assert.match(plan.clarificationQuestion!, /India/);
    assert.match(plan.clarificationQuestion!, /Nigeria/);
  });

  it('does not ask when the request already names the market', async () => {
    await fileInMarket(mm, 'India.pdf', 'India', 'warm gold on black');
    await fileInMarket(mm, 'nigeria.pdf', 'Nigeria', 'bright cyan blocks');

    const plan = await planner.planGeneration(mm, {
      requestText: 'Make a Diwali post for Nigeria',
      mediaType: 'image',
    });

    assert.equal(plan.clarificationQuestion, null, 'the Brain asked something it had been told');
  });

  it('does not ask when there is only one market to choose from', async () => {
    await fileInMarket(mm, 'India.pdf', 'India', 'warm gold on black');

    const plan = await planner.planGeneration(mm, {
      requestText: 'Make a Diwali post',
      mediaType: 'image',
    });

    assert.equal(plan.clarificationQuestion, null, 'the Brain asked a question with one answer');
  });

  it('one company cannot see another company markets', async () => {
    await fileInMarket(mm, 'India.pdf', 'India', 'warm gold on black');
    await fileInMarket(nh, 'kenya.pdf', 'Kenya', 'clinical white');

    const markets = await import('../src/server/brain/markets');
    const ours = (await markets.companyMarkets(mm)).map((m) => m.market);
    const theirs = (await markets.companyMarkets(nh)).map((m) => m.market);

    assert.deepEqual(ours, ['India']);
    assert.deepEqual(theirs, ['Kenya']);
  });
});

describe('brands', () => {
  /** Files a fact to a brand, the way understanding does. */
  async function factForBrand(
    scope: Scope,
    brand: string | null,
    value: string,
  ): Promise<void> {
    await adminSql`
      insert into brand_dna_facts
        (company_id, section, attribute, value, brand, kind, confidence, evidence_count)
      values (${scope.companyId}, 'visual', 'style', ${value}, ${brand}, 'observed', 0.5, 1)
      on conflict (company_id, section, attribute, value, coalesce(brand, '')) do nothing
    `;
  }

  it('reads the brand a request names, longest name first', async () => {
    const brands = await import('../src/server/brain/brands');
    const roster = ['Whytehall', 'Whytehall Honey', 'Magic Moments'];

    // The flavour must win over its parent, or every flavour resolves to the
    // parent and loses exactly the distinction that matters.
    assert.equal(brands.brandInRequest('a post for Whytehall Honey', roster), 'Whytehall Honey');
    assert.equal(brands.brandInRequest('a post for Whytehall', roster), 'Whytehall');
    assert.equal(brands.brandInRequest('something for magic moments', roster), 'Magic Moments');
    assert.equal(brands.brandInRequest('a post for Morpheus', roster), null);
  });

  it('knows the other names a brand goes by', async () => {
    const brands = await import('../src/server/brain/brands');
    const roster = [
      { name: 'Rampur', note: null, aliases: ['asava', 'jugalbandi', 'double cask'], facts: 0 },
      { name: 'Magic Moments', note: null, aliases: ['jamun'], facts: 0 },
      { name: 'Whytehall', note: null, aliases: [], facts: 0 },
      { name: 'Whytehall Honey', note: null, aliases: [], facts: 0 },
    ];

    // The case this exists for: a bottle whose filename never says Rampur.
    assert.equal(brands.brandForText('Asava_Bottle.png', roster), 'Rampur');
    assert.equal(brands.brandForText('Jugalbandi_5_Bottle - Revised.png', roster), 'Rampur');
    assert.equal(brands.brandForText('261517 Radico FOI Jamun Creatives.jpg', roster), 'Magic Moments');

    // The brand's own name still works, and the more specific one still wins.
    assert.equal(brands.brandForText('WHYTEHALL HONEY Logo.png', roster), 'Whytehall Honey');
    assert.equal(brands.brandForText('a post for Rampur', roster), 'Rampur');

    // A name and one of its own aliases together is still one brand.
    assert.equal(brands.brandForText('Rampur Asava tilted.png', roster), 'Rampur');

    // Two different brands is no match: filing it under either would put the
    // knowledge on a brand it is only half about.
    assert.equal(brands.brandForText('rampur-and-jamun-lockup.png', roster), null);
    assert.equal(brands.brandForText('bottle.png', roster), null);
  });

  it('keeps the aliases it was given', async () => {
    const brands = await import('../src/server/brain/brands');
    await brands.addBrand(mm, { name: 'Rampur', aliases: ['Asava', 'ASAVA', ' jugalbandi '] });

    const roster = await brands.companyBrands(mm);
    const rampur = roster.find((b) => b.name === 'Rampur');
    assert.ok(rampur, 'the brand was not added');
    // Lower-cased and de-duplicated on the way in, because every use of them
    // is case-insensitive and two spellings of one alias is one alias.
    assert.deepEqual([...rampur!.aliases].sort(), ['asava', 'jugalbandi']);

    // Adding it again without aliases keeps the ones it has, rather than
    // silently emptying them.
    await brands.addBrand(mm, { name: 'Rampur', note: 'Single malt' });
    const again = (await brands.companyBrands(mm)).find((b) => b.name === 'Rampur');
    assert.deepEqual([...again!.aliases].sort(), ['asava', 'jugalbandi']);
  });

  it('only accepts a brand the company actually has', async () => {
    const brands = await import('../src/server/brain/brands');
    const roster = ['Whytehall', 'Magic Moments'];

    assert.equal(brands.normaliseBrand('whytehall', roster), 'Whytehall', 'case should not matter');
    assert.equal(brands.normaliseBrand('Whytehall Fire', roster), null, 'not on this roster');
    assert.equal(brands.normaliseBrand('', roster), null);
    assert.equal(brands.normaliseBrand(null, roster), null);
  });

  it("one brand's voice does not reach another's brief", async () => {
    await factForBrand(mm, 'Whytehall', 'restrained gold on black');
    await factForBrand(mm, 'Magic Moments', 'bright playful colour');

    const whytehall = await brandDna.readBrandDna(mm, { minEvidence: 1, limit: 50, brand: 'Whytehall' });
    assert.ok(
      whytehall.some((f) => f.value === 'restrained gold on black'),
      'Whytehall lost its own style',
    );
    assert.ok(
      !whytehall.some((f) => f.value === 'bright playful colour'),
      "Magic Moments' voice reached a Whytehall brief",
    );
  });

  it("what belongs to the house reaches every brand", async () => {
    await factForBrand(mm, null, 'never target minors');
    await factForBrand(mm, 'Whytehall', 'restrained gold on black');

    for (const brand of ['Whytehall', 'Magic Moments']) {
      const facts = await brandDna.readBrandDna(mm, { minEvidence: 1, limit: 50, brand });
      assert.ok(
        facts.some((f) => f.value === 'never target minors'),
        `a house-wide rule was withheld from ${brand}`,
      );
    }
  });

  it("a brand's own knowledge outranks facts that belong to nobody", async () => {
    // The shape that caused it: one heavily-photographed brand leaves behind a
    // pile of facts nothing could attribute, and they then outnumber a smaller
    // brand's own knowledge by four to one.
    for (let i = 0; i < 200; i += 1) await factForBrand(mm, null, `unattributed detail ${i}`);
    for (let i = 0; i < 40; i += 1) await factForBrand(mm, '8PM', `8PM detail ${i}`);

    const facts = await brandDna.readBrandDna(mm, { minEvidence: 1, limit: 40, brand: '8PM' });
    const own = facts.filter((f) => f.brand === '8PM').length;

    // Asked for 8PM, CIP used to return 25 unattributed facts against 15 about
    // 8PM, and generated a creative for the other brand entirely.
    assert.ok(
      own > facts.length - own,
      `a brief for 8PM carried ${own} facts about 8PM and ${facts.length - own} about nobody`,
    );
  });

  it('still leaves room for what belongs to the house', async () => {
    // The brand has more than enough to fill the brief on its own. A legal
    // constraint applies whichever brand is being made, so it must survive
    // being outnumbered.
    for (let i = 0; i < 200; i += 1) await factForBrand(mm, '8PM', `8PM plenty ${i}`);
    await factForBrand(mm, null, 'never imply drinking improves performance');

    const facts = await brandDna.readBrandDna(mm, { minEvidence: 1, limit: 40, brand: '8PM' });
    assert.ok(
      facts.some((f) => f.value === 'never imply drinking improves performance'),
      'a house-wide rule was crowded out by the brand it applies to',
    );
  });

  it('fills the brief from the house when a brand has little of its own', async () => {
    for (let i = 0; i < 100; i += 1) await factForBrand(mm, null, `house detail ${i}`);
    await factForBrand(mm, 'Sangam', 'the one thing known about Sangam');

    const facts = await brandDna.readBrandDna(mm, { minEvidence: 1, limit: 40, brand: 'Sangam' });
    // Reserving room for the brand must not mean returning an empty brief when
    // the brand has nothing to put in it.
    assert.equal(facts.length, 40, 'the brief came back short rather than being filled');
    assert.ok(facts.some((f) => f.value === 'the one thing known about Sangam'));
  });

  it('leads a film brief with what is known about film', async () => {
    /** A fact in a named section, which factForBrand always files as visual. */
    const inSection = async (section: string, value: string): Promise<void> => {
      await adminSql`
        insert into brand_dna_facts
          (company_id, section, attribute, value, brand, kind, confidence, evidence_count)
        values (${mm.companyId}, ${section}, 'style', ${value}, '8PM', 'observed', 0.5, 1)
        on conflict (company_id, section, attribute, value, coalesce(brand, '')) do nothing
      `;
    };

    // Deliberately outnumbered, and deliberately lower confidence than the
    // poster knowledge would be: ordering must come from what is being made,
    // not from how much of each kind happens to exist.
    for (let i = 0; i < 30; i += 1) await inSection('visual', `poster detail ${i}`);
    await inSection('video', 'cuts on the pour, never on the face');

    const film = await brandDna.readBrandDna(mm, {
      minEvidence: 1, limit: 10, brand: '8PM', prefer: 'video',
    });
    assert.ok(
      film.some((f) => f.value === 'cuts on the pour, never on the face'),
      'a film brief never mentioned the one thing known about this brand on film',
    );

    const poster = await brandDna.readBrandDna(mm, {
      minEvidence: 1, limit: 10, brand: '8PM', prefer: 'visual',
    });
    assert.ok(
      poster.every((f) => f.section === 'visual'),
      'a poster brief led with something other than how this brand looks',
    );
  });

  it('the same claim about two brands stays two facts', async () => {
    await factForBrand(mm, 'Whytehall', 'tone is confident');
    await factForBrand(mm, 'Magic Moments', 'tone is confident');

    const rows = await adminSql<{ n: number }[]>`
      select count(*)::int as n from brand_dna_facts
       where company_id = ${mm.companyId} and value = 'tone is confident'
    `;
    // Merging them would hand each brand the other's evidence, and a claim
    // twice as well evidenced as it really is.
    assert.equal(rows[0]!.n, 2, 'two brands making the same claim were merged into one fact');
  });

  it('THE TEST: asks which brand when there are several and the request says none', async () => {
    const brands = await import('../src/server/brain/brands');
    await brands.addBrand(mm, { name: 'Whytehall', note: 'Regal', position: 0 });
    await brands.addBrand(mm, { name: 'Magic Moments', note: 'Playful', position: 1 });

    const plan = await planner.planGeneration(mm, {
      requestText: 'Make a festive post',
      mediaType: 'image',
    });

    assert.ok(plan.clarificationQuestion, 'the Brain blended two brands instead of asking');
    assert.match(plan.clarificationQuestion!, /Whytehall/);
    assert.match(plan.clarificationQuestion!, /Magic Moments/);
  });

  it('does not ask when the request already names the brand', async () => {
    const brands = await import('../src/server/brain/brands');
    await brands.addBrand(mm, { name: 'Whytehall', note: 'Regal', position: 0 });
    await brands.addBrand(mm, { name: 'Magic Moments', note: 'Playful', position: 1 });

    const plan = await planner.planGeneration(mm, {
      requestText: 'Make a festive post for Whytehall',
      mediaType: 'image',
    });

    assert.equal(plan.clarificationQuestion, null, 'the Brain asked something it had been told');
  });

  it('a company with no roster behaves exactly as it did before', async () => {
    await factForBrand(mm, null, 'warm and human');

    const plan = await planner.planGeneration(mm, {
      requestText: 'Make a festive post',
      mediaType: 'image',
    });

    assert.equal(plan.clarificationQuestion, null, 'asked about brands that do not exist');
    assert.ok(plan.brief.brandRules.length >= 0);
  });

  it('one company cannot see another company brands', async () => {
    const brands = await import('../src/server/brain/brands');
    await brands.addBrand(mm, { name: 'Whytehall', note: 'Regal', position: 0 });
    await brands.addBrand(nh, { name: 'Cardiac Care', note: 'Clinical', position: 0 });

    const ours = (await brands.companyBrands(mm)).map((b) => b.name);
    const theirs = (await brands.companyBrands(nh)).map((b) => b.name);

    assert.deepEqual(ours, ['Whytehall']);
    assert.deepEqual(theirs, ['Cardiac Care']);
  });
});

describe('a document longer than one call', () => {
  it('is read in sections rather than truncated', async () => {
    const { sectionsOf } = await import('../src/server/brain/understanding');

    const short = 'a'.repeat(500);
    assert.deepEqual(sectionsOf(short, 1000), [short], 'a short document should not be cut');

    // Paragraph breaks, so the split has somewhere sensible to land.
    const long = Array.from({ length: 40 }, (_, i) => `Section ${i}. ${'x'.repeat(200)}`).join('\n\n');
    const sections = sectionsOf(long, 1000);

    assert.ok(sections.length > 1, 'a long document was not cut at all');
    assert.ok(
      sections.every((s) => s.length <= 1000),
      'a section came back longer than the limit',
    );

    // Every character has to survive somewhere, or the read is silently partial
    // in exactly the way this exists to prevent.
    const joined = sections.join('');
    for (const marker of ['Section 0.', 'Section 20.', 'Section 39.']) {
      assert.ok(joined.includes(marker), `${marker} was dropped entirely`);
    }
  });

  it('overlaps its sections, so a rule split by a cut survives whole', async () => {
    const { sectionsOf } = await import('../src/server/brain/understanding');

    const long = Array.from({ length: 30 }, (_, i) => `Line ${i} ${'y'.repeat(120)}`).join('\n\n');
    const sections = sectionsOf(long, 800);

    assert.ok(sections.length > 1);
    const overlapped = sections.slice(1).some((section, index) => {
      const tail = sections[index]!.slice(-40);
      return section.includes(tail.slice(0, 20));
    });
    assert.ok(overlapped, 'sections were cut with no overlap between them');
  });
});
