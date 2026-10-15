import { noStore, withBrainScope } from '@/server/brain/http';
import { approveEdit, deleteEdit, getEdit, previewEdit, updatePlan } from '@/server/video/edit';
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

/** PATCH { plan, makeVertical? } - a person's changes to the plan. */
export async function PATCH(request: Request, { params }: Params) {
  return withBrainScope(async (scope) => {
    const body = (await request.json().catch(() => ({}))) as { plan?: EditPlan; makeVertical?: unknown };
    if (!body.plan) return Response.json({ error: 'rejected', message: 'Send the plan.' }, { status: 422, headers: noStore });
    const makeVertical = typeof body.makeVertical === 'boolean' ? body.makeVertical : undefined;
    return Response.json({ edit: await updatePlan(scope, (await params).id, body.plan, { makeVertical }) }, { headers: noStore });
  });
}

/** DELETE - remove the film and its plan. */
export async function DELETE(_request: Request, { params }: Params) {
  return withBrainScope(async (scope) => {
    await deleteEdit(scope, (await params).id);
    return Response.json({ ok: true }, { headers: noStore });
  });
}

/**
 * POST { action: "approve" } - the plan is read; make the film.
 * POST { action: "preview" } - a quick rough cut of the plan as it stands, made now.
 */
export const maxDuration = 300;

export async function POST(request: Request, { params }: Params) {
  return withBrainScope(async (scope) => {
    const body = (await request.json().catch(() => ({}))) as { action?: unknown };
    if (body.action === 'preview') return Response.json({ edit: await previewEdit(scope, (await params).id) }, { headers: noStore });
    if (body.action !== 'approve') return Response.json({ error: 'rejected', message: 'Unknown action.' }, { status: 422, headers: noStore });
    const edit = await approveEdit(scope, (await params).id);
    // Made by the next pump pass; nudged now so nobody waits a quarter of an hour.
    pumpInBackground();
    return Response.json({ edit }, { headers: noStore });
  });
}
