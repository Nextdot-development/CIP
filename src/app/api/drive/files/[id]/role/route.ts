import { withDriveScope, noStore } from '@/server/drive/http';
import { getKnowledgeRole, setKnowledgeRole } from '@/server/drive/knowledgeRole';
import type { KnowledgeRole } from '@/server/drive/knowledgeRole';

type Params = { params: Promise<{ id: string }> };

export const dynamic = 'force-dynamic';

const ROLES: readonly KnowledgeRole[] = ['brand', 'market', 'reference'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** GET /api/drive/files/[id]/role - what the file is read as, and whether a person chose it. */
export async function GET(_request: Request, { params }: Params) {
  return withDriveScope(async (scope) => {
    const { id } = await params;
    const found = UUID.test(id) ? await getKnowledgeRole(scope, id) : null;
    if (!found) return Response.json({ error: 'not_found', message: 'That file is not in this workspace.' }, { status: 404, headers: noStore });
    return Response.json(found, { headers: noStore });
  });
}

/** PUT /api/drive/files/[id]/role  { role: 'brand' | 'market' | 'reference' } */
export async function PUT(request: Request, { params }: Params) {
  return withDriveScope(async (scope) => {
    const { id } = await params;
    const body = (await request.json().catch(() => ({}))) as { role?: unknown };
    const role = ROLES.find((r) => r === body.role);
    if (!role) {
      return Response.json({ error: 'rejected', message: 'Choose brand, market or reference.' }, { status: 422, headers: noStore });
    }
    const ok = UUID.test(id) && (await setKnowledgeRole(scope, id, role));
    if (!ok) return Response.json({ error: 'not_found', message: 'That file is not in this workspace.' }, { status: 404, headers: noStore });
    return Response.json({ role, chosen: true }, { headers: noStore });
  });
}
