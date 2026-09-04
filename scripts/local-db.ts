import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';

/**
 * A local PostgreSQL for development, so the app runs without a Supabase
 * project. Data lives in ./.pgdata (gitignored) and survives restarts.
 *
 * Production points DATABASE_URL at Supabase instead; nothing else changes.
 */
const PORT = Number(process.env.CIP_LOCAL_DB_PORT ?? 55432);
const DIR = join(process.cwd(), '.pgdata');

async function main() {
  mkdirSync(DIR, { recursive: true });

  const pg = new EmbeddedPostgres({
    databaseDir: join(DIR, 'data'),
    user: 'cip_admin',
    password: 'cip_admin',
    port: PORT,
    persistent: true,
  });

  try {
    await pg.initialise();
  } catch {
    // Already initialised from a previous run.
  }
  await pg.start();
  try {
    await pg.createDatabase('cip');
  } catch {
    // Already exists.
  }

  console.log('');
  console.log('  Local PostgreSQL is running.');
  console.log('');
  console.log('  Put these in .env.local:');
  console.log(`    DATABASE_ADMIN_URL=postgres://cip_admin:cip_admin@localhost:${PORT}/cip`);
  console.log(`    DATABASE_URL=postgres://cip_app:local-dev-password@localhost:${PORT}/cip`);
  console.log('    CIP_APP_DB_PASSWORD=local-dev-password');
  console.log('');
  console.log('  Then: npm run db:reset');
  console.log('  Leave this window open. Ctrl+C stops the database.');

  const stop = async () => {
    await pg.stop();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  await new Promise(() => {});
}

main().catch((err) => {
  console.error('Could not start the local database:', err instanceof Error ? err.message : err);
  process.exit(1);
});
