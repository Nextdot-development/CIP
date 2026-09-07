import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { adminSql } from './db-admin';

/**
 * Applies every unapplied .sql file in ./migrations, in filename order, and
 * records what it ran. Each file executes in one implicit transaction, so a
 * failure part-way through a file leaves nothing behind.
 */
export async function migrate(
  log: (m: string) => void = console.log,
  options: { upTo?: string } = {},
): Promise<string[]> {
  const sql = adminSql();
  const applied: string[] = [];

  try {
    await sql`
      create table if not exists _cip_migrations (
        name       text primary key,
        applied_at timestamptz not null default now()
      )
    `;

    const dir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
    let files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();

    // `upTo` exists for one reason: migration 0007 needs pgvector, and the
    // PostgreSQL the offline tests run against does not have it. Phase 1-3
    // tests stop at the last migration their database can apply rather than
    // failing on an extension they never use.
    if (options.upTo) {
      const cut = files.indexOf(options.upTo);
      if (cut === -1) throw new Error(`upTo names a migration that does not exist: ${options.upTo}`);
      files = files.slice(0, cut + 1);
    }

    const done = await sql<{ name: string }[]>`select name from _cip_migrations`;
    const already = new Set(done.map((r) => r.name));

    for (const file of files) {
      if (already.has(file)) {
        log(`  skip  ${file}`);
        continue;
      }
      const body = await readFile(join(dir, file), 'utf8');
      await sql.unsafe(body).simple();
      await sql`insert into _cip_migrations (name) values (${file})`;
      log(`  apply ${file}`);
      applied.push(file);
    }

    // The cip_app role is created without a password so no secret sits in a
    // committed .sql file. Set it here, from the environment, every run.
    const appPassword = process.env.CIP_APP_DB_PASSWORD;
    if (appPassword) {
      await sql`select 1 from pg_roles where rolname = 'cip_app'`.then(async (rows) => {
        if (rows.length > 0) {
          await sql.unsafe(`alter role cip_app with password ${literal(appPassword)}`);
          log('  set   cip_app password from CIP_APP_DB_PASSWORD');
        }
      });
    } else {
      log('  warn  CIP_APP_DB_PASSWORD is not set — cip_app has no password yet');
    }

    return applied;
  } finally {
    await sql.end();
  }
}

/**
 * Undoes the most recently applied migrations, newest first.
 *
 * Every migration has a matching file in migrations/down/. A migration with no
 * down file cannot be rolled back, and this refuses rather than leaving the
 * schema half-undone.
 *
 * Note that rolling back 0003 drops the cip_app role, which the running
 * application connects as — stop the app first.
 */
export async function rollback(steps = 1, log: (m: string) => void = console.log): Promise<string[]> {
  const sql = adminSql();
  const undone: string[] = [];

  try {
    const dir = join(dirname(fileURLToPath(import.meta.url)), 'migrations', 'down');
    const available = new Set(
      await readdir(dir).catch(() => [] as string[]),
    );

    const applied = await sql<{ name: string }[]>`
      select name from _cip_migrations order by name desc limit ${steps}
    `;

    if (applied.length === 0) {
      log('  nothing to roll back');
      return undone;
    }

    // Check every step before running any of them.
    for (const row of applied) {
      if (!available.has(row.name)) {
        throw new Error(
          `${row.name} has no down migration (expected migrations/down/${row.name}). ` +
            'Refusing to roll back part-way.',
        );
      }
    }

    for (const row of applied) {
      const body = await readFile(join(dir, row.name), 'utf8');
      await sql.unsafe(body).simple();
      await sql`delete from _cip_migrations where name = ${row.name}`;
      log(`  undo  ${row.name}`);
      undone.push(row.name);
    }

    return undone;
  } finally {
    await sql.end();
  }
}

/** ALTER ROLE will not take a bind parameter, so the literal is escaped here. */
function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  const stepsArg = process.argv.find((a) => a.startsWith('--steps='));
  const steps = stepsArg ? Number(stepsArg.split('=')[1]) : 1;

  if (process.argv.includes('--down')) {
    console.log(`Rolling back ${steps} migration(s)...`);
    rollback(steps)
      .then((undone) => {
        console.log(undone.length ? `Done — ${undone.length} rolled back.` : 'Nothing to do.');
        process.exit(0);
      })
      .catch((err) => {
        console.error('Rollback failed:', err instanceof Error ? err.message : err);
        process.exit(1);
      });
  } else {
  console.log('Running migrations...');
  migrate()
    .then((applied) => {
      console.log(applied.length ? `Done — ${applied.length} applied.` : 'Done — already up to date.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('Migration failed:', err instanceof Error ? err.message : err);
      process.exit(1);
    });
  }
}
