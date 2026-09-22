import 'server-only';
import { withCompanyScope } from '../db';
import type { CompanyScope } from '../db';
import { driveStorage } from '../drive/storage';
import { profilePdf } from '../drive/extraction/pdfRender';
import { readBrandDna } from './brandDna';
import { runCheck, rulesForBrief } from './checker';
import type { CheckFlag, CreativeCheck, RuleSource } from './checker';
import { BRAIN_LIMITS } from './providers/types';

/**
 * Creative QC: the same check, reported the way a reviewer needs to read it.
 *
 * The Consistency Check answers "what is wrong with this". A person about to
 * send work to a client needs three answers, not one: what is wrong, what was
 * looked at and found right, and what a machine should not be deciding alone.
 *
 * Nothing here judges anything. It is a second view of a check that has already
 * been grounded - every flag still cites a rule or a fact that was actually
 * sent, and the score is still worked out from the flags rather than asked of
 * the model. What this adds is the part the checker never said out loud.
 *
 * WHY "PASSED" IS WORTH SAYING
 *
 * A report that lists only failures cannot be told apart from a report that
 * found nothing because it was given nothing to look for. "Checked 27 rules,
 * 24 passed" and "checked nothing, found nothing" both print as a clean bill of
 * health, and only one of them is one. Passed rules are named here for that
 * reason, and `rulesConsidered` is shown next to them.
 */

export type QcVerdict = 'pass' | 'fix' | 'review' | 'nothing_to_check';

export type QcReport = {
  check: CreativeCheck;
  verdict: QcVerdict;
  /**
   * Rules that applied to this creative and raised no flag.
   *
   * Absence of a flag is weaker evidence than a flag: the model looked and did
   * not object. It is still worth printing, because it says what the check
   * covered.
   */
  passed: { id: string; rule: string; source: RuleSource; verified: boolean }[];
  /** Flags that must be fixed: they cite something a person has confirmed. */
  mustFix: CheckFlag[];
  /**
   * Flags a person should look at rather than act on.
   *
   * A rule CIP suggested that nobody has verified can raise a question. It
   * cannot condemn a creative on its own, so it is separated here rather than
   * mixed in with the rules the company actually stands behind.
   */
  toReview: CheckFlag[];
  counts: { rulesApplied: number; factsApplied: number; passed: number; flagged: number };
};

export async function runQc(
  scope: CompanyScope,
  input: { fileId?: string | null; generationId?: string | null; assetId?: string | null; brand?: string | null; market?: string | null; page?: number | null },
): Promise<QcReport> {
  const check = await runCheck(scope, input);
  return reportOn(scope, check);
}

/** The reviewer's view of a check that has already run. */
export async function reportOn(scope: CompanyScope, check: CreativeCheck): Promise<QcReport> {
  const rules = await rulesForBrief(scope, { brand: check.brand, market: check.market });

  const verifiedById = new Map(rules.map((r) => [r.id, r.verifiedAt !== null]));
  const flaggedRuleIds = new Set(
    check.flags.map((flag) => flag.citedRule?.id).filter((id): id is string => Boolean(id)),
  );

  const passed = rules
    .filter((rule) => !flaggedRuleIds.has(rule.id))
    .map((rule) => ({
      id: rule.id,
      rule: rule.rule,
      source: rule.source,
      verified: rule.verifiedAt !== null,
    }));

  // A disputed or accepted flag has been dealt with by a person and is not
  // waiting on anybody.
  const open = check.flags.filter((flag) => flag.status === 'open');

  const advisory = (flag: CheckFlag): boolean => {
    if (!flag.citedRule) return false;
    return flag.citedRule.source === 'suggested' && verifiedById.get(flag.citedRule.id) !== true;
  };

  const mustFix = open.filter((flag) => !advisory(flag));
  const toReview = open.filter(advisory);

  return {
    check,
    verdict: verdictFor(check, mustFix, toReview),
    passed,
    mustFix,
    toReview,
    counts: {
      rulesApplied: check.rulesConsidered,
      factsApplied: check.factsConsidered,
      passed: passed.length,
      flagged: open.length,
    },
  };
}

/**
 * The one word at the top.
 *
 * `nothing_to_check` exists because it is the honest answer far more often than
 * anyone expects. A company with no rules written down and no brand facts
 * learned yet gets a clean report from any checker, and that report means
 * nothing at all. Saying so is the difference between a tool and a rubber stamp.
 */
function verdictFor(check: CreativeCheck, mustFix: CheckFlag[], toReview: CheckFlag[]): QcVerdict {
  if (check.rulesConsidered === 0 && check.factsConsidered === 0) return 'nothing_to_check';
  if (mustFix.length > 0) return 'fix';
  if (toReview.length > 0) return 'review';
  return 'pass';
}

/**
 * How many pages there are to look at.
 *
 * One for a picture. For a PDF, what the document says it has — a deck is
 * checked page by page, because a rule broken on page nine is not found by
 * looking at page one, and checking only the first page of a fourteen-page
 * deck and reporting "nothing to fix" is worse than not checking at all.
 */
export async function pageCountFor(scope: CompanyScope, fileId: string): Promise<number> {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID.test(fileId)) return 1;

  const rows = await withCompanyScope(scope, (tx) =>
    tx<{ mime_type: string; storage_path: string | null }[]>`
      select mime_type, storage_path from drive_files
       where id = ${fileId} and company_id = ${scope.companyId} and archived_at is null
    `,
  );
  const file = rows[0];
  if (!file || file.mime_type.toLowerCase() !== 'application/pdf' || !file.storage_path) return 1;

  const body = await driveStorage().get(file.storage_path);
  const profile = await profilePdf(body);
  return Math.max(1, profile.pageCount);
}

/**
 * What CIP knows about this brand, said plainly.
 *
 * Printed beside the verdict so a reviewer can see how much the verdict rests
 * on before trusting it.
 */
export async function coverageFor(
  scope: CompanyScope,
  context: { brand?: string | null; market?: string | null },
): Promise<{ rules: number; verifiedRules: number; facts: number }> {
  const [rules, facts] = await Promise.all([
    rulesForBrief(scope, context),
    readBrandDna(scope, {
      brand: context.brand ?? null,
      market: context.market ?? null,
      limit: 200,
      minEvidence: BRAIN_LIMITS.factMinEvidence,
    }),
  ]);

  return {
    rules: rules.length,
    verifiedRules: rules.filter((r) => r.verifiedAt !== null).length,
    facts: facts.length,
  };
}
