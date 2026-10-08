import { noStore, withBrainScope } from '@/server/brain/http';
import { healthReport } from '@/server/jobs/health';

/**
 * /api/health
 *
 * GET whether CIP is keeping up: when the background work last ran, and
 * anything it could not do, in sentences a person can act on.
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  return withBrainScope(async (scope) => Response.json(await healthReport(scope), { headers: noStore }));
}
