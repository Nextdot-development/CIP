import { noStore, withBrainScope } from '@/server/brain/http';
import { listBenchmarks, runBenchmarkItem } from '@/server/brain/benchmark';

type Params = { params: Promise<{ runId: string }> };

export const dynamic = 'force-dynamic';
/** One check: a film or a PDF page takes most of a minute. */
export const maxDuration = 300;

/** POST { benchmarkId } - check one creative of the run, and say how the set stands. */
export async function POST(request: Request, { params }: Params) {
  return withBrainScope(async (scope) => {
    const { runId } = await params;
    const body = (await request.json().catch(() => ({}))) as { benchmarkId?: unknown };
    await runBenchmarkItem(scope, runId, String(body.benchmarkId ?? ''));
    return Response.json(await listBenchmarks(scope), { headers: noStore });
  });
}
