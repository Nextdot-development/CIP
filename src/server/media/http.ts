import 'server-only';
import { requireSessionOr401 } from '../auth/guards';
import { noStore } from '../drive/http';
import type { CompanyScope } from '../db';
import {
  COMPANY_GENERATION_LIMIT,
  rateLimit,
} from '../rateLimit';
import type { RateLimitOptions } from '../rateLimit';
import { MediaConflict, MediaNotFound, MediaProviderUnavailable, MediaRejected } from './types';

/**
 * The shape every media route shares: prove the session, hand the handler a
 * scope, and turn whatever the service throws into an honest status code.
 *
 * As in the Drive, there is no way for a handler to receive a company id. It
 * can only get the one attached to the session, so a company_id in a request
 * body is not ignored by convention — there is nowhere for it to go.
 */
export async function withMediaScope(
  handler: (scope: CompanyScope) => Promise<Response>,
): Promise<Response> {
  const auth = await requireSessionOr401();
  if (!auth.ok) return auth.response;

  try {
    return await handler(auth.session.scope);
  } catch (error) {
    return mediaErrorResponse(error);
  }
}

export function mediaErrorResponse(error: unknown): Response {
  // 404 for anything belonging to another company. Distinguishing "forbidden"
  // from "missing" would confirm that an id exists somewhere.
  if (error instanceof MediaNotFound) {
    return Response.json(
      { error: 'not_found', message: error.message },
      { status: 404, headers: noStore },
    );
  }
  if (error instanceof MediaConflict) {
    return Response.json(
      { error: 'conflict', message: error.message },
      { status: 409, headers: noStore },
    );
  }
  if (error instanceof MediaProviderUnavailable) {
    // 503, because nothing about the request was wrong — the service simply
    // has no provider configured, and that is ours to fix, not the caller's.
    return Response.json(
      { error: 'PROVIDER_NOT_CONFIGURED', message: error.message },
      { status: 503, headers: noStore },
    );
  }
  if (error instanceof MediaRejected) {
    return Response.json(
      { error: error.code, message: error.message },
      { status: error.code === 'STORAGE_ERROR' ? 409 : 422, headers: noStore },
    );
  }

  // Never echo the error: it can carry the prompt, which is the customer's.
  console.error('[media] a request failed');
  return Response.json(
    { error: 'media_error', message: 'Something went wrong. Try again in a moment.' },
    { status: 500, headers: noStore },
  );
}

/**
 * Two buckets, both server-side: one for the person, one for the company.
 *
 * The per-user limit stops a runaway client. The per-company limit stops a
 * whole team doing it at once, which the per-user limit cannot see.
 */
export async function checkGenerationRate(
  scope: CompanyScope,
  kind: 'image' | 'video',
  perUser: RateLimitOptions,
): Promise<Response | null> {
  const user = await rateLimit(`media:${kind}:user:${scope.userId}`, perUser);
  if (!user.allowed) return tooMany(user.retryAfterSeconds);

  const company = await rateLimit(`media:company:${scope.companyId}`, COMPANY_GENERATION_LIMIT());
  if (!company.allowed) return tooMany(company.retryAfterSeconds);

  return null;
}

function tooMany(retryAfterSeconds: number): Response {
  return Response.json(
    {
      error: 'RATE_LIMITED',
      message: 'That is a lot of generating. Give it a moment.',
    },
    { status: 429, headers: { ...noStore, 'retry-after': String(retryAfterSeconds) } },
  );
}

export { noStore };
