import 'server-only';
import { createHmac, randomBytes } from 'node:crypto';
import { cookies } from 'next/headers';
import { sql, withConnectionRetry } from '../db';
import type { CompanyRole, CompanyScope } from '../db';

export const SESSION_COOKIE = 'cip_session';
const SESSION_DAYS = 7;

/**
 * The cookie holds an opaque random token. Only an HMAC of it is stored, so a
 * leaked database gives an attacker neither live sessions nor anything they
 * can precompute without also holding SESSION_SECRET.
 */
function secret(): Buffer {
  const raw = process.env.SESSION_SECRET;
  if (!raw || raw.length < 32) {
    throw new Error(
      'SESSION_SECRET must be set to at least 32 characters. Generate one with:\n' +
        '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
    );
  }
  return Buffer.from(raw, 'utf8');
}

function tokenHash(token: string): string {
  return createHmac('sha256', secret()).update(token).digest('base64');
}

export type AuthenticatedSession = {
  sessionId: string;
  user: { id: string; email: string; fullName: string };
  scope: CompanyScope;
};

/**
 * Issues a session for one user in one company and sets the cookie.
 * The company must already have been proven to be one the user belongs to.
 */
export async function createSession(
  userId: string,
  companyId: string,
  userAgent: string | null,
): Promise<void> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);

  await sql`
    insert into sessions (token_hash, user_id, company_id, expires_at, user_agent)
    values (${tokenHash(token)}, ${userId}, ${companyId}, ${expiresAt}, ${userAgent})
  `;

  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    expires: expiresAt,
  });
}

/**
 * Resolves the caller from their cookie, or null.
 *
 * The membership is re-checked on every call. A session row records which
 * company was chosen at sign-in; it is not on its own permission to read that
 * company, so revoking a membership takes effect immediately rather than at
 * the next sign-in.
 */
export async function getSession(): Promise<AuthenticatedSession | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  // Retried through a pooler hiccup. Every page in the workspace starts here,
  // so a dropped connection on this one query used to take the whole page down
  // with "password authentication failed for user cip_app" - a sentence about
  // the pooler, shown to somebody who was reading their brand.
  const rows = await withConnectionRetry(() => sql<
    {
      session_id: string;
      user_id: string;
      email: string;
      full_name: string;
      company_id: string;
      role: CompanyRole;
    }[]
  >`
    select s.id          as session_id,
           u.id          as user_id,
           u.email,
           u.full_name,
           m.company_id,
           m.role
      from sessions s
      join users u       on u.id = s.user_id
      -- the join to memberships is the authorisation check: no membership,
      -- no row, no session, whatever the session record claims.
      -- the companies table is deliberately not joined: it is under
      -- row-level security, and no company is set this early in a request.
      join memberships m on m.user_id = s.user_id and m.company_id = s.company_id
     where s.token_hash = ${tokenHash(token)}
       and s.expires_at > now()
     limit 1
  `);

  const row = rows[0];
  if (!row) return null;

  void sql`update sessions set last_seen_at = now() where id = ${row.session_id}`.catch(() => {});

  return {
    sessionId: row.session_id,
    user: { id: row.user_id, email: row.email, fullName: row.full_name },
    scope: { companyId: row.company_id, userId: row.user_id, role: row.role },
  };
}

/** Deletes the current session server-side and clears the cookie. */
export async function destroySession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) {
    await sql`delete from sessions where token_hash = ${tokenHash(token)}`;
  }
  jar.delete(SESSION_COOKIE);
}

/** Exposed for tests, which build sessions without a browser. */
export const __testing = { tokenHash };
