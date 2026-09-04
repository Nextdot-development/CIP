import 'server-only';
import postgres from 'postgres';

/**
 * The application's database connection.
 *
 * This module imports `server-only`, so any attempt to reach it from a client
 * component fails the build rather than shipping a connection string to a
 * browser. Nothing under src/server may be imported from client code.
 *
 * The role in DATABASE_URL must not be a superuser. PostgreSQL lets superusers
 * read through row-level security, which would silently disable the second
 * isolation layer that migration 0003 installs.
 */

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL is not set. Copy .env.example to .env.local and fill it in.');
}

declare global {
  var __cipSql: postgres.Sql | undefined;
}

// Next's dev server re-evaluates modules on every edit; without this the
// connection pool would multiply until PostgreSQL refuses new clients.
export const sql: postgres.Sql =
  globalThis.__cipSql ??
  postgres(connectionString, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
    onnotice: () => {},
  });

if (process.env.NODE_ENV !== 'production') globalThis.__cipSql = sql;

export type CompanyRole = 'owner' | 'admin' | 'member' | 'viewer';

/** A company the current session has been proven to hold a membership in. */
export type CompanyScope = {
  readonly companyId: string;
  readonly userId: string;
  readonly role: CompanyRole;
};

/**
 * Runs `fn` inside a transaction bound to one company.
 *
 * `cip.company_id` is set for the transaction only, and every row-level
 * security policy from migration 0003 reads it. A query in here that forgets
 * its own company filter returns nothing rather than another company's rows.
 *
 * There is deliberately no way to obtain a CompanyScope except from a verified
 * session, so no caller can pass in a company id that came from a browser.
 */
export async function withCompanyScope<T>(
  scope: CompanyScope,
  fn: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  const result = await sql.begin(async (tx) => {
    await tx`select set_config('cip.company_id', ${scope.companyId}, true)`;
    return fn(tx);
  });
  return result as T;
}

/**
 * Reports whether row-level security actually binds for the connected role.
 * /api/health surfaces this so a misconfigured DATABASE_URL is visible instead
 * of quietly leaving the application on a single layer of defence.
 */
export async function isRowLevelSecurityBinding(): Promise<boolean> {
  const rows = await sql<{ bypasses: boolean }[]>`
    select (rolsuper or rolbypassrls) as bypasses
      from pg_roles
     where rolname = current_user
  `;
  return rows.length > 0 ? !rows[0]!.bypasses : false;
}
