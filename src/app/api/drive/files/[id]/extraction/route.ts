import { withDriveScope, noStore } from '@/server/drive/http';
import { getExtraction, getProcessingState } from '@/server/drive/processing';

type Params = { params: Promise<{ id: string }> };

export const dynamic = 'force-dynamic';

/**
 * GET /api/drive/files/[id]/extraction
 *
 * The plain text we read out of a file, or an honest account of why there is
 * none yet.
 *
 * This used to answer 404 "This file has not been read yet" for everything
 * without an extraction row, which covered four different situations under one
 * sentence: never queued, waiting, being read right now, and failed. A file
 * synced from Google Drive and sitting in the queue looked identical to one
 * nothing would ever read — so the honest answer for it, "queued", is now
 * distinguishable from the misleading one.
 *
 * Scoped like every other Drive read: another company's file id gives 404, not
 * a different answer.
 */
export async function GET(_request: Request, { params }: Params) {
  return withDriveScope(async (scope) => {
    const { id } = await params;

    const extraction = await getExtraction(scope, id);
    if (extraction) return Response.json(extraction, { headers: noStore });

    const state = await getProcessingState(scope, id);

    // No such file, for this company or at all. The same answer either way.
    if (!state) {
      return Response.json(
        { error: 'not_found', message: 'That file could not be found.' },
        { status: 404, headers: noStore },
      );
    }

    // Waiting or in flight. A 202 says "ask again", which is true, where a 404
    // says "there will never be anything here", which is not.
    if (state.status === 'pending' || state.status === 'processing') {
      return Response.json(
        {
          status: state.status === 'processing' ? 'processing' : 'queued',
          message:
            state.status === 'processing'
              ? 'This file is being read right now.'
              : 'This file is queued to be read.',
          fileType: state.fileType,
          attempts: state.attempts,
          queuedSince: state.updatedAt,
        },
        { status: 202, headers: noStore },
      );
    }

    if (state.status === 'failed') {
      return Response.json(
        {
          status: 'failed',
          message: state.error ?? 'This file could not be read.',
          fileType: state.fileType,
          attempts: state.attempts,
        },
        { status: 422, headers: noStore },
      );
    }

    // Marked processed with nothing stored. True for the file types the
    // Knowledge Layer does not read as text — an image, a video — which are
    // understood by looking at them instead, not by extraction.
    return Response.json(
      {
        status: 'not_extracted',
        message: state.extractable
          ? 'This file was processed but produced no text.'
          : `CIP does not read .${state.fileType} files as text. It looks at them instead.`,
        fileType: state.fileType,
      },
      { status: 404, headers: noStore },
    );
  });
}
