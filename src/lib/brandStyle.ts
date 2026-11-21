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
  // `keep`: a look the scene is painted from keeps its scope, so the scene can put this market's or pack's own first.
  const of = (re: RegExp, keep = false) => {
    const own: string[] = [];
    const every: string[] = [];
    for (const f of facts) {
      if (!re.test(f.attribute.toLowerCase())) continue;
      const { scope, text } = scopeOf(f.value);
      if (!text) continue;
      if (!scope) every.push(text);
      else if (context && inScope(scope, context)) own.push(keep ? f.value.trim() : text);
    }
    return [...new Set([...own, ...every])];
  };
  return {
    // A packshot's plain white or black is how the bottle was photographed, not a scene for a post.
    backgrounds: of(/^(background|setting|scene)$/, true).filter((b) => !/^(a |the )?(solid |plain |pure )?(white|black)( plain)?( background)?$/i.test(b) && !/photographed against/i.test(b)),
    props: of(/^props?$/, true),
    lighting: of(/^(lighting|light)$/, true),
    colourUse: of(/^(colou?r use)$/, true).filter((c) => !/#[0-9a-f]{6}/i.test(c)),
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

/** Whether the person asked for a glass or a drink in the scene: only then is one painted. */
export function asksForGlass(request: string | null | undefined): boolean {
  return /\b(glass(es)?|tumblers?|snifters?|coupes?|highballs?|copa|martini|cocktails?|mojito|negroni|whisky sour|on the rocks|neat pour|served|serve|ice cubes?|a drink|drinks|g&t|gin and tonic)\b/i.test(request ?? '');
}

export function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Words that say nothing about what a post is about. */
const EMPTY = new Set(['post', 'posts', 'headline', 'bottle', 'brand', 'with', 'from', 'that', 'this', 'your', 'make', 'create', 'image', 'picture',
  'scene', 'shot', 'background', 'glass', 'static', 'creative', 'instagram', 'story', 'banner', 'poster', 'some', 'into', 'every', 'more', 'than', 'have', 'their']);

/** Words that name a flavour or a pack's character: a line that shares one is that post's line. */
const FLAVOURS = new Set(['orange', 'lemon', 'lime', 'raspberry', 'berry', 'apple', 'chocolate', 'honey', 'mango', 'coffee', 'cafe', 'café', 'fire', 'spice',
  'cinnamon', 'saffron', 'watermelon', 'melon', 'mint', 'citru', 'gold', 'golden', 'royal', 'tiger', 'smoky', 'peat', 'vanilla', 'coconut', 'coco']);

/** The words a line is about, plainly: "Oranges!" and "orange" are one word. */
function about(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/\p{L}{4,}/gu) ?? []).filter((w) => !EMPTY.has(w)).map((w) => w.replace(/(ies)$/, 'y').replace(/s$/, '')));
}

/**
 * The brand's own lines, the best for this request first: a line that shares the request's occasion
 * counts three times, and each word they share - "orange", "honey", "royal", "evening" - once. Words
 * the person quoted as the headline are theirs and not matched against.
 */
export function rankHeadlines(request: string, examples: string[], brand?: string | null): { line: string; score: number }[] {
  const asked = request.replace(/["“][^"”]*["”]/g, ' ');
  const wanted = occasionsIn(asked);
  const own = about(brand ?? '');
  const words = new Set([...about(asked)].filter((w) => !own.has(w)));
  return examples
    .map((line) => {
      const shared = occasionsIn(line).filter((o) => wanted.includes(o)).length;
      const overlap = [...about(line)].filter((w) => words.has(w)).reduce((n, w) => n + (FLAVOURS.has(w) ? 5 : 1), 0);
      return { line, score: shared * 3 + overlap };
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * One of the brand's own headlines for this request: the one that shares its occasion or its words -
 * a Diwali line for a Diwali post, an orange line for an orange post - else one chosen by the request's
 * words, so two posts asked differently do not both carry the brand's first line. Null with nothing to choose from.
 */
export function pickHeadline(request: string, examples: string[], maxWords = 12, brand?: string | null): string | null {
  // A line that is the brand's name and a pack - "Whytehall honey", a layout's name - is not a headline.
  const own = about(brand ?? '');
  const fit = examples.filter((e) => e.trim().split(/\s+/).length <= maxWords && [...about(e)].filter((w) => !own.has(w)).length >= 2);
  if (!fit.length) return null;
  const ranked = rankHeadlines(request, fit, brand);
  if (ranked[0] && ranked[0].score > 0) {
    const top = ranked.filter((x) => x.score === ranked[0]!.score);
    return top[hash(request) % top.length]!.line;
  }
  // A seasonal line is not for a post that names no season.
  const plain = fit.filter((e) => !occasionsIn(e).some((o) => SEASONS.includes(o)));
  const pool = plain.length ? plain : fit;
  return pool[hash(request.trim().toLowerCase()) % pool.length]!;
}

/**
 * The parts of a look, each said once: "a rocks glass; Honey: honeycomb; Chocolate: chocolate pieces" is
 * three parts, and a part scoped to a pack or a market is kept only for a post that is about it.
 */
function partsFor(values: string[], context: { market?: string | null; request?: string | null }): string[] {
  return scopedParts(values, context).map((p) => p.text);
}

/** The parts with whether each was said for this post's market or pack - those are its own, ahead of the brand's every-day ones. */
function scopedParts(values: string[], context: { market?: string | null; request?: string | null }): { text: string; own: boolean }[] {
  return values
    .flatMap((v) => v.split(/;\s*/))
    .map((part) => scopeOf(part))
    .filter(({ scope, text }) => text && (!scope || inScope(scope, context)))
    .map(({ scope, text }) => ({ text, own: Boolean(scope) }));
}

/** Of the brand's backgrounds, the one the request's words point to - "a palace evening" to its palace interiors - else none. */
function pointedTo(request: string, options: string[]): string | null {
  const words = about(request.replace(/["“][^"”]*["”]/g, ' '));
  let best: { text: string; n: number } | null = null;
  for (const text of options) {
    const n = [...about(text)].filter((w) => words.has(w)).length;
    if (n > 0 && (!best || n > best.n)) best = { text, n };
  }
  return best?.text ?? null;
}

/** Of the brand's layouts, the one the request's words point to - a Honey post to its Honey layout - else null. */
export function layoutPointedTo(request: string, names: string[], brand: string): string | null {
  const own = about(brand);
  const words = new Set([...about(request)].filter((w) => !own.has(w)));
  let best: { name: string; n: number } | null = null;
  for (const name of names) {
    const n = [...about(name)].filter((w) => words.has(w)).length;
    if (n > 0 && (!best || n > best.n)) best = { name, n };
  }
  return best?.name ?? null;
}

/**
 * The scene the brand's posts are set in, for this request: its usual background, its everyday props and
 * serve, and the props that belong to the request's occasion only - diyas for Diwali, not for a summer post.
 */
export function styleScene(style: BrandStyle, request: string, market?: string | null): string | null {
  const context = { market: market ?? null, request };
  const wanted = occasionsIn(request);
  const festive = wanted.some((o) => ['diwali', 'holi', 'christmas', 'new year', 'celebration', 'gift'].includes(o));
  const backgrounds = partsFor(style.backgrounds, context);
  const background = (festive ? backgrounds.find((b) => /festive|celebrat|occasion/i.test(b)) : null)
    ?? pointedTo(request, backgrounds.filter((b) => !/festive|occasion/i.test(b)))
    ?? backgrounds.find((b) => !/festive|occasion/i.test(b))
    ?? backgrounds[0]
    ?? null;
  // The occasion's props when it has one, and two of the brand's everyday ones beside them.
  const scoped = scopedParts(style.props, context);
  const parts = scoped.map((p) => p.text);
  const occasionProps = parts.filter((p) => occasionsIn(p).some((o) => wanted.includes(o)));
  const plainDay = (p: string) => !occasionsIn(p).some((o) => SEASONS.includes(o) || ['celebration', 'gift'].includes(o)) && !occasionProps.includes(p);
  // Props said for this market or pack are its own; without them, the brand's first two every-day ones.
  const ownProps = scoped.filter((p) => p.own && plainDay(p.text)).map((p) => p.text);
  const everyday = (ownProps.length ? ownProps : parts.filter(plainDay)).slice(0, 2);
  // Glasses and drinks are laid on the post afterwards, as pictures of their own: none painted into the scene.
  const GLASSWARE = /\b(glass(es)?|tumbler|snifter|coupe|highball|copa|martini|cocktails?|mojito|negroni|sour|shots?|drink|ice( cubes?)?|pour)\b/i;
  // ...unless the person asked for one: then the brand's own glass and serve are part of the scene.
  const glass = asksForGlass(request);
  const props = [...occasionProps, ...everyday].map((p) => (glass ? p : p.split(/,\s*/).filter((x) => !GLASSWARE.test(x)).join(', '))).filter(Boolean);
  // How it is poured, so any glass in the scene is the brand's own: a snifter for a brandy, a rocks glass with large ice for this whisky.
  const serveSaid = style.serve ? partsFor([style.serve], context)[0] ?? null : null;
  const serve = serveSaid && serveSaid.length > 140 ? `${serveSaid.slice(0, 139).replace(/[ ,;-]+\S*$/, '')}…` : serveSaid;
  // An everyday post keeps the brand's room and drops its festive tables: "Candlelit interiors and festive tables" → "Candlelit interiors".
  const setting = background && !festive
    ? background.replace(/,?\s*(?:\band\b|\bor\b|;)\s*[^;,]*\b(festive|occasions?)\b[^;,]*/gi, '').trim() || background
    : background;
  // Its colours, without those kept for another occasion or for event cards: no Holi pastels on a Diwali post.
  const colours = partsFor(style.colourUse.slice(0, 1), context)
    .filter((c) => c && !/event card/i.test(c) && occasionsIn(c).every((o) => wanted.includes(o) || !SEASONS.includes(o)));
  const light = partsFor(style.lighting, context)[0] ?? '';
  const said = [
    setting,
    light ? (/light\b/i.test(light) ? light : `${light} light`) : '',
    props.length ? `props: ${props.join(', ')}` : '',
    // How it is served, only when a glass was asked for: otherwise the glass is laid on afterwards.
    glass && serve ? `serve: ${serve}` : '',
    colours.join('; '),
  ].filter(Boolean);
  return said.length ? said.join('; ').slice(0, 480) : null;
}
