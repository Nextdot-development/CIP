import 'server-only';
import { redirect } from 'next/navigation';
import { getSession } from './session';
import type { AuthenticatedSession } from './session';

/**
 * The only way into company data.
 *
 * Server components and route handlers call this instead of reading a company
 * id from anywhere else. There is no parameter to pass a company in, which is
 * what makes "never trust a company id from the browser" structural rather
 * than a rule people have to remember.
 */
export async function requireSession(): Promise<AuthenticatedSession> {
  const session = await getSession();
  if (!session) redirect('/login');
  return session;
}

/** Same check for API route handlers, which answer with 401 instead of a redirect. */
export async function requireSessionOr401(): Promise<
  { ok: true; session: AuthenticatedSession } | { ok: false; response: Response }
> {
  const session = await getSession();
  if (!session) {
    return {
      ok: false,
      response: Response.json(
        { error: 'not_authenticated', message: 'Sign in to continue.' },
        { status: 401 },
      ),
    };
  }
  return { ok: true, session };
}
