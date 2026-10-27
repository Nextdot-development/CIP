import { noStore, withBrainScope } from '@/server/brain/http';
import { factEvidence, judgeFact, readBrandDna } from '@/server/brain/brandDna';
import type { BrandSection } from '@/server/brain/brandDna';

/**
 * GET /api/brain/brand-dna
 *
 * The company's own Brand DNA. ?factId= returns the assets that support one
 * fact instead, which is what makes a claim auditable rather than asserted.
 */
export const dynamic = 'force-dynamic';

const SECTIONS = ['visual', 'video', 'content', 'rules'] as const;

export async function GET(request: Request) {
  return withBrainScope(async (scope) => {
    const params = new URL(request.url).searchParams;

    const factId = params.get('factId');
    if (factId) {
      return Response.json({ evidence: await factEvidence(scope, factId) }, { headers: noStore });
    }

    const sectionParam = params.get('section');
    const section = (SECTIONS as readonly string[]).includes(sectionParam ?? '')
      ? (sectionParam as BrandSection)
      : null;
    const minEvidence = Number(params.get('minEvidence'));

    const facts = await readBrandDna(scope, {
      section,
      minEvidence: Number.isFinite(minEvidence) && minEvidence > 0 ? minEvidence : 1,
      limit: 200,
    });

    return Response.json({ facts }, { headers: noStore });
  });
}

/**
 * POST /api/brain/brand-dna  { factId, verdict: 'right' | 'wrong' | 'clear' }
 *
 * A person's word on one fact: confirmed, rejected, or taken back. Only ever
 * a fact of the session's own company - the scope decides which rows exist.
 */
export async function POST(request: Request) {
  return withBrainScope(async (scope) => {
    const body = (await request.json().catch(() => null)) as { factId?: unknown; verdict?: unknown } | null;
    const factId = typeof body?.factId === 'string' ? body.factId : '';
    const verdict = body?.verdict;
    if (verdict !== 'right' && verdict !== 'wrong' && verdict !== 'clear') {
      return Response.json({ error: 'invalid', message: 'verdict must be right, wrong or clear.' }, { status: 400, headers: noStore });
    }
    const fact = await judgeFact(scope, factId, verdict);
    if (!fact) return Response.json({ error: 'not_found', message: 'No such fact.' }, { status: 404, headers: noStore });
    return Response.json({ fact }, { headers: noStore });
  });
}
