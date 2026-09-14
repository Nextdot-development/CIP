import { noStore, withBrainScope } from '@/server/brain/http';
import { addComplianceRule, listRules } from '@/server/brain/checker';
import type { RuleCategory } from '@/server/brain/checker';

/**
 * /api/brain/compliance
 *
 * GET  every compliance rule this company is checked against.
 * POST add one. Rules added here are "manual"; a reviewer can later retire one
 * by disputing a flag it raised, which is not true of a rule from a regulator.
 */
export const dynamic = 'force-dynamic';

const CATEGORIES: RuleCategory[] = ['disclaimer', 'audience', 'claim', 'placement', 'medium', 'other'];

export async function GET() {
  return withBrainScope(async (scope) => {
    return Response.json({ rules: await listRules(scope) }, { headers: noStore });
  });
}

export async function POST(request: Request) {
  return withBrainScope(async (scope) => {
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return Response.json(
        { error: 'INVALID_REQUEST', message: 'Send a JSON body.' },
        { status: 400, headers: noStore },
      );
    }

    const str = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value : null);
    const requirement = body.requirement === 'forbidden' ? 'forbidden' : body.requirement === 'required' ? 'required' : null;
    if (!requirement || !str(body.rule)) {
      return Response.json(
        { error: 'INVALID_REQUEST', message: 'A rule needs its wording, and whether it is required or forbidden.' },
        { status: 400, headers: noStore },
      );
    }

    await addComplianceRule(scope, {
      rule: str(body.rule)!,
      requirement,
      category: CATEGORIES.includes(body.category as RuleCategory) ? (body.category as RuleCategory) : 'other',
      brand: str(body.brand),
      market: str(body.market),
      note: str(body.note),
      referenceUrl: str(body.referenceUrl),
      source: 'manual',
    });
    return Response.json({ rules: await listRules(scope) }, { status: 201, headers: noStore });
  });
}
