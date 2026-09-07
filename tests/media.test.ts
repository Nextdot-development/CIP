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

beforeEach(() => {
  fakeImage.failWith = null;
  fakeVideo.reset();
  rateLimit.__resetRateLimits();
});

after(async () => {
  await appSql?.end();
  await adminSql?.end();
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
  it('refuses a burst and says how long to wait', () => {
    const options = { capacity: 3, refillPerSecond: 0.1 };
    const results = Array.from({ length: 6 }, () => rateLimit.rateLimit('media-test-subject', options));

    assert.equal(results.filter((r) => r.allowed).length, 3, 'the bucket let more through than it holds');
    const refused = results.find((r) => !r.allowed)!;
    assert.ok(refused.retryAfterSeconds >= 1, 'a refusal must say when to come back');
  });

  it('one company burst does not consume another company allowance', () => {
    const options = { capacity: 2, refillPerSecond: 0.1 };
    rateLimit.rateLimit(`media:company:${mm.companyId}`, options);
    rateLimit.rateLimit(`media:company:${mm.companyId}`, options);

    const theirs = rateLimit.rateLimit(`media:company:${nh.companyId}`, options);
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
