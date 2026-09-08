import { withDriveScope, noStore } from '@/server/drive/http';
import { getExtraction, getProcessingState } from '@/server/drive/processing';

type Params = { params: Promise<{ id: string }> };

export const dynamic = 'force-dynamic';

/**
 * GET /api/drive/files/[id]/extraction
 *
 * The plain text we read out of a file, or an honest account of why there is
 * none.
 *
 * This used to answer 404 "This file has not been read yet" for everything
 * without an extraction row, which covered several unrelated situations under
 * one sentence: waiting in the queue, being read right now, failed, and never
 * going to be read as text at all. A PDF synced from Google Drive and sitting
 * in the queue looked identical to a PNG that no extractor will ever claim.
 *
 * The order below matters. "Queued" is only true for a file something is
 * actually going to come back for; saying it about an image, or about a file
 * whose bytes we never kept, is the same lie in a new place — those sit at
 * `pending` for ever because nothing will ever claim them.
 *
 * Scoped like every other Drive read: another company's file id gives 404, not
 * a different answer.
 */
export async function GET(_request: Request, { params }: Params) {
  return withDriveScope(async (scope) => {
    const { id } = await params;

    const state = await getProcessingState(scope, id);

    // No such file, for this company or at all. The same answer either way.
    if (!state) {
      return Response.json(
        { error: 'not_found', message: 'That file could not be found.' },
        { status: 404, headers: noStore },
      );
    }

    // What the Brain made of it, worth returning alongside every answer below:
    // a file with no text is not a file nothing knows anything about.
    const visual = state.visual
      ? {
          understoodAs: state.visual.kind,
          understandingStatus: state.visual.status,
          ...(state.visual.pages > 0
            ? {
                pages: state.visual.pages,
                pagesUnderstood: state.visual.pagesUnderstood,
                posts: state.visual.posts,
              }
            : {}),
        }
      : {};

    const extraction = await getExtraction(scope, id);
    if (extraction && extraction.content.trim().length > 0) {
      return Response.json({ ...extraction, ...visual }, { headers: noStore });
    }

    // Nothing will ever claim it for text. Not an error, and not a wait.
    if (!state.extractable) {
      return Response.json(
        {
          status: 'not_extracted',
          message:
            `CIP does not read .${state.fileType} files as text. ` +
            (state.visual
              ? 'It looks at them instead.'
              : 'It looks at them instead, and has not yet.'),
          fileType: state.fileType,
          ...visual,
        },
        { status: 404, headers: noStore },
      );
    }

    // Read without being kept, so there are no bytes here to extract from. The
    // Brain fetched it from its source, understood it, and let it go.
    if (!state.retained) {
      return Response.json(
        {
          status: 'not_extracted',
          message:
            'This file was too large to keep, so it was read without being stored. ' +
            'What CIP learned from it is kept; the original is not.',
          fileType: state.fileType,
          ...visual,
        },
        { status: 404, headers: noStore },
      );
    }

    if (state.status === 'failed') {
      return Response.json(
        {
          status: 'failed',
          message: state.error ?? 'This file could not be read.',
          fileType: state.fileType,
          attempts: state.attempts,
          ...visual,
        },
        { status: 422, headers: noStore },
      );
    }

    // Genuinely waiting or in flight. A 202 says "ask again", which is true,
    // where a 404 says "there will never be anything here", which is not.
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
          ...visual,
        },
        { status: 202, headers: noStore },
      );
    }

    // Extracted, and there was no text in it. Common and expected for a PDF of
    // screenshots, which is exactly the case the visual pass exists for.
    return Response.json(
      {
        status: 'no_text',
        message: state.visual
          ? 'This file has no text layer, so it was read by looking at it instead.'
          : 'This file was read and contained no text.',
        fileType: state.fileType,
        ...visual,
      },
      { status: 404, headers: noStore },
    );
  });
}
