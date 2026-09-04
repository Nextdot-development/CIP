import postgres from 'postgres';

/**
 * Elevated connection used only by `db:migrate` and `db:seed`.
 *
 * Kept in its own module so it can never be pulled into the request path by
 * accident: the running application only ever imports src/server/db.ts, whose
 * role cannot bypass row-level security.
 */
export function adminSql(): postgres.Sql {
  const url = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_ADMIN_URL (or DATABASE_URL) must be set to run this script.');
  }
  return postgres(url, { max: 1, onnotice: () => {} });
}
