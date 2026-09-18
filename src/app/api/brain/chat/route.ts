import { noStore, withBrainScope } from '@/server/brain/http';
import { ChatNotFound, ChatRejected, askBrain, getThread, listThreads } from '@/server/brain/chat';
import { activeBrand } from '@/server/brain/activeBrand';
import { rateLimit } from '@/server/rateLimit';

/**
 * /api/brain/chat
 *
 * GET              this person's conversations
 * GET ?threadId=   one conversation, with its messages
 * POST             { threadId?, message } - ask, and get the question and answer back
 *
 * No company or user in the body: both come from the session, and a thread id
 * belonging to someone else is simply not found.
 */
export const dynamic = 'force-dynamic';

/** Every answer is a model call; a person asks a few a minute, not a few a second. */
const CHAT_LIMIT = { capacity: 10, refillPerSecond: 1 / 6 };

function handled(error: unknown): Response | null {
  if (error instanceof ChatRejected) {
    return Response.json({ error: 'rejected', message: error.message }, { status: 422, headers: noStore });
  }
  if (error instanceof ChatNotFound) {
    return Response.json({ error: 'not_found', message: error.message }, { status: 404, headers: noStore });
  }
  return null;
}

export async function GET(request: Request) {
  return withBrainScope(async (scope) => {
    const threadId = new URL(request.url).searchParams.get('threadId');
    if (threadId) {
      const thread = await getThread(scope, threadId);
      if (!thread) return Response.json({ error: 'not_found', message: 'That conversation is not here.' }, { status: 404, headers: noStore });
      return Response.json(thread, { headers: noStore });
    }
    return Response.json({ threads: await listThreads(scope) }, { headers: noStore });
  });
}

export async function POST(request: Request) {
  return withBrainScope(async (scope) => {
    const limit = await rateLimit(`chat:${scope.userId}`, CHAT_LIMIT);
    if (!limit.allowed) {
      return Response.json(
        { error: 'rate_limited', message: 'That is a lot of questions at once. Give it a moment.' },
        { status: 429, headers: { ...noStore, 'retry-after': String(limit.retryAfterSeconds) } },
      );
    }

    let body: { threadId?: unknown; message?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return Response.json({ error: 'INVALID_REQUEST', message: 'Send a JSON body.' }, { status: 400, headers: noStore });
    }

    try {
      const { active } = await activeBrand(scope);
      const result = await askBrain(scope, {
        threadId: typeof body.threadId === 'string' && body.threadId ? body.threadId : null,
        message: typeof body.message === 'string' ? body.message : '',
        activeBrand: active,
      });
      return Response.json(result, { status: 201, headers: noStore });
    } catch (error) {
      const response = handled(error);
      if (response) return response;
      throw error;
    }
  });
}
