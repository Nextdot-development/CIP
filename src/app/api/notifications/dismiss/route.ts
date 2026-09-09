import { requireSessionOr401 } from '@/server/auth/guards';
import { dismissNotice, notifications } from '@/server/notifications';
import { noStore } from '@/server/drive/http';

/**
 * POST /api/notifications/dismiss
 *
 * Puts one notice away for the person asking. Only notices about something
 * already final are dismissible; the derivation refuses to hide anything still
 * true by simply continuing to produce it.
 *
 * Answers with the list as it now stands, so the caller does not need a second
 * request to know what is left.
 */
export const dynamic = 'force-dynamic';

type Body = { noticeId?: unknown };

export async function POST(request: Request) {
  const auth = await requireSessionOr401();
  if (!auth.ok) return auth.response;

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return Response.json(
      { error: 'rejected', message: 'Send a JSON body.' },
      { status: 400, headers: noStore },
    );
  }

  const noticeId = typeof body.noticeId === 'string' ? body.noticeId : '';
  if (noticeId.length === 0) {
    return Response.json(
      { error: 'rejected', message: 'Name the notice to dismiss.' },
      { status: 422, headers: noStore },
    );
  }

  await dismissNotice(auth.session.scope, noticeId);

  return Response.json(
    { notices: await notifications(auth.session.scope) },
    { headers: noStore },
  );
}
