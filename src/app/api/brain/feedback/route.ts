import { noStore, withBrainScope } from '@/server/brain/http';
import { submitFeedback } from '@/server/brain/learning';
import { pumpInBackground } from '@/server/jobs/pump';

/**
 * POST /api/brain/feedback
 *
 * A 0-10 score and an optional comment on a generation. Stored immediately;
 * what it teaches is worked out after the response, because one person's
 * opinion should not rewrite a company's Brand DNA inside their own HTTP
 * request.
 *
 * "After the response" used to mean "when the standalone worker next runs",
 * and on a deployment without one that was never. The pump reads it instead,
 * on the same claim the worker takes, so the two can both be running.
 */
export const dynamic = 'force-dynamic';

type Body = { generationId?: unknown; score?: unknown; comment?: unknown };

export async function POST(request: Request) {
  return withBrainScope(async (scope) => {
    let body: Body;
    try {
      body = (await request.json()) as Body;
    } catch {
      return Response.json(
        { error: 'rejected', message: 'Send a JSON body.' },
        { status: 400, headers: noStore },
      );
    }

    // Only these three fields are read. A company id in the body has nowhere
    // to go: the scope comes from the session.
    const feedback = await submitFeedback(scope, {
      generationId: typeof body.generationId === 'string' ? body.generationId : '',
      score: body.score,
      comment: body.comment,
    });

    // Fire and forget: the rating is already stored, and reading it costs a
    // model call the person should not wait for.
    pumpInBackground();

    return Response.json({ feedback }, { status: 201, headers: noStore });
  });
}
