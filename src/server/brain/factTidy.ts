/**
 * One way of saying each thing the Brain learns.
 *
 * Facts are phrased by a model, freshly for every file, so the same
 * observation arrived as "colour palette", "colourPalette", "colour_palette"
 * and "colours", and the same placement as "top-right" and "top-right corner".
 * Each was counted on its own: on Radico's roster 14,000 facts held 6,490
 * attribute names and only one in forty was ever seen twice. Evidence that
 * should have added up to a pattern was spread across spellings of it.
 *
 * And some of what was read is not knowledge about a brand at all - the
 * salutation of a letter, the axis of a revenue chart, a page's footer - or is
 * one file's pixels rather than anyone's choice, like the white of a white
 * background read as a "brand colour".
 *
 * So every fact is said one way before it is stored, and what is not about the
 * brand is not stored. Pure, so the same rule tidies new facts as they arrive
 * and the ones already on record.
 */

/**
 * The only answers an image's layout questions may have. The analysis is
 * given these lists to choose from, and older facts phrased freely are mapped
 * onto them, so both count towards the same claims.
 */
export const DESIGN_ANSWERS = {
  placement: [
    'top left', 'top centre', 'top right',
    'middle left', 'centre', 'middle right',
    'bottom left', 'bottom centre', 'bottom right',
  ],
  scale: ['small', 'medium', 'large'],
  case: ['all caps', 'title case', 'sentence case', 'lowercase', 'mixed case'],
  alignment: ['left', 'centre', 'right'],
  typeStyle: ['serif', 'sans serif', 'script', 'display', 'slab serif'],
  backgroundKind: ['plain colour', 'gradient', 'texture', 'studio surface', 'indoor scene', 'outdoor scene', 'illustration'],
  tone: ['dark', 'mid', 'light'],
  lighting: ['warm', 'cool', 'neutral'],
  imageStyle: ['product shot', 'lifestyle photo', 'illustration', 'graphic', 'mixed'],
  people: ['none', 'hands only', 'one person', 'a group'],
} as const;

export type TidyFact = {
  section: 'visual' | 'video' | 'content' | 'rules';
  attribute: string;
  value: string;
  brand: string | null;
};

/**
 * What a document says about itself or its business, rather than about how a
 * brand looks or speaks: a letter's salutation, a deck's revenue, a chart's
 * axis, a page's footer.
 */
const NOT_ABOUT_THE_BRAND =
  /\b(document ?(type|date)?|page (type|purpose|number)|deck|slide|section title|bullet|footer|header text|chart|graph|diagram|legend|axis|data ?shown|dataset|metric|revenue|margin|ebitda|financial|gross|profit|sales|volume growth|market share|price|mix commentary|signatory|signature|stamp|seal|salutation|letter|contact|e-?mail|phone|website|social links|url|address|references|disclosure|knowledge|flag for review|numeric format|instructional|ranking claims|matches listed|teams displayed)\b/;

/** Attribute names that mean the same thing, said the one way. */
const SAME_ATTRIBUTE: [RegExp, string][] = [
  [/^(colou?r ?palette|colou?r scheme|colou?rs|colou?r|dominant colou?rs?|primary colou?rs?|brand colou?rs?|palette)$/, 'palette'],
  [/^(accent|secondary) colou?r$/, '$1 colour'],
  [/^background( colou?r)?$/, 'background'],
  [/^(font|fonts|typeface|typography)( style)?$/, 'font'],
  [/^(brand )?logo (location|position|placement)$/, 'logo placement'],
  [/^(brand )?logo (scale|size)$/, 'logo scale'],
  [/^(brand logo|logo visible|brand mark)$/, 'logo'],
  [/^(brand )?wordmark( visible)?$/, 'wordmark'],
  [/^headline (position|location)$/, 'headline placement'],
  [/^(product|bottle) (position|location)$/, 'product placement'],
  [/^(tone|tone of voice|voice|brand voice)$/, 'tone of voice'],
  [/^lighting (style|quality)$/, 'lighting'],
  [/^photography$/, 'photography style'],
];

/** "colourPalette", "colour_palette" and "Colour palette (overall)" are one name. */
export function attributeName(raw: string): string {
  const plain = raw
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/[_/-]+/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  for (const [pattern, name] of SAME_ATTRIBUTE) {
    if (pattern.test(plain)) return plain.replace(pattern, name);
  }
  return plain;
}

/** A short answer to a fixed question, which is where spellings split evidence. */
function isPlacement(attribute: string): boolean {
  return /\b(placement|position|location)$/.test(attribute);
}

/** "ALL CAPS", "uppercase" and "All caps" are one way of setting words. */
function caseValue(value: string): string {
  const v = value.toLowerCase().replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (/^(all ?caps|all upper ?case|upper ?case|capitals|all capitals)$/.test(v)) return 'all caps';
  if (/^(title ?case|title)$/.test(v)) return 'title case';
  if (/^(sentence ?case|sentence)$/.test(v)) return 'sentence case';
  if (/^(all )?lower ?case$/.test(v)) return 'lowercase';
  if (/^mixed( case)?$/.test(v)) return 'mixed case';
  return v;
}

/**
 * "Top-right corner" is "top right"; "upper third, centred" is "top centre";
 * "centre left" is "middle left" - the cells of the grid the analysis chooses
 * from, wherever an older wording plainly names one.
 */
function placementValue(value: string): string {
  return value
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/\bcent(?:er|red|ered|ral)\b/g, 'centre')
    .replace(/\bupper( third)?\b/g, 'top')
    .replace(/\blower( third)?\b/g, 'bottom')
    .replace(/\b(corner|area|region|of the (frame|image|canvas|post)|the)\b/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:centre|middle) (left|right)$/, 'middle $1')
    .replace(/^(left|right) (?:centre|middle)$/, 'middle $1')
    .replace(/^(?:centre centre|middle centre|middle)$/, 'centre')
    .replace(/^(top|bottom)$/, '$1 centre')
    .replace(/^(?:centre|middle) (top|bottom)$/, '$1 centre')
    .replace(/^(left|right) (top|bottom)$/, '$2 $1')
    .replace(/^(left|right)$/, 'middle $1');
}

/** "About a quarter" is medium; "dominant" is large. */
function scaleValue(value: string): string {
  const v = value.toLowerCase().replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (/^(tiny|very small|small|minimal|subtle)$/.test(v)) return 'small';
  if (/^(about a (quarter|third)|a (quarter|third)|quarter|third|medium|moderate|mid|half|about half)$/.test(v)) return 'medium';
  if (/^(dominant|large|big|prominent|very large|hero|full width|most of the width)$/.test(v)) return 'large';
  return v;
}

/** A colour so close to white or black that it is a background, not a choice. */
export function isNeutralHex(value: string): boolean {
  const match = /^#?([0-9a-f]{6})$/i.exec(value.trim());
  if (!match) return false;
  const n = parseInt(match[1]!, 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const high = Math.max(r, g, b);
  const low = Math.min(r, g, b);
  return high - low <= 12 && (low >= 225 || high <= 30);
}

/**
 * The fact as it is stored, or null when it is not knowledge about a brand.
 *
 * Only short answers to fixed questions have their wording changed - a
 * placement, a case, a scale. A description, a line of copy or a rule keeps
 * its own words: changing those would change what it says.
 */
export function tidyFact<F extends TidyFact>(fact: F): F | null {
  const attribute = attributeName(fact.attribute);
  let value = fact.value.replace(/\s+/g, ' ').trim().replace(/[.;,]+$/, '');
  if (!attribute || value.length < 2) return null;
  if (NOT_ABOUT_THE_BRAND.test(attribute)) return null;
  if (/^(unknown|none|n\/?a|not visible|not applicable|not specified|unclear)$/i.test(value)) return null;

  const short = value.split(' ').length <= 6;
  if (/\bcase$/.test(attribute) && short) value = caseValue(value);
  else if (isPlacement(attribute) && short) value = placementValue(value);
  else if (/\b(scale|size)$/.test(attribute) && short) value = scaleValue(value);

  if (/^#?[0-9a-f]{6}$/i.test(value)) {
    if (isNeutralHex(value)) return null;
    value = `#${value.replace(/^#/, '').toLowerCase()}`;
  }
  if (!value) return null;

  return { ...fact, attribute, value };
}

/** What two facts are the same claim on: where, about what, and which brand. */
export function factKey(fact: TidyFact): string {
  return `${fact.section}|${fact.attribute}|${fact.value}|${fact.brand ?? ''}`;
}
