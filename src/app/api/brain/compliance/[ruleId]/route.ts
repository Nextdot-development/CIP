import { noStore, withBrainScope } from '@/server/brain/http';
import { setRuleVerified } from '@/server/brain/checker';

type Params = { params: Promise<{ ruleId: string }> };

export const dynamic = 'force-dynamic';

/**
 * POST /api/brain/compliance/[ruleId]   { "verified": true | false }
 *
 * A person confirming a compliance rule is right - the legal check the rules
 * CIP suggested are waiting for. Until then such a rule can warn but not fail
 * a creative.
 */
export async function POST(request: Request, { params }: Params) {
  return withBrainScope(async (scope) => {
    const { ruleId } = await params;
    const body = (await request.json().catch(() => ({}))) as { verified?: unknown };
    if (typeof body.verified !== 'boolean') {
      return Response.json({ error: 'INVALID_REQUEST', message: 'Send { "verified": true } or false.' }, { status: 400, headers: noStore });
    }
    const ok = await setRuleVerified(scope, ruleId, body.verified);
    if (!ok) return Response.json({ error: 'not_found', message: 'That rule is not here.' }, { status: 404, headers: noStore });
    return Response.json({ ok: true, verifiedAt: body.verified ? new Date().toISOString() : null }, { headers: noStore });
  });
}
