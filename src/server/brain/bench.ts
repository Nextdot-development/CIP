import 'server-only';
import { withCompanyScope, type CompanyScope } from '../db';
import { brandAssets } from './brandAssets';
import { brandNames } from './brands';
import { rulesFor, rulesForBrief } from './checker';
import { brandLayouts, type BrandLayout, type LayoutSpec } from './layouts';
import { brain } from './providers';
import type { BenchDraft } from './providers/types';
import { printable, type Casing, type HeadlineLine } from '../media/typography';

/**
 * The Bench: a post planned the way a senior creative director, the brand's
 * manager and an art director would plan it together, before anything is made.
 *
 * The creative director gives the idea and briefs the scene - the background
 * only, since the bottle, the words and the logo are the brand's own and are
 * placed, not painted. The brand manager picks the pack, names the names that
 * must be written exactly, and calls out what comes near a rule. The art
 * director picks one of the layouts the brand's designers made and writes the
 * headline to it, line by line.
 *
 * Then CIP settles the plan against what exists: a layout or a pack the bench
 * named that the brand does not have is replaced by one it does, the words a
 * person gave are kept word for word, and the copy is held to house spelling.
 */

export type BenchPlan = {
  idea: string;
  scene: { description: string; mood: string; light: 'left' | 'right' | 'front'; surface: 'matte' | 'gloss' };
  /** The pack to show: its variant name, or null for the standard pack. */
  variant: string | null;
  layout: { name: string; spec: LayoutSpec };
  headline: HeadlineLine[];
  casing: Casing;
  /** Names to write exactly as written, whatever the casing. */
  keep: string[];
  risks: string[];
  /** One line from each seat, for the person to read. */
  notes: { creativeDirector: string; brandManager: string; artDirector: string };
  /** What CIP changed in the bench's plan, and why. */
  settled: string[];
};

/** The house layout when a brand has none learned: words left, the bottle right, the logo top right. */
export const DEFAULT_LAYOUT: LayoutSpec = {
  ratio: 1,
  logo: { corner: 'top-right', width: 0.15, insetX: 0.04, insetY: 0.04 },
  bottle: { cx: 0.7, base: 0.9, height: 0.7 },
  text: {
    x: 0.07, y: 0.3, width: 0.45, align: 'left', leading: 1.1, ink: '#ffffff', accent: '#f5c242',
    lines: [
      { role: 'lead', size: 0.058, font: 'Poppins-SemiBold', weight: 'bold', italic: false, script: false, upper: false, tracking: 0, accent: false, box: null },
      { role: 'key', size: 0.075, font: 'Poppins-Black', weight: 'black', italic: false, script: false, upper: false, tracking: 0, accent: true, box: null },
      { role: 'tail', size: 0.036, font: 'Poppins-Italic', weight: 'regular', italic: true, script: false, upper: false, tracking: 0, accent: false, box: null },
    ],
  },
};

/** A layout in words, for the bench to choose between. */
export function describeLayout(name: string, spec: LayoutSpec): string {
  const parts: string[] = [];
  const t = spec.text;
  if (t) {
    const roles = t.lines.map((l) => {
      const looks = [l.box ? 'on a box' : null, l.accent ? 'in the accent colour' : null, l.script ? 'script face' : l.italic ? 'italic' : null, l.upper ? 'capitals' : null].filter(Boolean);
      return looks.length ? `${l.role} (${looks.join(', ')})` : l.role;
    });
    const across = t.align === 'center' ? 'centred' : `${t.align}-aligned on the ${t.x + t.width / 2 < 0.5 ? 'left' : 'right'}`;
    const down = t.y < 0.33 ? 'top' : t.y < 0.6 ? 'middle' : 'bottom';
    parts.push(`${t.lines.length} lines - ${roles.join(', ')}; ${across}, ${down}`);
  }
  if (spec.bottle) parts.push(`bottle ${spec.bottle.cx < 0.4 ? 'left' : spec.bottle.cx > 0.6 ? 'right' : 'centre'}, ${spec.bottle.height > 0.65 ? 'tall' : 'medium'}`);
  if (spec.logo) parts.push(`logo ${spec.logo.corner}`);
  return `${parts.join('; ')}. Made for a post that said "${name}" - those words are not to be reused.`;
}

/** The exact words a person gave for the post, when they gave any. */
export function givenWords(request: string): string | null {
  const quoted = /["“]([^"“”]{3,140})["”]/.exec(request);
  if (quoted) return quoted[1]!.trim();
  const labelled = /\b(?:headline|text|copy|tagline)\s*[:=–-]\s*([^\n]{3,140})/i.exec(request);
  return labelled ? labelled[1]!.trim().replace(/[.;]$/, '') : null;
}

/**
 * Headlines from the brand's own posts: its layouts, each named for the words
 * its post carried, and the lines the Brain read quoted off its posts.
 *
 * A fact reads "The right-side headline reads 'A Richer way to Unwind' with
 * 'Unwind' in large yellow letters": the quoted words are the headline, the
 * rest is a description of it. A value with no quotes is the words themselves
 * only when it is short and not a sentence about a picture.
 */
export function pastHeadlines(layoutNames: string[], said: string[]): string[] {
  const lines: string[] = [];
  for (const value of said) {
    // Double quotes first; a single quote only where it is not an apostrophe.
    const quoted = /["“]([^"”]{3,60})["”]/.exec(value)?.[1]
      ?? /(?<![\p{L}])['‘]([^'‘’]{3,60})['’](?![\p{L}])/u.exec(value)?.[1];
    if (quoted) lines.push(quoted);
    else if (!/\b(reads?|appears?|displayed|shown|set in|printed|contains|headline|text|type|letters)\b/i.test(value)) lines.push(value);
  }
  const words = (s: string) => s.trim().split(/\s+/).length;
  return [...new Map([...layoutNames, ...lines]
    .map((l) => printable(l).replace(/\s*[—–-]\s*Caption:.*$/i, ''))
    .filter((l) => words(l) >= 2 && words(l) <= 12 && /\p{L}/u.test(l))
    .map((l) => [plain(l), l] as const)).values()].slice(0, 12);
}

/**
 * The most words a headline for this brand runs to: the length three in
 * four of its own headlines keep within. Never under four - a headline needs
 * room for its payoff - nor over eight. A brand with too few to read from
 * gets seven.
 */
export function headlineLimit(examples: string[]): number {
  if (examples.length < 3) return 7;
  const counts = examples.map((e) => e.trim().split(/\s+/).length).sort((a, b) => a - b);
  const upper = counts[Math.min(counts.length - 1, Math.floor(counts.length * 0.75))]!;
  return Math.max(4, Math.min(8, upper));
}

/**
 * How the brand's own pictures were set: the background, the light, the mood,
 * the props and the colours of each one CIP has read - its posters, social
 * posts and lifestyle shots, not its packshots on black or its logo files.
 * What a new scene should belong with. Read from what was learned when the
 * files came in, so nothing is asked of a model here.
 */
export async function pastScenes(scope: CompanyScope, brand: string, limit = 6): Promise<string[]> {
  const rows = await withCompanyScope(scope, (tx) => tx<{
    background: string | null; lighting: string | null; mood: string | null; style: string | null;
    objects: unknown; colours: unknown;
  }[]>`
    select u.structured->>'background' as background, u.structured->>'lighting' as lighting,
           u.structured->>'mood' as mood, u.structured->>'style' as style,
           u.structured->'objects' as objects, u.structured->'colours' as colours
      from asset_understanding u
      join drive_files d on d.id = u.file_id and d.company_id = u.company_id
     where d.brand = ${brand} and d.archived_at is null
       and u.kind = 'image' and u.status = 'ready'
       and coalesce(u.structured->>'contentType', '') !~* '(logo|label|pack ?-?shot|product (shot|photo)|catalogue|mock|document|chart|slide)'
     order by (u.structured->>'contentType' ~* '(advert|poster|social|post|hero|campaign|creative|promotional|static|lifestyle)') desc,
              u.updated_at desc
     limit ${limit * 4}
  `).catch(() => []);
  // Soft focus taken out: a background is painted clear, whatever the old shots did.
  const tidy = (s: string | null) => (s ?? '')
    .replace(/[^;,.]*\b(bokeh|out[- ]of[- ]focus|soft[- ]focus|shallow depth of field|blurr?(ed|y)?|defocused)\b[^;,.]*[;,.]?/gi, '')
    .replace(/\s+/g, ' ').trim().replace(/^[;,.\s]+|[;,.\s]+$/g, '');
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const scenes: string[] = [];
  for (const r of rows) {
    const background = tidy(r.background);
    // A packshot's black or white is not a scene to belong with.
    if (!background || /^(solid |plain |pure )?(black|white|transparent)\b/i.test(background)) continue;
    // The props, without the pack, the words or the people - those are placed, not painted.
    const props = list(r.objects).filter((o) => !PLACED.test(o)).slice(0, 5);
    const colours = list(r.colours).slice(0, 4);
    const line = [
      background, tidy(r.lighting), tidy(r.mood), tidy(r.style),
      props.length ? `props: ${props.join(', ')}` : '',
      colours.length ? `colours: ${colours.join(', ')}` : '',
    ].filter(Boolean).join('; ').slice(0, 320);
    if (!scenes.some((s) => plain(s) === plain(line))) scenes.push(line);
    if (scenes.length >= limit) break;
  }
  return scenes;
}

/** What a post has placed on it rather than painted into its scene. */
const PLACED = /bottle|pack|label|logo|text|word|headline|warning|disclaimer|person|people|\bman\b|woman|female|male|model|face|hand|bokeh|graphic|illustrat/i;

/** What the brand pours, and its colour: for a glass in the scene that holds the right drink. */
export type BrandDrink = { kind: string | null; colour: string | null; variant?: string | null };

/**
 * The brand's drink as its files describe it - "whisky", "deep amber" - the
 * value said most often. Read from the Brand DNA already learned; no model.
 */
export async function brandDrink(scope: CompanyScope, brand: string): Promise<BrandDrink> {
  const rows = await withCompanyScope(scope, (tx) => tx<{ attribute: string; value: string; n: number }[]>`
    select attribute, value, sum(greatest(evidence_count, 1))::int as n
      from brand_dna_facts
     where brand = ${brand} and status = 'active'
       and lower(attribute) ~ '(liquid|drink|spirit|product ?type|category|liquor)'
     group by 1, 2
  `).catch(() => []);
  // The kind: the drink word the brand's files say most, wherever they say it.
  const kinds = new Map<string, number>();
  for (const r of rows) {
    const said = `${r.attribute} ${r.value}`.toLowerCase().match(DRINK_WORDS)?.[0];
    if (said) kinds.set(said.replace('whiskey', 'whisky'), (kinds.get(said) ?? 0) + r.n);
  }
  const kind = [...kinds].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  // The colour: what the liquid itself was called, the plainest of the most said.
  const colours = rows
    .filter((r) => /liquid colou?r|drink colou?r|spirit colou?r/i.test(r.attribute) && r.value.length <= 40)
    .map((r) => ({ value: r.value.replace(/\s+/g, ' ').replace(/\b(liquid|visible|in the bottle|inside the bottle)\b/gi, '').replace(/\s+/g, ' ').trim(), n: r.n }))
    .filter((c) => c.value)
    .sort((a, b) => b.n - a.n || a.value.length - b.value.length);
  return { kind, colour: colours[0]?.value ?? null };
}

const DRINK_WORDS = /\b(single malt|whiske?y|vodka|gin|rum|brandy|cognac|liqueur|tequila|wine|beer)\b/;

/** The pack a brand calls its standard one, when it names it. */
const STANDARD = /^(plain|original|classic|regular|standard)$/i;

const plain = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/**
 * The bench's plan, settled against what the brand has: its layouts, its
 * packs, its names - and the person's own words, which are never rewritten.
 */
export function settlePlan(
  draft: Omit<BenchDraft, 'usage'>,
  context: {
    request: string; brand: string; variants: (string | null)[]; layouts: Pick<BrandLayout, 'name' | 'spec'>[]; brands?: string[];
    /** The most words the brand's own headlines run to. */
    maxWords?: number;
  },
): BenchPlan {
  const settled: string[] = [];
  const cd = draft.creativeDirector;
  const bm = draft.brandManager;
  const ad = draft.artDirector;

  // The layout: one the designers made, else the house layout.
  const usable = context.layouts.filter((l) => l.spec.text);
  let layout = usable.find((l) => l.name === ad.layout) ?? usable.find((l) => plain(l.name) === plain(ad.layout)) ?? null;
  if (!layout) {
    layout = usable[0] ?? { name: 'default', spec: DEFAULT_LAYOUT };
    if (ad.layout && ad.layout !== 'default') settled.push(`The layout "${ad.layout}" does not exist; used "${layout.name}".`);
  }
  const roles = new Set(layout.spec.text!.lines.map((l) => l.role));

  // The pack: one the brand has a cut-out for.
  const has = (v: string | null) => context.variants.some((x) => (x ?? '').toLowerCase() === (v ?? '').toLowerCase());
  let variant = bm.variant && has(bm.variant) ? context.variants.find((x) => x?.toLowerCase() === bm.variant!.toLowerCase())! : null;
  if (!variant) {
    const named = context.variants.find((v) => v && new RegExp(`\\b${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(context.request));
    if (named) variant = named;
    else if (!has(null) && context.variants.length) variant = context.variants.find((v) => STANDARD.test(v ?? '')) ?? context.variants[0]!;
    if (bm.variant) settled.push(`There is no "${bm.variant}" pack in the library; used the ${variant ?? 'standard'} pack.`);
  }

  // The headline: the person's words word for word; else the art director's,
  // in parts the layout has, no longer than a headline should be.
  let headline: HeadlineLine[] = ad.headline
    .map((l) => ({ text: l.text.replace(/\s+/g, ' ').trim(), role: roles.has(l.role) ? l.role : 'lead' }))
    .filter((l) => l.text);
  const given = givenWords(context.request);
  // The person's words, as they gave them - broken where the bench broke them
  // only when no line is left as one stray word.
  const stray = headline.length > 1 && headline.some((l) => !/\s/.test(l.text));
  if (given && (stray || plain(headline.map((l) => l.text).join(' ')) !== plain(given))) {
    headline = splitGiven(given, roles);
    settled.push('Kept the exact words given for the post.');
  }
  if (!given) {
    // As long as the brand's own headlines run, and no longer: an aside goes
    // first, then the closing lines, so what is left still opens as written.
    const most = context.maxWords ?? 12;
    while (headline.length > 1 && (headline.length > 4 || headline.reduce((n, l) => n + l.text.split(' ').length, 0) > most)) {
      const cut = headline.findLastIndex((l) => l.role === 'tail');
      headline.splice(cut >= 0 ? cut : headline.length - 1, 1);
      settled.push('Shortened the headline to the length of the brand\'s own.');
    }
    // A layout with a part made to stand out - the brand's script, its accent
    // colour - has one. Set without it, every word fell to the plain face.
    if (roles.has('key') && headline.length > 1 && !headline.some((l) => l.role === 'key')) {
      const last = headline.at(-1)!;
      if (last.text.split(' ').length <= 4) {
        headline[headline.length - 1] = { ...last, role: 'key' };
        settled.push('Set the closing words as the part the layout makes stand out.');
      }
    }
  }
  headline = headline
    .map((l) => ({ ...l, text: printable(l.text).replace(/\bwhiskey\b/gi, (w) => (w[0] === 'W' ? 'Whisky' : 'whisky')) }))
    .filter((l) => l.text);
  if (headline.length === 0) headline = [{ text: context.brand, role: 'lead' }];

  // An old post's words, reused, are not a new post.
  if (!given && context.layouts.some((l) => plain(l.name) === plain(headline.map((h) => h.text).join(' ')))) {
    settled.push('The headline repeats the words of an earlier post.');
  }

  // Names written exactly: the bench's, the brand, the pack, and any of the
  // company's brands the copy mentions. A pack's name alone ("Honey") is a
  // plain word too, and a sentence is not a name.
  const words = headline.map((l) => l.text).join(' ');
  const keep = [...new Set([
    ...bm.keep.map((k) => k.trim()).filter((k) => k && k.split(/\s+/).length <= 4 && !context.variants.some((v) => v?.toLowerCase() === k.toLowerCase())),
    context.brand,
    ...(variant ? [`${context.brand} ${variant}`] : []),
    ...(context.brands ?? []).filter((b) => new RegExp(`(?<![\\p{L}\\p{N}])${b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'iu').test(words)),
  ])];

  const casing: Casing = layout.spec.text!.lines.every((l) => l.upper) ? 'upper' : ad.casing;

  return {
    idea: cd.idea.trim(),
    scene: { description: cd.scene.trim(), mood: cd.mood.trim(), light: cd.light, surface: cd.surface },
    variant,
    layout: { name: layout.name, spec: layout.spec },
    headline,
    casing,
    keep,
    risks: bm.risks.map((r) => r.trim()).filter(Boolean),
    notes: { creativeDirector: cd.note.trim(), brandManager: bm.note.trim(), artDirector: ad.note.trim() },
    settled,
  };
}

/**
 * Other headlines to try on a post, for nothing: the same words broken at
 * another place, on one line, and the brand's own headlines from its past
 * posts, as long as its headlines run. No model is asked; these are read
 * from what CIP already holds.
 */
export async function headlineSuggestions(
  scope: CompanyScope,
  brand: string,
  current: HeadlineLine[],
  roles: Set<HeadlineLine['role']>,
): Promise<{ from: 'words' | 'brand'; lines: HeadlineLine[] }[]> {
  const [layouts, said] = await Promise.all([
    brandLayouts(scope, brand).catch(() => []),
    withCompanyScope(scope, (tx) => tx<{ value: string }[]>`
      select value from brand_dna_facts
       where brand = ${brand} and status = 'active'
         and lower(attribute) ~ '^(headline|static headline|headline text|headline copy)$'
       order by evidence_count desc
       limit 40
    `).catch(() => []),
  ]);
  return suggestHeadlines(current, roles, pastHeadlines(layouts.filter((l) => l.brand === brand).map((l) => l.name), said.map((r) => r.value)));
}

/** The suggestions themselves, from the words and the brand's past headlines. */
export function suggestHeadlines(
  current: HeadlineLine[],
  roles: Set<HeadlineLine['role']>,
  past: string[],
): { from: 'words' | 'brand'; lines: HeadlineLine[] }[] {
  const out: { from: 'words' | 'brand'; lines: HeadlineLine[] }[] = [];
  const seen = new Set<string>([current.map((l) => `${l.role}:${plain(l.text)}`).join('|')]);
  const add = (from: 'words' | 'brand', lines: HeadlineLine[]) => {
    const key = lines.map((l) => `${l.role}:${plain(l.text)}`).join('|');
    if (lines.length && !seen.has(key)) { seen.add(key); out.push({ from, lines }); }
  };
  const words = current.map((l) => l.text).join(' ').trim().split(/\s+/).filter(Boolean);
  if (words.length >= 3 && roles.has('key')) {
    // Broken a word earlier and a word later than the middle: what stands out changes.
    const mid = Math.ceil(words.length / 2);
    for (const at of [mid - 1, mid, mid + 1]) {
      if (at < 1 || at >= words.length) continue;
      add('words', [{ text: words.slice(0, at).join(' '), role: 'lead' }, { text: words.slice(at).join(' '), role: 'key' }]);
    }
  }
  if (words.length >= 2) add('words', [{ text: words.join(' '), role: 'lead' }]);
  const limit = headlineLimit(past);
  for (const headline of past) {
    if (headline.trim().split(/\s+/).length > limit) continue;
    add('brand', splitGiven(headline, roles));
    if (out.filter((o) => o.from === 'brand').length >= 6) break;
  }
  return out;
}

/** A person's words in the layout's parts: broken at a comma or full stop, the second half made the key. */
function splitGiven(given: string, roles: Set<HeadlineLine['role']>): HeadlineLine[] {
  const parts = given.split(/(?<=[,.!?;:])\s+/).filter(Boolean);
  if (parts.length < 2 || !roles.has('key')) return [{ text: given, role: 'lead' }];
  return [{ text: parts[0]!, role: 'lead' }, { text: parts.slice(1).join(' '), role: 'key' }];
}

/** What the Bench would have said, from what CIP holds - no model asked. Settled like any other plan. */
export function freeDraft(request: string, brand: string, examples: string[]): Omit<BenchDraft, 'usage'> {
  const past = examples.find((e) => e.split(/\s+/).length <= 12) ?? null;
  return {
    creativeDirector: { idea: request.trim() || `A post for ${brand}`, scene: 'A picture the person brought.', mood: '', light: 'front', surface: 'matte', note: '' },
    brandManager: { variant: null, keep: [], risks: [], note: '' },
    artDirector: { layout: '', casing: 'sentence', headline: past ? splitGiven(past, new Set(['lead', 'key'])) : [], note: '' },
  };
}

/** The Bench plans one post for a brand. */
export async function planPost(
  scope: CompanyScope,
  input: {
    request: string; brand: string; ratio: number; market?: string | null;
    /**
     * Planned from what CIP holds, with no model asked and nothing spent: for
     * a post on a picture the person brought. The person's words, when they
     * gave any, else one of the brand's own headlines; the brand's layout; the
     * pack the request names.
     */
    noModel?: boolean;
  },
): Promise<BenchPlan & { bottleFileId: string | null; rules: string[]; pastScenes: string[]; drink: BrandDrink }> {
  const [layouts, bottles, everyRule, brands, saidHeadlines, scenes, drink] = await Promise.all([
    brandLayouts(scope, input.brand),
    brandAssets(scope, { brand: input.brand, kind: 'bottle' }),
    rulesForBrief(scope, { brand: input.brand, market: input.market ?? null, format: 'image' }),
    brandNames(scope),
    withCompanyScope(scope, (tx) => tx<{ value: string }[]>`
      select value from brand_dna_facts
       where brand = ${input.brand} and status = 'active'
         and lower(attribute) ~ '^(headline|static headline|headline text|headline copy)$'
       order by evidence_count desc
       limit 40
    `).catch(() => []),
    pastScenes(scope, input.brand),
    brandDrink(scope, input.brand),
  ]);
  // How this brand writes headlines: its own posts, not every brand's.
  const examples = pastHeadlines(
    layouts.filter((l) => l.brand === input.brand).map((l) => l.name),
    saidHeadlines.map((r) => r.value),
  );
  const maxWords = headlineLimit(examples);
  // The rules this post can meet. Not the statutory lines: the design team
  // sets those in their approved wording. Asked for them, the reviewer had
  // the scene painted again with a health warning in it - another country's.
  const rules = rulesFor(everyRule, { generated: true, composed: true });
  const variants = [...new Map(bottles.filter((b) => b.asset.cutout).map((b) => [b.asset.variant?.toLowerCase() ?? '', b.asset.variant])).values()];
  const usable = layouts.filter((l) => l.spec.text);

  const draft = input.noModel ? freeDraft(input.request, input.brand, examples) : await brain().benchPlan({
    request: input.request,
    brand: input.brand,
    variants,
    layouts: usable.map((l) => ({ name: l.name, description: describeLayout(l.name, l.spec) })),
    rules: rules.map((r) => r.rule),
    ratio: input.ratio,
    pastHeadlines: examples,
    maxWords,
    pastScenes: scenes,
  });
  const plan = settlePlan(draft, { request: input.request, brand: input.brand, variants, layouts: usable, brands, maxWords });
  const [bottle] = await brandAssets(scope, { brand: input.brand, kind: 'bottle', variant: plan.variant });
  return { ...plan, bottleFileId: bottle?.asset.cutout ? bottle.fileId : null, rules: rules.map((r) => r.rule), pastScenes: scenes, drink };
}
