import { noStore, withBrainScope } from '@/server/brain/http';
import { approveEdit, getEdit, updatePlan } from '@/server/video/edit';
import type { EditPlan } from '@/server/video/edit';
import { pumpInBackground } from '@/server/jobs/pump';

type Params = { params: Promise<{ id: string }> };

export const dynamic = 'force-dynamic';

const notFound = () =>
  Response.json({ error: 'not_found', message: 'That edit is not in this workspace.' }, { status: 404, headers: noStore });

/** GET one edit, with its plan. */
export async function GET(_request: Request, { params }: Params) {
  return withBrainScope(async (scope) => {
    const edit = await getEdit(scope, (await params).id);
    return edit ? Response.json({ edit }, { headers: noStore }) : notFound();
  });
}

/** PATCH { plan } - a person's changes to the plan. */
export async function PATCH(request: Request, { params }: Params) {
  return withBrainScope(async (scope) => {
    const body = (await request.json().catch(() => ({}))) as { plan?: EditPlan };
    if (!body.plan) return Response.json({ error: 'rejected', message: 'Send the plan.' }, { status: 422, headers: noStore });
    return Response.json({ edit: await updatePlan(scope, (await params).id, body.plan) }, { headers: noStore });
  });
}

/** POST { action: "approve" } - the plan is read; make the film. */
export async function POST(request: Request, { params }: Params) {
  return withBrainScope(async (scope) => {
    const body = (await request.json().catch(() => ({}))) as { action?: unknown };
    if (body.action !== 'approve') return Response.json({ error: 'rejected', message: 'Unknown action.' }, { status: 422, headers: noStore });
    const edit = await approveEdit(scope, (await params).id);
    // Made by the next pump pass; nudged now so nobody waits a quarter of an hour.
    pumpInBackground();
    return Response.json({ edit }, { headers: noStore });
  });
}
