import { noStore, withBrainScope } from '@/server/brain/http';
import { addBenchmark, listBenchmarks } from '@/server/brain/benchmark';

/**
 * /api/brain/benchmarks
 *
 * GET   the accuracy test set, and how the newest run of it went
 * POST  { checkId, page, expected: "pass" | "flag", note } - add a checked
 *       creative to it, with the answer it should get
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  return withBrainScope(async (scope) => Response.json(await listBenchmarks(scope), { headers: noStore }));
}

export async function POST(request: Request) {
  return withBrainScope(async (scope) => {
    const body = (await request.json().catch(() => ({}))) as { checkId?: unknown; page?: unknown; expected?: unknown; note?: unknown };
    const summary = await addBenchmark(scope, {
      checkId: String(body.checkId ?? ''),
      page: typeof body.page === 'number' ? body.page : null,
      expected: body.expected === 'flag' ? 'flag' : body.expected === 'pass' ? 'pass' : ('' as 'pass'),
      note: typeof body.note === 'string' ? body.note : null,
    });
    return Response.json(summary, { status: 201, headers: noStore });
  });
}
