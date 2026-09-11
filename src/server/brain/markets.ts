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
 * Words too common to say anything about where a request belongs.
 *
 * Not a language model's stopword list — a short one aimed at the sentences
 * people actually type here. Anything longer starts discarding real signal.
 */
const NOT_A_SIGNAL = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'make', 'create', 'design',
  'post', 'image', 'video', 'banner', 'poster', 'story', 'reel', 'carousel',
  'billboard', 'please', 'need', 'want', 'some', 'something', 'new', 'about',
  'brand', 'bottle', 'product', 'social', 'media', 'campaign', 'ad', 'ads',
  'banao', 'karo', 'chahiye', 'wala', 'wali', 'hai', 'mein', 'kar', 'bana',
]);

/** The words in a request that could plausibly point at one market. */
function signalsIn(requestText: string): string[] {
  const seen = new Set<string>();
  for (const raw of requestText.toLowerCase().split(/[^a-z0-9]+/)) {
    // Three letters or fewer is noise at this scale; "eid" is the exception
    // worth keeping and it is three, so the bar is set below it.
    if (raw.length < 3 || NOT_A_SIGNAL.has(raw)) continue;
    seen.add(raw);
    if (seen.size >= 12) break;
  }
  return [...seen];
}

/**
 * The market a request is about, worked out from what each market's own files
 * actually contain.
 *
 * Naming the country is the easy case and `marketInRequest` already handles
 * it. This is the other one: "a Diwali post" names no country and obviously
 * means India, and being asked to pick from a list is the software admitting
 * it did not read its own knowledge.
 *
 * So the request's words are looked for in each market's assets, and a word
 * only counts when it appears in one market and not the others. Diwali is in
 * the India deck and nowhere else, so it decides; a bottle is in all three and
 * decides nothing. Nothing here is hardcoded about festivals or cities — the
 * vocabulary is whatever this company's own files happen to contain, so it is
 * right for their markets rather than for a general idea of the world.
 *
 * Returns null rather than guessing. A weak signal is worse than a question:
 * the caller asks, exactly as it did before.
 */
export async function marketFromEvidence(
  scope: CompanyScope,
  requestText: string,
  markets: readonly string[],
): Promise<string | null> {
  if (markets.length < 2) return null;

  const terms = signalsIn(requestText);
  if (terms.length === 0) return null;

  const rows = await withCompanyScope(scope, async (tx) =>
    tx<{ market: string; score: number; terms: number }[]>`
      with term as (
        select unnest(${terms}::text[]) as word
      ),
      -- Two places a word can be found, and both count. What an asset says is
      -- the raw material; a Brand DNA fact is what CIP concluded from it, and
      -- a conclusion is the better signal of the two — so neither is dropped.
      seen as (
        select f.market, f.id as file_id, t.word
          from drive_files f
          join asset_understanding u
            on u.file_id = f.id and u.company_id = f.company_id
          cross join term t
         where f.company_id = ${scope.companyId}
           and f.archived_at is null
           and f.market is not null
           and f.market = any(${[...markets]}::text[])
           and u.status = 'ready'
           and (
             u.summary ilike '%' || t.word || '%'
             or coalesce(u.extracted_text, '') ilike '%' || t.word || '%'
           )

        union

        select f.market, f.id as file_id, t.word
          from brand_dna_facts b
          join brand_dna_evidence e
            on e.fact_id = b.id and e.company_id = b.company_id
          join drive_files f
            on f.id = e.file_id and f.company_id = e.company_id
          cross join term t
         where b.company_id = ${scope.companyId}
           and b.status = 'active'
           and f.archived_at is null
           and f.market is not null
           and f.market = any(${[...markets]}::text[])
           and (
             b.value ilike '%' || t.word || '%'
             or b.attribute ilike '%' || t.word || '%'
           )
      ),
      hit as (
        -- Counted per market and per word by distinct file, so one enormous
        -- document cannot outvote a market.
        select market, word, count(distinct file_id)::int as files
          from seen group by market, word
      ),
      distinctive as (
        -- A word seen in every market says nothing about which one this is.
        select word from hit group by word having count(distinct market) = 1
      )
      select h.market, sum(h.files)::int as score, count(*)::int as terms
        from hit h join distinctive d on d.word = h.word
       group by h.market
       order by score desc, terms desc, h.market
    `,
  );

  const [best, next] = rows;
  if (!best || best.score === 0) return null;

  // A clear winner, or nothing. Two markets that both half-match a request is
  // the case the question exists for, and answering it anyway would be the
  // silent averaging this whole module was written to prevent.
  if (next && next.score * 2 > best.score) return null;

  return best.market;
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
