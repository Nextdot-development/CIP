import 'server-only';
import { requireSessionOr401 } from '../auth/guards';
import { DriveConflict, DriveNotFound, DriveRejected } from './service';
import type { CompanyScope } from '../db';

/**
 * The shape every Drive route shares: prove the session, hand the handler a
 * scope, and turn whatever the service throws into an honest status code.
 *
 * Note what is missing — there is no way for a handler to receive a company
 * id. It can only get the one attached to the session.
 */
export async function withDriveScope(
  handler: (scope: CompanyScope) => Promise<Response>,
): Promise<Response> {
  const auth = await requireSessionOr401();
  if (!auth.ok) return auth.response;

  try {
    return await handler(auth.session.scope);
  } catch (error) {
    // 404 for anything belonging to another company. Distinguishing "forbidden"
    // from "missing" would confirm that an id exists somewhere.
    if (error instanceof DriveNotFound) {
      return Response.json({ error: 'not_found', message: error.message }, { status: 404 });
    }
    if (error instanceof DriveConflict) {
      return Response.json({ error: 'conflict', message: error.message }, { status: 409 });
    }
    if (error instanceof DriveRejected) {
      return Response.json({ error: 'rejected', message: error.message }, { status: 422 });
    }
    console.error('Drive request failed:', error);
    // Named, and named differently from the Brain's version of this message.
    // A dropped creative is uploaded here and then checked there, and when both
    // layers answered with the same sentence there was no way to tell which of
    // the two had actually failed.
    const kind = error instanceof Error && error.name.trim() ? error.name.slice(0, 40) : 'unknown';
    return Response.json(
      {
        error: 'drive_error',
        message: `The upload went wrong (${kind}). Try again in a moment.`,
      },
      { status: 500 },
    );
  }
}

/** Route handlers are per-session; nothing here may be cached or shared. */
export const noStore = { 'cache-control': 'private, no-store' };
