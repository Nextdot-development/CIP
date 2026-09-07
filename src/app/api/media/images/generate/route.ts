import { checkGenerationRate, mediaErrorResponse, noStore, withMediaScope } from '@/server/media/http';
import { generateImage } from '@/server/media/generation';
import { IMAGE_GENERATION_LIMIT } from '@/server/rateLimit';

/**
 * POST /api/media/images/generate
 *
 * Generates an image within the caller's company. There is no company
 * parameter — the scope comes from the session, and row-level security turns
 * it into the filter.
 *
 * POST only, and rate limited before anything is read, because every call that
 * gets past this line costs real money at a provider.
 */
export const dynamic = 'force-dynamic';

type Body = {
  prompt?: unknown;
  referenceFileIds?: unknown;
  aspectRatio?: unknown;
  imageSize?: unknown;
  idempotencyKey?: unknown;
};

export async function POST(request: Request) {
  return withMediaScope(async (scope) => {
    const limited = checkGenerationRate(scope, 'image', IMAGE_GENERATION_LIMIT());
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
      const generation = await generateImage(scope, {
        // A company id in the body is simply not read. Only these five fields are.
        prompt: body.prompt,
        referenceFileIds: body.referenceFileIds,
        aspectRatio: body.aspectRatio,
        imageSize: body.imageSize,
        idempotencyKey: body.idempotencyKey,
      });
      return Response.json({ generation }, { status: 201, headers: noStore });
    } catch (error) {
      return mediaErrorResponse(error);
    }
  });
}
