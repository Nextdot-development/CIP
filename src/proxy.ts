import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const SESSION_COOKIE = 'cip_session';

/**
 * Sends signed-out visitors to /login before a page starts rendering.
 *
 * This is a convenience, NOT the security boundary. It runs on the edge
 * runtime with no database, so all it can see is whether a cookie exists —
 * not whether it is valid. Every page and route handler proves the session
 * for itself through requireSession(); forging this cookie earns an attacker
 * a trip back to /login and nothing else.
 *
 * It deliberately does not bounce a cookie-holder away from /login. A stale or
 * expired cookie would otherwise loop forever: /login sends you to /, the real
 * session check sends you back to /login, and around again. The login page
 * does that redirect itself, where it can actually verify the session.
 */
export default function proxy(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const hasCookie = typeof token === 'string' && token.length > 0;
  const { pathname } = request.nextUrl;

  if (!hasCookie && pathname !== '/login') {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.search = '';
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico|cip.svg).*)'],
};
