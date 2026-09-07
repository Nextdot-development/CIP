import { checkGenerationRate, mediaErrorResponse, noStore, withMediaScope } from '@/server/media/http';
import { generateVideo } from '@/server/media/generation';
import { VIDEO_GENERATION_LIMIT } from '@/server/rateLimit';

/**
 * POST /api/media/videos/generate
 *
 * Queues a video and returns immediately with a generation to poll. Nothing is
 * sent to the provider here — a video takes minutes, and an HTTP request must
 * not be held open for one.
 *
 * 202 rather than 201: the record exists, the video does not yet.
 */
export const dynamic = 'force-dynamic';

type Body = {
  prompt?: unknown;
  referenceFileId?: unknown;
  durationSeconds?: unknown;
  resolution?: unknown;
  aspectRatio?: unknown;
  idempotencyKey?: unknown;
};

export async function POST(request: Request) {
  return withMediaScope(async (scope) => {
    const limited = checkGenerationRate(scope, 'video', VIDEO_GENERATION_LIMIT());
    if (limited) return limited;

    let body: Body;
    try {
      body = (await request.json()) as Body;
    } catch {
      return Response.json(
        { error: 'INVALID_REQUEST', message: 'Send a JSON body.' },
        { status: 400, headers: noStore },
      );
    }

    try {
      const generation = await generateVideo(scope, {
        prompt: body.prompt,
        referenceFileId: body.referenceFileId,
        durationSeconds: body.durationSeconds,
        resolution: body.resolution,
        aspectRatio: body.aspectRatio,
        idempotencyKey: body.idempotencyKey,
      });
      return Response.json({ generation }, { status: 202, headers: noStore });
    } catch (error) {
      return mediaErrorResponse(error);
    }
  });
}
