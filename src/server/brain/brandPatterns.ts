import type { BrandFactDTO } from './brandDna';

/**
 * The brand's patterns that a creative can fairly be held to, out of all it
 * has been seen to do.
 *
 * Brand DNA is read off every file the company has - posts, packshots, and
 * the investor deck - so it holds a great deal that is not a standard at all:
 * "documentType: Investor Presentation", the axis label of a chart, one
 * campaign's headline, the volume printed on one bottle, a colour code from a
 * white slide. And it holds the same thing several ways, often in
 * contradiction: "headline case: all caps" from fifty posts beside "Title
 * case" from eleven and "sentence case" from three. Sent to the checker, each
 * of those became a flag - "the cap should read WHYTEHALL" on a Magic Moments
 * post, "use a solid black background" on a sunset - and sent to a brief,
 * each pulled the picture a different way.
 *
 * So, before either sees them: what is not a design standard is set aside;
 * the same attribute said several ways is counted as one; where the brand
 * plainly does one thing - twice as often as anything else - that is the
 * pattern, and where it does not, there is no pattern to hold anyone to. A
 * brand's own pattern stands in for the house's on the same attribute.
 */

/**
 * Attributes that describe a document, one file or one campaign - never a
 * standard. Nor does what is printed on the pack: the pack is the approved
 * pack, compared with its own photographs, not a pattern posts follow - and
 * read off one flavour's bottle, "flavour text: Lemongrass & Ginger" faulted
 * every other flavour's post. Nor the people in one campaign, nor the legal
 * lines, which are rules of their own.
 */
const NOT_A_STANDARD =
  /document|axis|chart|graph|table|slide|page|section|^title$|subtitle|contact|e-?mail|phone|website|url|address|company|^brand$|content type|callout|orientation|format|aspect|resolution|dimension|volume|liquid|text ?colou?r|\btext\b|subtext|wordmark|tagline|slogan|^copy$|caption|date|price|ingredient|abv|alcohol|country|bottle|label|\bcap\b|pack|flavour|descriptor|\bmark\b|model|person|people|clothing|outfit|statutory|warning|disclaimer|^headline$|(primary|featured|hero) product/;

/** Attribute names that mean the same thing. */
function attributeKey(attribute: string): string {
  const a = attribute
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[_/-]+/g, ' ')
    .replace(/\(.*?\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (/^background( colou?r)?$/.test(a)) return 'background';
  if (/^(font|typeface|typography)\b/.test(a)) return 'font';
  return a;
}

/** Values that mean the same thing: "Solid black background" is "black", "upper third centred" is "top centre". */
function valueKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/\(.*?\)/g, '')
    .replace(/\b(solid|background|colou?r|corner|the|a)\b/g, ' ')
    .replace(/\bcent(?:er|red|ered|ral)\b/g, 'centre')
    .replace(/\bupper( third)?\b/g, 'top')
    .replace(/\blower( third)?\b/g, 'bottom')
    .replace(/[^a-z0-9#%+ ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * What the whole house can be held to, across brands that look nothing alike:
 * where its logo goes and how big, how its headlines are set, its palette
 * when it is named in words (a colour code is dropped above). Not a background
 * or where a bottle stands - those are each brand's own, and a house-wide
 * "black background" is mostly packshots on black.
 */
const HOUSE_STANDARD = /^(logo|headline|font|palette)\b/;

/** Words copied off a creative: mostly capitals, or a sequence drawn with arrows. */
function isQuotedCopy(value: string): boolean {
  if (/[→>]/.test(value)) return true;
  const letters = value.replace(/[^A-Za-z]/g, '');
  const capitals = value.replace(/[^A-Z]/g, '');
  return value.trim().split(/\s+/).length >= 2 && letters.length >= 6 && capitals.length / letters.length > 0.6;
}

/** How much more often the brand must do one thing than the next for it to be its pattern. */
const CLEAR_LEAD = 2;

export function standingPatterns(
  facts: BrandFactDTO[],
  brand: string | null,
  /**
   * For judging a creative: only what can be seen to be met or not - a short
   * value, not a mood board. "Recurring visual language: black; ivory; gold;
   * crest; crown; filigree; ..." is good context for making a picture and no
   * use for failing one, which it would do for any item it lacks.
   */
  options: { forChecking?: boolean } = {},
): BrandFactDTO[] {
  const groups = new Map<string, BrandFactDTO[]>();
  for (const fact of facts) {
    // Another brand's way of doing things is not this one's - and with no
    // brand known, only the house's own.
    if (fact.brand !== null && fact.brand !== brand) continue;
    const key = `${fact.section}:${attributeKey(fact.attribute)}`;
    if (NOT_A_STANDARD.test(attributeKey(fact.attribute))) continue;
    // A bare colour code is one file's pixels, not a palette anyone chose.
    if (/^#?[0-9a-f]{6}$/i.test(fact.value.trim())) continue;
    if (options.forChecking && (fact.value.length > 60 || (fact.value.match(/[;,]/g) ?? []).length >= 3)) continue;
    // One campaign's own words, quoted - "UNDERRATED. UNAPOLOGETIC." - are that
    // campaign's, not what the next post must say.
    if (!/case|font|placement|scale|size/.test(attributeKey(fact.attribute)) && isQuotedCopy(fact.value)) continue;
    groups.set(key, [...(groups.get(key) ?? []), fact]);
  }

  const kept: BrandFactDTO[] = [];
  for (const group of groups.values()) {
    // The brand's own word on this, where it has one, over the house's.
    const own = group.filter((f) => f.brand !== null);
    if (own.length === 0 && !HOUSE_STANDARD.test(attributeKey(group[0]!.attribute))) continue;
    const said = own.length > 0 ? own : group;

    const byValue = new Map<string, { facts: BrandFactDTO[]; evidence: number }>();
    for (const fact of said) {
      const key = valueKey(fact.value);
      if (!key) continue;
      const entry = byValue.get(key) ?? { facts: [], evidence: 0 };
      entry.facts.push(fact);
      entry.evidence += Math.max(1, fact.evidenceCount);
      byValue.set(key, entry);
    }
    const ranked = [...byValue.values()].sort((a, b) => b.evidence - a.evidence);
    // What a person confirmed is the pattern, whatever the counts say.
    const confirmed = ranked.find((entry) => entry.facts.some((f) => f.kind === 'preference'));
    const [top, next] = confirmed ? [confirmed, undefined] : ranked;
    if (!top) continue;
    // Two ways of doing it, neither plainly the brand's: no pattern at all.
    if (next && top.evidence < next.evidence * CLEAR_LEAD) continue;
    const lead = top.facts.sort((a, b) =>
      Number(b.kind === 'preference') - Number(a.kind === 'preference') || b.evidenceCount - a.evidenceCount)[0]!;
    kept.push({ ...lead, evidenceCount: top.evidence });
  }
  // The best-attested first, as they were.
  return kept.sort((a, b) => Number(b.brand !== null) - Number(a.brand !== null) || b.evidenceCount - a.evidenceCount);
}
