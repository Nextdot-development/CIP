import 'server-only';
import type { CompanyScope } from '../db';
import { brandAssets } from './brandAssets';
import { brandNames } from './brands';
import { rulesForBrief } from './checker';
import { brandLayouts, type BrandLayout, type LayoutSpec } from './layouts';
import { brain } from './providers';
import type { BenchDraft } from './providers/types';
import type { Casing, HeadlineLine } from '../media/typography';

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

/** The pack a brand calls its standard one, when it names it. */
const STANDARD = /^(plain|original|classic|regular|standard)$/i;

const plain = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/**
 * The bench's plan, settled against what the brand has: its layouts, its
 * packs, its names - and the person's own words, which are never rewritten.
 */
export function settlePlan(
  draft: Omit<BenchDraft, 'usage'>,
  context: { request: string; brand: string; variants: (string | null)[]; layouts: Pick<BrandLayout, 'name' | 'spec'>[]; brands?: string[] },
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
  if (given && plain(headline.map((l) => l.text).join(' ')) !== plain(given)) {
    headline = splitGiven(given, roles);
    settled.push('Kept the exact words given for the post.');
  }
  if (!given) {
    while (headline.length > 1 && (headline.length > 4 || headline.reduce((n, l) => n + l.text.split(' ').length, 0) > 12)) {
      const cut = headline.findLastIndex((l) => l.role === 'tail');
      headline.splice(cut >= 0 ? cut : headline.length - 1, 1);
      settled.push('Shortened the headline to fit a post.');
    }
  }
  headline = headline.map((l) => ({ ...l, text: l.text.replace(/\bwhiskey\b/gi, (w) => (w[0] === 'W' ? 'Whisky' : 'whisky')) }));
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

/** A person's words in the layout's parts: broken at a comma or full stop, the second half made the key. */
function splitGiven(given: string, roles: Set<HeadlineLine['role']>): HeadlineLine[] {
  const parts = given.split(/(?<=[,.!?;:])\s+/).filter(Boolean);
  if (parts.length < 2 || !roles.has('key')) return [{ text: given, role: 'lead' }];
  return [{ text: parts[0]!, role: 'lead' }, { text: parts.slice(1).join(' '), role: 'key' }];
}

/** The Bench plans one post for a brand. */
export async function planPost(
  scope: CompanyScope,
  input: { request: string; brand: string; ratio: number; market?: string | null },
): Promise<BenchPlan & { bottleFileId: string | null; rules: string[] }> {
  const [layouts, bottles, rules, brands] = await Promise.all([
    brandLayouts(scope, input.brand),
    brandAssets(scope, { brand: input.brand, kind: 'bottle' }),
    rulesForBrief(scope, { brand: input.brand, market: input.market ?? null, format: 'image' }),
    brandNames(scope),
  ]);
  const variants = [...new Map(bottles.filter((b) => b.asset.cutout).map((b) => [b.asset.variant?.toLowerCase() ?? '', b.asset.variant])).values()];
  const usable = layouts.filter((l) => l.spec.text);

  const draft = await brain().benchPlan({
    request: input.request,
    brand: input.brand,
    variants,
    layouts: usable.map((l) => ({ name: l.name, description: describeLayout(l.name, l.spec) })),
    rules: rules.map((r) => r.rule),
    ratio: input.ratio,
  });
  const plan = settlePlan(draft, { request: input.request, brand: input.brand, variants, layouts: usable, brands });
  const [bottle] = await brandAssets(scope, { brand: input.brand, kind: 'bottle', variant: plan.variant });
  return { ...plan, bottleFileId: bottle?.asset.cutout ? bottle.fileId : null, rules: rules.map((r) => r.rule) };
}
