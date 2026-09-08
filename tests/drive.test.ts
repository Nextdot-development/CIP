import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { startTestDatabase } from './harness';
import type { TestDb } from './harness';

/**
 * Company Drive — behaviour and isolation.
 *
 * The isolation half is written from the attacker's side: a real Magic Moments
 * session holding a real Narayana Health id, doing everything the API allows.
 * Every one of those must come back as "not found", never as data and never as
 * a distinguishable "forbidden".
 */

let db: TestDb;
let appSql: postgres.Sql;
let adminSql: postgres.Sql;
let storageDir: string;

type Scope = { companyId: string; userId: string; role: 'owner' | 'admin' | 'member' | 'viewer' };
let mm: Scope;
let nh: Scope;

let drive: typeof import('../src/server/drive/service');

const PASSWORD = 'cip-demo-password';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

before(async () => {
  db = await startTestDatabase();
  storageDir = mkdtempSync(join(tmpdir(), 'cip-test-storage-'));

  process.env.DATABASE_ADMIN_URL = db.adminUrl;
  process.env.CIP_APP_DB_PASSWORD = db.appPassword;
  process.env.SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.CIP_SEED_PASSWORD = PASSWORD;
  process.env.CIP_STORAGE_DIR = storageDir;
  // Keep this suite on disk even when Supabase credentials are in the shell,
  // so it stays deterministic and needs no network.
  process.env.CIP_FORCE_LOCAL_STORAGE = 'true';

  const { migrate } = await import('../src/server/migrate');
  await migrate(() => {}, { skip: db.skipMigrations });
  const { seed } = await import('../src/server/seed');
  await seed(() => {});

  process.env.DATABASE_URL = db.appUrl;
  drive = await import('../src/server/drive/service');

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

describe('folders', () => {
  it('creates a folder at the root and lists it', async () => {
    const folder = await drive.createFolder(mm, null, 'Brand Assets');
    assert.equal(folder.name, 'Brand Assets');
    assert.equal(folder.parentId, null);

    const listing = await drive.listFolder(mm, null);
    assert.ok(listing.folders.some((f) => f.id === folder.id));
    assert.deepEqual(listing.breadcrumbs, [{ id: null, name: 'Drive' }]);
  });

  it('nests folders and builds breadcrumbs in order', async () => {
    const top = await drive.createFolder(mm, null, 'Campaigns');
    const mid = await drive.createFolder(mm, top.id, '2026');
    const leaf = await drive.createFolder(mm, mid.id, 'Diwali');

    const listing = await drive.listFolder(mm, leaf.id);
    assert.deepEqual(
      listing.breadcrumbs.map((b) => b.name),
      ['Drive', 'Campaigns', '2026', 'Diwali'],
    );
    assert.equal(listing.folder?.id, leaf.id);
  });

  it('refuses two live folders with the same name in one place', async () => {
    await drive.createFolder(mm, null, 'Duplicates');
    await assert.rejects(() => drive.createFolder(mm, null, 'duplicates'), /already here/i);
  });

  it('renames a folder', async () => {
    const f = await drive.createFolder(mm, null, 'Old Name');
    const renamed = await drive.renameFolder(mm, f.id, 'New Name');
    assert.equal(renamed.name, 'New Name');
  });

  it('archiving a folder archives everything inside it', async () => {
    const top = await drive.createFolder(mm, null, 'To Archive');
    const child = await drive.createFolder(mm, top.id, 'Child');
    await drive.uploadFile(mm, { folderId: child.id, filename: 'deep.png', mimeType: 'image/png', body: PNG });

    await drive.archiveFolder(mm, top.id);

    const root = await drive.listFolder(mm, null);
    assert.ok(!root.folders.some((f) => f.id === top.id), 'archived folder still listed');
    await assert.rejects(() => drive.listFolder(mm, child.id), /could not be found/i);

    const archived = await drive.listArchived(mm);
    assert.ok(archived.some((f) => f.name === 'deep.png'), 'nested file was not archived');
  });

  it('will not place a folder inside itself', async () => {
    const f = await drive.createFolder(mm, null, 'Self Parent');
    await assert.rejects(
      () => adminSql`update drive_folders set parent_id = id where id = ${f.id}`,
      /inside itself/i,
    );
  });
});

describe('files', () => {
  it('uploads, lists, downloads and reports pending processing', async () => {
    const folder = await drive.createFolder(mm, null, 'Uploads');
    const file = await drive.uploadFile(mm, {
      folderId: folder.id,
      filename: 'logo.png',
      mimeType: 'image/png',
      body: PNG,
    });

    assert.equal(file.name, 'logo.png');
    assert.equal(file.kind, 'image');
    assert.equal(file.fileSize, PNG.length);
    // The ingestion pipeline has not been built; everything waits in the queue.
    assert.equal(file.processingStatus, 'pending');

    const listing = await drive.listFolder(mm, folder.id);
    assert.equal(listing.files.length, 1);
    assert.equal(listing.files[0]!.id, file.id);

    const download = await drive.readFile(mm, file.id);
    assert.deepEqual(download.body, PNG, 'downloaded bytes differ from what was uploaded');
    assert.equal(download.filename, 'logo.png');
  });

  it('refuses a file type that is not on the list', async () => {
    await assert.rejects(
      () => drive.uploadFile(mm, { folderId: null, filename: 'payload.exe', mimeType: 'application/x-msdownload', body: PNG }),
      /cannot store/i,
    );
    await assert.rejects(
      () => drive.uploadFile(mm, { folderId: null, filename: 'script.html', mimeType: 'text/html', body: PNG }),
      /cannot store/i,
    );
  });

  it('refuses an empty file', async () => {
    await assert.rejects(
      () => drive.uploadFile(mm, { folderId: null, filename: 'empty.txt', mimeType: 'text/plain', body: Buffer.alloc(0) }),
      /empty/i,
    );
  });

  it('ignores a lying Content-Type and trusts the extension', async () => {
    const file = await drive.uploadFile(mm, {
      folderId: null,
      filename: 'honest.png',
      mimeType: 'text/html',
      body: PNG,
    });
    assert.equal(file.mimeType, 'image/png');
  });

  it('strips a path out of an uploaded filename', async () => {
    const file = await drive.uploadFile(mm, {
      folderId: null,
      filename: '../../../etc/passwd.txt',
      mimeType: 'text/plain',
      body: Buffer.from('hello'),
    });
    assert.equal(file.name, 'passwd.txt');
  });

  it('renames a file and keeps its extension', async () => {
    const file = await drive.uploadFile(mm, {
      folderId: null, filename: 'before.txt', mimeType: 'text/plain', body: Buffer.from('x'),
    });
    const renamed = await drive.renameFile(mm, file.id, 'after');
    assert.equal(renamed.name, 'after.txt');

    const sneaky = await drive.renameFile(mm, file.id, 'after.exe');
    assert.equal(sneaky.name, 'after.exe.txt', 'renaming must not change the stored type');
  });

  it('archives, restores and permanently deletes', async () => {
    const file = await drive.uploadFile(mm, {
      folderId: null, filename: 'temp.txt', mimeType: 'text/plain', body: Buffer.from('bye'),
    });

    await drive.archiveFile(mm, file.id);
    await assert.rejects(() => drive.readFile(mm, file.id), /could not be found/i);
    assert.ok((await drive.listArchived(mm)).some((f) => f.id === file.id));

    await drive.restoreFile(mm, file.id);
    assert.ok((await drive.readFile(mm, file.id)).body.equals(Buffer.from('bye')));

    await drive.deleteFileForever(mm, file.id);
    await assert.rejects(() => drive.readFile(mm, file.id), /could not be found/i);
  });
});

describe('search', () => {
  it('finds files and folders by name, scoped to the company', async () => {
    const folder = await drive.createFolder(mm, null, 'Searchable Campaign');
    await drive.uploadFile(mm, {
      folderId: folder.id, filename: 'searchable-brief.txt', mimeType: 'text/plain', body: Buffer.from('brief'),
    });
    await drive.uploadFile(nh, {
      folderId: null, filename: 'searchable-secret.txt', mimeType: 'text/plain', body: Buffer.from('secret'),
    });

    const results = await drive.search(mm, 'searchable');
    assert.ok(results.folders.some((f) => f.name === 'Searchable Campaign'));
    assert.ok(results.files.some((f) => f.name === 'searchable-brief.txt'));
    assert.ok(
      !results.files.some((f) => f.name === 'searchable-secret.txt'),
      'search crossed into another company',
    );
  });

  it('filters by kind', async () => {
    await drive.uploadFile(mm, {
      folderId: null, filename: 'kindfilter.png', mimeType: 'image/png', body: PNG,
    });
    await drive.uploadFile(mm, {
      folderId: null, filename: 'kindfilter.txt', mimeType: 'text/plain', body: Buffer.from('t'),
    });

    const images = await drive.search(mm, 'kindfilter', 'image');
    assert.equal(images.files.length, 1);
    assert.equal(images.files[0]!.fileType, 'png');
  });

  it('treats a wildcard in the query as a literal', async () => {
    await drive.uploadFile(mm, {
      folderId: null, filename: 'one-hundred-percent.txt', mimeType: 'text/plain', body: Buffer.from('x'),
    });
    // If % leaked through as a wildcard this would match everything.
    const results = await drive.search(mm, '%%%');
    assert.equal(results.files.length, 0);
  });
});

describe('one company cannot reach another', () => {
  let nhFolder: Awaited<ReturnType<typeof drive.createFolder>>;
  let nhFile: Awaited<ReturnType<typeof drive.uploadFile>>;

  before(async () => {
    nhFolder = await drive.createFolder(nh, null, 'Patient Consent Forms');
    nhFile = await drive.uploadFile(nh, {
      folderId: nhFolder.id,
      filename: 'consent-scan.pdf',
      mimeType: 'application/pdf',
      body: Buffer.from('%PDF-1.4 confidential'),
    });
  });

  it('1. cannot list the other company files', async () => {
    const listing = await drive.listFolder(mm, null);
    const names = [...listing.folders.map((f) => f.name), ...listing.files.map((f) => f.name)];
    assert.ok(!names.includes('Patient Consent Forms'));
    assert.ok(!names.includes('consent-scan.pdf'));
  });

  it('2. cannot open the other company folder by its real id', async () => {
    await assert.rejects(() => drive.listFolder(mm, nhFolder.id), /could not be found/i);
  });

  it('3. cannot download the other company file by its real id', async () => {
    await assert.rejects(() => drive.readFile(mm, nhFile.id), /could not be found/i);
  });

  it('4. cannot rename or delete the other company file', async () => {
    await assert.rejects(() => drive.renameFile(mm, nhFile.id, 'stolen.pdf'), /could not be found/i);
    await assert.rejects(() => drive.archiveFile(mm, nhFile.id), /could not be found/i);
    await assert.rejects(() => drive.deleteFileForever(mm, nhFile.id), /could not be found/i);
    await assert.rejects(() => drive.renameFolder(mm, nhFolder.id, 'stolen'), /could not be found/i);
    await assert.rejects(() => drive.archiveFolder(mm, nhFolder.id), /could not be found/i);

    // and it is all still there, untouched
    const still = await drive.readFile(nh, nhFile.id);
    assert.equal(still.filename, 'consent-scan.pdf');
  });

  it('5. cannot upload into the other company folder', async () => {
    await assert.rejects(
      () => drive.uploadFile(mm, {
        folderId: nhFolder.id, filename: 'planted.txt', mimeType: 'text/plain', body: Buffer.from('x'),
      }),
      /could not be found/i,
    );
    await assert.rejects(
      () => drive.createFolder(mm, nhFolder.id, 'planted folder'),
      /could not be found/i,
    );
  });

  it('5b. the database refuses a row whose company_id is forged', async () => {
    // The service has no parameter for this, so it is attempted directly —
    // this is what a compromised or careless query would look like.
    await assert.rejects(
      () => appSql.begin(async (tx) => {
        await tx`select set_config('cip.company_id', ${mm.companyId}, true)`;
        return tx`
          insert into drive_files (company_id, name, original_filename, file_type, mime_type,
                                   file_size, storage_path)
          values (${nh.companyId}, 'planted.txt', 'planted.txt', 'txt', 'text/plain', 1,
                  ${'companies/' + nh.companyId + '/planted'})
        `;
      }),
      /row-level security/i,
    );
  });

  it('5c. the composite key refuses a file parented into another company', async () => {
    // Even bypassing row-level security entirely, referential integrity holds.
    await assert.rejects(
      () => adminSql`
        insert into drive_files (company_id, folder_id, name, original_filename, file_type,
                                 mime_type, file_size, storage_path)
        values (${mm.companyId}, ${nhFolder.id}, 'crossed.txt', 'crossed.txt', 'txt',
                'text/plain', 1, ${'companies/' + mm.companyId + '/crossed'})
      `,
      /foreign key|violates/i,
    );
  });


  it('12. cannot reach the other company storage object', async () => {
    // The object store itself is deliberately dumb — it knows keys, not
    // companies. The gate is the drive_files row, which is under row-level
    // security, so the question that matters is whether company A can ever
    // come into possession of company B key.
    const [row] = await adminSql<{ storage_path: string }[]>`
      select storage_path from drive_files where id = ${nhFile.id}
    `;
    assert.ok(row, 'expected the Narayana file to exist');

    // Nothing the API returns carries a storage key.
    const listing = JSON.stringify(await drive.listFolder(mm, null));
    const searched = JSON.stringify(await drive.search(mm, 'consent'));
    const archived = JSON.stringify(await drive.listArchived(mm));
    for (const payload of [listing, searched, archived]) {
      assert.ok(!payload.includes('storage_path') && !payload.includes('storagePath'),
        'a storage key was exposed to the client');
      assert.ok(!payload.includes(row.storage_path), 'the other company storage path leaked');
    }

    // And the one path that reads bytes refuses first, so the key is never used.
    await assert.rejects(() => drive.readFile(mm, nhFile.id), /could not be found/i);

    // The key names its owning company, so even a leaked key is auditable.
    assert.ok(row.storage_path.startsWith(`companies/${nh.companyId}/`));
    assert.ok(!row.storage_path.includes(mm.companyId));
  });

  it('13. a forged scope for a company with no membership sees nothing', async () => {
    // The worst case: someone who can call the service directly and invents a
    // scope. Scopes only ever come from a verified session, but if one were
    // fabricated for a company that does not exist, it still yields nothing.
    const forged = { companyId: '00000000-0000-0000-0000-000000000000', userId: mm.userId, role: 'owner' as const };
    const listing = await drive.listFolder(forged, null);
    assert.equal(listing.folders.length, 0);
    assert.equal(listing.files.length, 0);
    await assert.rejects(() => drive.readFile(forged, nhFile.id), /could not be found/i);
    await assert.rejects(() => drive.listFolder(forged, nhFolder.id), /could not be found/i);
  });

  it('8. an unscoped query returns nothing, and a scoped one stays in its lane', async () => {
    const nothing = await appSql`select name from drive_files`;
    assert.equal(nothing.length, 0, 'policies must fail closed with no company set');

    const scoped = (await appSql.begin(async (tx) => {
      await tx`select set_config('cip.company_id', ${mm.companyId}, true)`;
      // deliberately no WHERE clause — this is what a future bug looks like
      return tx<{ name: string }[]>`select name from drive_files`;
    })) as { name: string }[];

    assert.ok(scoped.length > 0, 'expected Magic Moments to have files');
    assert.ok(
      !scoped.some((r) => r.name === 'consent-scan.pdf'),
      'an unfiltered query leaked the other company',
    );
  });

  it('the storage key of every file names its owning company', async () => {
    const rows = await adminSql<{ company_id: string; storage_path: string }[]>`
      select company_id, storage_path from drive_files
    `;
    for (const row of rows) {
      assert.ok(
        row.storage_path.startsWith(`companies/${row.company_id}/`),
        `storage path ${row.storage_path} does not sit under its company`,
      );
    }
  });
});
