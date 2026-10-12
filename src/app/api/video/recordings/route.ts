import { noStore, withBrainScope } from '@/server/brain/http';
import { listRecordings } from '@/server/video/edit';

export const dynamic = 'force-dynamic';

/** GET the videos in this workspace a film can be made from. */
export async function GET() {
  return withBrainScope(async (scope) => Response.json({ recordings: await listRecordings(scope) }, { headers: noStore }));
}
