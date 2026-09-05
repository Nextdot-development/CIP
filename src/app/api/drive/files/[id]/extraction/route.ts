import { withDriveScope, noStore } from '@/server/drive/http';
import { getExtraction } from '@/server/drive/processing';

type Params = { params: Promise<{ id: string }> };

export const dynamic = 'force-dynamic';

/**
 * GET /api/drive/files/[id]/extraction
 *
 * The plain text we read out of a file. Scoped like every other Drive read:
 * another company's file id gives 404, not a different answer.
 */
export async function GET(_request: Request, { params }: Params) {
  return withDriveScope(async (scope) => {
    const { id } = await params;
    const extraction = await getExtraction(scope, id);

    if (!extraction) {
      return Response.json(
        { error: 'not_extracted', message: 'This file has not been read yet.' },
        { status: 404, headers: noStore },
      );
    }
    return Response.json(extraction, { headers: noStore });
  });
}
