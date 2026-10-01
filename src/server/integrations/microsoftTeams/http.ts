import 'server-only';
import { requireSessionOr401 } from '../../auth/guards';
import { noStore } from '../../drive/http';
import type { CompanyScope } from '../../db';
import { MicrosoftSyncRejected } from './sync';
import { MicrosoftNeedsAdminConsent, MicrosoftNotConnected } from './types';
import { MicrosoftGraphError } from './client';

/**
 * The shape every Microsoft route shares: prove the session, hand the handler
 * a scope, and turn whatever the service throws into an honest status.
 *
 * As everywhere else in CIP, there is no way for a handler to receive a company
 * id. It can only get the one attached to the session, so a company_id in a
 * body, a query string or a header has nowhere to go.
 */
export async function withMicrosoftScope(
  handler: (scope: CompanyScope) => Promise<Response>,
): Promise<Response> {
  const auth = await requireSessionOr401();
  if (!auth.ok) return auth.response;

  try {
    return await handler(auth.session.scope);
  } catch (error) {
    return microsoftErrorResponse(error);
  }
}

export function microsoftErrorResponse(error: unknown): Response {
  if (error instanceof MicrosoftNotConnected) {
    return Response.json(
      { error: 'not_connected', message: error.message },
      { status: 409, headers: noStore },
    );
  }
  if (error instanceof MicrosoftNeedsAdminConsent) {
    // 409 rather than 401 or 403: the caller's own session is fine, and the
    // caller is very likely not the person who can fix this. The message says
    // an administrator must act, which is the only useful next step.
    return Response.json(
      { error: 'needs_admin_consent', message: error.message },
      { status: 409, headers: noStore },
    );
  }
  if (error instanceof MicrosoftSyncRejected) {
    return Response.json(
      { error: 'rejected', message: error.message },
      { status: 422, headers: noStore },
    );
  }
  if (error instanceof MicrosoftGraphError) {
    const status = error.kind === 'rate_limited' ? 429 : 502;
    return Response.json(
      { error: error.kind, message: error.message },
      {
        status,
        headers: error.retryAfterSeconds
          ? { ...noStore, 'retry-after': String(error.retryAfterSeconds) }
          : noStore,
      },
    );
  }

  // Never echo the error: it can carry a file name or a token.
  console.error('[microsoft-teams] a request failed');
  return Response.json(
    { error: 'integration_error', message: 'Something went wrong. Try again in a moment.' },
    { status: 500, headers: noStore },
  );
}

export { noStore };
