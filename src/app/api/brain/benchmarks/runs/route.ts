import { noStore, withBrainScope } from '@/server/brain/http';
import { startBenchmarkRun } from '@/server/brain/benchmark';

export const dynamic = 'force-dynamic';

/**
 * POST - start checking the whole test set again.
 *
 * Answers with the run and the creatives in it; each is then checked in a
 * request of its own, so no one request has to last as long as the set.
 */
export async function POST() {
  return withBrainScope(async (scope) => Response.json(await startBenchmarkRun(scope), { status: 201, headers: noStore }));
}
