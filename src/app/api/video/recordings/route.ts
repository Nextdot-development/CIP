import { noStore, withBrainScope } from '@/server/brain/http';
import { listRecordings } from '@/server/video/edit';

export const dynamic = 'force-dynamic';

/** GET the videos in this workspace a film can be made from; ?endScreens=1 includes the end screens too. */
export async function GET(request: Request) {
  const endScreens = new URL(request.url).searchParams.get('endScreens') === '1';
  return withBrainScope(async (scope) => Response.json({ recordings: await listRecordings(scope, { endScreens }) }, { headers: noStore }));
}
