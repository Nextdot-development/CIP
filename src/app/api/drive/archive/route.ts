import { withDriveScope, noStore } from '@/server/drive/http';
import { listArchived } from '@/server/drive/service';

/** GET /api/drive/archive — files that were deleted but not purged */
export const dynamic = 'force-dynamic';

export async function GET() {
  return withDriveScope(async (scope) => {
    const files = await listArchived(scope);
    return Response.json({ files }, { headers: noStore });
  });
}
