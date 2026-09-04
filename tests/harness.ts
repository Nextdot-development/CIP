import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';

/**
 * A throwaway PostgreSQL for the test run.
 *
 * Point TEST_DATABASE_ADMIN_URL at a real server (Supabase, or a local one) to
 * test against that instead; otherwise a real PostgreSQL is started on a free
 * port and thrown away afterwards, so `npm test` needs no setup.
 */
export type TestDb = {
  adminUrl: string;
  appUrl: string;
  appPassword: string;
  stop: () => Promise<void>;
};

const APP_PASSWORD = 'test-app-password';

export async function startTestDatabase(): Promise<TestDb> {
  const external = process.env.TEST_DATABASE_ADMIN_URL;
  if (external) {
    const appUrl = new URL(external);
    appUrl.username = 'cip_app';
    appUrl.password = APP_PASSWORD;
    return {
      adminUrl: external,
      appUrl: appUrl.toString(),
      appPassword: APP_PASSWORD,
      stop: async () => {},
    };
  }

  const dir = mkdtempSync(join(tmpdir(), 'cip-test-pg-'));
  const port = 50000 + Math.floor(Math.random() * 5000);
  const pg = new EmbeddedPostgres({
    databaseDir: join(dir, 'data'),
    user: 'cip_admin',
    password: 'cip_admin',
    port,
    persistent: false,
  });

  await pg.initialise();
  await pg.start();
  await pg.createDatabase('cip_test');

  return {
    adminUrl: `postgres://cip_admin:cip_admin@localhost:${port}/cip_test`,
    appUrl: `postgres://cip_app:${APP_PASSWORD}@localhost:${port}/cip_test`,
    appPassword: APP_PASSWORD,
    stop: async () => {
      await pg.stop();
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* Windows sometimes holds the directory briefly; it is a temp dir */
      }
    },
  };
}
