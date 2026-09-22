import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { Resolver, promises as dnsPromises } from 'node:dns';
import { promisify } from 'node:util';

const { lookup } = dnsPromises;
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
  /** Whether this database can create the pgvector extension. */
  hasVector: boolean;
  /** Migrations this database cannot run, for migrate({ skip }). */
  skipMigrations: readonly string[];
  stop: () => Promise<void>;
};

/**
 * Migration 0007 installs pgvector. The embedded PostgreSQL used for offline
 * tests does not ship it, so a database without it stops at 0006 and the
 * Phase 4 suites skip with a reason rather than failing on a missing
 * extension deep inside a migration.
 */
export const MIGRATIONS_NEEDING_VECTOR = ['0007_embeddings.sql'] as const;

/**
 * Replaces the hostname in a connection URL with a literal address.
 *
 * The machine this is developed on resolves the Supabase host only
 * intermittently — it is AAAA-only, and the system resolver times out for
 * minutes at a time while a public resolver answers immediately with the same
 * address. Whether the Phase 4 isolation tests run at all should not depend on
 * that, so the harness asks a public resolver when the system one fails and
 * connects to the address it gets back.
 *
 * Only ever applied to TEST_DATABASE_ADMIN_URL, and only after the system
 * resolver has already failed.
 */
async function withResolvedHost(url: string): Promise<string> {
  const parsed = new URL(url);
  const host = parsed.hostname;
  try {
    await lookup(host);
    return url;
  } catch {
    const resolver = new Resolver();
    resolver.setServers(['1.1.1.1', '8.8.8.8']);
    // IPv4 only. postgres.js splits its host string on ':' to find a port, so
    // an IPv6 literal is torn in half and the connection fails with a NaN port
    // — worse than the timeout this is trying to avoid. If the host has no A
    // record, hand back the original URL and let the real error surface.
    const resolve4 = promisify(resolver.resolve4.bind(resolver));
    try {
      const [address] = (await resolve4(host)) as string[];
      if (address) {
        parsed.hostname = address;
        return parsed.toString();
      }
    } catch {
      /* no A record, or the public resolver is unreachable too */
    }
    return url;
  }
}

async function detectVector(url: string, required: boolean): Promise<boolean> {
  const sql = postgres(url, { max: 1, connect_timeout: 15, onnotice: () => {} });
  try {
    const rows = await sql<{ name: string }[]>`
      select name from pg_available_extensions where name = 'vector'
    `;
    return rows.length > 0;
  } catch (error) {
    // Reporting "no pgvector" for what is actually an unreachable host sends
    // whoever reads it chasing the wrong problem.
    if (required) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Could not reach TEST_DATABASE_ADMIN_URL: ${detail}`);
    }
    return false;
  } finally {
    await sql.end().catch(() => {});
  }
}


/**
 * Closes the pool that src/server/db.ts opens on import.
 *
 * Test files open their own connections and close them, but importing any
 * service module also creates the application's module-level pool, and nothing
 * was closing that. Its idle connections keep the event loop alive, so the
 * process finishes every test and then simply never exits — which reads as a
 * hung suite even though nothing failed.
 *
 * Only closes a pool that was actually created: a suite that imported no
 * service module has none, and importing db.ts here just to close it would
 * create the very thing being cleaned up.
 */
async function closeApplicationPool(): Promise<void> {
  const pool = (globalThis as { __cipSql?: { end: (o?: { timeout?: number }) => Promise<void> } }).__cipSql;
  if (!pool) return;
  try {
    // A connection stuck mid-query must not be able to block teardown for ever.
    await pool.end({ timeout: 5 });
  } catch {
    /* already closed, or refused to close; the process is going away anyway */
  }
  (globalThis as { __cipSql?: unknown }).__cipSql = undefined;
}

const APP_PASSWORD = 'test-app-password';

/**
 * Swaps the role in a connection URL, keeping anything the pooler needs.
 *
 * Supabase's pooler reads the tenant out of the username: the admin user is
 * "postgres.<project-ref>", not "postgres". Setting the username to a bare
 * "cip_app" dropped the project ref with it, and every test that touched the
 * database died on connect with "(ENOIDENTIFIER) no tenant identifier provided
 * (external_id or sni_hostname required)" — 122 of them, which read as the
 * suite being broken rather than as one string being built wrong.
 *
 * The suffix is whatever followed the first dot, so a plain "postgres" on a
 * local or embedded server becomes a plain "cip_app" exactly as before.
 */
function asRole(url: string, role: string): URL {
  const next = new URL(url);
  const [, ...tenant] = decodeURIComponent(next.username).split('.');
  next.username = tenant.length > 0 ? `${role}.${tenant.join('.')}` : role;
  return next;
}

export async function startTestDatabase(): Promise<TestDb> {
  const external = process.env.TEST_DATABASE_ADMIN_URL;
  if (external) {
    // PostgreSQL roles are cluster-wide, so cip_app is shared with whatever
    // else lives on this server. Reuse its real password rather than setting
    // a test one, or migrating a test database would lock the running
    // application out of the production database on the same cluster.
    const appPassword = process.env.CIP_APP_DB_PASSWORD ?? APP_PASSWORD;
    const appUrl = asRole(external, 'cip_app');
    appUrl.password = appPassword;
    // Resolve once, then use the same address for both roles, so the admin and
    // application connections cannot end up pointed at different servers.
    const adminUrl = await withResolvedHost(external);
    appUrl.hostname = new URL(adminUrl).hostname;
    const hasVector = await detectVector(adminUrl, true);
    return {
      adminUrl,
      appUrl: appUrl.toString(),
      appPassword,
      hasVector,
      skipMigrations: hasVector ? [] : MIGRATIONS_NEEDING_VECTOR,
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

  const adminUrl = `postgres://cip_admin:cip_admin@localhost:${port}/cip_test`;
  const hasVector = await detectVector(adminUrl, false);

  return {
    adminUrl,
    appUrl: `postgres://cip_app:${APP_PASSWORD}@localhost:${port}/cip_test`,
    appPassword: APP_PASSWORD,
    hasVector,
    skipMigrations: hasVector ? [] : MIGRATIONS_NEEDING_VECTOR,
    stop: async () => {
      await closeApplicationPool();
      try {
        await pg.stop();
      } catch {
        // embedded-postgres removes its own data directory as it stops, and on
        // Windows those files are still locked for a moment after the server
        // exits: "EBUSY: resource busy or locked, rmdir ...\\data". The server
        // is down either way, and this throws from an after hook, so a suite
        // whose every test passed was reported as failed - twice in one run,
        // which is exactly how a real failure goes unnoticed.
      }
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* Windows sometimes holds the directory briefly; it is a temp dir */
      }
    },
  };
}
