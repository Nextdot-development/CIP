import { noStore, withBrainScope } from '@/server/brain/http';
import { correctFlag } from '@/server/brain/checker';
import type { Correction } from '@/server/brain/checker';

type Params = { params: Promise<{ flagId: string }> };

export const dynamic = 'force-dynamic';

/**
 * POST /api/brain/checks/flags/[flagId]
 *
 * "Disagree? Correct this." A reviewer accepts a flag, or disputes it and says
 * which way: the creative is a legitimate exception, or the rule itself is
 * wrong. Only the second changes what CIP believes.
 *
 *   { "decision": "accept" }
 *   { "decision": "dispute", "reason": "exception" | "wrong_rule", "correction": "..." }
 */
export async function POST(request: Request, { params }: Params) {
  return withBrainScope(async (scope) => {
    const { flagId } = await params;

    let body: { decision?: unknown; reason?: unknown; correction?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return Response.json(
        { error: 'INVALID_REQUEST', message: 'Send a JSON body.' },
        { status: 400, headers: noStore },
      );
    }

    let correction: Correction;
    if (body.decision === 'accept') {
      correction = { decision: 'accept' };
    } else if (body.decision === 'dispute' && (body.reason === 'exception' || body.reason === 'wrong_rule')) {
      correction = {
        decision: 'dispute',
        reason: body.reason,
        correction: typeof body.correction === 'string' ? body.correction : null,
      };
    } else {
      return Response.json(
        {
          error: 'INVALID_REQUEST',
          message: 'Accept the flag, or dispute it as an exception or as a wrong rule.',
        },
        { status: 400, headers: noStore },
      );
    }

    const result = await correctFlag(scope, flagId, correction);
    return Response.json(result, { headers: noStore });
  });
}
