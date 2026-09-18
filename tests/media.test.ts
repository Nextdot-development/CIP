import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { startTestDatabase } from './harness';
import type { TestDb } from './harness';

/**
 * Media generation — providers, lifecycle, storage and isolation.
 *
 * Everything runs against the deterministic fake providers, so the suite costs
 * nothing, needs no key and gives the same answer every time. What it is
 * really testing is the code around the provider: the queue, the retry
 * arithmetic, the storage paths, and the company boundary.
 */

let db: TestDb;
let appSql: postgres.Sql;
let adminSql: postgres.Sql;
let storageDir: string;

type Scope = { companyId: string; userId: string; role: 'owner' };
let mm: Scope;
let nh: Scope;

let media: typeof import('../src/server/media/generation');
let jobs: typeof import('../src/server/media/jobs');
let providers: typeof import('../src/server/media/providers');
let drive: typeof import('../src/server/drive/service');
let storage: typeof import('../src/server/media/storage');
let rateLimit: typeof import('../src/server/rateLimit');

let fakeImage: import('../src/server/media/providers').FakeImageProvider;
let fakeVideo: import('../src/server/media/providers').FakeVideoProvider;

const PASSWORD = 'cip-demo-password';

/**
 * Pushes everything already in the queue out of reach.
 *
 * The worker claims the oldest claimable row, which is almost never the one
 * the test just created — earlier cases leave work behind. Parking first is
 * what makes "claim it and check what happened to it" mean anything.
 */
async function parkQueue(): Promise<void> {
  await adminSql`
    update media_generations
       set next_attempt_at = now() + interval '1 hour'
     where status in ('queued', 'processing')
  `;
}

/** Runs the worker until nothing more can move, as the real one does. */
async function drainQueue(maxSteps = 40): Promise<string[]> {
  const outcomes: string[] = [];
  for (let i = 0; i < maxSteps; i += 1) {
    const claim = await jobs.claimGeneration();
    if (!claim) break;
    const outcome = await jobs.processGeneration(claim);
    outcomes.push(outcome.status);
    if (outcome.status === 'pending') {
      // The worker would wait; the test moves time along instead.
      await adminSql`update media_generations set next_attempt_at = now() - interval '1 second' where id = ${claim.id}`;
    }
  }
  return outcomes;
}

before(async () => {
  db = await startTestDatabase();
  storageDir = mkdtempSync(join(tmpdir(), 'cip-media-'));

  process.env.DATABASE_ADMIN_URL = db.adminUrl;
  process.env.CIP_APP_DB_PASSWORD = db.appPassword;
  process.env.SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.CIP_SEED_PASSWORD = PASSWORD;
  process.env.CIP_STORAGE_DIR = storageDir;
  process.env.CIP_FORCE_LOCAL_STORAGE = 'true';
  process.env.CIP_FORCE_FAKE_PROVIDERS = 'true';

  const { migrate } = await import('../src/server/migrate');
  await migrate(() => {}, { skip: db.skipMigrations });
  const { seed } = await import('../src/server/seed');
  await seed(() => {});

  process.env.DATABASE_URL = db.appUrl;
  media = await import('../src/server/media/generation');
  jobs = await import('../src/server/media/jobs');
  providers = await import('../src/server/media/providers');
  drive = await import('../src/server/drive/service');
  storage = await import('../src/server/media/storage');
  rateLimit = await import('../src/server/rateLimit');

  fakeImage = new providers.FakeImageProvider();
  fakeVideo = new providers.FakeVideoProvider();
  providers.__setProviders(fakeImage, fakeVideo);

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
  fakeImage.failWith = null;
  fakeVideo.reset();
  await rateLimit.__resetRateLimits();
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

describe('the fake providers behave like providers', () => {
  it('produces a real PNG, and the same prompt twice gives the same bytes', async () => {
    const one = await fakeImage.generate({ prompt: 'a diwali lantern', references: [] });
    const two = await fakeImage.generate({ prompt: 'a diwali lantern', references: [] });
    const other = await fakeImage.generate({ prompt: 'a cardiac ward', references: [] });

    const png = one.assets[0]!;
    assert.equal(png.mimeType, 'image/png');
    // The PNG signature, so this is an image a decoder would accept.
    assert.deepEqual([...png.bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
    assert.ok(png.bytes.includes(Buffer.from('IHDR')));
    assert.deepEqual(one.assets[0]!.bytes, two.assets[0]!.bytes);
    assert.notDeepEqual(one.assets[0]!.bytes, other.assets[0]!.bytes);
  });

  it('honours the aspect ratio it was given', async () => {
    const wide = await fakeImage.generate({ prompt: 'x', references: [], aspectRatio: '16:9' });
    assert.ok(wide.assets[0]!.width! > wide.assets[0]!.height!);
  });

  it('refuses an empty prompt permanently rather than retrying forever', async () => {
    await assert.rejects(
      () => fakeImage.generate({ prompt: '   ', references: [] }),
      (error: unknown) => {
        assert.equal((error as { kind: string }).kind, 'permanent');
        assert.equal((error as { code: string }).code, 'INVALID_REQUEST');
        return true;
      },
    );
  });

  it('video submission returns a handle, not a video', async () => {
    const job = await fakeVideo.submit({ prompt: 'a lantern drifting upward' });
    assert.ok(job.providerJobId.length > 0);
    // Nothing is ready on the first poll: video generation is asynchronous.
    assert.equal((await fakeVideo.poll(job.providerJobId)).state, 'pending');
    const done = await fakeVideo.poll(job.providerJobId);
    assert.equal(done.state, 'completed');
    if (done.state !== 'completed') return;
    assert.equal(done.assets[0]!.mimeType, 'video/mp4');
    assert.ok(done.assets[0]!.bytes.includes(Buffer.from('ftyp')));
  });
});

describe('image generation', () => {
  it('creates a completed generation with an asset', async () => {
    const generation = await media.generateImage(mm, { prompt: 'a bottle on a beach at dusk' });

    assert.equal(generation.status, 'completed');
    assert.equal(generation.type, 'image');
    assert.equal(generation.assetCount, 1);
    assert.ok(generation.hasAsset);
    assert.ok(generation.completedAt);

    const asset = await media.readAsset(mm, generation.id);
    assert.equal(asset.mimeType, 'image/png');
    assert.ok(asset.fileSize > 0);
  });

  it('stores the bytes under this company, in the media prefix', async () => {
    const generation = await media.generateImage(mm, { prompt: 'a paper lantern' });
    const rows = await adminSql<{ storage_path: string }[]>`
      select storage_path from media_generation_assets where generation_id = ${generation.id}
    `;
    const path = rows[0]!.storage_path;
    assert.ok(path.startsWith(`companies/${mm.companyId}/media/${generation.id}/`), path);
    // and the key is one the storage layer will actually accept
    const { assertSafeKey } = await import('../src/server/drive/storage');
    assert.doesNotThrow(() => assertSafeKey(path));
  });

  it('never returns a company id or a storage path', async () => {
    const generation = await media.generateImage(mm, { prompt: 'a rangoli pattern' });
    const detail = await media.getGeneration(mm, generation.id);
    const payload = JSON.stringify(detail);

    for (const forbidden of [mm.companyId, 'company_id', 'companyId', 'storage_path', 'storagePath', 'companies/']) {
      assert.ok(!payload.includes(forbidden), `a media response leaked ${forbidden}`);
    }
  });

  it('refuses a prompt that is empty or too long', async () => {
    await assert.rejects(() => media.generateImage(mm, { prompt: '' }), /prompt is required/i);
    await assert.rejects(() => media.generateImage(mm, { prompt: 'x'.repeat(4001) }), /under 4000/i);
  });

  it('refuses an aspect ratio the provider does not offer', async () => {
    await assert.rejects(
      () => media.generateImage(mm, { prompt: 'ok', aspectRatio: '7:3' }),
      /Aspect ratio must be one of/i,
    );
  });

  it('records the failure instead of losing it, and says why', async () => {
    const { ProviderFailed } = await import('../src/server/media/providers/types');
    fakeImage.failWith = new ProviderFailed('PROVIDER_ERROR', 'permanent', 'The provider refused.');

    await assert.rejects(() => media.generateImage(mm, { prompt: 'something refused' }));

    const rows = await adminSql<{ status: string; error_code: string; prompt: string }[]>`
      select status, error_code, prompt from media_generations
       where company_id = ${mm.companyId} and prompt = 'something refused'
    `;
    assert.equal(rows[0]!.status, 'failed');
    assert.equal(rows[0]!.error_code, 'PROVIDER_ERROR');
  });
});

describe('idempotency', () => {
  it('the same key returns the first generation rather than buying a second', async () => {
    const key = `test-key-${Date.now()}`;
    const first = await media.generateImage(mm, { prompt: 'once only', idempotencyKey: key });
    const second = await media.generateImage(mm, { prompt: 'once only', idempotencyKey: key });

    assert.equal(first.id, second.id);
    const rows = await adminSql<{ n: number }[]>`
      select count(*)::int n from media_generations where idempotency_key = ${key}
    `;
    assert.equal(rows[0]!.n, 1);
  });

  it('two companies may use the same key without colliding', async () => {
    const key = `shared-key-${Date.now()}`;
    const a = await media.generateImage(mm, { prompt: 'theirs', idempotencyKey: key });
    const b = await media.generateImage(nh, { prompt: 'theirs', idempotencyKey: key });
    assert.notEqual(a.id, b.id);
  });
});

describe('the video lifecycle is asynchronous', () => {
  it('queues without calling the provider, then completes through the worker', async () => {
    await parkQueue();
    const queued = await media.generateVideo(mm, { prompt: 'a lantern rising over water' });

    // Nothing has been sent yet: the request returned before any provider call.
    assert.equal(queued.status, 'queued');
    assert.equal(queued.hasAsset, false);

    const outcomes = await drainQueue();
    assert.ok(outcomes.includes('submitted'), `expected a submit, saw ${outcomes.join(',')}`);
    assert.ok(outcomes.includes('pending'), 'expected at least one poll to find it unfinished');
    assert.ok(outcomes.includes('completed'), `expected a completion, saw ${outcomes.join(',')}`);

    const { generation, assets } = await media.getGeneration(mm, queued.id);
    assert.equal(generation.status, 'completed');
    assert.equal(assets[0]!.mimeType, 'video/mp4');
    assert.equal(generation.durationSeconds, 5);
  });

  it('records the provider job id so a restarted worker finds the same job', async () => {
    await parkQueue();
    const queued = await media.generateVideo(mm, { prompt: 'a second lantern' });
    const claim = await jobs.claimGeneration();
    await jobs.processGeneration(claim!);

    const rows = await adminSql<{ provider_job_id: string | null; status: string }[]>`
      select provider_job_id, status from media_generations where id = ${queued.id}
    `;
    assert.ok(rows[0]!.provider_job_id, 'the job handle was not recorded');
    assert.equal(rows[0]!.status, 'processing');
  });

  it('a provider that reports a failed job fails the generation permanently', async () => {
    await parkQueue();
    const queued = await media.generateVideo(mm, { prompt: 'a doomed video' });
    fakeVideo.failJob = { code: 'GENERATION_FAILED', message: 'The model could not do it.' };

    await drainQueue();

    const { generation } = await media.getGeneration(mm, queued.id);
    assert.equal(generation.status, 'failed');
    assert.equal(generation.errorCode, 'GENERATION_FAILED');
  });
});

describe('the queue claims safely and backs off', () => {
  it('two workers never claim the same generation', async () => {
    await parkQueue();
    const queued = await media.generateVideo(mm, { prompt: 'a contested job' });

    // Two workers reaching for the queue at the same moment. Exactly one may
    // come away with this generation; whoever loses must get something else or
    // nothing, never the same row.
    const [first, second] = await Promise.all([jobs.claimGeneration(), jobs.claimGeneration()]);

    const claimedIt = [first, second].filter((c) => c?.id === queued.id);
    assert.equal(claimedIt.length, 1, 'both workers claimed the same generation');
  });

  it('a claim is leased, so a second worker cannot take it while the first works', async () => {
    await parkQueue();
    const queued = await media.generateVideo(mm, { prompt: 'a leased job' });

    const first = await jobs.claimGeneration();
    assert.equal(first?.id, queued.id);

    // The first worker has not finished. Nothing else may pick this up.
    const second = await jobs.claimGeneration();
    assert.notEqual(second?.id, queued.id, 'a claimed generation was handed out twice');

    // And the lease is a lease, not a lock: when it expires the work returns.
    await adminSql`
      update media_generations set next_attempt_at = now() - interval '1 second' where id = ${queued.id}
    `;
    const third = await jobs.claimGeneration();
    assert.equal(third?.id, queued.id, 'an abandoned claim never came back');
  });

  it('a transient failure spends an attempt and backs off rather than retrying at once', async () => {
    const { ProviderFailed } = await import('../src/server/media/providers/types');
    await parkQueue();
    const queued = await media.generateVideo(mm, { prompt: 'a flaky job' });
    fakeVideo.failWith = new ProviderFailed('PROVIDER_ERROR', 'transient', 'Provider hiccup.');

    const claim = await jobs.claimGeneration();
    const outcome = await jobs.processGeneration(claim!);
    assert.equal(outcome.status, 'failed');
    assert.ok(outcome.status === 'failed' && outcome.willRetry);

    const rows = await adminSql<{ attempts: number; next_attempt_at: Date | null; status: string }[]>`
      select attempts, next_attempt_at, status from media_generations where id = ${queued.id}
    `;
    assert.equal(rows[0]!.attempts, 1);
    assert.equal(rows[0]!.status, 'queued');
    assert.ok(rows[0]!.next_attempt_at instanceof Date, 'no backoff was set');
    assert.ok(rows[0]!.next_attempt_at!.getTime() > Date.now(), 'the backoff is already in the past');
  });

  it('rate limiting does not spend an attempt', async () => {
    const { ProviderFailed } = await import('../src/server/media/providers/types');
    await parkQueue();
    const queued = await media.generateVideo(mm, { prompt: 'a throttled job' });
    fakeVideo.failWith = new ProviderFailed('RATE_LIMITED', 'rate_limited', 'Slow down.', 5);

    const claim = await jobs.claimGeneration();
    await jobs.processGeneration(claim!);

    const rows = await adminSql<{ attempts: number; status: string }[]>`
      select attempts, status from media_generations where id = ${queued.id}
    `;
    assert.equal(rows[0]!.attempts, 0, 'being rate limited must not cost an attempt');
    assert.equal(rows[0]!.status, 'queued');
  });

  it('a permanent failure stops immediately instead of using all three attempts', async () => {
    const { ProviderFailed } = await import('../src/server/media/providers/types');
    await parkQueue();
    const queued = await media.generateVideo(mm, { prompt: 'a rejected job' });
    fakeVideo.failWith = new ProviderFailed('INVALID_REQUEST', 'permanent', 'No.');

    const claim = await jobs.claimGeneration();
    await jobs.processGeneration(claim!);

    const rows = await adminSql<{ attempts: number; status: string }[]>`
      select attempts, status from media_generations where id = ${queued.id}
    `;
    assert.equal(rows[0]!.status, 'failed');
    assert.equal(rows[0]!.attempts, 3);
  });

  it('a retried generation goes back to the queue with its attempts reset', async () => {
    const { ProviderFailed } = await import('../src/server/media/providers/types');
    await parkQueue();
    const queued = await media.generateVideo(mm, { prompt: 'a job worth retrying' });
    fakeVideo.failWith = new ProviderFailed('INVALID_REQUEST', 'permanent', 'No.');
    await drainQueue();

    fakeVideo.failWith = null;
    const retried = await media.retryGeneration(mm, queued.id);
    assert.equal(retried.status, 'queued');
    assert.equal(retried.errorCode, null);

    await drainQueue();
    const { generation } = await media.getGeneration(mm, queued.id);
    assert.equal(generation.status, 'completed');
  });

  it('refuses to retry something that has not failed', async () => {
    const generation = await media.generateImage(mm, { prompt: 'a finished image' });
    await assert.rejects(() => media.retryGeneration(mm, generation.id), /failed or cancelled/i);
  });

  it('cancelling stops the job and the worker leaves it alone', async () => {
    await parkQueue();
    const queued = await media.generateVideo(mm, { prompt: 'a cancelled job' });
    const cancelled = await media.cancelGeneration(mm, queued.id);
    assert.equal(cancelled.status, 'cancelled');

    // A cancelled generation is not claimable, so the worker cannot revive it.
    const claim = await jobs.claimGeneration();
    assert.notEqual(claim?.id, queued.id);
  });
});

describe('storage and recovery', () => {
  it('reports a recoverable failure when the row exists but the object does not', async () => {
    const generation = await media.generateImage(mm, { prompt: 'about to lose its file' });
    const rows = await adminSql<{ storage_path: string }[]>`
      select storage_path from media_generation_assets where generation_id = ${generation.id}
    `;
    await storage.removeMediaAsset(rows[0]!.storage_path);

    await assert.rejects(() => media.readAsset(mm, generation.id), /contents are missing/i);
  });

  it('re-running the storage step does not stack duplicate assets', async () => {
    const generation = await media.generateImage(mm, { prompt: 'stored twice' });
    const result = await fakeImage.generate({ prompt: 'stored twice', references: [] });

    await media.completeGeneration(mm, generation.id, result.assets, result.usage, fakeImage.model);

    const rows = await adminSql<{ n: number }[]>`
      select count(*)::int n from media_generation_assets where generation_id = ${generation.id}
    `;
    assert.equal(rows[0]!.n, 1, 'the same ordinal was inserted twice');
  });
});

describe('one company cannot reach another', () => {
  it('THE TEST: company A cannot list, read, download or retry company B generation', async () => {
    const theirs = await media.generateImage(nh, { prompt: 'a patient consent poster' });

    // list
    const { generations } = await media.listGenerations(mm, { limit: 100 });
    assert.ok(
      !generations.some((g) => g.id === theirs.id),
      'Magic Moments listed a Narayana Health generation',
    );

    // read metadata
    await assert.rejects(() => media.getGeneration(mm, theirs.id), /could not be found/i);
    // download the bytes
    await assert.rejects(() => media.readAsset(mm, theirs.id), /could not be found/i);
    // retry it, which would spend the other company money
    await assert.rejects(() => media.retryGeneration(mm, theirs.id), /could not be found/i);
    // cancel it
    await assert.rejects(() => media.cancelGeneration(mm, theirs.id), /could not be found/i);

    // and the owning company can still do all of it, so this proves isolation
    // rather than a broken lookup
    const mine = await media.getGeneration(nh, theirs.id);
    assert.equal(mine.generation.id, theirs.id);
    assert.ok((await media.readAsset(nh, theirs.id)).fileSize > 0);
  });

  it('the reverse direction holds too', async () => {
    const ours = await media.generateImage(mm, { prompt: 'a diwali campaign key visual' });
    await assert.rejects(() => media.getGeneration(nh, ours.id), /could not be found/i);
    await assert.rejects(() => media.readAsset(nh, ours.id), /could not be found/i);
  });

  it('an asset id from another company cannot be fetched through your own generation', async () => {
    const theirs = await media.generateImage(nh, { prompt: 'their poster' });
    const mine = await media.generateImage(mm, { prompt: 'my poster' });

    const rows = await adminSql<{ id: string }[]>`
      select id from media_generation_assets where generation_id = ${theirs.id}
    `;
    const theirAssetId = rows[0]!.id;

    await assert.rejects(() => media.readAsset(mm, mine.id, theirAssetId), /could not be found/i);
  });

  it('a reference image belonging to another company is not found', async () => {
    const theirFile = await drive.uploadFile(nh, {
      folderId: null,
      filename: 'their-logo.png',
      mimeType: 'image/png',
      body: (await fakeImage.generate({ prompt: 'their logo', references: [] })).assets[0]!.bytes,
    });

    await assert.rejects(
      () => media.generateImage(mm, { prompt: 'use their logo', referenceFileIds: [theirFile.id] }),
      /reference image could not be found/i,
    );

    // and no generation was charged for on the way to being refused
    const rows = await adminSql<{ n: number }[]>`
      select count(*)::int n from media_generations
       where company_id = ${mm.companyId} and prompt = 'use their logo'
    `;
    assert.equal(rows[0]!.n, 0);
  });

  it('still makes the picture when a reference image cannot be read', async () => {
    // A file read without being kept has no bytes here by design: it was too
    // large for the object store, so CIP looked at it and stored what it
    // learnt instead. That used to abort the whole generation before a record
    // existed, so nothing was made and nothing explained why.
    const good = await drive.uploadFile(mm, {
      folderId: null,
      filename: 'kept.png',
      mimeType: 'image/png',
      body: (await fakeImage.generate({ prompt: 'kept', references: [] })).assets[0]!.bytes,
    });
    const unkept = await drive.uploadFile(mm, {
      folderId: null,
      filename: 'not-kept.png',
      mimeType: 'image/png',
      body: (await fakeImage.generate({ prompt: 'unkept', references: [] })).assets[0]!.bytes,
    });
    await adminSql`
      update drive_files set storage_path = null, bytes_retained = false
       where id = ${unkept.id} and company_id = ${mm.companyId}
    `;

    const generation = await media.generateImage(mm, {
      prompt: 'a poster using what we have',
      referenceFileIds: [good.id, unkept.id],
    });

    assert.equal(generation.status, 'completed', 'one unreadable aid stopped the whole request');

    // A picture made with one reference instead of two looks different, so it
    // is recorded rather than silently dropped.
    const rows = await adminSql<{ input_metadata: Record<string, unknown> }[]>`
      select input_metadata from media_generations where id = ${generation.id}
    `;
    assert.equal(rows[0]!.input_metadata.referenceCount, 1);
    assert.equal(rows[0]!.input_metadata.referencesSkipped, 1);
  });

  it('scales an oversized reference down rather than refusing it', async () => {
    // A brand's own library is print resolution. Refusing a 9 MB packshot is
    // the same mistake as refusing to look at a 90 MB bottle shot.
    const { createCanvas } = await import('@napi-rs/canvas');
    const canvas = createCanvas(3000, 3000);
    const ctx = canvas.getContext('2d');
    const noise = ctx.createImageData(3000, 3000);

    // Genuinely incompressible, and the same every run. A periodic pattern
    // looks like noise and is not: PNG found the period and the first attempt
    // at this fixture came out at 160 KB instead of the megabytes it needed.
    let seed = 0x2545f491;
    for (let i = 0; i < noise.data.length; i += 4) {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; seed |= 0;
      noise.data[i] = seed & 0xff;
      noise.data[i + 1] = (seed >>> 8) & 0xff;
      noise.data[i + 2] = (seed >>> 16) & 0xff;
      noise.data[i + 3] = 255;
    }
    ctx.putImageData(noise, 0, 0);
    const big = canvas.toBuffer('image/png');
    assert.ok(big.byteLength > 8 * 1024 * 1024, `the fixture is only ${big.byteLength} bytes`);

    const file = await drive.uploadFile(mm, {
      folderId: null,
      filename: 'print-resolution-packshot.png',
      mimeType: 'image/png',
      body: big,
    });

    const generation = await media.generateImage(mm, {
      prompt: 'a poster built around the packshot',
      referenceFileIds: [file.id],
    });

    assert.equal(generation.status, 'completed');
    const rows = await adminSql<{ input_metadata: Record<string, unknown> }[]>`
      select input_metadata from media_generations where id = ${generation.id}
    `;
    assert.equal(rows[0]!.input_metadata.referenceCount, 1, 'the packshot was dropped, not scaled');
    assert.equal(rows[0]!.input_metadata.referencesSkipped, 0);
  });

  it('a company can use its own reference image', async () => {
    const ourFile = await drive.uploadFile(mm, {
      folderId: null,
      filename: 'our-logo.png',
      mimeType: 'image/png',
      body: (await fakeImage.generate({ prompt: 'our logo', references: [] })).assets[0]!.bytes,
    });

    const generation = await media.generateImage(mm, {
      prompt: 'put our logo on a poster',
      referenceFileIds: [ourFile.id],
    });
    assert.equal(generation.status, 'completed');
  });
});

describe('row-level security and composite ownership', () => {
  it('with no company set, the media tables are empty', async () => {
    const generations = await appSql`select id from media_generations limit 10`;
    const assets = await appSql`select id from media_generation_assets limit 10`;
    assert.equal(generations.length, 0, 'policies must fail closed with no company set');
    assert.equal(assets.length, 0, 'policies must fail closed with no company set');
  });

  it('a scoped query sees only that company', async () => {
    await media.generateImage(mm, { prompt: 'scoped read a' });
    await media.generateImage(nh, { prompt: 'scoped read b' });

    const seen = await appSql.begin(async (tx) => {
      await tx`select set_config('cip.company_id', ${mm.companyId}, true)`;
      return tx<{ company_id: string }[]>`select company_id from media_generations`;
    });

    assert.ok(seen.length > 0, 'the scoped query found nothing, so it proves nothing');
    for (const row of seen) assert.equal(row.company_id, mm.companyId);
  });

  it('row-level security refuses a generation written for another company', async () => {
    await assert.rejects(
      () =>
        appSql.begin(async (tx) => {
          await tx`select set_config('cip.company_id', ${mm.companyId}, true)`;
          return tx`
            insert into media_generations (company_id, created_by, type, provider, model, prompt)
            values (${nh.companyId}, ${mm.userId}, 'image', 'fake-image', 'fake-image-1', 'forged')
          `;
        }),
      /row-level security/i,
    );
  });

  it('the composite key refuses an asset whose generation belongs elsewhere', async () => {
    const theirs = await media.generateImage(nh, { prompt: 'their generation' });

    // Even with the policy satisfied for company A, the composite foreign key
    // makes an asset under A pointing at B's generation unrepresentable.
    await assert.rejects(
      () =>
        adminSql`
          insert into media_generation_assets
            (company_id, generation_id, storage_bucket, storage_path, mime_type, file_size, ordinal)
          values
            (${mm.companyId}, ${theirs.id}, 'local', 'companies/x/media/y/z.png', 'image/png', 1, 99)
        `,
      /violates foreign key constraint/i,
    );
  });

  it('every stored asset sits in the same company as its generation', async () => {
    const rows = await adminSql<{ n: number }[]>`
      select count(*)::int n
        from media_generation_assets a
        join media_generations g on g.id = a.generation_id
       where g.company_id <> a.company_id
    `;
    assert.equal(rows[0]!.n, 0);
  });

  it('a completed generation must have somewhere its bytes are', async () => {
    await assert.rejects(
      () =>
        adminSql`
          insert into media_generations (company_id, created_by, type, provider, model, prompt, status)
          values (${mm.companyId}, ${mm.userId}, 'image', 'fake-image', 'fake-image-1', 'lying', 'completed')
        `,
      /media_generations_completed_has_output/i,
    );
  });
});

describe('rate limiting', () => {
  it('refuses a burst and says how long to wait', async () => {
    const options = { capacity: 3, refillPerSecond: 0.1 };
    const results = [];
    for (let i = 0; i < 6; i += 1) results.push(await rateLimit.rateLimit('media-test-subject', options));

    assert.equal(results.filter((r) => r.allowed).length, 3, 'the bucket let more through than it holds');
    const refused = results.find((r) => !r.allowed)!;
    assert.ok(refused.retryAfterSeconds >= 1, 'a refusal must say when to come back');
  });

  it('one company burst does not consume another company allowance', async () => {
    const options = { capacity: 2, refillPerSecond: 0.1 };
    await rateLimit.rateLimit(`media:company:${mm.companyId}`, options);
    await rateLimit.rateLimit(`media:company:${mm.companyId}`, options);

    const theirs = await rateLimit.rateLimit(`media:company:${nh.companyId}`, options);
    assert.ok(theirs.allowed, 'one company exhausted another company bucket');
  });

  it('the configured limits are real numbers, not zero', () => {
    for (const options of [
      rateLimit.IMAGE_GENERATION_LIMIT(),
      rateLimit.VIDEO_GENERATION_LIMIT(),
      rateLimit.COMPANY_GENERATION_LIMIT(),
    ]) {
      assert.ok(options.capacity > 0);
      assert.ok(options.refillPerSecond > 0);
    }
  });
});

describe('OpenAI as a second image provider', () => {
  /**
   * A stand-in for OpenAI's HTTP API.
   *
   * The suite must never call the real one: it costs money, needs a key, and
   * would make the tests depend on somebody else's uptime. So fetch is replaced
   * for the duration of each case and the adapter is exercised against
   * responses shaped exactly like OpenAI's.
   */
  const realFetch = globalThis.fetch;

  /** A one-pixel PNG, so the bytes that come back are a real image. */
  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );

  let captured: { url: string; init: RequestInit | undefined }[] = [];

  function stubFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
    captured = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      captured.push({ url: String(input), init });
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', ...headers },
      });
    }) as typeof fetch;
  }

  function restoreFetch() {
    globalThis.fetch = realFetch;
  }

  async function makeProvider(key: string | undefined = 'sk-test-not-a-real-key') {
    const { OpenAIImageProvider } = await import('../src/server/media/providers/openaiImage');
    return new OpenAIImageProvider(key);
  }

  it('initialises from a key and reports the model it will use', async () => {
    const provider = await makeProvider();
    assert.equal(provider.name, 'openai');
    assert.equal(provider.model, 'gpt-image-2');
    assert.equal(provider.configured, true);
    assert.ok(provider.aspectRatios.includes('1:1'));
  });

  it('without a key it reports unconfigured and refuses to call anything', async () => {
    // Constructed directly rather than through makeProvider: passing undefined
    // to a parameter with a default gets the default, which would quietly give
    // this provider a key and test nothing.
    const { OpenAIImageProvider } = await import('../src/server/media/providers/openaiImage');
    const provider = new OpenAIImageProvider(undefined);
    assert.equal(provider.configured, false);

    const reached: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      reached.push(String(input));
      return new Response('{}');
    }) as typeof fetch;

    try {
      await assert.rejects(
        () => provider.generate({ prompt: 'anything', references: [] }),
        (error: unknown) => {
          assert.equal((error as { code: string }).code, 'PROVIDER_NOT_CONFIGURED');
          assert.equal((error as { kind: string }).kind, 'permanent');
          return true;
        },
      );
      assert.deepEqual(reached, [], 'an unconfigured provider must not reach the network');
    } finally {
      restoreFetch();
    }
  });

  it('reads a spent account as spent, not as a rate limit', async () => {
    const provider = await makeProvider();
    // What OpenAI actually sends when the credits run out: the type says
    // insufficient_quota and the code says credit_balance_exhausted. Reading
    // the code alone, CIP told people it was being rate limited — so the page
    // said "try again", and trying again could never work.
    stubFetch(429, {
      error: {
        message: 'You have no credits remaining.',
        type: 'insufficient_quota',
        code: 'credit_balance_exhausted',
      },
    });

    try {
      await assert.rejects(
        () => provider.generate({ prompt: 'anything', references: [] }),
        (error: unknown) => {
          assert.equal((error as { kind: string }).kind, 'permanent', 'a spent account was called transient');
          assert.notEqual((error as { code: string }).code, 'RATE_LIMITED');
          assert.match((error as { message: string }).message, /credit/i);
          return true;
        },
      );
    } finally {
      restoreFetch();
    }
  });

  it('still reads a real rate limit as one', async () => {
    const provider = await makeProvider();
    stubFetch(429, { error: { message: 'slow down', type: 'rate_limit_error', code: 'rate_limit_exceeded' } }, { 'retry-after': '7' });

    try {
      await assert.rejects(
        () => provider.generate({ prompt: 'anything', references: [] }),
        (error: unknown) => {
          assert.equal((error as { code: string }).code, 'RATE_LIMITED');
          assert.equal((error as { retryAfterSeconds: number }).retryAfterSeconds, 7);
          return true;
        },
      );
    } finally {
      restoreFetch();
    }
  });

  it('turns a successful response into image bytes', async () => {
    const provider = await makeProvider();
    stubFetch(200, {
      data: [{ b64_json: PNG.toString('base64') }],
      usage: { input_tokens: 11, output_tokens: 22 },
    });

    try {
      const result = await provider.generate({
        prompt: 'a brass diya on dark marble',
        references: [],
        aspectRatio: '3:2',
        imageSize: 'high',
      });

      const asset = result.assets[0]!;
      assert.equal(result.model, 'gpt-image-2');
      assert.equal(asset.mimeType, 'image/png', 'the type is read from the bytes, not assumed');
      assert.deepEqual([...asset.bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
      assert.equal(asset.width, 1536);
      assert.equal(asset.height, 1024);
      assert.equal(result.usage.inputUnits, 11);
      assert.equal(result.usage.outputUnits, 22);

      const body = JSON.parse(String(captured[0]!.init!.body)) as Record<string, unknown>;
      assert.equal(captured[0]!.url, 'https://api.openai.com/v1/images/generations');
      assert.equal(body.model, 'gpt-image-2');
      assert.equal(body.size, '1536x1024');
      assert.equal(body.quality, 'high');
      // This model rejects response_format as an unknown parameter.
      assert.ok(!('response_format' in body));
    } finally {
      restoreFetch();
    }
  });

  it('sends only the prompt and the options, never anything of ours', async () => {
    const provider = await makeProvider();
    stubFetch(200, { data: [{ b64_json: PNG.toString('base64') }] });

    try {
      await provider.generate({ prompt: 'a lantern', references: [] });
      const sent = String(captured[0]!.init!.body);
      for (const forbidden of [mm.companyId, mm.userId, 'companies/', 'storage_path']) {
        assert.ok(!sent.includes(forbidden), 'the provider sent something of ours to OpenAI');
      }
    } finally {
      restoreFetch();
    }
  });

  it('uses the edit endpoint when a reference image is given', async () => {
    const provider = await makeProvider();
    stubFetch(200, { data: [{ b64_json: PNG.toString('base64') }] });

    try {
      await provider.generate({
        prompt: 'put our logo on it',
        references: [{ bytes: PNG, mimeType: 'image/png' }],
      });
      assert.equal(captured[0]!.url, 'https://api.openai.com/v1/images/edits');
      assert.ok(captured[0]!.init!.body instanceof FormData);
    } finally {
      restoreFetch();
    }
  });

  it('classifies failures instead of passing the provider wording on', async () => {
    const cases: [number, unknown, string, string][] = [
      [401, { error: { code: 'invalid_api_key' } }, 'PROVIDER_NOT_CONFIGURED', 'permanent'],
      [400, { error: { code: 'invalid_value' } }, 'INVALID_REQUEST', 'permanent'],
      [429, { error: { code: 'rate_limit_exceeded' } }, 'RATE_LIMITED', 'rate_limited'],
      [429, { error: { code: 'insufficient_quota' } }, 'PROVIDER_ERROR', 'permanent'],
      [400, { error: { code: 'moderation_blocked' } }, 'GENERATION_FAILED', 'permanent'],
      [500, { error: { code: 'server_error' } }, 'PROVIDER_ERROR', 'transient'],
    ];

    for (const [status, body, code, kind] of cases) {
      const provider = await makeProvider();
      stubFetch(status, body);
      try {
        await assert.rejects(
          () => provider.generate({ prompt: 'x', references: [] }),
          (error: unknown) => {
            assert.equal((error as { code: string }).code, code, 'status ' + status);
            assert.equal((error as { kind: string }).kind, kind, 'status ' + status);
            // The provider's own wording must never survive: it can quote the prompt.
            assert.ok(!String((error as Error).message).includes('moderation_blocked'));
            return true;
          },
        );
      } finally {
        restoreFetch();
      }
    }
  });

  it('a response carrying no image is a failure, not an empty success', async () => {
    const provider = await makeProvider();
    stubFetch(200, { data: [] });
    try {
      await assert.rejects(
        () => provider.generate({ prompt: 'x', references: [] }),
        (error: unknown) => {
          assert.equal((error as { code: string }).code, 'GENERATION_FAILED');
          return true;
        },
      );
    } finally {
      restoreFetch();
    }
  });

  it('never puts the key in anything it exposes or throws', async () => {
    const secret = 'sk-proj-super-secret-value-0000';
    const provider = await makeProvider(secret);
    stubFetch(401, { error: { code: 'invalid_api_key', message: 'key ' + secret + ' is bad' } });

    try {
      await provider.generate({ prompt: 'x', references: [] }).catch((error: unknown) => {
        const thrown = error as Error;
        assert.ok(!String(thrown.message).includes(secret), 'the key reached the error message');
        assert.ok(!JSON.stringify(thrown, Object.getOwnPropertyNames(thrown)).includes(secret));
      });

      const exposed = JSON.stringify({
        name: provider.name,
        model: provider.model,
        configured: provider.configured,
        ratios: provider.aspectRatios,
      });
      assert.ok(!exposed.includes(secret), 'the key is reachable from the provider');
    } finally {
      restoreFetch();
    }
  });
});

describe('choosing which image provider answers', () => {
  /** Two distinguishable doubles, so which one ran is observable. */
  class NamedProvider {
    readonly configured = true;
    readonly aspectRatios = ['1:1'];
    readonly imageSizes = ['auto'];
    calls = 0;
    constructor(
      readonly name: 'openai' | 'google',
      readonly model: string,
    ) {}
    async generate() {
      this.calls += 1;
      return {
        assets: [{ bytes: Buffer.from('generated'), mimeType: 'image/png', width: 8, height: 8 }],
        model: this.model,
        usage: {},
      };
    }
  }

  type AnyImageProvider = import('../src/server/media/providers').ImageGenerationProvider;

  let openai: NamedProvider;
  let gemini: NamedProvider;

  beforeEach(() => {
    openai = new NamedProvider('openai', 'gpt-image-2');
    gemini = new NamedProvider('google', 'gemini-3.1-flash-image');
    providers.__setProviders(fakeImage, fakeVideo, {
      openai: openai as unknown as AnyImageProvider,
      gemini: gemini as unknown as AnyImageProvider,
    });
  });

  after(() => {
    providers.__setProviders(fakeImage, fakeVideo);
  });

  it('provider "openai" generates through OpenAI', async () => {
    const generation = await media.generateImage(mm, { prompt: 'via openai', provider: 'openai' });
    assert.equal(openai.calls, 1);
    assert.equal(gemini.calls, 0);
    assert.equal(generation.provider, 'openai');
    assert.equal(generation.model, 'gpt-image-2');
  });

  it('provider "gemini" generates through Gemini', async () => {
    const generation = await media.generateImage(mm, { prompt: 'via gemini', provider: 'gemini' });
    assert.equal(gemini.calls, 1);
    assert.equal(openai.calls, 0);
    assert.equal(generation.provider, 'google');
    assert.equal(generation.model, 'gemini-3.1-flash-image');
  });

  it('refuses a provider name it does not publish', async () => {
    await assert.rejects(
      () => media.generateImage(mm, { prompt: 'x', provider: 'midjourney' }),
      /Provider must be one of/i,
    );
    assert.equal(openai.calls + gemini.calls, 0, 'something ran on the way to being refused');
  });

  it('one company cannot read a generation another made with OpenAI', async () => {
    const theirs = await media.generateImage(nh, { prompt: 'their openai image', provider: 'openai' });
    await assert.rejects(() => media.getGeneration(mm, theirs.id), /could not be found/i);
    await assert.rejects(() => media.readAsset(mm, theirs.id), /could not be found/i);

    const mine = await media.listGenerations(mm, { limit: 100 });
    assert.ok(!mine.generations.some((g) => g.id === theirs.id));
  });

  it('stores an OpenAI image in the private store under its own company', async () => {
    const generation = await media.generateImage(mm, { prompt: 'stored openai', provider: 'openai' });

    const rows = await adminSql<{ storage_path: string; company_id: string }[]>`
      select storage_path, company_id from media_generation_assets where generation_id = ${generation.id}
    `;
    const path = rows[0]!.storage_path;
    assert.equal(rows[0]!.company_id, mm.companyId);
    assert.ok(path.startsWith('companies/' + mm.companyId + '/media/' + generation.id + '/'), path);

    // The same private store the Drive uses, reachable only through the service.
    const asset = await media.readAsset(mm, generation.id);
    assert.ok(asset.fileSize > 0);

    // And nothing about where it lives reaches a caller.
    const payload = JSON.stringify(await media.getGeneration(mm, generation.id));
    for (const forbidden of ['storage_path', 'storagePath', 'companies/', mm.companyId]) {
      assert.ok(!payload.includes(forbidden), 'a media response leaked ' + forbidden);
    }
  });

  it('remembers the chosen provider so a retry does not wander to the other', async () => {
    const generation = await media.generateImage(mm, { prompt: 'sticky choice', provider: 'openai' });
    const rows = await adminSql<{ input_metadata: { providerChoice?: string } }[]>`
      select input_metadata from media_generations where id = ${generation.id}
    `;
    // An object, not a JSON string: stringifying before handing it to the
    // driver encodes it twice and every field reads back undefined.
    assert.equal(typeof rows[0]!.input_metadata, 'object');
    assert.equal(rows[0]!.input_metadata.providerChoice, 'openai');
  });

  it('the options a generation was made with survive into the record', async () => {
    const generation = await media.generateImage(mm, {
      prompt: 'round trip',
      provider: 'openai',
      aspectRatio: '1:1',
    });
    // Reads through the DTO, which is where a double-encoded column showed up
    // as a quietly missing field rather than an error.
    const { generation: read } = await media.getGeneration(mm, generation.id);
    assert.equal(read.aspectRatio, '1:1');
  });

  it('reports both providers, each with its own configured state', () => {
    const status = providers.providerStatus();
    assert.deepEqual(status.images.map((p) => p.choice).sort(), ['gemini', 'openai']);
    assert.ok(status.defaultImageProvider === 'gemini' || status.defaultImageProvider === 'openai');
  });
});

describe('provider configuration is reported honestly', () => {
  it('a fake standing in reports the real provider as unconfigured', () => {
    const status = providers.providerStatus();
    assert.equal(status.image.configured, false);
    assert.equal(status.video.configured, false);
    assert.equal(status.image.provider, 'fake-image');
  });

  it('an unconfigured real provider refuses rather than pretending', async () => {
    const { GoogleImageProvider } = await import('../src/server/media/providers/google-image');
    const unconfigured = new GoogleImageProvider(undefined);

    assert.equal(unconfigured.configured, false);
    await assert.rejects(
      () => unconfigured.generate({ prompt: 'anything', references: [] }),
      (error: unknown) => {
        assert.equal((error as { code: string }).code, 'PROVIDER_NOT_CONFIGURED');
        return true;
      },
    );
  });

  it('the video provider only claims cancel because the API really has it', async () => {
    const { SeedanceVideoProvider } = await import('../src/server/media/providers/seedance-video');
    const unconfigured = new SeedanceVideoProvider(undefined);
    assert.equal(unconfigured.supportsCancel, true);
    await assert.rejects(
      () => unconfigured.submit({ prompt: 'anything' }),
      (error: unknown) => {
        assert.equal((error as { code: string }).code, 'PROVIDER_NOT_CONFIGURED');
        return true;
      },
    );
  });

  it('no provider adapter carries a key in anything it exposes', async () => {
    const { GoogleImageProvider } = await import('../src/server/media/providers/google-image');
    const { SeedanceVideoProvider } = await import('../src/server/media/providers/seedance-video');

    const secret = 'super-secret-key-value';
    const google = new GoogleImageProvider(secret);
    const seedance = new SeedanceVideoProvider(secret);

    for (const provider of [google, seedance]) {
      const exposed = JSON.stringify({
        name: provider.name,
        model: provider.model,
        configured: provider.configured,
      });
      assert.ok(!exposed.includes(secret), 'a provider exposed its key');
    }
    assert.ok(!JSON.stringify(providers.providerStatus()).includes(secret));
  });
});
