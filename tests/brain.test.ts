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
    // The fake derives its facts from the bytes, so identical bytes agree.
    await uploadImage(mm, 'a.png', 7);
    await uploadImage(mm, 'b.png', 7);
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
    await uploadImage(mm, 'once.png', 11);
    await understanding.enqueueUnderstanding(mm);
    await understandAll();
    await brandDna.recomputeBrandDna(mm);

    const before = await brandDna.readBrandDna(mm, { limit: 50 });

    // Force a second analysis of the same file by changing its hash.
    await adminSql`update drive_files set checksum_sha256 = 'another-hash'`;
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
