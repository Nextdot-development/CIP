import 'server-only';
import { withCompanyScope } from '../db';
import type { CompanyScope } from '../db';
import { CheckRejected, getCheck } from './checker';
import { runQc } from './qc';
import type { QcVerdict } from './qc';

/**
 * The accuracy test set.
 *
 * A reviewer marks creatives CIP has checked as ones that should pass or
 * should be flagged. The set can then be checked again whenever anything
 * changes, and the answer is a number - eighteen of twenty right - instead of
 * a feeling. A change that makes the checker worse shows up the same day.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type BenchmarkExpected = 'pass' | 'flag';

export type BenchmarkDTO = {
  id: string;
  fileId: string;
  fileName: string;
  page: number;
  brand: string | null;
  market: string | null;
  expected: BenchmarkExpected;
  /** The rules it should be flagged for, in words. */
  expectedRules: string[];
  note: string | null;
  /** What the newest run made of it, if it was in one. */
  last: { got: 'pass' | 'flag' | 'error'; correct: boolean; checkId: string | null; missed: string[]; extra: string[]; error: string | null } | null;
};

export type BenchmarkRunDTO = {
  id: string;
  at: string;
  total: number;
  done: number;
  correct: number;
};

export type BenchmarkSummary = {
  items: BenchmarkDTO[];
  /** The newest run, however far it got. */
  lastRun: BenchmarkRunDTO | null;
};

/** What a check's verdict counts as against "should pass" and "should be flagged". */
export function verdictAs(verdict: QcVerdict): 'pass' | 'flag' | 'error' {
  if (verdict === 'pass') return 'pass';
  if (verdict === 'fix' || verdict === 'review') return 'flag';
  return 'error';
}

/**
 * Adds a checked creative to the set, with the right answer a person gave.
 *
 * "Should be flagged" takes the rules its standing flags cite - the ones
 * nobody disputed - as the rules it breaks. A later run that flags it for
 * something else has not got it right.
 */
export async function addBenchmark(
  scope: CompanyScope,
  input: { checkId: string; page?: number | null; expected: BenchmarkExpected; note?: string | null },
): Promise<BenchmarkSummary> {
  if (input.expected !== 'pass' && input.expected !== 'flag') {
    throw new CheckRejected('Say whether it should pass or be flagged.');
  }
  const check = await getCheck(scope, input.checkId);
  if (!check) throw new CheckRejected('That check is not in this workspace.');
  if (!check.fileId) throw new CheckRejected('Only an uploaded creative can go in the test set.');

  const page = Number.isInteger(input.page) && input.page! >= 1 ? input.page! : 1;
  const ruleIds =
    input.expected === 'flag'
      ? [...new Set(
          check.flags
            .filter((f) => f.status !== 'disputed' && f.severity !== 'note' && f.citedRule)
            .map((f) => f.citedRule!.id),
        )]
      : [];

  await withCompanyScope(scope, (tx) => tx`
    insert into qc_benchmarks (company_id, file_id, page, brand, market, expected, expected_rule_ids, note, added_by)
    values (${scope.companyId}, ${check.fileId}, ${page}, ${check.brand}, ${check.market},
            ${input.expected}, ${ruleIds}::uuid[], ${input.note?.trim().slice(0, 500) || null}, ${scope.userId})
    on conflict (company_id, file_id, page) do update
       set expected = excluded.expected, expected_rule_ids = excluded.expected_rule_ids,
           brand = excluded.brand, market = excluded.market, note = excluded.note
  `);
  return listBenchmarks(scope);
}

export async function removeBenchmark(scope: CompanyScope, id: string): Promise<BenchmarkSummary> {
  if (!UUID.test(id)) throw new CheckRejected('That is not in the test set.');
  await withCompanyScope(scope, (tx) => tx`
    delete from qc_benchmarks where id = ${id} and company_id = ${scope.companyId}
  `);
  return listBenchmarks(scope);
}

export async function listBenchmarks(scope: CompanyScope): Promise<BenchmarkSummary> {
  return withCompanyScope(scope, async (tx) => {
    const runs = await tx<{ id: string; created_at: Date; total: number; done: number; correct: number }[]>`
      select r.id, r.created_at, r.total,
             count(x.id)::int as done,
             count(x.id) filter (where x.correct)::int as correct
        from qc_benchmark_runs r
        left join qc_benchmark_results x on x.run_id = r.id and x.company_id = r.company_id
       where r.company_id = ${scope.companyId}
       group by r.id
       order by r.created_at desc
       limit 1
    `;
    const run = runs[0] ?? null;

    const rows = await tx<{
      id: string; file_id: string; file_name: string; page: number; brand: string | null; market: string | null;
      expected: BenchmarkExpected; expected_rules: string[] | null; note: string | null;
      got: 'pass' | 'flag' | 'error' | null; correct: boolean | null; check_id: string | null;
      missed: string[] | null; extra_flags: string[] | null; error_message: string | null;
    }[]>`
      select b.id, b.file_id, f.name as file_name, b.page, b.brand, b.market, b.expected, b.note,
             (select array_agg(r.rule order by r.rule) from compliance_rules r
               where r.id = any(b.expected_rule_ids) and r.company_id = b.company_id) as expected_rules,
             x.got, x.correct, x.check_id, x.extra_flags, x.error_message,
             (select array_agg(r.rule order by r.rule) from compliance_rules r
               where r.id = any(x.missed_rule_ids) and r.company_id = b.company_id) as missed
        from qc_benchmarks b
        join drive_files f on f.id = b.file_id and f.company_id = b.company_id
        left join qc_benchmark_results x
          on x.benchmark_id = b.id and x.company_id = b.company_id and x.run_id = ${run?.id ?? null}
       where b.company_id = ${scope.companyId}
       order by b.created_at
    `;

    return {
      lastRun: run
        ? { id: run.id, at: run.created_at.toISOString(), total: run.total, done: run.done, correct: run.correct }
        : null,
      items: rows.map((r) => ({
        id: r.id,
        fileId: r.file_id,
        fileName: r.file_name,
        page: r.page,
        brand: r.brand,
        market: r.market,
        expected: r.expected,
        expectedRules: r.expected_rules ?? [],
        note: r.note,
        last: r.got
          ? {
              got: r.got,
              correct: r.correct ?? false,
              checkId: r.check_id,
              missed: r.missed ?? [],
              extra: r.extra_flags ?? [],
              error: r.error_message,
            }
          : null,
      })),
    };
  });
}

/** Starts a run over the whole set. The caller checks each one, a request apiece. */
export async function startBenchmarkRun(scope: CompanyScope): Promise<{ runId: string; ids: string[] }> {
  return withCompanyScope(scope, async (tx) => {
    const items = await tx<{ id: string }[]>`
      select id from qc_benchmarks where company_id = ${scope.companyId} order by created_at
    `;
    if (items.length === 0) throw new CheckRejected('The test set is empty. Mark a checked creative as should pass or should be flagged first.');
    const [run] = await tx<{ id: string }[]>`
      insert into qc_benchmark_runs (company_id, started_by, total)
      values (${scope.companyId}, ${scope.userId}, ${items.length})
      returning id
    `;
    return { runId: run!.id, ids: items.map((i) => i.id) };
  });
}

/**
 * Checks one creative of a run, exactly as the QC page would, and records
 * whether it got the answer the person gave.
 */
export async function runBenchmarkItem(
  scope: CompanyScope,
  runId: string,
  benchmarkId: string,
): Promise<{ correct: boolean }> {
  if (!UUID.test(runId) || !UUID.test(benchmarkId)) throw new CheckRejected('That is not in the test set.');
  const [item] = await withCompanyScope(scope, (tx) => tx<{
    file_id: string; page: number; brand: string | null; market: string | null;
    expected: BenchmarkExpected; expected_rule_ids: string[];
  }[]>`
    select b.file_id, b.page, b.brand, b.market, b.expected, b.expected_rule_ids
      from qc_benchmarks b
      join qc_benchmark_runs r on r.id = ${runId} and r.company_id = b.company_id
     where b.id = ${benchmarkId} and b.company_id = ${scope.companyId}
  `);
  if (!item) throw new CheckRejected('That is not in the test set.');

  let got: 'pass' | 'flag' | 'error' = 'error';
  let checkId: string | null = null;
  let missed: string[] = [];
  let extra: string[] = [];
  let error: string | null = null;
  try {
    const report = await runQc(scope, { fileId: item.file_id, page: item.page, brand: item.brand, market: item.market });
    checkId = report.check.id;
    got = verdictAs(report.verdict);
    const standing = [...report.mustFix, ...report.toReview];
    const flaggedRules = new Set(
      standing.flatMap((f) => [f.citedRule?.id, ...f.alsoRules.map((r) => r.id)]).filter((id): id is string => Boolean(id)),
    );
    missed = item.expected_rule_ids.filter((id) => !flaggedRules.has(id));
    extra = standing
      .filter((f) => !f.citedRule || !item.expected_rule_ids.includes(f.citedRule.id))
      .map((f) => f.message.slice(0, 200));
  } catch (failure) {
    error = failure instanceof Error ? failure.message.slice(0, 300) : 'It could not be checked.';
  }

  // Right means the verdict the person gave, and - for one that should be
  // flagged - every rule they said it breaks.
  const correct = got === item.expected && missed.length === 0;
  await withCompanyScope(scope, (tx) => tx`
    insert into qc_benchmark_results
      (company_id, run_id, benchmark_id, expected, got, correct, check_id, missed_rule_ids, extra_flags, error_message)
    values (${scope.companyId}, ${runId}, ${benchmarkId}, ${item.expected}, ${got}, ${correct}, ${checkId},
            ${missed}::uuid[], ${extra}::text[], ${error})
    on conflict (run_id, benchmark_id) do update
       set got = excluded.got, correct = excluded.correct, check_id = excluded.check_id,
           missed_rule_ids = excluded.missed_rule_ids, extra_flags = excluded.extra_flags,
           error_message = excluded.error_message
  `);
  return { correct };
}
