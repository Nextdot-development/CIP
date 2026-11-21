/**
 * A brand's packs as a person chooses between them: the flavour or expression, not every picture of it.
 * "Fire", "Fire with box" and "Fire tilted" are one pack, Fire; a size of the plain bottle - "750ml",
 * "Mini", "Pocket Pack" - is the brand's Standard; a picture of several bottles together is its
 * Collection; "Jugalbandi 1" to "Jugalbandi 8" are Jugalbandi. Pure, for the page and the server alike.
 */
export const STANDARD = 'Standard';
export const COLLECTION = 'Collection';

export function packFamily(variant: string | null | undefined): string {
  let v = (variant ?? '').trim();
  if (!v) return STANDARD;
  if (/\b(range|collection|trio|duo|quartet|line-?up|family)\b|\band\b|three sizes/i.test(v)) return COLLECTION;
  v = v.replace(/(^|\s+)(with|in)\s+.*$/i, '').replace(/\s+tilted$/i, '').replace(/\s*#?\s*\d+$/, '').trim();
  if (!v || /^(\d+(\.\d+)?\s*(ml|l|cl)|mini|small|flask|pocket( pack)?|plain|standard|mono|regular)$/i.test(v)) return STANDARD;
  return v;
}

/** The packs to offer for a brand, from the variants of its bottles: Standard first, Collection last. */
export function packsOf(variants: (string | null)[]): string[] {
  const all = [...new Set(variants.map(packFamily))];
  const middle = all.filter((p) => p !== STANDARD && p !== COLLECTION).sort((a, b) => a.localeCompare(b));
  return [...(all.includes(STANDARD) ? [STANDARD] : []), ...middle, ...(all.includes(COLLECTION) ? [COLLECTION] : [])];
}

/** The countries a region takes in, among the markets a company has. */
const REGIONS: Record<string, string[]> = {
  'west africa': ['Nigeria', 'Ghana', "Côte d'Ivoire", 'Togo', 'Senegal', 'Benin', 'Liberia', 'Sierra Leone'],
};

/**
 * The markets a brand is sold in, among the company's: those its facts name ("Ghana and Côte d'Ivoire",
 * "West Africa"), a region bringing its countries. None named: every market, as before.
 */
export function marketsFor(said: string[], markets: string[]): string[] {
  const text = said.join(' ; ').toLowerCase();
  if (!text.trim()) return markets;
  const named = new Set<string>();
  for (const m of markets) {
    const name = m.toLowerCase();
    if (new RegExp(`(^|[^a-z])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`).test(text)) named.add(m);
  }
  for (const [region, countries] of Object.entries(REGIONS)) {
    if (!text.includes(region)) continue;
    for (const m of markets) if (countries.some((c) => c.toLowerCase() === m.toLowerCase())) named.add(m);
  }
  const out = markets.filter((m) => named.has(m));
  return out.length ? out : markets;
}

/** Of the brand's bottle variants, the one that shows this pack best: the bottle on its own before one with its box. */
export function variantForPack(pack: string, variants: (string | null)[]): string | null | undefined {
  const of = variants.filter((v) => packFamily(v) === pack);
  if (!of.length) return undefined;
  const plain = of.filter((v) => !v || !/\b(with|in)\b|tilted/i.test(v));
  const pool = plain.length ? plain : of;
  // The plain bottle with no name of its own first, then the shortest name.
  return pool.sort((a, b) => Number(Boolean(a)) - Number(Boolean(b)) || (a ?? '').length - (b ?? '').length)[0]!;
}
