import { noStore, withBrainScope } from '@/server/brain/http';
import { QuestionRejected, answerQuestion } from '@/server/brain/questions';

/**
 * POST /api/brain/questions/[id]   { answer: string }
 *
 * A person settles something CIP could not: the answer is kept with the
 * question, and the question leaves the Brand Brain's list.
 */
export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = (await request.json().catch(() => null)) as { answer?: unknown } | null;
  return withBrainScope(async (scope) => {
    try {
      const answered = await answerQuestion(scope, id, body?.answer);
      if (!answered) return Response.json({ error: 'not_found', message: 'That question was already answered.' }, { status: 404, headers: noStore });
      return Response.json({ ok: true }, { headers: noStore });
    } catch (error) {
      if (error instanceof QuestionRejected) return Response.json({ error: 'rejected', message: error.message }, { status: 422, headers: noStore });
      throw error;
    }
  });
}
