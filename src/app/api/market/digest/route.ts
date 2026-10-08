import { withDriveScope, noStore } from '@/server/drive/http';
import { latestDigest, writeDigest } from '@/server/brain/filings';

/**
 * /api/market/digest
 *
 * GET   the newest weekly note on the watched companies' filings
 * POST  write it now, from what has been read since the last one, rather than
 *       waiting for the week to turn
 */
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export async function GET() {
  return withDriveScope(async (scope) => Response.json({ digest: await latestDigest(scope) }, { headers: noStore }));
}

export async function POST() {
  return withDriveScope(async (scope) => {
    const written = await writeDigest(scope);
    if (!written) {
      return Response.json(
        { error: 'nothing_new', message: 'No filing has been read since the last note. It is written once they have been.' },
        { status: 422, headers: noStore },
      );
    }
    return Response.json({ digest: written }, { status: 201, headers: noStore });
  });
}
