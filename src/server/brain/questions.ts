import 'server-only';
import { withCompanyScope, type CompanyScope } from '../db';

/**
 * What CIP has found and cannot settle on its own - two briefs that disagree,
 * a line nobody has approved - put to a person, with what CIP would suggest.
 * An answer is kept with the question and the question leaves the list.
 */
export type OpenQuestion = { id: string; question: string; context: string; suggestion: string };

export async function openQuestions(scope: CompanyScope): Promise<OpenQuestion[]> {
  return withCompanyScope(scope, (tx) => tx<OpenQuestion[]>`
    select id, question, context, suggestion from brand_confirmations
     where company_id = ${scope.companyId} and answered_at is null
     order by sort_order
  `);
}

export class QuestionRejected extends Error {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function answerQuestion(scope: CompanyScope, id: string, raw: unknown): Promise<boolean> {
  if (scope.role === 'viewer') throw new QuestionRejected('Viewers cannot answer for the brand.');
  const answer = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().slice(0, 500) : '';
  if (!answer) throw new QuestionRejected('Write an answer first.');
  if (!UUID.test(id)) return false;
  const rows = await withCompanyScope(scope, (tx) => tx`
    update brand_confirmations set answer = ${answer}, answered_at = now()
     where id = ${id} and company_id = ${scope.companyId} and answered_at is null
    returning id
  `);
  return rows.length > 0;
}
