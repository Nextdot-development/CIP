import 'server-only';
import { requireSessionOr401 } from '../../auth/guards';
import { noStore } from '../../drive/http';
import type { CompanyScope } from '../../db';
import { GoogleDriveRejected } from './connection';
import { GoogleDriveSyncRejected } from './sync';
import { GoogleDriveNeedsReauth, GoogleDriveNotConnected } from './types';
import { GoogleDriveError } from './client';

/**
 * The shape every Google Drive route shares: prove the session, hand the
 * handler a scope, and turn whatever the service throws into an honest status.
 *
 * As everywhere else in CIP, there is no way for a handler to receive a company
 * id. It can only get the one attached to the session, so a company_id in a
 * body, a query string or a header has nowhere to go.
 */
export async function withIntegrationScope(
  handler: (scope: CompanyScope) => Promise<Response>,
): Promise<Response> {
  const auth = await requireSessionOr401();
  if (!auth.ok) return auth.response;

  try {
    return await handler(auth.session.scope);
  } catch (error) {
    return integrationErrorResponse(error);
  }
}

export function integrationErrorResponse(error: unknown): Response {
  if (error instanceof GoogleDriveNotConnected) {
    return Response.json(
      { error: 'not_connected', message: error.message },
      { status: 409, headers: noStore },
    );
  }
  if (error instanceof GoogleDriveNeedsReauth) {
    // 409 rather than 401: the caller's own session is fine. It is the Google
    // grant that has gone, and the fix is to reconnect, not to sign in again.
    return Response.json(
      { error: 'needs_reauth', message: error.message },
      { status: 409, headers: noStore },
    );
  }
  if (error instanceof GoogleDriveRejected || error instanceof GoogleDriveSyncRejected) {
    return Response.json(
      { error: 'rejected', message: error.message },
      { status: 422, headers: noStore },
    );
  }
  if (error instanceof GoogleDriveError) {
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
  console.error('[google-drive] a request failed');
  return Response.json(
    { error: 'integration_error', message: 'Something went wrong. Try again in a moment.' },
    { status: 500, headers: noStore },
  );
}

export { noStore };
