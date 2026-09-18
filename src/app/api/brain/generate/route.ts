import { checkGenerationRate, noStore } from '@/server/media/http';
import { withBrainScope } from '@/server/brain/http';
import { generateWithBrain } from '@/server/brain/generate';
import type { BrainGenerateInput } from '@/server/brain/generate';
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
  market?: unknown;
  /** An earlier generation to build on, by id. */
  basedOn?: unknown;
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

    const limited = await checkGenerationRate(
      scope,
      mediaType,
      mediaType === 'video' ? VIDEO_GENERATION_LIMIT() : IMAGE_GENERATION_LIMIT(),
    );
    if (limited) return limited;

/**
     * The same work, reported as it happens.
     *
     * One line of JSON per event. The status code has to be sent before any of the
     * work runs, so it is always 200 and the outcome travels in the last line —
     * a stream cannot go back and change its mind about a header.
     *
     * An error mid-stream arrives as a final `failed` line rather than a status
     * code, for the same reason. The client treats a stream that ends without a
     * terminal line as a failure, so a dropped connection is not read as success.
     */
    function streamed(options: BrainGenerateInput): Response {
      const encoder = new TextEncoder();
    
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const send = (event: unknown): void => {
            controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
          };
    
          try {
            send({ stage: 'planning' });
    
            const result = await generateWithBrain(scope, {
              ...options,
              onPlanned: (plan, briefId) => send({ stage: 'planned', plan, briefId }),
            });
    
            send({ stage: 'done', result });
          } catch (error) {
            send({
              stage: 'failed',
              message: error instanceof Error ? error.message : 'That could not be made.',
            });
          } finally {
            controller.close();
          }
        },
      });
    
      return new Response(stream, {
        headers: {
          ...noStore,
          'content-type': 'application/x-ndjson; charset=utf-8',
          // Nothing between here and the browser may hold the first line back
          // waiting for the last one.
          'x-accel-buffering': 'no',
        },
      });
    }

    const options: BrainGenerateInput = {
      requestText,
      mediaType,
      provider: body.provider,
      aspectRatio: body.aspectRatio,
      imageSize: body.imageSize,
      resolution: body.resolution,
      durationSeconds: body.durationSeconds,
      idempotencyKey: body.idempotencyKey,
      clarification: typeof body.clarification === 'string' ? body.clarification : null,
      market: typeof body.market === 'string' ? body.market : null,
      // Resolved against this company's own generations, like any other id.
      basedOnGenerationId: typeof body.basedOn === 'string' ? body.basedOn : null,
    };

    // A caller that asks for a stream is told when the brief is written, which
    // is roughly half the wait and the half that produces something worth
    // reading. Anything else — the tests, the proof scripts, curl — gets the
    // single JSON reply it has always got.
    if (request.headers.get('accept')?.includes('application/x-ndjson')) {
      return streamed(options);
    }

    const result = await generateWithBrain(scope, options);

    // 200 rather than an error when the Brain asks a question: nothing went
    // wrong, it simply needs an answer before it can proceed.
    return Response.json(result, {
      status: result.status === 'generated' ? 201 : 200,
      headers: noStore,
    });
  });
}
