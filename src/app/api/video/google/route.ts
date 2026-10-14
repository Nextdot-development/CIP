import { noStore, withIntegrationScope } from '@/server/integrations/googleDrive/http';
import { brainErrorResponse } from '@/server/brain/http';
import { importGoogleVideo, listGoogleVideos } from '@/server/video/googleVideos';
import { VideoEditRejected } from '@/server/video/edit';

/**
 * /api/video/google
 *
 * GET   the newest videos in the connected Google Drive ({ connected: false } when none is)
 * POST  { id } - bring one into the workspace, to edit or use as b-roll
 */
export const dynamic = 'force-dynamic';
/** A recording of a few hundred megabytes takes a while to come across. */
export const maxDuration = 300;

export async function GET() {
  return withIntegrationScope(async (scope) => {
    const videos = await listGoogleVideos(scope);
    return Response.json({ connected: videos !== null, videos: videos ?? [] }, { headers: noStore });
  });
}

export async function POST(request: Request) {
  return withIntegrationScope(async (scope) => {
    const body = (await request.json().catch(() => ({}))) as { id?: unknown };
    try {
      return Response.json({ file: await importGoogleVideo(scope, String(body.id ?? '')) }, { status: 201, headers: noStore });
    } catch (error) {
      if (error instanceof VideoEditRejected) return brainErrorResponse(error);
      throw error;
    }
  });
}
