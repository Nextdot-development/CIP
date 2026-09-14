import 'server-only';
import { withCompanyScope } from '../db';
import type { CompanyScope } from '../db';
import { adminSql } from '../db-admin';
import { driveStorage } from '../drive/storage';
import { readAsset } from '../media/generation';
import { readBrandDna } from './brandDna';
import { fitForVision } from './fitImage';
import { brain } from './providers';
import { BRAIN_LIMITS, BrainFailed } from './providers/types';
import type { CheckDimension, CheckFinding, CheckRule } from './providers/types';

/**
 * The Consistency & Compliance Checker.
 *
 * CIP could make a picture and could not look at one and say whether it was
 * right. This does: a creative is scored against what CIP has learned about
 * the brand and against the rules its category has to obey, and every flag
 * says which of those it came from.
 *
 * Three things keep it honest.
 *
 * A flag must cite a rule that was actually sent. The model is handed short
 * refs - F1, R3 - and a finding naming anything else is thrown away. A flag
 * grounded in nothing is exactly the ungrounded output this product exists
 * not to produce, and the schema alone cannot stop a model inventing one.
 *
 * The score is worked out here, from the flags, never asked of the model. A
 * number a model reports about its own judgement is a number it chose.
 *
 * A reviewer can disagree, and say which way. "This asset is a legitimate
 * exception" changes nothing CIP believes. "This rule is wrong" does - it
 * rejects the fact, or retires a rule CIP suggested - because a person said
 * so. A brain that only ever grows and cannot be corrected drifts.
 */

export class CheckRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CheckRejected';
  }
}

export type RuleCategory = 'disclaimer' | 'audience' | 'claim' | 'placement' | 'medium' | 'other';
export type RuleSource = 'manual' | 'regulation' | 'suggested';

export type ComplianceRule = {
  id: string;
  brand: string | null;
  market: string | null;
  category: RuleCategory;
  requirement: 'required' | 'forbidden';
  rule: string;
  note: string | null;
  referenceUrl: string | null;
  source: RuleSource;
  active: boolean;
};

export type NewComplianceRule = {
  rule: string;
  requirement: 'required' | 'forbidden';
  category?: RuleCategory;
  brand?: string | null;
  market?: string | null;
  note?: string | null;
  referenceUrl?: string | null;
  source?: RuleSource;
};

export type CheckFlag = {
  id: string;
  dimension: CheckDimension;
  severity: 'critical' | 'warning' | 'note';
  message: string;
  /** What the flag was judged against. Exactly one of these is set. */
  citedFact: { id: string; attribute: string; value: string; brand: string | null } | null;
  citedRule: { id: string; rule: string; source: RuleSource; referenceUrl: string | null } | null;
  status: 'open' | 'accepted' | 'disputed';
  disputeReason: 'exception' | 'wrong_rule' | null;
  correction: string | null;
};

export type CreativeCheck = {
  id: string;
  fileId: string | null;
  generationId: string | null;
  /** The display name of what was checked. */
  subject: string;
  brand: string | null;
  market: string | null;
  status: 'pending' | 'ready' | 'failed';
  score: number | null;
  visualScore: number | null;
  verbalScore: number | null;
  complianceScore: number | null;
  summary: string | null;
  /** How much the score stands on. A perfect score against nothing is not a pass. */
  factsConsidered: number;
  rulesConsidered: number;
  errorMessage: string | null;
  createdAt: string;
  flags: CheckFlag[];
};

/**
 * What each finding costs a dimension.
 *
 * A critical finding is a missing mandatory warning or a forbidden element in
 * the frame. Two of those and a dimension is at twenty, which is where it
 * belongs.
 */
const PENALTY = { critical: 40, warning: 15, note: 5 } as const;

/**
 * The most a creative can score while it breaks a compliance requirement.
 *
 * An average hides the one thing that matters most: a banner that is perfectly
 * on-brand and missing its statutory warning must not come back as a 73. It
 * fails, whatever else is true of it.
 */
const COMPLIANCE_FAIL_CEILING = 49;

/** Facts sent per check. Enough to judge a brand, few enough to stay legible. */
const MAX_FACTS = 40;

const SEVERITY_RANK = { note: 0, warning: 1, critical: 2 } as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHECKABLE_IMAGES = new Set(['image/png', 'image/jpeg', 'image/webp']);

/**
 * Scores worked out from the flags that still stand.
 *
 * A dimension nothing was judged against scores null, not a hundred - there
 * was nothing to fail, which is a different thing from passing.
 */
export function scoreFrom(
  flags: { dimension: CheckDimension; severity: CheckFinding['severity'] }[],
  judged: Record<CheckDimension, boolean>,
): { score: number | null; visual: number | null; verbal: number | null; compliance: number | null } {
  const dimension = (name: CheckDimension): number | null => {
    if (!judged[name]) return null;
    const lost = flags
      .filter((f) => f.dimension === name)
      .reduce((sum, f) => sum + PENALTY[f.severity], 0);
    return Math.max(0, 100 - lost);
  };

  const visual = dimension('visual');
  const verbal = dimension('verbal');
  const compliance = dimension('compliance');

  const present = [visual, verbal, compliance].filter((v): v is number => v !== null);
  if (present.length === 0) return { score: null, visual, verbal, compliance };

  let score = Math.round(present.reduce((a, b) => a + b, 0) / present.length);
  if (flags.some((f) => f.dimension === 'compliance' && f.severity === 'critical')) {
    score = Math.min(score, COMPLIANCE_FAIL_CEILING);
  }
  return { score, visual, verbal, compliance };
}

/** Where a ref came from, so a finding can be checked against it. */
type RefTarget =
  | { kind: 'fact'; id: string; dimension: CheckDimension; requirement: 'observed' }
  | { kind: 'rule'; id: string; dimension: 'compliance'; requirement: 'required' | 'forbidden' };

/**
 * Keeps only findings that are about something CIP actually sent.
 *
 * Exported for the tests, because this is the part of the checker that stands
 * between a model's imagination and a reviewer's screen.
 */
export function groundFindings(
  findings: CheckFinding[],
  refs: Map<string, RefTarget>,
): (CheckFinding & { target: RefTarget })[] {
  const kept = new Map<string, CheckFinding & { target: RefTarget }>();

  for (const raw of findings) {
    const ref = typeof raw.ref === 'string' ? raw.ref.trim() : '';
    const target = refs.get(ref);
    // A ref nobody sent: a rule the model made up. Discarded, not reported.
    if (!target) continue;

    const message = typeof raw.message === 'string' ? raw.message.trim().slice(0, 400) : '';
    if (message.length === 0) continue;

    let severity: CheckFinding['severity'] =
      raw.severity === 'critical' || raw.severity === 'warning' ? raw.severity : 'note';
    // What a brand has usually done is not what it must do. Departing from an
    // observed pattern is at most a warning, whatever the model called it.
    if (target.requirement === 'observed' && severity === 'critical') severity = 'warning';

    const finding = {
      ref,
      // The dimension comes from what the ref is, never from what the model
      // said it was, so a compliance rule cannot be quietly filed as visual.
      dimension: target.dimension,
      severity,
      message,
      target,
    };

    // One flag per rule, the most severe of whatever was said about it.
    const existing = kept.get(ref);
    if (!existing || SEVERITY_RANK[severity] > SEVERITY_RANK[existing.severity]) {
      kept.set(ref, finding);
    }
  }

  return [...kept.values()];
}

/** The bytes of a file, including one read from Google Drive without being kept. */
async function fileBytes(
  scope: CompanyScope,
  file: { id: string; storage_path: string | null },
): Promise<Buffer> {
  if (file.storage_path) return driveStorage().get(file.storage_path);

  const sql = adminSql();
  let externalId: string | undefined;
  try {
    const rows = await sql<{ external_id: string }[]>`
      select external_id from google_drive_files
       where file_id = ${file.id} and company_id = ${scope.companyId}
       limit 1
    `;
    externalId = rows[0]?.external_id;
  } finally {
    await sql.end();
  }
  if (!externalId) {
    throw new CheckRejected('That file was read without being kept, and its source is no longer known.');
  }

  const { requireConnected } = await import('../integrations/googleDrive/connection');
  const { googleDrive } = await import('../integrations/googleDrive');
  const connection = await requireConnected(scope);
  return googleDrive().download(connection.accessToken, externalId);
}

/** What is being checked, resolved to bytes and to the brand it is for. */
async function resolveSubject(
  scope: CompanyScope,
  input: { fileId?: string | null; generationId?: string | null; assetId?: string | null },
): Promise<{
  fileId: string | null;
  generationId: string | null;
  subject: string;
  bytes: Buffer;
  mimeType: string;
  brand: string | null;
  market: string | null;
}> {
  const fileId = input.fileId?.trim() || null;
  const generationId = input.generationId?.trim() || null;

  if ((fileId === null) === (generationId === null)) {
    throw new CheckRejected('Choose one creative to check: an uploaded file or something CIP made.');
  }

  if (fileId) {
    if (!UUID.test(fileId)) throw new CheckRejected('That file is not in this workspace.');
    const rows = await withCompanyScope(scope, (tx) =>
      tx<{ id: string; name: string; mime_type: string; storage_path: string | null; brand: string | null; market: string | null }[]>`
        select id, name, mime_type, storage_path, brand, market
          from drive_files
         where id = ${fileId} and company_id = ${scope.companyId} and archived_at is null
      `,
    );
    const file = rows[0];
    if (!file) throw new CheckRejected('That file is not in this workspace.');
    if (!CHECKABLE_IMAGES.has(file.mime_type.toLowerCase())) {
      throw new CheckRejected('Only images can be checked for now: PNG, JPEG or WebP.');
    }
    return {
      fileId: file.id,
      generationId: null,
      subject: file.name,
      bytes: await fileBytes(scope, file),
      mimeType: file.mime_type,
      brand: file.brand,
      market: file.market,
    };
  }

  if (!UUID.test(generationId!)) throw new CheckRejected('That creative is not in this workspace.');
  const asset = await readAsset(scope, generationId!, input.assetId ?? null);
  if (!CHECKABLE_IMAGES.has(asset.mimeType.toLowerCase())) {
    throw new CheckRejected('Only images can be checked for now.');
  }

  // The brief that produced it already knows which brand and market it was for.
  const briefs = await withCompanyScope(scope, (tx) =>
    tx<{ brand: string | null; market: string | null }[]>`
      select brief->>'brand' as brand, brief->>'market' as market
        from generation_briefs
       where generation_id = ${generationId} and company_id = ${scope.companyId}
       order by created_at desc
       limit 1
    `,
  );

  return {
    fileId: null,
    generationId,
    subject: `Generated creative ${generationId!.slice(0, 8)}`,
    bytes: asset.bytes,
    mimeType: asset.mimeType,
    brand: briefs[0]?.brand ?? null,
    market: briefs[0]?.market ?? null,
  };
}

/**
 * Checks one creative, start to finish.
 *
 * The provider call happens between two short transactions rather than inside
 * one: a check is written as pending first, so a failure mid-call leaves a
 * record that says it failed rather than nothing at all.
 */
export async function runCheck(
  scope: CompanyScope,
  input: {
    fileId?: string | null;
    generationId?: string | null;
    assetId?: string | null;
    brand?: string | null;
    market?: string | null;
  },
): Promise<CreativeCheck> {
  const provider = brain();
  if (!provider.configured) {
    throw new BrainFailed('NOT_CONFIGURED', 'permanent', 'The Brain is not configured.');
  }

  const subject = await resolveSubject(scope, input);
  // A reviewer's choice wins; otherwise what the file or the brief already says.
  const brand = input.brand?.trim() || subject.brand;
  const market = input.market?.trim() || subject.market;

  // What the brand has consistently done. Patterns only - a single observation
  // is not something a creative can be faulted for departing from.
  const facts = (
    await readBrandDna(scope, {
      brand,
      market,
      limit: MAX_FACTS,
      minEvidence: BRAIN_LIMITS.factMinEvidence,
    })
  ).filter((f) => f.section !== 'video');

  // What the category requires. Rules about where and when an advert may run
  // cannot be judged from a picture, so they are never sent to be judged.
  const rules = await withCompanyScope(scope, (tx) =>
    tx<{ id: string; rule: string; requirement: 'required' | 'forbidden' }[]>`
      select id, rule, requirement
        from compliance_rules
       where company_id = ${scope.companyId}
         and active
         and category <> 'medium'
         and (brand is null or brand = ${brand})
         and (market is null or market = ${market})
       order by requirement, rule
    `,
  );

  const refs = new Map<string, RefTarget>();
  const sent: CheckRule[] = [];
  facts.forEach((fact, index) => {
    const ref = `F${index + 1}`;
    const dimension: CheckDimension = fact.section === 'content' ? 'verbal' : 'visual';
    refs.set(ref, { kind: 'fact', id: fact.id, dimension, requirement: 'observed' });
    sent.push({ ref, dimension, requirement: 'observed', statement: `${fact.attribute}: ${fact.value}` });
  });
  rules.forEach((rule, index) => {
    const ref = `R${index + 1}`;
    refs.set(ref, { kind: 'rule', id: rule.id, dimension: 'compliance', requirement: rule.requirement });
    sent.push({ ref, dimension: 'compliance', requirement: rule.requirement, statement: rule.rule });
  });

  const judged: Record<CheckDimension, boolean> = {
    visual: sent.some((r) => r.dimension === 'visual'),
    verbal: sent.some((r) => r.dimension === 'verbal'),
    compliance: sent.some((r) => r.dimension === 'compliance'),
  };

  const created = await withCompanyScope(scope, (tx) =>
    tx<{ id: string }[]>`
      insert into creative_checks
        (company_id, file_id, generation_id, brand, market, status,
         facts_considered, rules_considered, provider, model, created_by)
      values
        (${scope.companyId}, ${subject.fileId}, ${subject.generationId}, ${brand}, ${market},
         'pending', ${facts.length}, ${rules.length}, ${provider.name}, ${provider.model},
         ${scope.userId})
      returning id
    `,
  );
  const checkId = created[0]!.id;

  let analysis;
  try {
    const fitted = await fitForVision(subject.bytes, subject.mimeType);
    analysis = await provider.checkCreative({
      bytes: fitted.bytes,
      mimeType: fitted.mimeType,
      filename: subject.subject,
      brand,
      market,
      rules: sent,
    });
  } catch (error) {
    const failure =
      error instanceof BrainFailed
        ? error
        : new BrainFailed('PROVIDER_ERROR', 'transient', 'The creative could not be checked.');
    await withCompanyScope(scope, (tx) => tx`
      update creative_checks
         set status = 'failed', error_code = ${failure.code}, error_message = ${failure.message},
             completed_at = now()
       where id = ${checkId} and company_id = ${scope.companyId}
    `);
    throw failure;
  }

  const grounded = groundFindings(analysis.findings, refs);
  const scores = scoreFrom(grounded, judged);

  let summary = analysis.summary.slice(0, 600) || null;
  if (sent.length === 0) {
    summary = 'Nothing to check against yet: CIP holds no established patterns or rules for this brand and market.';
  }

  await withCompanyScope(scope, async (tx) => {
    for (const finding of grounded) {
      await tx`
        insert into check_flags
          (company_id, check_id, dimension, severity, message, fact_id, rule_id)
        values
          (${scope.companyId}, ${checkId}, ${finding.dimension}, ${finding.severity}, ${finding.message},
           ${finding.target.kind === 'fact' ? finding.target.id : null},
           ${finding.target.kind === 'rule' ? finding.target.id : null})
      `;
    }
    await tx`
      update creative_checks
         set status = 'ready', summary = ${summary},
             score = ${scores.score}, visual_score = ${scores.visual},
             verbal_score = ${scores.verbal}, compliance_score = ${scores.compliance},
             completed_at = now()
       where id = ${checkId} and company_id = ${scope.companyId}
    `;
  });

  return (await getCheck(scope, checkId))!;
}

/** One check with its flags, and what each flag was judged against. */
export async function getCheck(scope: CompanyScope, checkId: string): Promise<CreativeCheck | null> {
  if (!UUID.test(checkId)) return null;

  return withCompanyScope(scope, async (tx) => {
    const checks = await tx<{
      id: string; file_id: string | null; generation_id: string | null; subject: string | null;
      brand: string | null; market: string | null; status: CreativeCheck['status'];
      score: number | null; visual_score: number | null; verbal_score: number | null;
      compliance_score: number | null; summary: string | null; facts_considered: number;
      rules_considered: number; error_message: string | null; created_at: Date;
    }[]>`
      select c.id, c.file_id, c.generation_id, f.name as subject, c.brand, c.market, c.status,
             c.score, c.visual_score, c.verbal_score, c.compliance_score, c.summary,
             c.facts_considered, c.rules_considered, c.error_message, c.created_at
        from creative_checks c
        left join drive_files f on f.id = c.file_id and f.company_id = c.company_id
       where c.id = ${checkId} and c.company_id = ${scope.companyId}
    `;
    const check = checks[0];
    if (!check) return null;

    const flags = await tx<{
      id: string; dimension: CheckDimension; severity: CheckFlag['severity']; message: string;
      fact_id: string | null; fact_attribute: string | null; fact_value: string | null; fact_brand: string | null;
      rule_id: string | null; rule_text: string | null; rule_source: RuleSource | null; rule_url: string | null;
      status: CheckFlag['status']; dispute_reason: CheckFlag['disputeReason']; correction: string | null;
    }[]>`
      select g.id, g.dimension, g.severity, g.message,
             g.fact_id, b.attribute as fact_attribute, b.value as fact_value, b.brand as fact_brand,
             g.rule_id, r.rule as rule_text, r.source as rule_source, r.reference_url as rule_url,
             g.status, g.dispute_reason, g.correction
        from check_flags g
        left join brand_dna_facts b on b.id = g.fact_id and b.company_id = g.company_id
        left join compliance_rules r on r.id = g.rule_id and r.company_id = g.company_id
       where g.check_id = ${checkId} and g.company_id = ${scope.companyId}
       order by case g.severity when 'critical' then 0 when 'warning' then 1 else 2 end,
                g.dimension, g.created_at
    `;

    return {
      id: check.id,
      fileId: check.file_id,
      generationId: check.generation_id,
      subject: check.subject ?? (check.generation_id ? `Generated creative ${check.generation_id.slice(0, 8)}` : 'Creative'),
      brand: check.brand,
      market: check.market,
      status: check.status,
      score: check.score,
      visualScore: check.visual_score,
      verbalScore: check.verbal_score,
      complianceScore: check.compliance_score,
      summary: check.summary,
      factsConsidered: check.facts_considered,
      rulesConsidered: check.rules_considered,
      errorMessage: check.error_message,
      createdAt: check.created_at.toISOString(),
      flags: flags.map((g) => ({
        id: g.id,
        dimension: g.dimension,
        severity: g.severity,
        message: g.message,
        citedFact: g.fact_id
          ? { id: g.fact_id, attribute: g.fact_attribute ?? '', value: g.fact_value ?? '', brand: g.fact_brand }
          : null,
        citedRule: g.rule_id
          ? { id: g.rule_id, rule: g.rule_text ?? '', source: g.rule_source ?? 'manual', referenceUrl: g.rule_url }
          : null,
        status: g.status,
        disputeReason: g.dispute_reason,
        correction: g.correction,
      })),
    };
  });
}

/** Recent checks, newest first, without their flags. */
export async function listChecks(
  scope: CompanyScope,
  limit = 30,
): Promise<Omit<CreativeCheck, 'flags'>[]> {
  return withCompanyScope(scope, async (tx) => {
    const rows = await tx<{
      id: string; file_id: string | null; generation_id: string | null; subject: string | null;
      brand: string | null; market: string | null; status: CreativeCheck['status'];
      score: number | null; visual_score: number | null; verbal_score: number | null;
      compliance_score: number | null; summary: string | null; facts_considered: number;
      rules_considered: number; error_message: string | null; created_at: Date;
    }[]>`
      select c.id, c.file_id, c.generation_id, f.name as subject, c.brand, c.market, c.status,
             c.score, c.visual_score, c.verbal_score, c.compliance_score, c.summary,
             c.facts_considered, c.rules_considered, c.error_message, c.created_at
        from creative_checks c
        left join drive_files f on f.id = c.file_id and f.company_id = c.company_id
       where c.company_id = ${scope.companyId}
       order by c.created_at desc
       limit ${Math.min(Math.max(limit, 1), 100)}
    `;
    return rows.map((c) => ({
      id: c.id,
      fileId: c.file_id,
      generationId: c.generation_id,
      subject: c.subject ?? (c.generation_id ? `Generated creative ${c.generation_id.slice(0, 8)}` : 'Creative'),
      brand: c.brand,
      market: c.market,
      status: c.status,
      score: c.score,
      visualScore: c.visual_score,
      verbalScore: c.verbal_score,
      complianceScore: c.compliance_score,
      summary: c.summary,
      factsConsidered: c.facts_considered,
      rulesConsidered: c.rules_considered,
      errorMessage: c.error_message,
      createdAt: c.created_at.toISOString(),
    }));
  });
}

export type Correction =
  | { decision: 'accept' }
  | { decision: 'dispute'; reason: 'exception' | 'wrong_rule'; correction?: string | null };

/** What a correction changed in what CIP believes, if anything. */
export type Learned = 'fact_rejected' | 'rule_retired' | 'rule_kept' | null;

/**
 * A reviewer agreeing or disagreeing with one flag.
 *
 * Disputed flags stop counting against the score. Beyond that, only "this rule
 * is wrong" changes what CIP believes, and even then a rule that came from a
 * regulator is kept: one reviewer disagreeing with a statutory requirement is
 * recorded, not obeyed, because the regulator did not change its mind.
 */
export async function correctFlag(
  scope: CompanyScope,
  flagId: string,
  correction: Correction,
): Promise<{ check: CreativeCheck; learned: Learned }> {
  if (!UUID.test(flagId)) throw new CheckRejected('That flag is not in this workspace.');

  const outcome = await withCompanyScope(scope, async (tx) => {
    const rows = await tx<{
      check_id: string; fact_id: string | null; rule_id: string | null; rule_source: RuleSource | null;
    }[]>`
      select g.check_id, g.fact_id, g.rule_id, r.source as rule_source
        from check_flags g
        left join compliance_rules r on r.id = g.rule_id and r.company_id = g.company_id
       where g.id = ${flagId} and g.company_id = ${scope.companyId}
    `;
    const flag = rows[0];
    if (!flag) throw new CheckRejected('That flag is not in this workspace.');

    let learned: Learned = null;

    if (correction.decision === 'accept') {
      await tx`
        update check_flags
           set status = 'accepted', dispute_reason = null, correction = null,
               corrected_by = ${scope.userId}, corrected_at = now()
         where id = ${flagId} and company_id = ${scope.companyId}
      `;
    } else {
      if (correction.reason !== 'exception' && correction.reason !== 'wrong_rule') {
        throw new CheckRejected('Say whether this creative is an exception, or the rule itself is wrong.');
      }
      const note = correction.correction?.trim().slice(0, 600) || null;
      await tx`
        update check_flags
           set status = 'disputed', dispute_reason = ${correction.reason}, correction = ${note},
               corrected_by = ${scope.userId}, corrected_at = now()
         where id = ${flagId} and company_id = ${scope.companyId}
      `;

      if (correction.reason === 'wrong_rule') {
        if (flag.fact_id) {
          // A person said the brand does not actually do this. Nothing
          // automatic ever overturns a rejection.
          await tx`
            update brand_dna_facts set status = 'rejected', updated_at = now()
             where id = ${flag.fact_id} and company_id = ${scope.companyId}
          `;
          learned = 'fact_rejected';
        } else if (flag.rule_id) {
          if (flag.rule_source === 'regulation') {
            learned = 'rule_kept';
          } else {
            await tx`
              update compliance_rules set active = false, updated_at = now()
               where id = ${flag.rule_id} and company_id = ${scope.companyId}
            `;
            learned = 'rule_retired';
          }
        }
      }
    }

    // Re-score from the flags that still stand. A dimension that was not judged
    // before is not judged now: its score stays null.
    const check = await tx<{ visual_score: number | null; verbal_score: number | null; compliance_score: number | null }[]>`
      select visual_score, verbal_score, compliance_score from creative_checks
       where id = ${flag.check_id} and company_id = ${scope.companyId}
    `;
    const standing = await tx<{ dimension: CheckDimension; severity: CheckFinding['severity'] }[]>`
      select dimension, severity from check_flags
       where check_id = ${flag.check_id} and company_id = ${scope.companyId} and status <> 'disputed'
    `;
    const current = check[0]!;
    const scores = scoreFrom(standing, {
      visual: current.visual_score !== null,
      verbal: current.verbal_score !== null,
      compliance: current.compliance_score !== null,
    });
    await tx`
      update creative_checks
         set score = ${scores.score}, visual_score = ${scores.visual},
             verbal_score = ${scores.verbal}, compliance_score = ${scores.compliance}
       where id = ${flag.check_id} and company_id = ${scope.companyId}
    `;

    return { checkId: flag.check_id, learned };
  });

  return { check: (await getCheck(scope, outcome.checkId))!, learned: outcome.learned };
}

// --- compliance rules --------------------------------------------------------

/** Every rule, active first, grouped the way a reviewer reads them. */
export async function listRules(scope: CompanyScope): Promise<ComplianceRule[]> {
  return withCompanyScope(scope, async (tx) => {
    const rows = await tx<{
      id: string; brand: string | null; market: string | null; category: RuleCategory;
      requirement: 'required' | 'forbidden'; rule: string; note: string | null;
      reference_url: string | null; source: RuleSource; active: boolean;
    }[]>`
      select id, brand, market, category, requirement, rule, note, reference_url, source, active
        from compliance_rules
       where company_id = ${scope.companyId}
       order by active desc, market nulls first, brand nulls first, category, rule
    `;
    return rows.map((r) => ({
      id: r.id,
      brand: r.brand,
      market: r.market,
      category: r.category,
      requirement: r.requirement,
      rule: r.rule,
      note: r.note,
      referenceUrl: r.reference_url,
      source: r.source,
      active: r.active,
    }));
  });
}

/**
 * Adds one rule, or refreshes it.
 *
 * Idempotent on the rule, brand and market, so loading a market's rules twice
 * leaves one of each. A rule a reviewer retired is not brought back by a reload
 * - the retirement was a decision, and a seed script is not.
 */
export async function addComplianceRule(scope: CompanyScope, input: NewComplianceRule): Promise<boolean> {
  const rule = input.rule.trim().slice(0, 500);
  if (rule.length === 0) throw new CheckRejected('A rule needs some words in it.');
  if (input.requirement !== 'required' && input.requirement !== 'forbidden') {
    throw new CheckRejected('A rule is either something required or something forbidden.');
  }

  return withCompanyScope(scope, async (tx) => {
    const rows = await tx<{ id: string }[]>`
      insert into compliance_rules
        (company_id, brand, market, category, requirement, rule, note, reference_url, source, created_by)
      values
        (${scope.companyId}, ${input.brand?.trim() || null}, ${input.market?.trim() || null},
         ${input.category ?? 'other'}, ${input.requirement}, ${rule},
         ${input.note?.trim() || null}, ${input.referenceUrl?.trim() || null},
         ${input.source ?? 'manual'}, ${scope.userId})
      on conflict (company_id, rule, coalesce(brand, ''), coalesce(market, ''))
        do update set
          category = excluded.category,
          requirement = excluded.requirement,
          note = coalesce(excluded.note, compliance_rules.note),
          reference_url = coalesce(excluded.reference_url, compliance_rules.reference_url),
          updated_at = now()
      returning id
    `;
    return rows.length > 0;
  });
}
