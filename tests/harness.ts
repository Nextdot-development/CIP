import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';

/**
 * Ask the operating system for a port nobody is using.
 *
 * Picking one at random looked fine and then wedged the suite: a collision
 * makes PostgreSQL fail to bind, and the run hangs instead of failing.
 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('Could not work out a free port'));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

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
  const port = await freePort();
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
