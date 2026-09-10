import 'server-only';
import { withCompanyScope } from '../db';
import type { CompanyScope } from '../db';

/**
 * Which market a piece of knowledge belongs to.
 *
 * A brand that sells in several countries does not have one look. Magic
 * Moments' three decks differ in palette, composition and call to action, and
 * a brief drawn from all three at once produces an average of three markets —
 * which is a thing no market wants.
 *
 * The market is a property of the file, not of what is printed on it. Every
 * one of the 275 posts read back with country null, correctly: nothing on a
 * grid of thumbnails says which country it is for. The filename does, and so
 * does whoever uploaded it.
 *
 * So it is suggested from the filename where that is unambiguous, and shown
 * where it can be corrected. A guess made visible is a different thing from an
 * inference made silently, and only the first is safe to act on.
 */

/**
 * Names worth recognising in a filename.
 *
 * Deliberately short and explicit. This is not geocoding: it exists so that
 * three files called after three countries do not have to be labelled by hand,
 * and every match it makes is offered for correction rather than applied out
 * of sight. Anything not on this list simply has no suggestion.
 */
const KNOWN_MARKETS: { market: string; patterns: RegExp }[] = [
  { market: 'India', patterns: /\b(india|indian|bharat)\b/i },
  { market: 'Europe', patterns: /\b(europe|european|eu)\b/i },
  { market: 'Nigeria', patterns: /\b(nigeria|nigerian)\b/i },
  { market: 'UAE', patterns: /\b(uae|dubai|emirates)\b/i },
  { market: 'UK', patterns: /\b(uk|britain|british)\b/i },
  { market: 'USA', patterns: /\b(usa|us|america|american)\b/i },
  { market: 'Singapore', patterns: /\b(singapore|sg)\b/i },
  { market: 'Kenya', patterns: /\b(kenya|kenyan)\b/i },
  { market: 'South Africa', patterns: /\b(south[\s-]?africa|za)\b/i },
  { market: 'Australia', patterns: /\b(australia|australian|aus)\b/i },
];

/**
 * The market a filename suggests, if it clearly suggests one.
 *
 * The extension is dropped first so `India.pdf` matches on `India` rather than
 * having to allow for a dot. Two matches means no match: a file called
 * "india-vs-europe.pdf" is about both and belongs to neither.
 */
export function marketFromFilename(filename: string): string | null {
  const stem = filename.replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ');
  const hits = KNOWN_MARKETS.filter((entry) => entry.patterns.test(stem));
  return hits.length === 1 ? hits[0]!.market : null;
}

export type MarketSummary = {
  market: string;
  /** Files belonging to it. */
  files: number;
  /** Distinct Brand DNA facts its files produced. */
  facts: number;
};

/**
 * The markets this company actually has knowledge about, largest first.
 *
 * Only markets with a file behind them. An empty list means nobody has said
 * where anything belongs, and the Brain should not start asking about markets
 * that do not exist.
 */
export async function companyMarkets(scope: CompanyScope): Promise<MarketSummary[]> {
  return withCompanyScope(scope, async (tx) => {
    const rows = await tx<{ market: string; files: number; facts: number }[]>`
      select f.market,
             count(distinct f.id)::int      as files,
             count(distinct e.fact_id)::int as facts
        from drive_files f
        left join brand_dna_evidence e
          on e.file_id = f.id and e.company_id = f.company_id
       where f.company_id = ${scope.companyId}
         and f.archived_at is null
         and f.market is not null
       group by f.market
       order by files desc, f.market
    `;
    return rows;
  });
}

/**
 * The market a request names, if it names one this company has.
 *
 * Matched against the company's own markets rather than the whole list, so
 * "make it for Kenya" only counts when there is Kenyan knowledge to draw on.
 * Otherwise the Brain would confidently claim a market it knows nothing about.
 */
export function marketInRequest(requestText: string, markets: readonly string[]): string | null {
  const text = requestText.toLowerCase();

  for (const market of markets) {
    const entry = KNOWN_MARKETS.find((known) => known.market === market);
    if (entry?.patterns.test(text)) return market;
    // A market somebody typed in themselves is matched on its own name.
    if (!entry && text.includes(market.toLowerCase())) return market;
  }

  return null;
}

/**
 * Sets, or clears, which market a file belongs to.
 *
 * Answers false when no such file belongs to this company, so the caller can
 * say "not found" without first loading the file's bytes to prove it exists.
 */
export async function setFileMarket(
  scope: CompanyScope,
  fileId: string,
  market: string | null,
): Promise<boolean> {
  const value = market?.trim().slice(0, 60) || null;

  return withCompanyScope(scope, async (tx) => {
    const rows = await tx<{ id: string }[]>`
      update drive_files
         set market = ${value}, updated_at = now()
       where id = ${fileId} and company_id = ${scope.companyId} and archived_at is null
      returning id
    `;
    return rows.length > 0;
  });
}

/**
 * Fills in a suggestion for files nobody has labelled.
 *
 * Only where the file has no market yet, so it never overwrites a correction.
 * Returns what it changed, so a caller can say so rather than the labels
 * simply appearing.
 */
export async function suggestMarkets(
  scope: CompanyScope,
): Promise<{ fileId: string; name: string; market: string }[]> {
  return withCompanyScope(scope, async (tx) => {
    const unlabelled = await tx<{ id: string; name: string }[]>`
      select id, name from drive_files
       where company_id = ${scope.companyId} and archived_at is null and market is null
    `;

    const changed: { fileId: string; name: string; market: string }[] = [];

    for (const file of unlabelled) {
      const market = marketFromFilename(file.name);
      if (!market) continue;

      await tx`
        update drive_files set market = ${market}, updated_at = now()
         where id = ${file.id} and company_id = ${scope.companyId}
      `;
      changed.push({ fileId: file.id, name: file.name, market });
    }

    return changed;
  });
}
