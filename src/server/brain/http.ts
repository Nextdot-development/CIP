import 'server-only';
import { requireSessionOr401 } from '../auth/guards';
import { noStore } from '../drive/http';
import type { CompanyScope } from '../db';
import { BrainFailed } from './providers/types';
import { FeedbackRejected } from './learning';
import { CheckRejected } from './checker';
import { MediaNotFound, MediaProviderUnavailable, MediaRejected } from '../media/types';

/**
 * The shape every Brain route shares: prove the session, hand the handler a
 * scope, and turn whatever the service throws into an honest status code.
 *
 * As everywhere else in CIP there is no way for a handler to receive a company
 * id. It can only get the one attached to the session, so a company_id in a
 * body or a query string has nowhere to go.
 */
export async function withBrainScope(
  handler: (scope: CompanyScope) => Promise<Response>,
): Promise<Response> {
  const auth = await requireSessionOr401();
  if (!auth.ok) return auth.response;

  try {
    return await handler(auth.session.scope);
  } catch (error) {
    return brainErrorResponse(error);
  }
}

export function brainErrorResponse(error: unknown): Response {
  if (error instanceof FeedbackRejected || error instanceof MediaRejected || error instanceof CheckRejected) {
    return Response.json(
      { error: 'rejected', message: error.message },
      { status: 422, headers: noStore },
    );
  }
  if (error instanceof MediaNotFound) {
    return Response.json(
      { error: 'not_found', message: error.message },
      { status: 404, headers: noStore },
    );
  }
  if (error instanceof MediaProviderUnavailable) {
    return Response.json(
      { error: 'PROVIDER_NOT_CONFIGURED', message: error.message },
      { status: 503, headers: noStore },
    );
  }
  if (error instanceof BrainFailed) {
    if (error.code === 'NOT_CONFIGURED') {
      return Response.json(
        { error: 'NOT_CONFIGURED', message: 'The Brain is not configured on this server.' },
        { status: 503, headers: noStore },
      );
    }
    const status = error.kind === 'rate_limited' ? 429 : error.kind === 'permanent' ? 422 : 502;
    return Response.json(
      { error: error.code, message: error.message },
      {
        status,
        headers: error.retryAfterSeconds
          ? { ...noStore, 'retry-after': String(error.retryAfterSeconds) }
          : noStore,
      },
    );
  }

  // Never echo the error's message: it can carry a prompt or a document's
  // contents. Its class name carries neither, and without it an unexpected
  // failure on the deployment is indistinguishable from every other one —
  // "Something went wrong" was all a PDF check said for a week while the same
  // PDF checked cleanly on a laptop. The stack is logged for the same reason
  // and stays on the server.
  const kind = classOf(error);
  console.error(`[brain] a request failed unexpectedly: ${kind}`);
  if (error instanceof Error && error.stack) console.error(error.stack);

  return Response.json(
    {
      error: 'brain_error',
      message: `Something went wrong (${kind}). Try again in a moment.`,
    },
    { status: 500, headers: noStore },
  );
}

/**
 * What kind of thing was thrown, and nothing about what it said.
 *
 * Our own class names and the built-in ones — TypeError, ExtractionFailed,
 * GoogleDriveError. None of them is derived from a document, a prompt or a
 * file name, so this is safe to show; the message is not, so it is left behind.
 */
function classOf(error: unknown): string {
  if (error instanceof Error && typeof error.name === 'string' && error.name.trim()) {
    return error.name.slice(0, 40);
  }
  return 'unknown';
}

export { noStore };
