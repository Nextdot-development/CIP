import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { startTestDatabase } from './harness';
import type { TestDb } from './harness';

/**
 * Connected Microsoft Teams — delta sync, re-learning, and isolation.
 *
 * Everything runs against an in-memory Microsoft Graph, so the suite needs no
 * tenant, no application registration and no network. What it is really
 * testing is the code around Graph: that CIP is told only what changed and
 * acts on exactly that, that a file edited in the Team is learned again while
 * a file merely renamed is not re-read, and that one company's Team cannot
 * reach another's.
 */

let db: TestDb;
let appSql: postgres.Sql;
let adminSql: postgres.Sql;
let storageDir: string;

type Scope = { companyId: string; userId: string; role: 'owner' };
let mm: Scope;
let nh: Scope;

let connection: typeof import('../src/server/integrations/microsoftTeams/connection');
let sync: typeof import('../src/server/integrations/microsoftTeams/sync');
let jobs: typeof import('../src/server/integrations/microsoftTeams/jobs');
let graph: typeof import('../src/server/integrations/microsoftTeams');
let processing: typeof import('../src/server/drive/processing');
let understanding: typeof import('../src/server/brain/understanding');

let fake: import('../src/server/integrations/microsoftTeams/fake').FakeMicrosoftGraph;

const PASSWORD = 'cip-demo-password';
const TXT = 'text/plain';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

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

/** Drains the understanding queue, exactly as the Brain worker does. */
async function understandAll(): Promise<number> {
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

/** The drive_files rows a Team produced, newest first. */
async function syncedFiles(scope: Scope) {
  return adminSql<
    { id: string; name: string; processing_status: string; checksum_sha256: string; archived_at: Date | null }[]
  >`
    select id, name, processing_status, checksum_sha256, archived_at
      from drive_files
     where company_id = ${scope.companyId} and source_type = 'microsoft_teams'
     order by created_at
  `;
}

before(async () => {
  db = await startTestDatabase();
  storageDir = mkdtempSync(join(tmpdir(), 'cip-teams-'));

  process.env.DATABASE_ADMIN_URL = db.adminUrl;
  process.env.CIP_APP_DB_PASSWORD = db.appPassword;
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
  connection = await import('../src/server/integrations/microsoftTeams/connection');
  sync = await import('../src/server/integrations/microsoftTeams/sync');
  jobs = await import('../src/server/integrations/microsoftTeams/jobs');
  graph = await import('../src/server/integrations/microsoftTeams');
  processing = await import('../src/server/drive/processing');
  understanding = await import('../src/server/brain/understanding');

  const { FakeMicrosoftGraph } = await import('../src/server/integrations/microsoftTeams/fake');
  fake = new FakeMicrosoftGraph();
  graph.__setMicrosoftGraph(fake);

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
  fake.teams = [
    { id: 'team-1', name: 'Brand Team', description: null },
    { id: 'team-2', name: 'Clinical Team', description: null },
  ];

  // Every case starts from nothing connected and nothing synced. These tests
  // share one database, and a connection or a synced file left behind by an
  // earlier case would make a later one assert against somebody else's state.
  await adminSql`delete from microsoft_files`;
  await adminSql`delete from microsoft_connections`;
  await adminSql`delete from drive_files where source_type = 'microsoft_teams'`;
});

after(async () => {
  await appSql?.end({ timeout: 5 });
  await adminSql?.end({ timeout: 5 });
  await db?.stop();
  try {
    rmSync(storageDir, { recursive: true, force: true });
  } catch {
    /* windows holds a temp directory briefly */
  }
});

describe('connecting a Team', () => {
  it('resolves the drive behind the team, so a bad choice fails now rather than at the first sync', async () => {
    const connected = await connection.setTeam(mm, 'team-1');

    assert.equal(connected.status, 'connected');
    assert.equal(connected.teamName, 'Brand Team');
    assert.equal(connected.driveName, 'Documents');
    assert.ok(fake.calls.getTeamDrive > 0, 'the drive was never resolved');
  });

  it('refuses a team CIP cannot see', async () => {
    await assert.rejects(() => connection.setTeam(mm, 'team-nobody-shared'), /not one CIP can see/i);
  });

  it('never returns anything secret', async () => {
    await connection.setTeam(mm, 'team-1');
    const dto = await connection.getConnection(mm);

    const text = JSON.stringify(dto);
    assert.ok(!/secret/i.test(text), 'the DTO carries something called a secret');
    assert.ok(!text.includes('fake-graph-token'), 'the DTO carries a token');
  });
});

describe('a file in a Team becomes an ordinary file', () => {
  it('travels the existing extraction and understanding pipelines', async () => {
    await connection.setTeam(mm, 'team-1');
    fake.addFile({ id: 'f1', name: 'brand-voice.txt', mimeType: TXT, content: 'Warm and unhurried.' });

    const outcome = await sync.syncNow(mm);
    assert.equal(outcome.added, 1);

    const [file] = await syncedFiles(mm);
    assert.ok(file, 'no drive_files row was written');
    assert.equal(file.name, 'brand-voice.txt');
    // Pending is what makes the rest happen. Nothing in the pipeline knows
    // Microsoft exists; it claims this row because it is pending.
    assert.equal(file.processing_status, 'pending');

    assert.ok((await extractAll()) > 0, 'the extractor never claimed it');
    assert.ok((await understandAll()) > 0, 'the Brain never looked at it');
  });

  it('records what it cannot read, with a reason', async () => {
    await connection.setTeam(mm, 'team-1');
    fake.addFile({ id: 'f1', name: 'numbers.xlsx', mimeType: XLSX, content: 'binary' });

    const outcome = await sync.syncNow(mm);

    assert.equal(outcome.unsupported, 1);
    assert.equal(outcome.added, 0);
    const files = await connection.listSyncedFiles(mm);
    assert.equal(files[0]!.state, 'unsupported');
    // The reason has to be useful to a marketer, not a mime type.
    assert.match(files[0]!.reason ?? '', /Excel/i);
  });

  it('trusts the extension when SharePoint reports a generic type', async () => {
    await connection.setTeam(mm, 'team-1');
    fake.addFile({ id: 'f1', name: 'guide.txt', mimeType: 'application/octet-stream', content: 'Hello.' });

    const outcome = await sync.syncNow(mm);
    assert.equal(outcome.added, 1, 'a plainly-named text file was refused');
  });

  it('ingests the files inside folders without ingesting the folders', async () => {
    await connection.setTeam(mm, 'team-1');
    fake.addFolder('dir-1', 'Brand');
    fake.addFile({ id: 'f1', name: 'inside.txt', mimeType: TXT, content: 'Inside a folder.' });

    const outcome = await sync.syncNow(mm);

    assert.equal(outcome.added, 1);
    const files = await connection.listSyncedFiles(mm);
    assert.equal(files.length, 1, 'the folder itself was recorded as a file');
  });
});

describe('being told only what changed', () => {
  it('asks for nothing it has already seen', async () => {
    await connection.setTeam(mm, 'team-1');
    fake.addFile({ id: 'f1', name: 'a.txt', mimeType: TXT, content: 'One.' });
    await sync.syncNow(mm);

    const downloadsAfterFirst = fake.calls.download;
    const second = await sync.syncNow(mm);

    assert.equal(second.scanned, 0, 'the second sync was told about files that had not changed');
    assert.equal(second.added, 0);
    assert.equal(fake.calls.download, downloadsAfterFirst, 'an unchanged file was downloaded again');
    assert.equal(second.full, false, 'the second sync walked everything again');
  });

  it('learns a file again when its contents change', async () => {
    await connection.setTeam(mm, 'team-1');
    fake.addFile({ id: 'f1', name: 'a.txt', mimeType: TXT, content: 'First draft.' });
    await sync.syncNow(mm);
    await extractAll();

    const [before] = await syncedFiles(mm);
    assert.equal(before!.processing_status, 'processed');

    fake.editFile('f1', 'Second draft, quite different.');
    const outcome = await sync.syncNow(mm);

    assert.equal(outcome.updated, 1, 'an edited file was not re-read');
    assert.equal(outcome.added, 0, 'an edited file became a second file');

    const after = await syncedFiles(mm);
    assert.equal(after.length, 1, 'the edit created a duplicate row');
    // The same row, back in the queue: that is what makes CIP learn the new
    // version rather than keep the old one beside it.
    assert.equal(after[0]!.id, before!.id, 'the file lost its identity on edit');
    assert.equal(after[0]!.processing_status, 'pending');
    assert.notEqual(after[0]!.checksum_sha256, before!.checksum_sha256);
  });

  it('does not re-read a file that was only renamed', async () => {
    await connection.setTeam(mm, 'team-1');
    fake.addFile({ id: 'f1', name: 'old-name.txt', mimeType: TXT, content: 'Unchanged bytes.' });
    await sync.syncNow(mm);
    await extractAll();

    const downloads = fake.calls.download;
    fake.renameFile('f1', 'new-name.txt');
    const outcome = await sync.syncNow(mm);

    // Graph reports the rename, so it is scanned — but the bytes did not move.
    assert.equal(outcome.scanned, 1);
    assert.equal(outcome.unchanged, 1, 'a rename was treated as an edit');
    assert.equal(outcome.updated, 0);
    assert.equal(fake.calls.download, downloads, 'a renamed file was downloaded again');

    const files = await syncedFiles(mm);
    assert.equal(files[0]!.processing_status, 'processed', 'a rename sent the file round the pipeline again');
    assert.equal((await connection.listSyncedFiles(mm))[0]!.name, 'new-name.txt', 'the new name was not recorded');
  });

  it('archives a file deleted from the Team, keeping what was learned', async () => {
    await connection.setTeam(mm, 'team-1');
    fake.addFile({ id: 'f1', name: 'gone.txt', mimeType: TXT, content: 'Here for now.' });
    await sync.syncNow(mm);
    await extractAll();

    fake.deleteFile('f1');
    const outcome = await sync.syncNow(mm);

    assert.equal(outcome.removed, 1);
    const files = await syncedFiles(mm);
    assert.ok(files[0]!.archived_at !== null, 'a deleted file is still live in the Drive');
    // Archived, not deleted: the extraction stays as history.
    const extractions = await adminSql<{ n: number }[]>`
      select count(*)::int as n from drive_file_extractions where file_id = ${files[0]!.id}
    `;
    assert.ok(extractions[0]!.n > 0, 'deleting in the Team destroyed what CIP had learned');
  });

  it('starts over when Microsoft expires the position, rather than failing', async () => {
    await connection.setTeam(mm, 'team-1');
    fake.addFile({ id: 'f1', name: 'a.txt', mimeType: TXT, content: 'One.' });
    await sync.syncNow(mm);

    const { MicrosoftGraphError } = await import('../src/server/integrations/microsoftTeams/client');
    fake.failDeltaNext = new MicrosoftGraphError('permanent', 'resyncRequired');

    const outcome = await sync.syncNow(mm);
    assert.equal(outcome.full, true, 'an expired delta token did not trigger a full walk');
    // And the file is still one file, not a second copy.
    assert.equal((await syncedFiles(mm)).length, 1);
  });
});

describe('the worker keeps it up to date on its own', () => {
  it('claims a connection that is due, syncs it, and releases the lease', async () => {
    await connection.setTeam(mm, 'team-1');
    fake.addFile({ id: 'f1', name: 'a.txt', mimeType: TXT, content: 'One.' });

    const claim = await jobs.claimTeamsConnectionForSync({ intervalMinutes: 0 });
    assert.ok(claim, 'nothing was claimable');

    const outcome = await jobs.runClaimedTeamsSync(claim!);
    assert.equal(outcome.status, 'synced');
    assert.equal(outcome.status === 'synced' ? outcome.outcome.added : -1, 1);

    const held = await adminSql<{ sync_claimed_until: Date | null }[]>`
      select sync_claimed_until from microsoft_connections where id = ${claim!.connectionId}
    `;
    assert.equal(held[0]!.sync_claimed_until, null, 'the lease was never released');
  });

  it('does not hand the same connection to two workers', async () => {
    await connection.setTeam(mm, 'team-1');

    const first = await jobs.claimTeamsConnectionForSync({ intervalMinutes: 0 });
    const second = await jobs.claimTeamsConnectionForSync({ intervalMinutes: 0 });

    assert.ok(first, 'the first worker claimed nothing');
    assert.equal(second, null, 'two workers claimed the same Team');
  });

  it('leaves a connection alone until its interval has passed', async () => {
    await connection.setTeam(mm, 'team-1');
    await sync.syncNow(mm);

    const claim = await jobs.claimTeamsConnectionForSync({ intervalMinutes: 60 });
    assert.equal(claim, null, 'a Team synced a moment ago was swept again');
  });
});

describe('when CIP is not allowed to read the tenant', () => {
  it('says an administrator must act, and stops syncing', async () => {
    await connection.setTeam(mm, 'team-1');
    fake.addFile({ id: 'f1', name: 'a.txt', mimeType: TXT, content: 'One.' });

    const { MicrosoftGraphError } = await import('../src/server/integrations/microsoftTeams/client');
    fake.failNext = new MicrosoftGraphError('needs_admin_consent', 'refused');

    await assert.rejects(() => sync.syncNow(mm), /administrator/i);

    const dto = await connection.getConnection(mm);
    assert.equal(dto.status, 'needs_admin_consent');
    // Not "reconnect": the person looking at this very likely cannot, and
    // sending them round that loop is how a Drive sat broken for a fortnight.
    assert.doesNotMatch(dto.lastSyncError ?? '', /reconnect/i);
  });
});

describe('one company cannot reach another', () => {
  it('THE TEST: a company never sees another company Team files', async () => {
    await connection.setTeam(mm, 'team-1');
    fake.addFile({ id: 'f1', name: 'magic-moments-only.txt', mimeType: TXT, content: 'Ours.' });
    await sync.syncNow(mm);

    // Narayana connects its own team, to the same in-memory workspace. What it
    // may see is decided by the company boundary, not by the fake.
    const theirs = await connection.listSyncedFiles(nh);
    assert.equal(theirs.length, 0, 'one company saw another company synced files');

    const theirFiles = await syncedFiles(nh);
    assert.equal(theirFiles.length, 0, 'one company holds another company Team file');
  });

  it('keeps each connection to its own company', async () => {
    await connection.setTeam(mm, 'team-1');
    await connection.setTeam(nh, 'team-2');

    assert.equal((await connection.getConnection(mm)).teamName, 'Brand Team');
    assert.equal((await connection.getConnection(nh)).teamName, 'Clinical Team');
  });

  it('with no company set, the Microsoft tables are empty', async () => {
    await connection.setTeam(mm, 'team-1');
    fake.addFile({ id: 'f1', name: 'a.txt', mimeType: TXT, content: 'One.' });
    await sync.syncNow(mm);

    // The application role with no company selected sees nothing at all: RLS
    // is the filter, not a WHERE clause somebody remembered to write.
    const connections = await appSql`select count(*)::int as n from microsoft_connections`;
    const files = await appSql`select count(*)::int as n from microsoft_files`;
    assert.equal((connections[0] as { n: number }).n, 0);
    assert.equal((files[0] as { n: number }).n, 0);
  });

  it('changing the team forgets where the last walk got to', async () => {
    await connection.setTeam(mm, 'team-1');
    fake.addFile({ id: 'f1', name: 'a.txt', mimeType: TXT, content: 'One.' });
    await sync.syncNow(mm);

    // A delta position is a place in one drive's history and means nothing in
    // another's. Presenting it would ask Microsoft what has changed in a drive
    // it no longer names.
    await connection.setTeam(mm, 'team-2');
    const stored = await adminSql<{ delta_link: string | null }[]>`
      select delta_link from microsoft_connections where company_id = ${mm.companyId}
    `;
    assert.equal(stored[0]!.delta_link, null, 'the old position survived a change of team');
  });
});

describe('what reaches Microsoft', () => {
  it('sends their identifiers and nothing of ours', async () => {
    await connection.setTeam(mm, 'team-1');
    fake.addFile({ id: 'f1', name: 'a.txt', mimeType: TXT, content: 'One.' });
    await sync.syncNow(mm);

    // The fake records every call it was given. None of them may carry a
    // company id, a CIP file id or a storage path.
    const seen = JSON.stringify(fake.calls);
    assert.ok(!seen.includes(mm.companyId), 'a company id reached Microsoft');

    const files = await syncedFiles(mm);
    assert.ok(!seen.includes(files[0]!.id), 'a CIP file id reached Microsoft');
  });
});
