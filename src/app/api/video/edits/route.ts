import { noStore, withBrainScope } from '@/server/brain/http';
import { createEdit, listEdits } from '@/server/video/edit';
import { pumpInBackground } from '@/server/jobs/pump';

/**
 * /api/video/edits
 *
 * GET   the company's video edits, newest first
 * POST  { fileId, doctorName, doctorTitle, hospitalLine, givenPlan, brollIds } - hear a
 *       recording and plan its edit; givenPlan is on-screen text already written,
 *       brollIds the footage already chosen for it; autoMake skips the review
 *       unless a block may break a rule
 */
export const dynamic = 'force-dynamic';
/** Hearing a recording of a few minutes, then planning it. */
export const maxDuration = 300;

export async function GET() {
  return withBrainScope(async (scope) => Response.json({ edits: await listEdits(scope) }, { headers: noStore }));
}

export async function POST(request: Request) {
  return withBrainScope(async (scope) => {
    const body = (await request.json().catch(() => ({}))) as {
      fileId?: unknown; doctorName?: unknown; doctorTitle?: unknown; hospitalLine?: unknown; givenPlan?: unknown; brollIds?: unknown; autoMake?: unknown;
    };
    const text = (v: unknown) => (typeof v === 'string' ? v : null);
    const edit = await createEdit(scope, {
      fileId: String(body.fileId ?? ''),
      doctorName: String(body.doctorName ?? ''),
      doctorTitle: text(body.doctorTitle),
      hospitalLine: text(body.hospitalLine),
      givenPlan: text(body.givenPlan),
      brollIds: Array.isArray(body.brollIds) ? body.brollIds.map(String).slice(0, 30) : [],
      autoMake: body.autoMake === true,
    });
    // Made by the next pump pass; nudged now so nobody waits a quarter of an hour.
    if (edit.status === 'approved') pumpInBackground();
    return Response.json({ edit }, { status: 201, headers: noStore });
  });
}
