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

/**
 * How many connections one process may hold.
 *
 * A long-running server wants a pool: it serves many requests at once and
 * reuses connections between them. A serverless instance does not — it handles
 * one request at a time, so every extra connection is idle, and there are as
 * many instances as there is traffic. Ten each against Supabase's pooler, which
 * allows fifteen clients in session mode, means two instances exhaust it and
 * the third gets "max clients reached". Which is exactly what production did.
 *
 * CIP_DB_POOL_MAX overrides it where neither default fits.
 */
function poolSize(): number {
  const configured = Number(process.env.CIP_DB_POOL_MAX);
  if (Number.isFinite(configured) && configured > 0) return configured;

  // Vercel, AWS Lambda and Netlify all set one of these.
  const serverless = Boolean(
    process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.NETLIFY,
  );
  return serverless ? 1 : 10;
}

/**
 * Whether the connection is going through a transaction-mode pooler.
 *
 * Supavisor hands a different backend to each statement in that mode, so a
 * prepared statement made on one is not there for the next and the query fails.
 * postgres.js prepares by default, so it has to be told not to. Session mode
 * (5432) keeps one backend per client and prepares fine.
 */
function transactionPooled(url: string): boolean {
  try {
    return new URL(url).port === '6543';
  } catch {
    return false;
  }
}

// Next's dev server re-evaluates modules on every edit; without this the
// connection pool would multiply until PostgreSQL refuses new clients.
export const sql: postgres.Sql =
  globalThis.__cipSql ??
  postgres(connectionString, {
    max: poolSize(),
    // Long enough to be reused within one request, short enough that a
    // finished serverless instance is not still holding a slot.
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: !transactionPooled(connectionString),
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
