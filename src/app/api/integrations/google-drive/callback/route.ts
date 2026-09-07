import { requireSessionOr401 } from '@/server/auth/guards';
import { googleDrive } from '@/server/integrations/googleDrive';
import { saveTokens, verifyOAuthState } from '@/server/integrations/googleDrive/connection';
import { redirectUri } from '@/server/integrations/googleDrive/oauth';

/**
 * GET /api/integrations/google-drive/callback
 *
 * Where Google sends the browser after consent.
 *
 * The state is checked against the session presenting it. Without that, a link
 * could make somebody's browser finish an OAuth flow an attacker started, which
 * would attach the attacker's Drive to the victim's company and quietly feed
 * documents into their Knowledge Layer. A mismatched state is refused outright.
 *
 * The company comes from the session, never from the callback URL.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const auth = await requireSessionOr401();
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const declined = url.searchParams.get('error');

  // A plain HTTP redirect rather than next/navigation's, because the outcome
  // travels as a query parameter and typed routes will not carry one.
  const back = (outcome: string) =>
    Response.redirect(new URL(`/knowledge?google=${outcome}`, url.origin), 303);

  if (declined) return back('declined');
  if (!code || !state) return back('invalid');
  if (!verifyOAuthState(state, auth.session.scope)) return back('state');

  try {
    const tokens = await googleDrive().exchangeCode(code, redirectUri(request));
    await saveTokens(auth.session.scope, tokens);
  } catch {
    // Nothing from the error reaches the URL: it can carry a token or an
    // account address, and a query string ends up in browser history.
    console.error('[google-drive] the OAuth exchange failed');
    return back('failed');
  }

  return back('connected');
}
