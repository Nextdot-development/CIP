import { noStore, withBrainScope } from '@/server/brain/http';
import { ChatNotFound, ChatRejected, decideProposedRule } from '@/server/brain/chat';

/**
 * POST /api/brain/chat/rules
 *
 * Keeps, or turns down, a rule the Brain heard in a conversation and proposed
 * back: { messageId, index, keep }. Kept, it becomes a QC rule the checker and
 * the generator both apply. Answers with the message, showing the decision.
 *
 * Only the owner of the conversation can decide, as only they can read it.
 */
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  return withBrainScope(async (scope) => {
    let body: { messageId?: unknown; index?: unknown; keep?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return Response.json({ error: 'INVALID_REQUEST', message: 'Send a JSON body.' }, { status: 400, headers: noStore });
    }
    const index = Number(body.index);
    if (typeof body.messageId !== 'string' || !Number.isInteger(index) || index < 0 || typeof body.keep !== 'boolean') {
      return Response.json(
        { error: 'INVALID_REQUEST', message: 'Say which answer, which rule on it, and whether to keep it.' },
        { status: 400, headers: noStore },
      );
    }

    try {
      const message = await decideProposedRule(scope, { messageId: body.messageId, index, keep: body.keep });
      return Response.json({ message }, { headers: noStore });
    } catch (error) {
      if (error instanceof ChatRejected) {
        return Response.json({ error: 'rejected', message: error.message }, { status: 422, headers: noStore });
      }
      if (error instanceof ChatNotFound) {
        return Response.json({ error: 'not_found', message: error.message }, { status: 404, headers: noStore });
      }
      throw error;
    }
  });
}
