import { checkGenerationRate, noStore } from '@/server/media/http';
import { withBrainScope } from '@/server/brain/http';
import { generateWithBrain } from '@/server/brain/generate';
import { IMAGE_GENERATION_LIMIT, VIDEO_GENERATION_LIMIT } from '@/server/rateLimit';

/**
 * POST /api/brain/generate
 *
 * Generation with the Brain in front: the request is planned against this
 * company's memory, and what reaches the generator is a brief rather than the
 * raw words.
 *
 * Rate limited exactly like the direct generation endpoints — planning costs a
 * model call and generating costs another, so this is the more expensive door,
 * not a cheaper way through.
 */
export const dynamic = 'force-dynamic';

type Body = {
  request?: unknown;
  mediaType?: unknown;
  provider?: unknown;
  aspectRatio?: unknown;
  imageSize?: unknown;
  resolution?: unknown;
  durationSeconds?: unknown;
  idempotencyKey?: unknown;
  clarification?: unknown;
};

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

    const mediaType = body.mediaType === 'video' ? 'video' : 'image';
    const requestText = typeof body.request === 'string' ? body.request.trim() : '';
    if (requestText.length === 0) {
      return Response.json(
        { error: 'rejected', message: 'Describe what you want made.' },
        { status: 422, headers: noStore },
      );
    }

    const limited = checkGenerationRate(
      scope,
      mediaType,
      mediaType === 'video' ? VIDEO_GENERATION_LIMIT() : IMAGE_GENERATION_LIMIT(),
    );
    if (limited) return limited;

    const result = await generateWithBrain(scope, {
      requestText,
      mediaType,
      provider: body.provider,
      aspectRatio: body.aspectRatio,
      imageSize: body.imageSize,
      resolution: body.resolution,
      durationSeconds: body.durationSeconds,
      idempotencyKey: body.idempotencyKey,
      clarification: typeof body.clarification === 'string' ? body.clarification : null,
    });

    // 200 rather than an error when the Brain asks a question: nothing went
    // wrong, it simply needs an answer before it can proceed.
    return Response.json(result, {
      status: result.status === 'generated' ? 201 : 200,
      headers: noStore,
    });
  });
}
