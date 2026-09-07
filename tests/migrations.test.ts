import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
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
/** Read from disk, so adding a migration does not break these tests. */
const MIGRATION_DIR = join(process.cwd(), 'src', 'server', 'migrations');
const upFiles = () => readdirSync(MIGRATION_DIR).filter((f) => f.endsWith('.sql')).sort();
let rollback: typeof import('../src/server/migrate')['rollback'];

const DRIVE_COLUMNS = async () =>
  (
    await sql<{ column_name: string }[]>`
      select column_name from information_schema.columns
       where table_name = 'drive_files' order by column_name
    `
  ).map((r) => r.column_name);

/**
 * The migrations this database can actually run.
 *
 * 0007 installs pgvector, which the embedded PostgreSQL does not ship, so on
 * such a database the chain stops at the last migration before it. Everything
 * below is written against this rather than the directory listing, so the same
 * assertions hold in both places and neither one quietly tests less than it
 * claims.
 */
const chain = () => {
  const all = upFiles();
  if (!db.migrateUpTo) return all;
  const stop = all.indexOf(db.migrateUpTo);
  return stop === -1 ? all : all.slice(0, stop + 1);
};

const applyChain = () => migrate(() => {}, { upTo: db.migrateUpTo });

/**
 * Every column of every table, as one comparable list.
 *
 * Rolling a migration back has to change the schema and rolling it forward has
 * to restore it exactly. Watching drive_files alone only worked while the
 * newest migration happened to touch drive_files — 0007 touches
 * drive_file_chunks and drive_file_embeddings, so that assumption stopped
 * holding the moment Phase 4 landed. The whole schema cannot go stale that way.
 */
const schemaFingerprint = async () =>
  (
    await sql<{ entry: string }[]>`
      select table_name || '.' || column_name || ':' || data_type as entry
        from information_schema.columns
       where table_schema = 'public'
       order by entry
    `
  ).map((r) => r.entry);

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
    const expected = chain();
    const applied = await applyChain();
    assert.deepEqual(applied, expected, 'not every migration was applied');

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

  it('rolls the newest migration back and forward, restoring the schema', async () => {
    const before = await schemaFingerprint();
    const newest = chain().at(-1)!;

    await rollback(1, () => {});
    const reverted = await schemaFingerprint();
    assert.notDeepEqual(reverted, before, `${newest} down migration changed nothing`);

    await applyChain();
    assert.deepEqual(await schemaFingerprint(), before, 'schema did not come back identical');
  });

  it('every migration has a down file', () => {
    const downs = new Set(
      readdirSync(join(MIGRATION_DIR, 'down')).filter((f) => f.endsWith('.sql')),
    );
    for (const up of upFiles()) {
      assert.ok(downs.has(up), `${up} has no down migration`);
    }
  });

  it('refuses to roll back a migration with no down file', async () => {
    // 0003 has a down file, so remove it from the equation by asserting the
    // guard fires for a name that has none.
    await sql`insert into _cip_migrations (name) values ('9999_no_down_file.sql')`;
    await assert.rejects(() => rollback(1, () => {}), /has no down migration/i);
    await sql`delete from _cip_migrations where name = '9999_no_down_file.sql'`;
  });

  it('unwinds the entire chain, leaving no CIP tables behind', async () => {
    await rollback(chain().length, () => {});

    const tables = await tableNames();
    for (const t of ['drive_file_chunks', 'drive_file_extractions', 'drive_files', 'drive_folders',
                     'companies', 'users', 'memberships', 'sessions']) {
      assert.ok(!tables.includes(t), `${t} survived the rollback`);
    }

    const roles = await sql<{ rolname: string }[]>`select rolname from pg_roles where rolname = 'cip_app'`;
    assert.equal(roles.length, 0, 'the cip_app role survived the rollback');

    // and it all comes back
    const reapplied = await applyChain();
    assert.deepEqual(reapplied, chain());
    const back = await tableNames();
    assert.ok(back.includes('drive_files'));
    assert.ok(back.includes('drive_file_chunks'));
  });
});
