import 'server-only';
import { adminSql } from '../db-admin';

/**
 * What a call to a model cost, written down.
 *
 * Prices are US dollars per million tokens as the provider publishes them, so
 * a figure here is an estimate of the bill, not the bill. CIP_AI_PRICES, a JSON
 * object of the same shape, replaces any of them without a release.
 */
type Price = { input: number; cached: number; output: number };

const PRICES: Record<string, Price> = {
  'gpt-5-mini': { input: 0.25, cached: 0.025, output: 2.0 },
  'gpt-5': { input: 1.25, cached: 0.125, output: 10.0 },
  'gpt-5-nano': { input: 0.05, cached: 0.005, output: 0.4 },
  // Image models bill text and image input apart; the image rate is used for
  // both here, which can only overstate.
  'gpt-image-1': { input: 10.0, cached: 2.5, output: 40.0 },
  'gpt-image-2': { input: 10.0, cached: 2.5, output: 40.0 },
  'text-embedding-3-small': { input: 0.02, cached: 0.02, output: 0 },
};

function priceFor(model: string): Price | null {
  let overrides: Record<string, Price> = {};
  try {
    overrides = JSON.parse(process.env.CIP_AI_PRICES ?? '{}') as Record<string, Price>;
  } catch {
    overrides = {};
  }
  const table = { ...PRICES, ...overrides };
  // "gpt-5-mini-2025-08-07" is priced as gpt-5-mini.
  const key = Object.keys(table)
    .filter((name) => model === name || model.startsWith(`${name}-`))
    .sort((a, b) => b.length - a.length)[0];
  return key ? table[key]! : null;
}

export type UsageRecord = {
  feature: string;
  model: string;
  inputTokens: number;
  cachedTokens?: number;
  outputTokens: number;
  reasoningTokens?: number;
};

export function costOf(record: UsageRecord): number {
  const price = priceFor(record.model);
  if (!price) return 0;
  const cached = Math.min(record.cachedTokens ?? 0, record.inputTokens);
  return (
    ((record.inputTokens - cached) * price.input + cached * price.cached + record.outputTokens * price.output) /
    1_000_000
  );
}

/**
 * Records one call. Never throws and never holds the caller up for long: a
 * failure to write down what was spent must not cost the work it paid for.
 */
export async function recordUsage(record: UsageRecord): Promise<void> {
  if (process.env.CIP_RECORD_AI_USAGE === 'false') return;
  let sql: ReturnType<typeof adminSql> | null = null;
  try {
    sql = adminSql();
    await sql`
      insert into ai_usage (feature, model, input_tokens, cached_tokens, output_tokens, reasoning_tokens, cost_usd)
      values (${record.feature.slice(0, 60)}, ${record.model.slice(0, 80)}, ${Math.round(record.inputTokens)},
              ${Math.round(record.cachedTokens ?? 0)}, ${Math.round(record.outputTokens)},
              ${Math.round(record.reasoningTokens ?? 0)}, ${costOf(record)})
    `;
  } catch {
    // Not recorded. The call itself went through.
  } finally {
    await sql?.end().catch(() => {});
  }
}

export type SpendSummary = {
  /** This calendar month, in US dollars. */
  month: number;
  byFeature: { feature: string; usd: number; calls: number }[];
  /** Share of input tokens the provider served from its cache. */
  cachedShare: number;
};

/** What has been spent this month, biggest first. */
export async function spendThisMonth(): Promise<SpendSummary> {
  const sql = adminSql();
  try {
    const rows = await sql<{ feature: string; usd: string; calls: number; input: string; cached: string }[]>`
      select feature, sum(cost_usd)::text as usd, count(*)::int as calls,
             sum(input_tokens)::text as input, sum(cached_tokens)::text as cached
        from ai_usage
       where created_at >= date_trunc('month', now())
       group by feature
       order by sum(cost_usd) desc
    `;
    const input = rows.reduce((n, r) => n + Number(r.input), 0);
    const cached = rows.reduce((n, r) => n + Number(r.cached), 0);
    return {
      month: rows.reduce((n, r) => n + Number(r.usd), 0),
      byFeature: rows.map((r) => ({ feature: r.feature, usd: Number(r.usd), calls: r.calls })),
      cachedShare: input > 0 ? cached / input : 0,
    };
  } catch {
    return { month: 0, byFeature: [], cachedShare: 0 };
  } finally {
    await sql.end();
  }
}
