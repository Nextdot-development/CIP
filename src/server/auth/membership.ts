import 'server-only';
import { sql } from '../db';
import type { CompanyScope } from '../db';

/**
 * Turns a (user, company) pair into a scope, or returns null.
 *
 * This is the single place company access is decided. It never accepts a
 * company id from a request; callers pass one that came from a session row or
 * from sign-in, and this function still checks the membership exists. No
 * membership, no scope, no data — whatever else the caller believed.
 *
 * Note this reads `memberships` only. Sign-in happens before any company scope
 * exists, and `companies` is under row-level security, so joining it here would
 * return nothing and lock everyone out.
 */
export async function resolveScope(userId: string, companyId: string): Promise<CompanyScope | null> {
  const rows = await sql<{ role: CompanyScope['role'] }[]>`
    select role from memberships
     where user_id = ${userId} and company_id = ${companyId}
     limit 1
  `;
  const row = rows[0];
  return row ? { userId, companyId, role: row.role } : null;
}

/** Every company a user may enter, oldest membership first. Ids only — see above. */
export async function listMemberships(
  userId: string,
): Promise<{ companyId: string; role: CompanyScope['role'] }[]> {
  const rows = await sql<{ company_id: string; role: CompanyScope['role'] }[]>`
    select company_id, role from memberships
     where user_id = ${userId}
     order by created_at asc
  `;
  return rows.map((r) => ({ companyId: r.company_id, role: r.role }));
}
