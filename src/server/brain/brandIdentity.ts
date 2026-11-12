import 'server-only';
import { withCompanyScope, type CompanyScope } from '../db';
import type { BrandFactDTO } from './brandDna';
import { isNeutralHex } from './factTidy';

/**
 * A brand at a glance, read from what CIP already holds: its colours, the
 * lines it says, how it sounds, its type, its packs and where it is sold, and
 * what was learned last. Nothing is made up to fill a gap - a part CIP has
 * nothing for is left empty and the page says so.
 *
 * The facts are many and loosely worded, so each part is picked with care:
 * colours deduplicated by eye, lines by their words, tone by the words that
 * keep coming back. Lines, packs and what is new are asked of the table
 * directly - a heavily photographed brand's few lines and packs never make
 * its strongest five hundred facts.
 */
export type BrandIdentity = {
  /** The house's own one line on the brand, as the roster has it. */
  note: string | null;
  palette: { hex: string; seen: number }[];
  lines: string[];
  tone: string[];
  fonts: string[];
  variants: string[];
  markets: string[];
  recent: { attribute: string; value: string; ago: string }[];
};

const LINES = ['campaign line', 'tagline', 'slogan', 'strapline', 'headline text', 'headline', 'secondary headline text', 'pack line', 'signature line'];
const TONE = /^(tone|tone of voice|personality|brand personality|mood|core personality)$/;
/** What a layout says about one picture - true, and not news worth a place in "just learned". */
const ROUTINE = /^(logo (scale|placement)|headline (case|placement)|product placement|palette|colou?r|font|alignment|composition|background|layout|lighting|orientation|aspect ?ratio|people|depth of field|setting)$/;

/** Two colours a person would call the same. */
function near(a: string, b: string): boolean {
  const rgb = (h: string) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  const [x, y] = [rgb(a), rgb(b)];
  return Math.hypot(x[0]! - y[0]!, x[1]! - y[1]!, x[2]! - y[2]!) < 48;
}

function agoOf(when: Date): string {
  const minutes = Math.max(0, Math.round((Date.now() - when.getTime()) / 60000));
  if (minutes < 60) return minutes < 1 ? 'just now' : `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)} days ago`;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/**
 * The words a line says, from how it was described: what is in quotes, or
 * what comes before "appears", "printed", "reads" and the like. A description
 * with no words of its own gives none.
 */
export function spokenWords(raw: string): string | null {
  const value = raw.replace(/\s+/g, ' ').trim();
  const quoted = [...value.matchAll(/["“'‘]([^"”'’]{3,60})["”'’]/g)].map((m) => m[1]!.trim());
  // "'A Richer way to Unwind' with 'Unwind' in yellow": a word picked out of the line is not more of it.
  const whole = quoted.filter((q, i) => !quoted.some((o, j) => j !== i && o.length > q.length && o.toLowerCase().includes(q.toLowerCase())));
  if (whole.length) return whole.join(' ');
  const said = value.split(/\s+(?:appears?|displayed|printed|set in|reads|located|placed|shown|written|centred|in the (?:upper|lower|top|bottom))\b/i)[0]!;
  if (said !== value) return said.replace(/\(.*?\)/g, '').trim() || null;
  // A description of the picture, not words on it.
  if (/\b(text|label|carton|font|type|logo|bottle)\b/i.test(value)) return null;
  return value.replace(/\(.*?\)/g, '').trim() || null;
}

/** "Premium whisky. Regal, sophisticated, restrained. Gold, black…" - the words after what it is. */
function toneFromNote(note: string | null): string[] {
  const second = note?.split('.').map((s) => s.trim()).filter(Boolean)[1] ?? '';
  return second.split(',').map((w) => w.trim().toLowerCase()).filter((w) => w && w.split(' ').length <= 2).slice(0, 6);
}

export async function brandIdentity(scope: CompanyScope, brand: string | null, facts: BrandFactDTO[]): Promise<BrandIdentity> {
  const own = facts.filter((f) => (brand ? f.brand === brand : true));
  const strongest = [...own].sort((a, b) => b.evidenceCount - a.evidenceCount || b.confidence - a.confidence);

  const { said, newest, note } = await withCompanyScope(scope, async (tx) => {
    const said = await tx<{ attribute: string; value: string; evidence_count: number }[]>`
      select attribute, value, evidence_count from brand_dna_facts
       where company_id = ${scope.companyId} and status = 'active'
         and (${brand}::text is null or brand = ${brand})
         and (attribute = any(${LINES}) or attribute = 'variant' or attribute ~ ${TONE.source})
       order by evidence_count desc, confidence desc, first_seen_at desc
       limit 400
    `;
    const newest = await tx<{ attribute: string; value: string; first_seen_at: Date }[]>`
      select attribute, value, first_seen_at from brand_dna_facts
       where company_id = ${scope.companyId} and status = 'active'
         and (${brand}::text is null or brand = ${brand})
       order by first_seen_at desc
       limit 60
    `;
    const [row] = brand
      ? await tx<{ note: string | null }[]>`select note from company_brands where company_id = ${scope.companyId} and name = ${brand}`
      : [];
    return { said, newest, note: row?.note ?? null };
  });

  // Colours: a choice, not a background - and each one once.
  const palette: { hex: string; seen: number }[] = [];
  for (const f of strongest) {
    if (!/palette|colou?r/.test(f.attribute)) continue;
    const hex = /^#[0-9a-f]{6}$/i.exec(f.value.trim())?.[0]?.toLowerCase();
    if (!hex || isNeutralHex(hex)) continue;
    const same = palette.find((p) => near(p.hex, hex));
    if (same) { same.seen += f.evidenceCount; continue; }
    if (palette.length < 6) palette.push({ hex, seen: f.evidenceCount });
  }

  // Lines it says: its own words, not its name on its own, each once.
  const seenLines = new Set<string>();
  const lines: string[] = [];
  for (const f of said) {
    if (!LINES.includes(f.attribute)) continue;
    const text = spokenWords(f.value);
    if (!text) continue;
    const key = text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (!key || key.split(' ').length < 2 || key === brand?.toLowerCase() || text.length > 70) continue;
    if (seenLines.has(key) || [...seenLines].some((k) => k.startsWith(key) || key.startsWith(k))) continue;
    seenLines.add(key);
    lines.push(text);
    if (lines.length === 4) break;
  }

  // How it sounds: the words that come back in what was read - else the house's own words for it.
  const words = new Map<string, number>();
  for (const f of said) {
    if (!TONE.test(f.attribute)) continue;
    const plain = f.value.replace(/^[^:]{0,40}:\s*/, '').replace(/\(.*?\)/g, '');
    for (const raw of plain.split(/[\/,;.]| and /)) {
      const w = raw.trim().toLowerCase();
      if (!w || w.split(' ').length > 2 || w.length < 3 || /^(visual world|core personality|whisky|vodka|rum|gin|brandy)$/.test(w)) continue;
      words.set(w, (words.get(w) ?? 0) + 1 + f.evidence_count);
    }
  }
  const learnedTone = [...words.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([w]) => w);
  const tone = learnedTone.length >= 3 ? learnedTone : toneFromNote(note);

  const fonts = [...new Set(strongest.filter((f) => /^(font|typography)$/.test(f.attribute)).map((f) => clip(f.value, 40)))].slice(0, 3);

  const variants = [...new Set(said
    .filter((f) => f.attribute === 'variant' && f.value.length <= 60 && !/\buses\b|\+/.test(f.value))
    // On the brand's own card its name need not be said again: "Chocolate 750ml", not "Magic Moments Chocolate 750ml".
    .map((f) => (brand && f.value.toLowerCase().startsWith(`${brand.toLowerCase()} `) ? f.value.slice(brand.length + 1) : f.value)))].slice(0, 12);

  // Where it is sold: each place once, however it was spelled.
  const markets = [...new Map(own.flatMap((f) => f.markets).map((m) => [m.toLowerCase(), m.charAt(0).toUpperCase() + m.slice(1)])).values()].slice(0, 8);

  // What is new: when each was first learned - not when a recount last touched it - and not a picture's routine.
  const recent = newest
    .filter((f) => !ROUTINE.test(f.attribute) && !/^#[0-9a-f]{6}$/i.test(f.value.trim()) && f.value.length >= 4)
    .slice(0, 6)
    .map((f) => ({ attribute: f.attribute, value: clip(f.value, 90), ago: agoOf(f.first_seen_at) }));

  return { note, palette, lines, tone, fonts, variants, markets, recent };
}
