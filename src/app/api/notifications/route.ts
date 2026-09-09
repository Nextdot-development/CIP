import { requireSessionOr401 } from '@/server/auth/guards';
import { notifications } from '@/server/notifications';
import { noStore } from '@/server/drive/http';

/**
 * GET /api/notifications
 *
 * What is worth telling this company about, derived from what is true right
 * now. Scoped to the session's own company: there is no company parameter to
 * pass and none to forget.
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  const auth = await requireSessionOr401();
  if (!auth.ok) return auth.response;

  return Response.json(
    { notices: await notifications(auth.session.scope) },
    { headers: noStore },
  );
}
