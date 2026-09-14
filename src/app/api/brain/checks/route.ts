import { noStore, withBrainScope } from '@/server/brain/http';
import { listChecks, runCheck } from '@/server/brain/checker';

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

export async function GET() {
  return withBrainScope(async (scope) => {
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
