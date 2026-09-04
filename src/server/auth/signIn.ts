import 'server-only';
import { sql } from '../db';
import { createSession } from './session';
import { verifyCredentials } from './credentials';

export type SignInResult = { ok: true } | { ok: false; message: string };

/**
 * Every failure returns the same message. Telling someone whether an email
 * exists, or whether it was the password that was wrong, hands an attacker a
 * list of valid accounts for free.
 */
const GENERIC_FAILURE = 'That email and password do not match.';

export async function signIn(
  email: string,
  password: string,
  userAgent: string | null,
): Promise<SignInResult> {
  const verified = await verifyCredentials(email, password);
  if (!verified) return { ok: false, message: GENERIC_FAILURE };

  await sql`update users set last_login_at = now() where id = ${verified.userId}`;
  await createSession(verified.userId, verified.companyId, userAgent);
  return { ok: true };
}
