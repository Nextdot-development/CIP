import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { adminSql } from './db-admin';

/**
 * Applies every unapplied .sql file in ./migrations, in filename order, and
 * records what it ran. Each file executes in one implicit transaction, so a
 * failure part-way through a file leaves nothing behind.
 */
export async function migrate(log: (m: string) => void = console.log): Promise<string[]> {
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
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();

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

/** ALTER ROLE will not take a bind parameter, so the literal is escaped here. */
function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
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
