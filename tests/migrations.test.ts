import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { startTestDatabase } from './harness';
import type { TestDb } from './harness';

/**
 * Migrations must go both ways.
 *
 * A migration you cannot reverse is a migration you cannot deploy with
 * confidence, so this walks the whole chain down and back up again and checks
 * the schema comes back identical.
 */

let db: TestDb;
let sql: postgres.Sql;
let migrate: typeof import('../src/server/migrate')['migrate'];
let rollback: typeof import('../src/server/migrate')['rollback'];

const DRIVE_COLUMNS = async () =>
  (
    await sql<{ column_name: string }[]>`
      select column_name from information_schema.columns
       where table_name = 'drive_files' order by column_name
    `
  ).map((r) => r.column_name);

const tableNames = async () =>
  (
    await sql<{ tablename: string }[]>`
      select tablename from pg_tables where schemaname = 'public' order by tablename
    `
  ).map((r) => r.tablename);

before(async () => {
  db = await startTestDatabase();
  process.env.DATABASE_ADMIN_URL = db.adminUrl;
  process.env.CIP_APP_DB_PASSWORD = db.appPassword;
  ({ migrate, rollback } = await import('../src/server/migrate'));
  sql = postgres(db.adminUrl, { onnotice: () => {} });
}, { timeout: 180_000 });

after(async () => {
  await sql?.end();
  await db?.stop();
});

describe('migrations run forwards and backwards', () => {
  it('applies the whole chain', async () => {
    const applied = await migrate(() => {});
    assert.equal(applied.length, 5, 'expected five migrations');

    const tables = await tableNames();
    for (const t of ['companies', 'users', 'memberships', 'sessions', 'drive_folders', 'drive_files']) {
      assert.ok(tables.includes(t), `${t} was not created`);
    }
  });

  it('0005 leaves drive_files with the settled column names', async () => {
    const columns = await DRIVE_COLUMNS();
    for (const wanted of ['original_filename', 'file_type', 'file_size', 'storage_path', 'uploaded_by']) {
      assert.ok(columns.includes(wanted), `missing ${wanted}`);
    }
    for (const gone of ['original_name', 'extension', 'size_bytes', 'storage_key', 'created_by']) {
      assert.ok(!columns.includes(gone), `${gone} should have been renamed away`);
    }
  });

  it('rolls 0005 back and forward again, restoring the same columns', async () => {
    const before = await DRIVE_COLUMNS();

    await rollback(1, () => {});
    const reverted = await DRIVE_COLUMNS();
    assert.ok(reverted.includes('storage_key'), 'down migration did not restore the old name');
    assert.ok(!reverted.includes('storage_path'));

    await migrate(() => {});
    assert.deepEqual(await DRIVE_COLUMNS(), before, 'schema did not come back identical');
  });

  it('refuses to roll back a migration with no down file', async () => {
    // 0003 has a down file, so remove it from the equation by asserting the
    // guard fires for a name that has none.
    await sql`insert into _cip_migrations (name) values ('9999_no_down_file.sql')`;
    await assert.rejects(() => rollback(1, () => {}), /has no down migration/i);
    await sql`delete from _cip_migrations where name = '9999_no_down_file.sql'`;
  });

  it('unwinds the entire chain, leaving no CIP tables behind', async () => {
    await rollback(5, () => {});

    const tables = await tableNames();
    for (const t of ['drive_files', 'drive_folders', 'companies', 'users', 'memberships', 'sessions']) {
      assert.ok(!tables.includes(t), `${t} survived the rollback`);
    }

    const roles = await sql<{ rolname: string }[]>`select rolname from pg_roles where rolname = 'cip_app'`;
    assert.equal(roles.length, 0, 'the cip_app role survived the rollback');

    // and it all comes back
    const reapplied = await migrate(() => {});
    assert.equal(reapplied.length, 5);
    assert.ok((await tableNames()).includes('drive_files'));
  });
});
