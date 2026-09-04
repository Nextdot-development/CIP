import 'server-only';
import { sql } from '../db';
import { fakeVerify, verifyPassword } from './password';
import { listMemberships } from './membership';

/**
 * Credential checking with no cookie or request involved, so it can be tested
 * directly and reused by anything that needs to authenticate a person.
 */
export type VerifiedUser = { userId: string; companyId: string };

export async function verifyCredentials(
  emailRaw: string,
  password: string,
): Promise<VerifiedUser | null> {
  const email = emailRaw.trim().toLowerCase();
  if (!email || !password) {
    await fakeVerify();
    return null;
  }

  const users = await sql<{ id: string; password_hash: string }[]>`
    select id, password_hash from users where email = ${email} limit 1
  `;
  const user = users[0];

  if (!user) {
    // Spend the same time as a real check so response timing does not reveal
    // which addresses are registered.
    await fakeVerify();
    return null;
  }

  if (!(await verifyPassword(password, user.password_hash))) return null;

  // Which company this person may enter comes from memberships, never from
  // anything the browser sent. Phase 1 opens the oldest membership; a company
  // chooser for multi-company users is a later phase.
  const memberships = await listMemberships(user.id);
  const first = memberships[0];
  if (!first) return null;

  return { userId: user.id, companyId: first.companyId };
}
