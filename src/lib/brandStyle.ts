/**
 * How a brand's posts look and speak, as its own facts say it - read off the
 * words a person or a study wrote ("logo placement: top right", "Gold serif
 * capitals", "Candlelit, luxurious interiors and festive tables"). Pure: no
 * model, no database, so a post can be planned from it for nothing.
 */

export type StyleFact = { attribute: string; value: string };

export type BrandStyle = {
  backgrounds: string[];
  props: string[];
  lighting: string[];
  colourUse: string[];
  headlineStyle: string | null;
  logoPlacement: string | null;
  serve: string | null;
  occasions: string[];
  /** What never goes in this brand's scenes, as the team set it. */
  never: string[];
};

export type Corner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

const has = (s: string, re: RegExp) => re.test(s.toLowerCase());

/**
 * A look said for one market or one pack - "Nigeria: bright flat colour cards", "Honey: sunny daylight" -
 * belongs to a post for that market, or one whose request names that pack. The words before the colon
 * are its scope; a look said for every post has none.
 */
export function scopeOf(value: string): { scope: string | null; text: string } {
  const m = /^([A-Z][A-Za-z'’ ]{1,28}):\s+(.+)$/s.exec(value.trim());
  return m && m[1]!.trim().split(/\s+/).length <= 3 ? { scope: m[1]!.trim(), text: m[2]!.trim() } : { scope: null, text: value.trim() };
}

/** Whether a scoped look is this post's: its market, or a pack its request names. */
export function inScope(scope: string, context: { market?: string | null; request?: string | null }): boolean {
  const s = scope.toLowerCase();
  if ((context.market ?? '').toLowerCase() === s) return true;
  return new RegExp(`\\b${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(context.request ?? '');
}

export function styleOf(facts: StyleFact[], context?: { market?: string | null; request?: string | null }): BrandStyle {
  // A look for this market or pack first, then the brand's look for every post; one for another market or pack, not at all.
  const of = (re: RegExp) => {
    const own: string[] = [];
    const every: string[] = [];
    for (const f of facts) {
      if (!re.test(f.attribute.toLowerCase())) continue;
      const { scope, text } = scopeOf(f.value);
      if (!text) continue;
      if (!scope) every.push(text);
      else if (context && inScope(scope, context)) own.push(text);
    }
    return [...new Set([...own, ...every])];
  };
  return {
    // A packshot's plain white or black is how the bottle was photographed, not a scene for a post.
    backgrounds: of(/^(background|setting|scene)$/).filter((b) => !/^(a |the )?(solid |plain |pure )?(white|black)( plain)?( background)?$/i.test(b) && !/photographed against/i.test(b)),
    props: of(/^props?$/),
    lighting: of(/^(lighting|light)$/),
    colourUse: of(/^(colou?r use)$/).filter((c) => !/#[0-9a-f]{6}/i.test(c)),
    headlineStyle: of(/^headline style$/)[0] ?? null,
    logoPlacement: of(/^logo placement$/)[0] ?? null,
    serve: of(/^serve$/)[0] ?? null,
    never: of(/^never in (the )?scenes?$/),
    occasions: of(/^occasions?$/).flatMap((o) => o.split(/,|;| and /)).map((o) => o.trim()).filter(Boolean),
  };
}

/** "top right", "upper-left corner", "bottom right" - the corner the words name. */
export function cornerFromWords(words: string | null): Corner | null {
  if (!words) return null;
  const s = words.toLowerCase();
  const v = /\b(top|upper)\b/.test(s) ? 'top' : /\b(bottom|lower|foot)\b/.test(s) ? 'bottom' : null;
  const h = /\bright\b/.test(s) ? 'right' : /\bleft\b/.test(s) ? 'left' : null;
  return v && h ? (`${v}-${h}` as Corner) : null;
}

/**
 * The face a headline style names: a serif, a script, a clean sans. A style that pairs a serif
 * with a script sets the headline in the serif - the script is the flourish under it.
 */
export function fontFromWords(words: string | null): 'playfair-display' | 'brittany-signature' | 'poppins' | null {
  if (!words) return null;
  if (has(words, /\bserif\b/) && !has(words, /\bsans[- ]serif\b/)) return 'playfair-display';
  if (has(words, /\b(script|calligraph|handwrit|signature)/)) return 'brittany-signature';
  if (has(words, /\b(sans|clean|modern|geometric)\b/)) return 'poppins';
  return null;
}

const INKS: [RegExp, string][] = [[/\bgold(en)?\b/, '#c9a24a'], [/\bcream\b/, '#f3e6c8'], [/\bivory\b/, '#f6efdf'], [/\bwhite\b/, '#ffffff'], [/\bsilver\b/, '#c8ccd2'], [/\bblack\b/, '#111111']];

/** The headline's colour, the first one the style names. */
export function inkFromWords(words: string | null): string | null {
  if (!words) return null;
  const s = words.toLowerCase();
  let best: { at: number; hex: string } | null = null;
  for (const [re, hex] of INKS) {
    const m = re.exec(s);
    if (m && (!best || m.index < best.at)) best = { at: m.index, hex };
  }
  return best?.hex ?? null;
}

export function alignFromWords(words: string | null): 'left' | 'center' | 'right' | null {
  if (!words) return null;
  if (has(words, /\bcent(re|er)(d|ed)?\b/)) return 'center';
  if (has(words, /\bleft\b/)) return 'left';
  if (has(words, /\bright\b/)) return 'right';
  return null;
}

export function capitalsFromWords(words: string | null): boolean {
  return !!words && has(words, /\b(capitals|caps|upper ?case)\b/);
}

/** Occasions a request or a line can be about, and the words that mean each. */
const OCCASIONS: [string, RegExp][] = [
  ['diwali', /\b(diwali|deepavali|diya|festival of lights)\b/],
  ['holi', /\b(holi|colou?rs|colou?r festival|gulal)\b/],
  ['christmas', /\b(christmas|xmas|santa|secret santa)\b/],
  ['new year', /\b(new year|nye|year[- ]end)\b/],
  ['gift', /\b(gift|giving|present)\b/],
  ['summer', /\b(summer|sun|beach|pool)\b/],
  ['monsoon', /\b(monsoon|rain)\b/],
  ['republic day', /\b(republic day|independence day)\b/],
  ['cocktail', /\b(cocktails?|mixolog|sour|negroni|tonic|highball)\b/],
  ['evening', /\b(evening|night|unwind|after dark)\b/],
  ['food', /\b(feast|food|cuisine|dinner|pairing)\b/],
  ['celebration', /\b(celebrat\w*|toast|party|cheers)\b/],
  ['world', /\b(world|global|international)\b/],
  ['craft', /\b(craft\w*|distill\w*|aged|cask|barrel|heritage)\b/],
];

/** The occasions that belong to one time of year. */
const SEASONS = ['diwali', 'holi', 'christmas', 'new year', 'republic day', 'monsoon'];

export function occasionsIn(text: string): string[] {
  const s = text.toLowerCase();
  return OCCASIONS.filter(([, re]) => re.test(s)).map(([name]) => name);
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * One of the brand's own headlines for this request: the one that shares its occasion - a
 * Diwali line for a Diwali post - else one chosen by the request's words, so two posts asked
 * differently do not both carry the brand's first line. Null with nothing to choose from.
 */
export function pickHeadline(request: string, examples: string[], maxWords = 12): string | null {
  const fit = examples.filter((e) => e.trim().split(/\s+/).length <= maxWords);
  if (!fit.length) return null;
  const wanted = occasionsIn(request);
  if (wanted.length) {
    const scored = fit
      .map((e) => ({ e, n: occasionsIn(e).filter((o) => wanted.includes(o)).length }))
      .filter((x) => x.n > 0)
      .sort((a, b) => b.n - a.n);
    if (scored.length) {
      const top = scored.filter((x) => x.n === scored[0]!.n);
      return top[hash(request) % top.length]!.e;
    }
  }
  // A seasonal line is not for a post that names no season.
  const plain = fit.filter((e) => !occasionsIn(e).some((o) => SEASONS.includes(o)));
  const pool = plain.length ? plain : fit;
  return pool[hash(request.trim().toLowerCase()) % pool.length]!;
}

/**
 * The scene the brand's posts are set in, for this request: its usual background, and the props
 * that belong to the request's occasion only - diyas for Diwali, not for a summer post.
 */
export function styleScene(style: BrandStyle, request: string): string | null {
  const wanted = occasionsIn(request);
  const festive = wanted.some((o) => ['diwali', 'holi', 'christmas', 'new year', 'celebration', 'gift'].includes(o));
  const backgrounds = style.backgrounds.flatMap((b) => b.split(/;\s*/)).map((b) => b.trim()).filter(Boolean);
  const background = (festive ? backgrounds.find((b) => /festive|celebrat|occasion/i.test(b)) : null)
    ?? backgrounds.find((b) => !/festive|occasion/i.test(b))
    ?? backgrounds[0]
    ?? null;
  const props = style.props
    .flatMap((p) => p.split(/;\s*/))
    .filter((p) => {
      const of = occasionsIn(p);
      return of.length === 0 ? false : of.some((o) => wanted.includes(o));
    });
  // An everyday post keeps the brand's room and drops its festive tables: "Candlelit interiors and festive tables" → "Candlelit interiors".
  const setting = background && !festive
    ? background.replace(/,?\s*(?:\band\b|\bor\b|;)\s*[^;,]*\b(festive|occasions?)\b[^;,]*/gi, '').trim() || background
    : background;
  // Its colours, without those kept for another occasion or for event cards: no Holi pastels on a Diwali post.
  const colours = (style.colourUse[0] ?? '').split(/;s*/).map((c) => c.trim())
    .filter((c) => c && !/event card/i.test(c) && occasionsIn(c).every((o) => wanted.includes(o) || !SEASONS.includes(o)));
  const light = style.lighting[0] ?? '';
  const parts = [
    setting,
    light ? (/light\b/i.test(light) ? light : `${light} light`) : '',
    props.length ? `props: ${props.join(', ')}` : '',
    colours.join('; '),
  ].filter(Boolean);
  return parts.length ? parts.join('; ').slice(0, 320) : null;
}
