import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { startTestDatabase } from './harness';
import type { TestDb } from './harness';

/**
 * Connected Google Drive — OAuth handling, sync, and isolation.
 *
 * Everything runs against an in-memory Google Drive, so the suite needs no
 * account, no OAuth client and no network. What it is really testing is the
 * code around Google: change detection, pagination, the company boundary, and
 * that a synced file genuinely travels the existing extraction and embedding
 * pipelines rather than a second copy of them.
 */

let db: TestDb;
let appSql: postgres.Sql;
let adminSql: postgres.Sql;
let storageDir: string;

type Scope = { companyId: string; userId: string; role: 'owner' };
let mm: Scope;
let nh: Scope;

let connection: typeof import('../src/server/integrations/googleDrive/connection');
let sync: typeof import('../src/server/integrations/googleDrive/sync');
let jobs: typeof import('../src/server/integrations/googleDrive/jobs');
let gdrive: typeof import('../src/server/integrations/googleDrive');
let crypto: typeof import('../src/server/integrations/crypto');
let processing: typeof import('../src/server/drive/processing');
let drive: typeof import('../src/server/drive/service');
let understanding: typeof import('../src/server/brain/understanding');

let fake: import('../src/server/integrations/googleDrive/fake').FakeGoogleDrive;

const PASSWORD = 'cip-demo-password';
const MM_FOLDER = 'folder-magic-moments';
const NH_FOLDER = 'folder-narayana-health';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const GOOGLE_DOC = 'application/vnd.google-apps.document';

/** Connects a company to a folder, the way the routes would. */
async function connect(scope: Scope, folderId: string): Promise<void> {
  const tokens = await fake.exchangeCode();
  await connection.saveTokens(scope, tokens);
  await connection.setFolder(scope, folderId);
}

/** Drains the understanding queue, exactly as the Brain worker does. */
async function understandAll(): Promise<number> {
  // Nothing is claimable until it has been queued, exactly as in the worker.
  await understanding.enqueueEverywhere();
  let done = 0;
  for (let i = 0; i < 40; i += 1) {
    const claim = await understanding.claimAssetForUnderstanding();
    if (!claim) break;
    await understanding.understandClaimedAsset(claim);
    done += 1;
  }
  return done;
}

/** Drains the extraction queue, exactly as the Phase 3 worker does. */
async function extractAll(): Promise<number> {
  let done = 0;
  for (;;) {
    const file = await processing.claimNextFile();
    if (!file) break;
    await processing.processClaimedFile(file);
    done += 1;
  }
  return done;
}

before(async () => {
  db = await startTestDatabase();
  storageDir = mkdtempSync(join(tmpdir(), 'cip-gdrive-'));

  process.env.DATABASE_ADMIN_URL = db.adminUrl;
  process.env.CIP_APP_DB_PASSWORD = db.appPassword;
  // Progress now runs through understanding, so the suite needs a Brain.
  // The deterministic fake keeps it offline and free.
  process.env.CIP_FORCE_FAKE_BRAIN = 'true';
  process.env.SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.CIP_SEED_PASSWORD = PASSWORD;
  process.env.CIP_STORAGE_DIR = storageDir;
  process.env.CIP_FORCE_LOCAL_STORAGE = 'true';

  const { migrate } = await import('../src/server/migrate');
  await migrate(() => {}, { skip: db.skipMigrations });
  const { seed } = await import('../src/server/seed');
  await seed(() => {});

  process.env.DATABASE_URL = db.appUrl;
  connection = await import('../src/server/integrations/googleDrive/connection');
  sync = await import('../src/server/integrations/googleDrive/sync');
  jobs = await import('../src/server/integrations/googleDrive/jobs');
  gdrive = await import('../src/server/integrations/googleDrive');
  crypto = await import('../src/server/integrations/crypto');
  processing = await import('../src/server/drive/processing');
  drive = await import('../src/server/drive/service');
  understanding = await import('../src/server/brain/understanding');

  const { FakeGoogleDrive } = await import('../src/server/integrations/googleDrive/fake');
  fake = new FakeGoogleDrive();
  gdrive.__setGoogleDrive(fake);

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

  // Every case starts from nothing connected and nothing synced. These tests
  // share one database, and a connection or a synced file left behind by an
  // earlier case would make a later one assert against somebody else's state.
  await adminSql`delete from google_drive_files`;
  await adminSql`delete from google_drive_connections`;
  await adminSql`delete from drive_files where source_type = 'google_drive'`;

  // Both folders exist and are empty at the start of every test.
  fake.put(MM_FOLDER, { id: `${MM_FOLDER}-seed`, name: 'seed.txt', mimeType: 'text/plain' }, 'seed');
  fake.remove(MM_FOLDER, `${MM_FOLDER}-seed`);
  fake.put(NH_FOLDER, { id: `${NH_FOLDER}-seed`, name: 'seed.txt', mimeType: 'text/plain' }, 'seed');
  fake.remove(NH_FOLDER, `${NH_FOLDER}-seed`);
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

describe('credentials are encrypted and never exposed', () => {
  it('encrypts a token so the plaintext is not in the stored value', () => {
    const token = 'ya29.super-secret-refresh-token';
    const stored = crypto.encryptSecret(token);

    assert.ok(!stored.includes(token), 'the ciphertext contains the plaintext');
    assert.equal(crypto.decryptSecret(stored), token);
  });

  it('encrypting twice gives different ciphertext for the same token', () => {
    const token = 'ya29.the-same-token';
    assert.notEqual(crypto.encryptSecret(token), crypto.encryptSecret(token));
  });

  it('refuses a token that has been tampered with', () => {
    const stored = crypto.encryptSecret('ya29.token');
    const parts = stored.split('.');
    // Flip a byte of the ciphertext. GCM must refuse it rather than return junk.
    const body = Buffer.from(parts[3]!, 'base64');
    body[0] = body[0]! ^ 0xff;
    parts[3] = body.toString('base64');

    assert.throws(() => crypto.decryptSecret(parts.join('.')));
  });

  it('the stored row holds no plaintext token', async () => {
    await connect(mm, MM_FOLDER);

    const rows = await adminSql<{ access: string | null; refresh: string | null }[]>`
      select access_token_encrypted as access, refresh_token_encrypted as refresh
        from google_drive_connections where company_id = ${mm.companyId}
    `;
    assert.ok(rows[0]!.access && !rows[0]!.access.includes('fake-access-token'));
    assert.ok(rows[0]!.refresh && !rows[0]!.refresh.includes('fake-refresh-token'));
  });

  it('the connection a caller sees carries no token at all', async () => {
    await connect(mm, MM_FOLDER);
    const dto = await connection.getConnection(mm);
    const payload = JSON.stringify(dto);

    for (const forbidden of ['fake-access-token', 'fake-refresh-token', 'token', mm.companyId, 'company_id']) {
      assert.ok(!payload.includes(forbidden), `the connection DTO leaked ${forbidden}`);
    }
    assert.equal(dto.status, 'connected');
  });
});

describe('the OAuth state ties the callback to the session that began it', () => {
  it('accepts its own state', () => {
    const state = connection.issueOAuthState(mm);
    assert.equal(connection.verifyOAuthState(state, mm), true);
  });

  it('refuses a state issued for another company', () => {
    // Without this, a link could make somebody finish an OAuth flow an attacker
    // started, attaching the attacker's Drive to the victim's company.
    const state = connection.issueOAuthState(nh);
    assert.equal(connection.verifyOAuthState(state, mm), false);
  });

  it('refuses a forged or altered state', () => {
    const state = connection.issueOAuthState(mm);
    const [encoded] = state.split('.');
    assert.equal(connection.verifyOAuthState(`${encoded}.not-the-signature`, mm), false);
    assert.equal(connection.verifyOAuthState('nonsense', mm), false);
    assert.equal(connection.verifyOAuthState('', mm), false);
  });
});

describe('choosing a folder', () => {
  it('takes the link people actually copy, not just the id', () => {
    const id = '1DhF_i3XqFK7HjK91e4nN6IA9hSRj6YrJ';

    // Every shape Drive hands out, plus the bare id.
    for (const input of [
      id,
      `https://drive.google.com/drive/folders/${id}`,
      `https://drive.google.com/drive/folders/${id}?usp=sharing`,
      `https://drive.google.com/drive/u/0/folders/${id}`,
      `https://drive.google.com/open?id=${id}`,
      `  https://drive.google.com/drive/folders/${id}?usp=drive_link  `,
    ]) {
      assert.equal(connection.parseFolderId(input), id, `did not understand: ${input}`);
    }
  });

  it('refuses something that is not a Drive folder', () => {
    for (const input of [
      '',
      '   ',
      'not a folder',
      'https://example.com/drive/folders/1DhF_i3XqFK7HjK91e4nN6IA9hSRj6YrJ',
      'https://drive.google.com/drive/folders/short',
      'https://drive.google.com/file/d/1DhF_i3XqFK7HjK91e4nN6IA9hSRj6YrJ/view',
    ]) {
      assert.equal(connection.parseFolderId(input), null, `should not have accepted: ${input}`);
    }
  });

  it('refuses something that is not a folder id', async () => {
    await connection.saveTokens(mm, await fake.exchangeCode());
    await assert.rejects(() => connection.setFolder(mm, 'not a folder at all'), /Google Drive folder/i);
    await assert.rejects(() => connection.setFolder(mm, ''), /Google Drive folder/i);
  });

  it('accepts a folder given as a link', async () => {
    await connect(mm, MM_FOLDER);
    const dto = await connection.setFolder(
      mm,
      `https://drive.google.com/drive/folders/${MM_FOLDER}?usp=sharing`,
    );
    // The id is what gets stored, never the URL.
    assert.equal(dto.folderId, MM_FOLDER);
  });

  it('refuses a folder the connected account cannot open, and says which way', async () => {
    await connection.saveTokens(mm, await fake.exchangeCode());
    // The specific reason survives rather than being flattened into one
    // catch-all message: "no longer available" and "the API is switched off"
    // send somebody to entirely different places.
    await assert.rejects(
      () => connection.setFolder(mm, 'folder-that-does-not-exist'),
      /no longer available/i,
    );
  });

  it('stores the id and the name once it is confirmed readable', async () => {
    await connect(mm, MM_FOLDER);
    const dto = await connection.getConnection(mm);
    assert.equal(dto.folderId, MM_FOLDER);
    assert.ok(dto.folderName);
  });
});

describe('a 403 is reported for what it actually is', () => {
  /**
   * Google answers "the API is off", "you may not read that" and "slow down"
   * with the same status. Telling them apart is the difference between someone
   * enabling an API in a console and someone waiting for a rate limit that was
   * never happening.
   */
  const realFetch = globalThis.fetch;

  function stub403(reason: string) {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ error: { code: 403, errors: [{ reason, message: 'quotes a file name' }] } }),
        { status: 403, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch;
  }

  async function realClient() {
    const { GoogleDriveClient } = await import('../src/server/integrations/googleDrive/client');
    return new GoogleDriveClient('client-id', 'client-secret');
  }

  after(() => {
    globalThis.fetch = realFetch;
  });

  const cases: [string, string, RegExp][] = [
    ['accessNotConfigured', 'permanent', /not enabled/i],
    ['SERVICE_DISABLED', 'permanent', /not enabled/i],
    ['insufficientFilePermissions', 'permanent', /cannot read that folder/i],
    ['rateLimitExceeded', 'rate_limited', /rate limiting/i],
    ['somethingNobodyHasSeen', 'permanent', /refused/i],
  ];

  for (const [reason, kind, message] of cases) {
    it(`${reason} is ${kind}`, async () => {
      const client = await realClient();
      stub403(reason);
      try {
        await assert.rejects(
          () => client.getFile('token', 'folder-id'),
          (error: unknown) => {
            const e = error as { kind: string; message: string };
            assert.equal(e.kind, kind, reason);
            assert.match(e.message, message);
            // Google's own wording can quote a file name, so it never survives.
            assert.ok(!e.message.includes('quotes a file name'));
            return true;
          },
        );
      } finally {
        globalThis.fetch = realFetch;
      }
    });
  }

  it('an unrecognised 403 is not retried four times over', async () => {
    const client = await realClient();
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: { code: 403, errors: [{ reason: 'mystery' }] } }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      await assert.rejects(() => client.getFile('token', 'folder-id'));
      assert.equal(calls, 1, 'a refusal we cannot explain should not be retried');
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('sync discovers, ingests and hands over to the existing pipeline', () => {
  it('ingests a supported file and marks it as coming from Google Drive', async () => {
    await connect(mm, MM_FOLDER);
    fake.put(
      MM_FOLDER,
      { id: 'gd-brief', name: 'Diwali brief', mimeType: 'text/plain', md5Checksum: 'md5-1' },
      'Magic Moments talks about the occasion, never the alcohol.',
    );

    const outcome = await sync.syncNow(mm);
    assert.equal(outcome.added, 1);
    assert.equal(outcome.scanned, 1);

    const files = await adminSql<{ name: string; source_type: string; processing_status: string }[]>`
      select name, source_type, processing_status from drive_files
       where company_id = ${mm.companyId} and source_type = 'google_drive'
    `;
    assert.equal(files.length, 1);
    assert.equal(files[0]!.source_type, 'google_drive');
    // Pending, which is exactly what the Phase 3 queue claims.
    assert.equal(files[0]!.processing_status, 'pending');
  });

  it('THE HANDOVER: the existing extraction and embedding pipelines take it from there', async () => {
    await connect(mm, MM_FOLDER);
    fake.put(
      MM_FOLDER,
      { id: 'gd-voice', name: 'Voice guide', mimeType: 'text/plain', md5Checksum: 'md5-voice' },
      'Our brand voice is warm and unhurried. We never rush the reader.',
    );
    await sync.syncNow(mm);

    // Nothing Google-specific runs here. This is the Phase 3 worker.
    const processed = await extractAll();
    assert.ok(processed > 0, 'the existing extraction queue never claimed the synced file');

    const rows = await adminSql<{ n: number }[]>`
      select count(*)::int n
        from drive_file_chunks c
        join drive_files f on f.id = c.file_id
       where f.company_id = ${mm.companyId} and f.source_type = 'google_drive'
    `;
    assert.ok(rows[0]!.n > 0, 'the synced file produced no chunks');

    // And they are ordinary chunks, so the Phase 4 embedding queue finds them
    // exactly as it finds chunks from an upload. Only assertable where 0007
    // ran: a database without pgvector has no embedding bookkeeping at all.
    if (!db.skipMigrations.includes('0007_embeddings.sql')) {
      const pending = await adminSql<{ n: number }[]>`
        select count(*)::int n from drive_file_chunks c
          join drive_files f on f.id = c.file_id
         where f.source_type = 'google_drive' and c.embedding_attempts = 0
      `;
      assert.ok(pending[0]!.n > 0, 'the synced chunks are not queued for embedding');
    }
  });

  it('exports a Google Doc rather than skipping it', async () => {
    await connect(mm, MM_FOLDER);
    fake.put(MM_FOLDER, { id: 'gd-native', name: 'Strategy', mimeType: GOOGLE_DOC }, 'exported body');

    const outcome = await sync.syncNow(mm);
    assert.equal(outcome.added, 1);
    assert.equal(fake.exportCalls, 1, 'a Google-native document must be exported, not downloaded');

    const rows = await adminSql<{ file_type: string; exported_mime: string | null }[]>`
      select f.file_type, g.exported_mime
        from google_drive_files g join drive_files f on f.id = g.file_id
       where g.external_id = 'gd-native'
    `;
    assert.equal(rows[0]!.file_type, 'docx');
    assert.equal(rows[0]!.exported_mime, DOCX_MIME);
  });

  it('records an unsupported file with a reason instead of pretending it worked', async () => {
    await connect(mm, MM_FOLDER);
    fake.put(MM_FOLDER, { id: 'gd-image', name: 'logo.png', mimeType: 'image/png' }, 'notadocument');

    const outcome = await sync.syncNow(mm);
    assert.equal(outcome.unsupported, 1);
    assert.equal(outcome.added, 0);

    const rows = await adminSql<{ state: string; reason: string | null; file_id: string | null }[]>`
      select state, reason, file_id from google_drive_files where external_id = 'gd-image'
    `;
    assert.equal(rows[0]!.state, 'unsupported');
    assert.ok(rows[0]!.reason, 'an unsupported file must say why');
    assert.equal(rows[0]!.file_id, null, 'an unsupported file must not become a knowledge record');
  });

  it('walks every page of a large folder', async () => {
    await connect(mm, MM_FOLDER);
    // More than one page: pagination is a claim worth testing.
    for (let i = 0; i < 105; i += 1) {
      fake.put(
        MM_FOLDER,
        { id: `gd-page-${i}`, name: `note-${i}.txt`, mimeType: 'text/plain', md5Checksum: `md5-${i}` },
        `note number ${i}`,
      );
    }

    const outcome = await sync.syncNow(mm);
    assert.equal(outcome.scanned, 105, 'the sync stopped before the end of the folder');
    assert.equal(outcome.added, 105);
    assert.ok(outcome.pages >= 2, `expected more than one page, saw ${outcome.pages}`);
  });
});

describe('change detection', () => {
  it('a second sync of an unchanged folder does no work at all', async () => {
    await connect(mm, MM_FOLDER);
    fake.put(
      MM_FOLDER,
      { id: 'gd-stable', name: 'stable.txt', mimeType: 'text/plain', md5Checksum: 'md5-stable' },
      'unchanging content',
    );

    await sync.syncNow(mm);
    const downloadsAfterFirst = fake.downloadCalls;

    const second = await sync.syncNow(mm);
    assert.equal(second.unchanged, 1);
    assert.equal(second.added, 0);
    assert.equal(second.updated, 0);
    assert.equal(fake.downloadCalls, downloadsAfterFirst, 'an unchanged file was downloaded again');

    // and it did not duplicate the knowledge record
    const rows = await adminSql<{ n: number }[]>`
      select count(*)::int n from drive_files
       where company_id = ${mm.companyId} and source_type = 'google_drive'
    `;
    assert.equal(rows[0]!.n, 1);
  });

  it('a modified file is reprocessed, and only that file', async () => {
    await connect(mm, MM_FOLDER);
    fake.put(MM_FOLDER, { id: 'gd-a', name: 'a.txt', mimeType: 'text/plain', md5Checksum: 'md5-a' }, 'first version');
    fake.put(MM_FOLDER, { id: 'gd-b', name: 'b.txt', mimeType: 'text/plain', md5Checksum: 'md5-b' }, 'untouched');

    await sync.syncNow(mm);
    await extractAll();

    const before = await adminSql<{ id: string; processing_status: string }[]>`
      select f.id, f.processing_status from drive_files f
        join google_drive_files g on g.file_id = f.id
       where g.external_id = 'gd-a'
    `;
    assert.equal(before[0]!.processing_status, 'processed');

    fake.edit(MM_FOLDER, 'gd-a', 'second version, quite different');
    const outcome = await sync.syncNow(mm);

    assert.equal(outcome.updated, 1);
    assert.equal(outcome.unchanged, 1, 'the untouched file should not have been reprocessed');

    const after = await adminSql<{ id: string; processing_status: string }[]>`
      select f.id, f.processing_status from drive_files f
        join google_drive_files g on g.file_id = f.id
       where g.external_id = 'gd-a'
    `;
    // Same knowledge record, put back in the queue rather than duplicated.
    assert.equal(after[0]!.id, before[0]!.id);
    assert.equal(after[0]!.processing_status, 'pending');

    // Re-extraction replaces the old extraction, so chunks and embeddings are
    // rebuilt for this file and no other.
    await extractAll();
    const chunks = await adminSql<{ content: string }[]>`
      select c.content from drive_file_chunks c
        join google_drive_files g on g.file_id = c.file_id
       where g.external_id = 'gd-a'
    `;
    assert.ok(chunks.some((c) => c.content.includes('second version')), 'the chunks were not rebuilt');
    assert.ok(!chunks.some((c) => c.content.includes('first version')), 'stale chunks survived');
  });

  it('a trashed file is archived, not deleted', async () => {
    await connect(mm, MM_FOLDER);
    fake.put(MM_FOLDER, { id: 'gd-bin', name: 'bin.txt', mimeType: 'text/plain', md5Checksum: 'md5-bin' }, 'body');
    await sync.syncNow(mm);
    await extractAll();

    fake.trash(MM_FOLDER, 'gd-bin');
    const outcome = await sync.syncNow(mm);
    assert.equal(outcome.removed, 1);

    const rows = await adminSql<{ archived_at: Date | null; state: string }[]>`
      select f.archived_at, g.state from drive_files f
        join google_drive_files g on g.file_id = f.id
       where g.external_id = 'gd-bin'
    `;
    assert.ok(rows[0]!.archived_at, 'a trashed file should be archived');
    assert.equal(rows[0]!.state, 'trashed');

    // The audit history survives: the extraction is still there.
    const extractions = await adminSql<{ n: number }[]>`
      select count(*)::int n from drive_file_extractions e
        join google_drive_files g on g.file_id = e.file_id
       where g.external_id = 'gd-bin'
    `;
    assert.ok(extractions[0]!.n > 0, 'the extraction history was destroyed');
  });

  it('a file removed from the folder entirely is archived too', async () => {
    await connect(mm, MM_FOLDER);
    fake.put(MM_FOLDER, { id: 'gd-gone', name: 'gone.txt', mimeType: 'text/plain', md5Checksum: 'md5-gone' }, 'body');
    await sync.syncNow(mm);

    fake.remove(MM_FOLDER, 'gd-gone');
    const outcome = await sync.syncNow(mm);
    assert.equal(outcome.removed, 1);

    const rows = await adminSql<{ archived_at: Date | null; state: string }[]>`
      select f.archived_at, g.state from drive_files f
        join google_drive_files g on g.file_id = f.id
       where g.external_id = 'gd-gone'
    `;
    assert.ok(rows[0]!.archived_at);
    assert.equal(rows[0]!.state, 'trashed');
  });

  it('syncing twice in a row is idempotent', async () => {
    await connect(mm, MM_FOLDER);
    for (let i = 0; i < 3; i += 1) {
      fake.put(
        MM_FOLDER,
        { id: `gd-idem-${i}`, name: `idem-${i}.txt`, mimeType: 'text/plain', md5Checksum: `md5-i-${i}` },
        `body ${i}`,
      );
    }

    await sync.syncNow(mm);
    await sync.syncNow(mm);
    await sync.syncNow(mm);

    const rows = await adminSql<{ n: number }[]>`
      select count(*)::int n from drive_files
       where company_id = ${mm.companyId} and source_type = 'google_drive'
    `;
    assert.equal(rows[0]!.n, 3, 'repeated syncs duplicated the knowledge records');
  });
});

describe('errors are handled rather than swallowed', () => {
  it('one unreadable file does not abandon the rest of the folder', async () => {
    await connect(mm, MM_FOLDER);
    fake.put(MM_FOLDER, { id: 'gd-ok-1', name: 'one.txt', mimeType: 'text/plain', md5Checksum: 'm1' }, 'one');
    fake.put(MM_FOLDER, { id: 'gd-bad', name: 'bad.txt', mimeType: 'text/plain', md5Checksum: 'm2' }, 'two');
    fake.put(MM_FOLDER, { id: 'gd-ok-2', name: 'three.txt', mimeType: 'text/plain', md5Checksum: 'm3' }, 'three');

    // One file cannot be fetched. The listing is fine, so the sync should carry
    // on and ingest the other two rather than giving up on the folder.
    fake.failFetchFor.add('gd-bad');

    const outcome = await sync.syncNow(mm);
    assert.equal(outcome.failed, 1);
    assert.equal(outcome.added, 2, 'the other files should still have been ingested');

    const failed = await adminSql<{ reason: string | null }[]>`
      select reason from google_drive_files where state = 'failed' and company_id = ${mm.companyId}
    `;
    assert.ok(failed[0]!.reason, 'a failed file must record why');
  });

  it('an expired grant marks the connection for reconnection', async () => {
    await connect(mm, MM_FOLDER);

    // Force a refresh by expiring the stored token, then revoke the grant.
    await adminSql`
      update google_drive_connections set token_expires_at = now() - interval '1 hour'
       where company_id = ${mm.companyId}
    `;
    fake.refreshRevoked = true;

    await assert.rejects(() => sync.syncNow(mm), /reconnect/i);

    const dto = await connection.getConnection(mm);
    assert.equal(dto.status, 'needs_reauth');
    // The dead access token is cleared rather than left lying around.
    const rows = await adminSql<{ access: string | null }[]>`
      select access_token_encrypted as access from google_drive_connections
       where company_id = ${mm.companyId}
    `;
    assert.equal(rows[0]!.access, null);
  });

  it('refreshes a token that is about to expire and carries on', async () => {
    await connect(mm, MM_FOLDER);
    fake.put(MM_FOLDER, { id: 'gd-refresh', name: 'r.txt', mimeType: 'text/plain', md5Checksum: 'mr' }, 'body');

    await adminSql`
      update google_drive_connections set token_expires_at = now() - interval '1 hour'
       where company_id = ${mm.companyId}
    `;

    const outcome = await sync.syncNow(mm);
    assert.equal(fake.refreshCalls, 1, 'an expiring token should have been refreshed');
    assert.equal(outcome.added, 1);
    assert.equal((await connection.getConnection(mm)).status, 'connected');
  });

  it('refuses to sync when nothing is connected', async () => {
    await assert.rejects(() => sync.syncNow(nh), /no google drive is connected/i);
  });

  it('refuses to sync a connection with no folder chosen', async () => {
    await connection.saveTokens(nh, await fake.exchangeCode());
    await assert.rejects(() => sync.syncNow(nh), /choose a folder/i);
    await connection.disconnect(nh);
  });
});

describe('the sync worker leases a connection', () => {
  it('claims a connection that is due and releases it afterwards', async () => {
    await connect(mm, MM_FOLDER);
    fake.put(MM_FOLDER, { id: 'gd-job', name: 'job.txt', mimeType: 'text/plain', md5Checksum: 'mj' }, 'body');

    const claim = await jobs.claimConnectionForSync({ intervalMinutes: 0 });
    assert.ok(claim, 'nothing was claimable');
    assert.equal(claim!.companyId, mm.companyId);

    const outcome = await jobs.runClaimedSync(claim!);
    assert.equal(outcome.status, 'synced');

    const rows = await adminSql<{ sync_claimed_until: Date | null }[]>`
      select sync_claimed_until from google_drive_connections where company_id = ${mm.companyId}
    `;
    assert.equal(rows[0]!.sync_claimed_until, null, 'the lease was not released');
  });

  it('a claimed connection is not handed to a second worker', async () => {
    await connect(mm, MM_FOLDER);

    const first = await jobs.claimConnectionForSync({ intervalMinutes: 0 });
    assert.ok(first);
    const second = await jobs.claimConnectionForSync({ intervalMinutes: 0 });
    assert.equal(second, null, 'the same connection was claimed twice');

    await jobs.runClaimedSync(first!);
  });
});

describe('one company cannot reach another', () => {
  it('THE TEST: a company never sees another company Google Drive files', async () => {
    await connect(mm, MM_FOLDER);
    await connect(nh, NH_FOLDER);

    fake.put(
      NH_FOLDER,
      { id: 'nh-consent', name: 'Consent policy', mimeType: 'text/plain', md5Checksum: 'md5-nh' },
      'Patient consent must be signed before any real patient appears in a film.',
    );
    fake.put(
      MM_FOLDER,
      { id: 'mm-brief', name: 'Diwali brief', mimeType: 'text/plain', md5Checksum: 'md5-mm' },
      'A brief about lanterns and warmth.',
    );

    await sync.syncNow(nh);
    await sync.syncNow(mm);

    // Searching for the wording that exists only in the other company's synced
    // file must find nothing.
    const mmLooksForTheirs = await drive.search(mm, 'Consent');
    assert.equal(mmLooksForTheirs.files.length, 0, 'Magic Moments reached a Narayana Health file');

    const nhLooksForOurs = await drive.search(nh, 'Diwali');
    assert.equal(nhLooksForOurs.files.length, 0, 'Narayana Health reached a Magic Moments file');

    // And each finds its own, so this proves isolation rather than a search
    // that returns nothing to anybody.
    const mmOwn = await drive.search(mm, 'Diwali');
    assert.ok(mmOwn.files.some((f) => f.sourceType === 'google_drive'), 'the owner cannot find its own synced file');

    const nhOwn = await drive.search(nh, 'Consent');
    assert.ok(nhOwn.files.some((f) => f.sourceType === 'google_drive'), 'the owner cannot find its own synced file');
  });

  it('a company cannot see another company connection or its folder', async () => {
    await connect(mm, MM_FOLDER);

    const theirs = await connection.getConnection(nh);
    assert.equal(theirs.status, 'disconnected');
    assert.equal(theirs.folderId, null, 'a company saw another company folder');
  });

  it('syncing as one company never touches the other company folder', async () => {
    await connect(mm, MM_FOLDER);
    fake.put(NH_FOLDER, { id: 'nh-secret', name: 'secret.txt', mimeType: 'text/plain', md5Checksum: 'ms' }, 'secret');

    // Magic Moments syncs. Its folder is its own; Narayana's is untouched.
    const outcome = await sync.syncNow(mm);
    assert.equal(outcome.scanned, 0, 'the sync read a folder that was not this company');

    const rows = await adminSql<{ n: number }[]>`
      select count(*)::int n from google_drive_files where external_id = 'nh-secret'
    `;
    assert.equal(rows[0]!.n, 0);
  });

  it('an external file id from another company resolves to nothing', async () => {
    await connect(mm, MM_FOLDER);
    await connect(nh, NH_FOLDER);
    fake.put(NH_FOLDER, { id: 'nh-only', name: 'theirs.txt', mimeType: 'text/plain', md5Checksum: 'mo' }, 'theirs');
    await sync.syncNow(nh);

    // Magic Moments knows the external id. Under its own scope it finds nothing.
    const seen = await appSql.begin(async (tx) => {
      await tx`select set_config('cip.company_id', ${mm.companyId}, true)`;
      return tx`select id from google_drive_files where external_id = 'nh-only'`;
    });
    assert.equal(seen.length, 0);
  });

  it('the same document in two companies stays two independent records', async () => {
    await connect(mm, MM_FOLDER);
    await connect(nh, NH_FOLDER);

    // The same Google file id shared into both folders.
    fake.put(MM_FOLDER, { id: 'shared-doc', name: 'shared.txt', mimeType: 'text/plain', md5Checksum: 'msh' }, 'shared');
    fake.put(NH_FOLDER, { id: 'shared-doc', name: 'shared.txt', mimeType: 'text/plain', md5Checksum: 'msh' }, 'shared');

    await sync.syncNow(mm);
    await sync.syncNow(nh);

    const rows = await adminSql<{ company_id: string }[]>`
      select company_id from google_drive_files where external_id = 'shared-doc'
    `;
    assert.equal(rows.length, 2, 'the unique key should be per company, not global');
    assert.notEqual(rows[0]!.company_id, rows[1]!.company_id);
  });
});

describe('row-level security and composite ownership', () => {
  it('with no company set, the integration tables are empty', async () => {
    await connect(mm, MM_FOLDER);
    const connections = await appSql`select id from google_drive_connections limit 10`;
    const files = await appSql`select id from google_drive_files limit 10`;
    assert.equal(connections.length, 0, 'policies must fail closed with no company set');
    assert.equal(files.length, 0, 'policies must fail closed with no company set');
  });

  it('row-level security refuses a connection written for another company', async () => {
    await assert.rejects(
      () =>
        appSql.begin(async (tx) => {
          await tx`select set_config('cip.company_id', ${mm.companyId}, true)`;
          return tx`
            insert into google_drive_connections (company_id, status)
            values (${nh.companyId}, 'connected')
          `;
        }),
      /row-level security/i,
    );
  });

  it('the composite key refuses a synced file whose connection belongs elsewhere', async () => {
    await connect(nh, NH_FOLDER);
    const theirs = await adminSql<{ id: string }[]>`
      select id from google_drive_connections where company_id = ${nh.companyId}
    `;

    await assert.rejects(
      () =>
        adminSql`
          insert into google_drive_files
            (company_id, connection_id, external_id, name, external_mime)
          values
            (${mm.companyId}, ${theirs[0]!.id}, 'forged', 'forged.txt', 'text/plain')
        `,
      /violates foreign key constraint/i,
    );
  });

  it('every synced record sits in the same company as its connection and its file', async () => {
    const rows = await adminSql<{ n: number }[]>`
      select count(*)::int n
        from google_drive_files g
        join google_drive_connections c on c.id = g.connection_id
        left join drive_files f on f.id = g.file_id
       where c.company_id <> g.company_id
          or (f.id is not null and f.company_id <> g.company_id)
    `;
    assert.equal(rows[0]!.n, 0);
  });
});

describe('the Company Drive is unchanged', () => {
  it('an uploaded file is still labelled as a manual upload', async () => {
    const uploaded = await drive.uploadFile(mm, {
      folderId: null,
      filename: 'still-works.txt',
      mimeType: 'text/plain',
      body: Buffer.from('An ordinary upload, exactly as before.'),
    });

    assert.equal(uploaded.sourceType, 'cip_drive');

    const rows = await adminSql<{ source_type: string }[]>`
      select source_type from drive_files where id = ${uploaded.id}
    `;
    assert.equal(rows[0]!.source_type, 'cip_drive');
  });

  it('search returns both sources, each saying where it came from', async () => {
    await connect(mm, MM_FOLDER);
    fake.put(
      MM_FOLDER,
      { id: 'gd-mixed', name: 'synced-note.txt', mimeType: 'text/plain', md5Checksum: 'mx' },
      'a synced note',
    );
    await sync.syncNow(mm);

    await drive.uploadFile(mm, {
      folderId: null,
      filename: 'uploaded-note.txt',
      mimeType: 'text/plain',
      body: Buffer.from('an uploaded note'),
    });

    const results = await drive.search(mm, 'note');
    const sources = new Set(results.files.map((f) => f.sourceType));
    assert.ok(sources.has('cip_drive'), 'uploads are missing from search');
    assert.ok(sources.has('google_drive'), 'synced files are missing from search');
  });
});

describe('a file larger than the object store can hold', () => {
  // The real case: two 52.84 MB country decks against a 50 MB object store
  // limit that cannot be raised on this plan. They used to be recorded as
  // failed and skipped entirely, which is the one outcome that helps nobody.

  it('is read anyway, and only the original goes unkept', async () => {
    await connect(mm, MM_FOLDER);

    // Smaller than the store's limit in the test environment, so the limit is
    // driven down to meet it rather than a 50 MB fixture being built.
    process.env.CIP_STORAGE_MAX_OBJECT_BYTES = '64';
    try {
      fake.put(
        MM_FOLDER,
        { id: 'gd-big', name: 'India.pdf', mimeType: 'application/pdf', md5Checksum: 'md5-big' },
        Buffer.alloc(200, 0x41),
      );

      const outcome = await sync.syncNow(mm);
      assert.equal(outcome.added, 1, 'an oversize file must still be ingested');
      assert.equal(outcome.tooLarge, 0, 'it is within what we can read, so it is not too large');

      const rows = await adminSql<
        { name: string; bytes_retained: boolean; storage_path: string | null; file_size: string }[]
      >`
        select name, bytes_retained, storage_path, file_size from drive_files
         where company_id = ${mm.companyId} and name = 'India.pdf'
      `;
      const row = rows[0]!;
      assert.equal(row.bytes_retained, false, 'the bytes are too large to keep');
      assert.equal(row.storage_path, null, 'a file we did not keep must not claim a storage key');
      assert.equal(Number(row.file_size), 200, 'the real size is still recorded');
    } finally {
      delete process.env.CIP_STORAGE_MAX_OBJECT_BYTES;
    }
  });

  it('is not claimed by the extractor, which has no bytes to read', async () => {
    await connect(mm, MM_FOLDER);
    process.env.CIP_STORAGE_MAX_OBJECT_BYTES = '64';
    try {
      fake.put(
        MM_FOLDER,
        { id: 'gd-big2', name: 'nigeria.pdf', mimeType: 'application/pdf', md5Checksum: 'md5-big2' },
        Buffer.alloc(200, 0x42),
      );
      await sync.syncNow(mm);

      // The queue must pass over it rather than claiming it and failing on a
      // storage key that was never written. Other files in the folder are
      // claimed as usual, which is the point: only this one is skipped.
      await extractAll();

      const rows = await adminSql<{ processing_status: string; processing_attempts: number }[]>`
        select processing_status, processing_attempts from drive_files
         where company_id = ${mm.companyId} and name = 'nigeria.pdf'
      `;
      assert.equal(rows[0]!.processing_status, 'pending', 'the extractor should have passed over it');
      assert.equal(rows[0]!.processing_attempts, 0, 'it must not even have been attempted');
    } finally {
      delete process.env.CIP_STORAGE_MAX_OBJECT_BYTES;
    }
  });

  it('past what CIP can read in one piece, is reported with both numbers', async () => {
    await connect(mm, MM_FOLDER);
    process.env.CIP_GDRIVE_MAX_FILE_BYTES = '100';
    try {
      fake.put(
        MM_FOLDER,
        { id: 'gd-huge', name: 'enormous.pdf', mimeType: 'application/pdf', md5Checksum: 'md5-huge' },
        Buffer.alloc(500, 0x43),
      );

      const outcome = await sync.syncNow(mm);
      assert.equal(outcome.tooLarge, 1);
      assert.equal(outcome.failed, 0, 'our own limit is not a failure');

      const rows = await adminSql<
        { state: string; reason: string; external_size: string; limit_bytes: string | null }[]
      >`
        select state, reason, external_size, limit_bytes from google_drive_files
         where company_id = ${mm.companyId} and name = 'enormous.pdf'
      `;
      const row = rows[0]!;
      assert.equal(row.state, 'too_large', 'too large is its own state, not a failure');
      assert.equal(Number(row.external_size), 500, 'the measured size is recorded');
      assert.equal(Number(row.limit_bytes), 100, 'so is the limit that rejected it');
      assert.match(row.reason, /over the/, 'and the reason says both');

      // Never silently skipped: nothing was ingested, and the record says why.
      const files = await adminSql<{ n: number }[]>`
        select count(*)::int n from drive_files
         where company_id = ${mm.companyId} and name = 'enormous.pdf'
      `;
      assert.equal(files[0]!.n, 0);
    } finally {
      delete process.env.CIP_GDRIVE_MAX_FILE_BYTES;
    }
  });

  it('is declined before it is downloaded', async () => {
    await connect(mm, MM_FOLDER);
    process.env.CIP_GDRIVE_MAX_FILE_BYTES = '100';
    try {
      fake.put(
        MM_FOLDER,
        { id: 'gd-huge2', name: 'huge2.pdf', mimeType: 'application/pdf', md5Checksum: 'm2' },
        Buffer.alloc(500, 0x44),
      );

      const before = fake.downloadCalls;
      await sync.syncNow(mm);
      assert.equal(
        fake.downloadCalls,
        before,
        'a file we will refuse must not be fetched in order to refuse it',
      );
    } finally {
      delete process.env.CIP_GDRIVE_MAX_FILE_BYTES;
    }
  });
});

describe('what a sync reports about a file it ingested', () => {
  it('does not call a queued file part of the Knowledge Layer', async () => {
    await connect(mm, MM_FOLDER);
    fake.put(
      MM_FOLDER,
      { id: 'gd-queued', name: 'waiting.txt', mimeType: 'text/plain', md5Checksum: 'md5-q' },
      'Something worth reading later.',
    );
    await sync.syncNow(mm);

    const listed = await connection.listSyncedFiles(mm, {});
    const row = listed.find((f) => f.name === 'waiting.txt')!;

    // The sync did its part, and nothing has read the file yet. Those are two
    // different facts and the row now carries both.
    assert.equal(row.state, 'synced');
    assert.ok(row.progress, 'a file that became a CIP file must report its progress');
    assert.equal(row.progress!.status, 'queued', 'nothing has read it yet');
    assert.equal(row.progress!.retained, true);
  });

  it('reports it ready once the pipeline has actually finished with it', async () => {
    await connect(mm, MM_FOLDER);
    fake.put(
      MM_FOLDER,
      { id: 'gd-done', name: 'finished.txt', mimeType: 'text/plain', md5Checksum: 'md5-d' },
      'Our brand voice is warm, unhurried and specific about the occasion.',
    );
    await sync.syncNow(mm);
    await extractAll();
    await understandAll();

    const listed = await connection.listSyncedFiles(mm, {});
    const row = listed.find((f) => f.name === 'finished.txt')!;
    assert.equal(row.progress!.status, 'ready');
  });

  it('carries the measured size and the limit for a file it refused', async () => {
    await connect(mm, MM_FOLDER);
    process.env.CIP_GDRIVE_MAX_FILE_BYTES = '100';
    try {
      fake.put(
        MM_FOLDER,
        { id: 'gd-big3', name: 'toobig.pdf', mimeType: 'application/pdf', md5Checksum: 'm3' },
        Buffer.alloc(400, 0x45),
      );
      await sync.syncNow(mm);

      const listed = await connection.listSyncedFiles(mm, {});
      const row = listed.find((f) => f.name === 'toobig.pdf')!;
      assert.equal(row.state, 'too_large');
      assert.equal(row.sizeBytes, 400);
      assert.equal(row.limitBytes, 100);
      assert.equal(row.progress, null, 'it never became a CIP file, so it has no progress');
    } finally {
      delete process.env.CIP_GDRIVE_MAX_FILE_BYTES;
    }
  });
});

describe('syncing twice changes nothing the second time', () => {
  it('does not duplicate rows, downloads or understanding', async () => {
    await connect(mm, MM_FOLDER);
    fake.put(
      MM_FOLDER,
      { id: 'gd-idem', name: 'stable.txt', mimeType: 'text/plain', md5Checksum: 'md5-stable' },
      'This document does not change.',
    );

    await sync.syncNow(mm);
    await extractAll();
    await understandAll();

    const downloadsAfterFirst = fake.downloadCalls;

    const second = await sync.syncNow(mm);
    assert.equal(second.unchanged, 1, 'an unchanged file should be recognised as unchanged');
    assert.equal(second.added, 0);
    assert.equal(second.updated, 0);
    assert.equal(
      fake.downloadCalls,
      downloadsAfterFirst,
      'an unchanged file must not be downloaded again',
    );

    const counts = await adminSql<{ files: number; understandings: number }[]>`
      select (select count(*) from drive_files
               where company_id = ${mm.companyId} and name = 'stable.txt')::int as files,
             (select count(*) from asset_understanding u
                join drive_files f on f.id = u.file_id
               where f.company_id = ${mm.companyId} and f.name = 'stable.txt')::int as understandings
    `;
    assert.equal(counts[0]!.files, 1, 'a second sync duplicated the file');
    assert.equal(counts[0]!.understandings, 1, 'a second sync duplicated the understanding');
  });

  it('reprocesses only the file that actually changed', async () => {
    await connect(mm, MM_FOLDER);
    fake.put(MM_FOLDER, { id: 'gd-a', name: 'a.txt', mimeType: 'text/plain', md5Checksum: 'a1' }, 'first');
    fake.put(MM_FOLDER, { id: 'gd-b', name: 'b.txt', mimeType: 'text/plain', md5Checksum: 'b1' }, 'second');
    await sync.syncNow(mm);
    await extractAll();

    fake.put(MM_FOLDER, { id: 'gd-a', name: 'a.txt', mimeType: 'text/plain', md5Checksum: 'a2' }, 'first, revised');

    const outcome = await sync.syncNow(mm);
    assert.equal(outcome.updated, 1);
    assert.equal(outcome.unchanged, 1);

    const rows = await adminSql<{ name: string; processing_status: string }[]>`
      select name, processing_status from drive_files
       where company_id = ${mm.companyId} and name in ('a.txt', 'b.txt') order by name
    `;
    assert.equal(rows[0]!.processing_status, 'pending', 'the changed file is queued again');
    assert.equal(rows[1]!.processing_status, 'processed', 'the unchanged one is left alone');
  });
});

describe('the queue moves without anybody running a worker', () => {
  it('a sync leaves work that the pump then completes', async () => {
    await connect(mm, MM_FOLDER);
    fake.put(
      MM_FOLDER,
      { id: 'gd-pump', name: 'pumped.txt', mimeType: 'text/plain', md5Checksum: 'md5-pump' },
      'Warm, celebratory, and never about the alcohol itself.',
    );
    await sync.syncNow(mm);

    const before = await adminSql<{ processing_status: string }[]>`
      select processing_status from drive_files
       where company_id = ${mm.companyId} and name = 'pumped.txt'
    `;
    assert.equal(before[0]!.processing_status, 'pending', 'a sync enqueues rather than processes');

    const { pumpQueues } = await import('../src/server/jobs/pump');
    const tally = await pumpQueues();
    assert.ok(tally.extracted > 0, 'the pump read nothing');

    const after = await adminSql<{ processing_status: string }[]>`
      select processing_status from drive_files
       where company_id = ${mm.companyId} and name = 'pumped.txt'
    `;
    assert.equal(after[0]!.processing_status, 'processed');
  });

  it('two pumps at once do the work once', async () => {
    await connect(mm, MM_FOLDER);
    for (let i = 0; i < 3; i += 1) {
      fake.put(
        MM_FOLDER,
        { id: `gd-race-${i}`, name: `race-${i}.txt`, mimeType: 'text/plain', md5Checksum: `r${i}` },
        `Document number ${i}, with enough words in it to be worth chunking at all.`,
      );
    }
    await sync.syncNow(mm);

    const { pumpQueues } = await import('../src/server/jobs/pump');
    const [a, b] = await Promise.all([pumpQueues(), pumpQueues()]);

    // The second call joins the first rather than starting a second pass, so
    // both see the same tally and nothing is claimed twice.
    assert.deepEqual(a, b, 'concurrent pumps should share one pass');

    const rows = await adminSql<{ n: number }[]>`
      select count(*)::int n from drive_files
       where company_id = ${mm.companyId} and name like 'race-%' and processing_status = 'processed'
    `;
    assert.equal(rows[0]!.n, 3);

    const extractions = await adminSql<{ n: number }[]>`
      select count(*)::int n from drive_file_extractions e
        join drive_files f on f.id = e.file_id
       where f.company_id = ${mm.companyId} and f.name like 'race-%'
    `;
    assert.equal(extractions[0]!.n, 3, 'a file was extracted more than once');
  });
});
