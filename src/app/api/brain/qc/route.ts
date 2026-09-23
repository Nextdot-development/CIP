import { noStore, withBrainScope } from '@/server/brain/http';
import { coverageFor, runQc } from '@/server/brain/qc';

/**
 * /api/brain/qc
 *
 * POST check one uploaded creative and report it the way a reviewer reads it:
 * what must be fixed, what a person should look at, and what passed.
 *
 * The file has to already be in this workspace - uploaded through
 * /api/drive/files, like anything else. Checking bytes that were never stored
 * would leave a verdict with nothing behind it, and a verdict nobody can go
 * back to is not worth printing.
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

/**
 * GET what a check would be judged against, for one brand and market.
 *
 * Asked again whenever either is changed, because the answer moves a great
 * deal: every rule this company holds belongs to a market, so switching from
 * Ghana to India changes six rules into three. A count fetched once when the
 * page loaded would go quietly out of date and say a check covered more than
 * it did.
 */
export async function GET(request: Request) {
  return withBrainScope(async (scope) => {
    const params = new URL(request.url).searchParams;
    const coverage = await coverageFor(scope, {
      brand: params.get('brand')?.trim() || null,
      market: params.get('market')?.trim() || null,
    });
    return Response.json({ coverage }, { headers: noStore });
  });
}

type Body = {
  fileId?: unknown;
  generationId?: unknown;
  assetId?: unknown;
  brand?: unknown;
  market?: unknown;
  page?: unknown;
};

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

const page = (value: unknown): number | null => {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n >= 1 ? Math.trunc(n) : null;
};

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

    const report = await runQc(scope, {
      fileId: text(body.fileId),
      generationId: text(body.generationId),
      assetId: text(body.assetId),
      brand: text(body.brand),
      market: text(body.market),
      page: page(body.page),
    });

    return Response.json({ report }, { status: 201, headers: noStore });
  });
}
