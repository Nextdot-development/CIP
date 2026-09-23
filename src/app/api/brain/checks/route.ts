import { noStore, withBrainScope } from '@/server/brain/http';
import { latestCheckForGeneration, listChecks, runCheck } from '@/server/brain/checker';

/**
 * /api/brain/checks
 *
 * GET  recent checks, newest first.
 * POST check one creative against the brand and its category's rules.
 *
 * There is no company in the body. The scope comes from the session, and a
 * file or generation id from another company is simply not found.
 */
export const dynamic = 'force-dynamic';
/**
 * Long enough for a check.
 *
 * A check draws a PDF page, reads the brand off it, fetches the approved
 * packshots and then sends four high-detail images to a vision model. That is
 * minutes, not seconds, and the platform's default is far shorter - a request
 * that runs out of time is killed with no error anybody can read, which is
 * exactly what a 2.8 MB PDF did on the deployment while working locally.
 */
export const maxDuration = 300;

export async function GET(request: Request) {
  return withBrainScope(async (scope) => {
    // ?generationId= asks for the verdict on one generated creative.
    const generationId = new URL(request.url).searchParams.get('generationId');
    if (generationId) {
      return Response.json({ check: await latestCheckForGeneration(scope, generationId) }, { headers: noStore });
    }
    return Response.json({ checks: await listChecks(scope) }, { headers: noStore });
  });
}

type Body = {
  fileId?: unknown;
  generationId?: unknown;
  assetId?: unknown;
  brand?: unknown;
  market?: unknown;
};

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value : null);

export async function POST(request: Request) {
  return withBrainScope(async (scope) => {
    let body: Body;
    try {
      body = (await request.json()) as Body;
    } catch {
      return Response.json(
        { error: 'INVALID_REQUEST', message: 'Send a JSON body.' },
        { status: 400, headers: noStore },
      );
    }

    const check = await runCheck(scope, {
      fileId: text(body.fileId),
      generationId: text(body.generationId),
      assetId: text(body.assetId),
      brand: text(body.brand),
      market: text(body.market),
    });
    return Response.json({ check }, { status: 201, headers: noStore });
  });
}
