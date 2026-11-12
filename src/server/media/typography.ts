import 'server-only';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createCanvas, GlobalFonts, loadImage } from '@napi-rs/canvas';
import type { Canvas, SKRSContext2D } from '@napi-rs/canvas';
import type { FittedLayout, LayoutLine, LayoutSpec } from '../brain/layouts';

/**
 * The headline, set the way the brand's designers set it - not drawn by an
 * image model, which misspells, miscapitalises and lets lines wander.
 *
 * Each line takes its style from the layout - the face, size, weight,
 * capitals, tracking, accent colour or highlight box the designers used for
 * that part of the headline - starts on the layout's left edge, and breaks
 * where a designer would break it: evenly, never leaving one word alone.
 * Capitals follow one rule for the whole headline, and a brand's own names
 * and the names of occasions are always written as they are written.
 */

/** A line of the headline: its words, its part, and - when a person chose one for it alone - its own face. */
export type HeadlineLine = { text: string; role: LayoutLine['role']; font?: string; ink?: string };
export type Casing = 'sentence' | 'title' | 'upper' | 'as-written';

// --- faces ---------------------------------------------------------------------------

const BUNDLED = join(process.cwd(), 'src', 'server', 'media', 'fonts');
/** Where a brand's own font files are kept, named by their PostScript names. */
const BRAND_FONTS = process.env.CIP_BRAND_FONTS_DIR ?? join(process.cwd(), '.brand-fonts');
const SYSTEM = process.platform === 'win32' ? 'C:\\Windows\\Fonts' : '/usr/share/fonts/truetype';

/**
 * Faces a brand uses that CIP does not hold, and the nearest free one: until
 * the brand's own files are given, the layout is kept and the look is close.
 */
const LOOK_ALIKES: [RegExp, string][] = [
  [/^chloe/i, 'AbrilFatface-Regular'],
  [/^esther/i, 'CormorantGaramond-Light'],
  [/royal\s*augustine/i, 'Marcellus-Regular'],
  [/^constantia-?bold/i, 'CrimsonText-Bold'],
  [/^constantia-?italic/i, 'CrimsonText-Italic'],
  [/^constantia/i, 'CrimsonText-Regular'],
  [/blacksword|ananda|swash|brush|script/i, 'BerkshireSwash-Regular'],
];
/** Constantia and Georgia are part of Windows and Office; where they are installed, they are the faces themselves. */
const SYSTEM_FACES: Record<string, string> = {
  'constantia': 'constan.ttf', 'constantia-bold': 'constanb.ttf', 'constantia-italic': 'constani.ttf', 'constantia-bolditalic': 'constanz.ttf',
  'georgia': 'georgia.ttf', 'georgia-bold': 'georgiab.ttf', 'georgia-italic': 'georgiai.ttf', 'georgia-bolditalic': 'georgiaz.ttf',
};

// --- the faces a person may choose for a headline ---------------------------------------

/**
 * The faces a headline may be set in, as the brand team named them. Three are
 * free and ship with CIP; Georgia is the machine's own where it has it; the
 * rest are the brand's licensed faces, used from their files once given (in
 * the brand fonts folder) - until then, the nearest free face stands in and
 * the page says so.
 */
export const HEADLINE_FONTS = [
  { id: 'poppins', label: 'Poppins' },
  { id: 'brittany-signature', label: 'Brittany Signature' },
  { id: 'instrument-serif', label: 'Instrument Serif' },
  { id: 'playfair-display', label: 'Playfair Display' },
  { id: 'butler', label: 'Butler' },
  { id: 'georgia', label: 'Georgia' },
  { id: 'miller-banner', label: 'Miller Banner' },
  { id: 'andrade-pro', label: 'Andrade Pro' },
] as const;
export type HeadlineFontId = (typeof HEADLINE_FONTS)[number]['id'];

type Cut = { weight: LayoutLine['weight']; italic: boolean };

/** A free face of CIP's own, by weight: what a family without a file of its own is set in. */
const SHIPPED: Record<string, (c: Cut) => string> = {
  poppins: (c) => (c.weight === 'black' ? 'Poppins-Black' : c.weight === 'bold' ? (c.italic ? 'Poppins-SemiBoldItalic' : 'Poppins-SemiBold') : c.italic ? 'Poppins-Italic' : 'Poppins-Regular'),
  playfair: (c) => (c.italic ? 'PlayfairDisplay-Italic' : c.weight === 'black' ? 'PlayfairDisplay-Black' : c.weight === 'bold' ? 'PlayfairDisplay-Bold' : 'PlayfairDisplay-Regular'),
  instrument: (c) => (c.italic ? 'InstrumentSerif-Italic' : 'InstrumentSerif-Regular'),
  gelasio: (c) => (c.italic ? 'Gelasio-Italic' : c.weight === 'regular' ? 'Gelasio-Regular' : 'Gelasio-Bold'),
  vibes: () => 'GreatVibes-Regular',
};

/** For each face: the start of its own files' names, and the free face that stands in without them. */
const CHOICES: Record<HeadlineFontId, { own?: string; system?: boolean; standIn: string }> = {
  'poppins': { standIn: 'poppins' },
  'instrument-serif': { standIn: 'instrument' },
  'playfair-display': { standIn: 'playfair' },
  'georgia': { system: true, standIn: 'gelasio' },
  'brittany-signature': { own: 'brittany', standIn: 'vibes' },
  'butler': { own: 'butler', standIn: 'playfair' },
  'miller-banner': { own: 'millerbanner', standIn: 'playfair' },
  'andrade-pro': { own: 'andrade', standIn: 'gelasio' },
};

/** The brand's own file for a face, nearest the weight asked for: "Butler_Black.otf", "MillerBanner-Italic.ttf". */
function ownFile(start: string, cut: Cut): string | null {
  if (!existsSync(BRAND_FONTS)) return null;
  const files = readdirSync(BRAND_FONTS).filter((f) => /\.(ttf|otf)$/i.test(f) && key(f).replace(/[^a-z0-9]/g, '').startsWith(start));
  if (!files.length) return null;
  const score = (f: string) => {
    const n = key(f);
    const italic = /italic|oblique/.test(n) === cut.italic ? 4 : 0;
    const weight = cut.weight === 'black' ? (/black|heavy|ultra/.test(n) ? 3 : /extrabold|bold/.test(n) ? 2 : 0)
      : cut.weight === 'bold' ? (/semibold|bold/.test(n) && !/extra|black/.test(n) ? 3 : /medium/.test(n) ? 1 : 0)
      : /regular|roman|book|light/.test(n) || !/bold|black|medium|heavy/.test(n) ? 3 : 0;
    return italic + weight;
  };
  return join(BRAND_FONTS, files.sort((a, b) => score(b) - score(a))[0]!);
}

/** Whether a face is set from its own file here, or stands in with a free one. */
export function headlineFontIsOwn(id: HeadlineFontId): boolean {
  const c = CHOICES[id];
  if (!c.own && !c.system) return true;
  if (c.system) return existsSync(join(SYSTEM, SYSTEM_FACES.georgia!));
  return ownFile(c.own!, { weight: 'regular', italic: false }) !== null;
}

/**
 * The name to set a line in, for a face a person chose: a name faceFor finds
 * - the brand's own file, the machine's, or the free face standing in.
 */
export function headlineFontName(id: HeadlineFontId, cut: Cut): string {
  const c = CHOICES[id];
  if (c.own) {
    const own = ownFile(c.own, cut);
    if (own) return own.split(/[\\/]/).pop()!.replace(/\.(ttf|otf)$/i, '');
  }
  if (c.system) {
    const name = `georgia${cut.weight !== 'regular' ? '-bold' : ''}${cut.italic ? (cut.weight !== 'regular' ? 'italic' : '-italic') : ''}`;
    if (SYSTEM_FACES[name] && existsSync(join(SYSTEM, SYSTEM_FACES[name]!))) return name;
  }
  return SHIPPED[c.standIn]!(cut);
}

/** A line's style in the face a person chose for that line alone, at the line's own weight; as it was without one. */
function inOwnFace(style: LayoutLine, font: string | undefined): LayoutLine {
  if (!font || !(font in CHOICES)) return style;
  const id = font as HeadlineFontId;
  return { ...style, font: headlineFontName(id, { weight: style.weight, italic: style.italic }), script: id === 'brittany-signature' ? true : style.script };
}

/** A layout's headline set in the face a person chose, each line at its own weight. */
export function withHeadlineFont(spec: LayoutSpec, id: HeadlineFontId | null | undefined): LayoutSpec {
  if (!id || !spec.text || !(id in CHOICES)) return spec;
  return {
    ...spec,
    text: { ...spec.text, lines: spec.text.lines.map((l) => ({ ...l, font: headlineFontName(id, { weight: l.weight, italic: l.italic }), script: id === 'brittany-signature' })) },
  };
}

const registered = new Map<string, string>();
function register(path: string): string {
  const known = registered.get(path);
  if (known) return known;
  const family = `CIP ${path.split(/[\\/]/).pop()!.replace(/\.(ttf|otf)$/i, '')}`;
  GlobalFonts.registerFromPath(path, family);
  registered.set(path, family);
  return family;
}

const key = (s: string) => s.toLowerCase().replace(/[\s_]+/g, '');

function fileIn(dir: string, name: string): string | null {
  if (!existsSync(dir)) return null;
  const wanted = key(name);
  const hit = readdirSync(dir).find((f) => /\.(ttf|otf)$/i.test(f) && key(f.replace(/\.(ttf|otf)$/i, '')) === wanted);
  return hit ? join(dir, hit) : null;
}

export type Face = { family: string; file: string; substitute: boolean };

/**
 * The face for a line: the brand's own file first, then one CIP ships, then
 * one the machine has, then the nearest look-alike, then a plain face of the
 * same kind.
 */
export function faceFor(line: Pick<LayoutLine, 'font' | 'weight' | 'italic' | 'script'>): Face {
  const name = line.font ?? '';
  if (name) {
    const own = fileIn(BRAND_FONTS, name) ?? fileIn(BUNDLED, name);
    if (own) return { family: register(own), file: own, substitute: false };
    const system = SYSTEM_FACES[key(name)];
    if (system && existsSync(join(SYSTEM, system))) return { family: register(join(SYSTEM, system)), file: join(SYSTEM, system), substitute: false };
    const like = LOOK_ALIKES.find(([re]) => re.test(name));
    if (like) {
      const file = join(BUNDLED, `${like[1]}.ttf`);
      return { family: register(file), file, substitute: true };
    }
  }
  const plain = line.script ? 'BerkshireSwash-Regular'
    : line.weight === 'black' ? 'Poppins-Black'
    : line.weight === 'bold' ? (line.italic ? 'Poppins-SemiBoldItalic' : 'Poppins-SemiBold')
    : line.italic ? 'Poppins-Italic' : 'Poppins-Regular';
  const file = join(BUNDLED, `${plain}.ttf`);
  return { family: register(file), file, substitute: Boolean(name) };
}

// --- capitals ------------------------------------------------------------------------

/** Occasions are names: "Happy New Year", never "happy new year". */
const OCCASIONS = [
  'Happy New Year', 'New Year', "New Year's Eve", 'Diwali', 'Holi', 'Christmas', 'Merry Christmas', 'Eid', 'Eid Mubarak',
  'Navratri', 'Durga Puja', 'Dussehra', 'Raksha Bandhan', 'Lohri', 'Pongal', 'Onam', 'Baisakhi', 'Ganesh Chaturthi',
  'Independence Day', 'Republic Day', "Valentine's Day", 'Friendship Day', "Father's Day", "Mother's Day", "Women's Day",
  'World Heart Day', 'Breastfeeding Week',
];
/** Words a phrase cannot end on: a line ending on one runs on into the next. */
const RUNS_ON = new Set(['a', 'an', 'the', 'and', 'or', 'but', 'of', 'in', 'on', 'at', 'to', 'by', 'with', 'from', 'for', 'your', 'our', 'my', 'every', 'is', 'are']);
/** Words that carry the line before on: a line opening on one continues it. */
const CARRIES_ON = new Set(['with', 'and', 'or', 'but', 'by', 'for', 'to', 'of', 'in', 'on', 'at', 'from', 'that', 'while', 'as', 'till', 'until']);
const MINOR = new Set(['a', 'an', 'the', 'and', 'but', 'or', 'nor', 'for', 'so', 'yet', 'of', 'in', 'on', 'at', 'to', 'by', 'with', 'from', 'as', 'per', 'via']);

/**
 * The headline's capitals, one rule for every line.
 *
 *   sentence   "Squeeze the nectar, sip the magic" - a capital to start each sentence
 *   title      "Sweet Moments, Smooth Sips" - a capital to every word but the small ones
 *   upper      "CATCH THE FIRE"
 *
 * Whatever the rule, `keep` (the brand's names: "8PM", "Magic Moments") and
 * the occasions are written exactly as they are written, and "I" is a capital.
 */
export function caseLines(given: string[], casing: Casing, keep: string[] = []): string[] {
  const lines = given.map(printable);
  if (casing === 'as-written') return lines;
  let sentenceStart = true;
  const out = lines.map((line, n) => {
    if (casing === 'upper') return line.toUpperCase();
    // Each line is a new phrase unless it runs on from the one before: that
    // ended on a comma or a dash, or on a word that cannot end one, or this
    // one opens on a word that carries the last one on ("with", "and").
    const before = n > 0 ? lines[n - 1]!.trim() : '';
    const opens = line.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
    // A writer who used capitals has already decided; only words typed all in
    // small letters are decided here.
    const decided = lines.some((l) => /\p{Lu}/u.test(l)) && !lines.every((l) => l === l.toUpperCase());
    if (n > 0 && decided && /^[^\p{L}]*\p{Ll}/u.test(line.trim())) sentenceStart = false;
    else if (n > 0 && !/[,;:&–—-]$/.test(before) && !RUNS_ON.has(before.split(/\s+/).at(-1)!.toLowerCase()) && !CARRIES_ON.has(opens)) sentenceStart = true;
    const words = line.split(/(\s+)/);
    // A line typed in capitals, or with a capital on every word, says nothing
    // about which words are names; a capital mid-line in any other says it is one.
    const lettered = words.filter((w) => /\p{L}{2}/u.test(w));
    const shouted = lettered.length > 0 && lettered.every((w) => w === w.toUpperCase());
    const titled = lettered.length >= 3 && lettered.every((w) => /^[^\p{L}]*\p{Lu}/u.test(w));
    const plain = (token: string) => (shouted || titled || token === token.toUpperCase() ? token.toLowerCase() : token);
    return words.map((token, i) => {
      if (/^\s+$/.test(token) || token === '') return token;
      const bare = token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}']+$/gu, '');
      let word = token;
      if (casing === 'title') {
        const first = i === 0 && n === 0;
        const last = i === words.length - 1 && n === lines.length - 1;
        word = MINOR.has(bare.toLowerCase()) && !first && !last ? token.toLowerCase() : capital(token.toLowerCase());
      } else {
        word = sentenceStart ? capital(plain(token)) : plain(token);
      }
      if (bare) sentenceStart = /[.!?]["')\]]*$/.test(token);
      if (bare.toLowerCase() === 'i') word = token.replace(/i/i, 'I');
      return word;
    }).join('');
  });
  // Names over any rule: the brand's own, and the occasions.
  const names = [...keep, ...OCCASIONS].sort((a, b) => b.length - a.length);
  return out.map((line) => {
    let fixed = line;
    for (const name of names) {
      const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/'/g, "[’']")}(?![\\p{L}\\p{N}])`, 'giu');
      fixed = fixed.replace(pattern, casing === 'upper' ? name.toUpperCase() : name);
    }
    return fixed;
  });
}

/**
 * Words as the brand's typefaces can set them.
 *
 * A model writes "honey‑gold" with a non-breaking hyphen and "well‑kept" with
 * another, and no face here has those characters: each was set as an empty
 * box in the middle of the headline. Every such character is written as the
 * one a face has - a plain hyphen, a plain space - and what no face has at
 * all, an emoji or an invisible joiner, is left out.
 */
export function printable(text: string): string {
  return text
    .replace(/[‐‑⁃−]/g, '-')
    .replace(/‒/g, '–')
    .replace(/―/g, '—')
    .replace(/[  -   　]/g, ' ')
    .replace(/[­​-‍⁠﻿]/g, '')
    .replace(/[′‵]/g, '’')
    .replace(/\p{Extended_Pictographic}️?/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function capital(word: string): string {
  const i = word.search(/\p{L}/u);
  return i < 0 ? word : word.slice(0, i) + word[i]!.toUpperCase() + word.slice(i + 1);
}

// --- breaking lines -------------------------------------------------------------------

/**
 * Words broken into the fewest lines that fit the width, as even as can be -
 * the way a designer breaks a headline: never one word left alone on a line,
 * and never a name ("Happy New Year", "Magic Moments") broken in two.
 */
export function balancedLines(text: string, maxWidth: number, measure: (s: string) => number, maxLines = 4, glue: string[] = []): string[] {
  const NBSP = ' ';
  let held = text.trim();
  for (const name of [...glue].sort((a, b) => b.length - a.length)) {
    const at = held.toLowerCase().indexOf(name.toLowerCase());
    if (at >= 0 && name.includes(' ')) held = held.slice(0, at) + held.slice(at, at + name.length).replace(/ /g, NBSP) + held.slice(at + name.length);
  }
  const words = held.split(/[ \t\n]+/).filter(Boolean);
  const out = (lines: string[]) => lines.map((l) => l.replaceAll(NBSP, ' '));
  if (words.length <= 1 || measure(text.trim()) <= maxWidth) return [text.trim()];
  let best: string[] | null = null;
  let bestScore = Infinity;
  for (let k = 2; k <= Math.min(maxLines, words.length); k++) {
    // Every way to cut the words into k lines.
    const cuts = (start: number, left: number): number[][] =>
      left === 1 ? [[]] : Array.from({ length: words.length - start - left + 1 }, (_, j) => start + 1 + j)
        .flatMap((cut) => cuts(cut, left - 1).map((rest) => [cut, ...rest]));
    for (const at of cuts(0, k)) {
      const bounds = [0, ...at, words.length];
      const lines = bounds.slice(0, -1).map((b, i) => words.slice(b, bounds[i + 1]).join(' '));
      const widths = lines.map((l) => measure(l.replaceAll(NBSP, ' ')));
      if (Math.max(...widths) > maxWidth) continue;
      // Even lines, and no line that is one short word.
      const mean = widths.reduce((a, b) => a + b, 0) / k;
      const alone = lines.filter((l) => !l.includes(' ') && !l.includes(NBSP)).length;
      const score = widths.reduce((s, w) => s + (w - mean) ** 2, 0) + alone * mean * mean;
      if (score < bestScore) { bestScore = score; best = lines; }
    }
    if (best) return out(best);
  }
  return [text.trim()];
}

// --- setting the headline ---------------------------------------------------------------

/** The set headline, its pictures encoded only when read. */
function encodedLater(canvas: Canvas, words: Canvas, lines: SetLine[]): SetHeadline {
  let flat: Buffer | null = null;
  let layer: Buffer | null = null;
  return {
    get bytes() { return (flat ??= canvas.toBuffer('image/png')); },
    canvas,
    get layer() { return (layer ??= words.toBuffer('image/png')); },
    layerCanvas: words,
    lines,
  };
}

export type SetHeadline = {
  /** The picture with its words, encoded when first asked for. */
  bytes: Buffer;
  /** The same, not yet encoded: to draw on without a PNG there and back. */
  canvas: Canvas;
  /** The headline alone, on transparency: the layer a designer would edit. */
  layer: Buffer;
  /** That layer, not yet encoded. */
  layerCanvas: Canvas;
  /** Each line as set, where it landed in pixels, and the face it was set in. */
  lines: SetLine[];
};

/** One line as set: enough to set it again as live text in another editor. */
export type SetLine = {
  text: string;
  role: LayoutLine['role'];
  /** Its box in pixels, from the top of its letters. */
  box: { x: number; y: number; w: number; h: number };
  /** The face's name, and the file it was set from. */
  face: string;
  file: string;
  /** The brand's own name for the face, as Photoshop and Illustrator know it. */
  font: string;
  substitute: boolean;
  px: number;
  colour: string;
  /** Letter spacing in pixels. */
  spacing: number;
  /** The solid box behind it, when it has one. */
  boxFill: string | null;
  shadow: boolean;
  /** Which layer its pixels are on: the headline's, or the added text's. */
  layer?: 'headline' | 'texts';
};

/**
 * The headline set on a picture, in the layout's text block.
 *
 * `lines` are the headline as the planner wrote it, each with its part: the
 * lead words, the key word made to stand out, the tail. Each takes the style
 * the layout gives that part; a line too long for the block is broken evenly,
 * and the whole block made a little smaller only when it will not otherwise
 * fit. Words over a ground too bright for them get a soft shadow.
 */
/**
 * How wide a headline is at the layout's sizes, unbroken: its longest line as
 * a share of the post's width, and its number of lines. What the layout is
 * fitted to, so the bottle makes way for these words rather than the
 * designer's.
 */
export function measureHeadline(
  text: NonNullable<LayoutSpec['text']>,
  lines: HeadlineLine[],
  ratio: number,
  casing: Casing = 'sentence',
  keep: string[] = [],
): { width: number; lines: number } {
  const H = 1000;
  const ctx = createCanvas(10, 10).getContext('2d');
  const cased = caseLines(lines.map((l) => l.text), casing, keep);
  let widest = 0;
  lines.forEach((line, i) => {
    const style = inOwnFace(text.lines.find((l) => l.role === line.role) ?? text.lines[0]!, line.font);
    setFont(ctx, faceFor(style).family, style.size * H, style);
    const words = style.upper || casing === 'upper' ? cased[i]!.toUpperCase() : cased[i]!;
    widest = Math.max(widest, ctx.measureText(words).width + (style.box ? style.size * H * 0.4 : 0));
  });
  return { width: widest / (H * ratio), lines: lines.length };
}

export async function setHeadline(input: {
  /** The picture to set the words on: bytes, or a canvas already drawn. */
  image: Buffer | Canvas;
  layout: FittedLayout;
  lines: HeadlineLine[];
  casing?: Casing;
  keep?: string[];
  colours?: { ink?: string; accent?: string; boxInk?: string };
  /** Every line's size, scaled: a headline set a little smaller to sit on fewer lines. */
  scale?: number;
}): Promise<SetHeadline> {
  const img = Buffer.isBuffer(input.image) ? await loadImage(input.image) : input.image;
  const W = img.width;
  const H = img.height;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const text = input.layout.text;
  if (!text || input.lines.length === 0) {
    return encodedLater(canvas, createCanvas(W, H), []);
  }
  // The words are set on a layer of their own and laid over the picture, so
  // the same headline can be handed to an editor as its own layer.
  const words = createCanvas(W, H);
  const wctx = words.getContext('2d');

  const ink = input.colours?.ink ?? text.ink;
  const accent = input.colours?.accent ?? text.accent ?? '#f5c242';
  const boxInk = input.colours?.boxInk ?? '#141414';
  const casing = input.casing ?? 'sentence';
  const cased = caseLines(input.lines.map((l) => l.text), casing, input.keep);
  const styleFor = (role: LayoutLine['role']) =>
    text.lines.find((l) => l.role === role) ?? text.lines.find((l) => l.role === 'lead') ?? text.lines[0]!;

  // The block's width is what the designer's words took; a headline of other
  // words may take a little more - never past the bottle beside it, or the
  // margin, whatever width it was given.
  const x0 = text.x * W;
  const bottle = input.layout.bottleBox;
  const block = input.layout.textBox;
  // Beside the words unless it stands wholly below them: a tall bottle whose
  // top is level with the lower lines is still in their way.
  // A bottle under words centred across the post is below them, not beside.
  // Words placed by hand go where they were put, whatever stands beside them.
  const beside = !input.layout.placedText && bottle && bottle.x > text.x && bottle.x + bottle.w / 2 > text.x + text.width / 2 + 0.1
    && (!block || bottle.y < block.y + block.h + 0.08);
  const edge = beside ? bottle.x - 0.03 : 0.97;
  const maxWidth = Math.max(0.15, Math.min(edge - text.x, text.width * 1.4)) * W;
  const background = ctx.getImageData(0, 0, W, H);

  // Fit: the lines as the planner wrote them, a little smaller if need be;
  // only then broken, evenly, and smaller again if the block still will not fit.
  type Placed = { text: string; role: LayoutLine['role']; style: LayoutLine; face: Face; px: number; ink?: string };
  const glue = [...(input.keep ?? []), ...OCCASIONS];
  const lay = (scale: number, mayBreak: boolean): Placed[] =>
    input.lines.flatMap((line, i) => {
      const style = inOwnFace(styleFor(line.role), line.font);
      const face = faceFor(style);
      let px = Math.max(8, style.size * H * scale * (input.scale ?? 1));
      const words = style.upper || casing === 'upper' ? cased[i]!.toUpperCase() : cased[i]!;
      setFont(ctx, face.family, px, style);
      // A boxed line is one phrase in one box, and a part of the headline
      // that is one short line - the key words, the tail - reads as one:
      // either is made smaller before it is split.
      const over = maxWidth / ctx.measureText(words).width;
      const alone = input.lines.filter((l) => l.role === line.role).length === 1 && words.split(/\s+/).length <= 4;
      if ((style.box || alone) && over < 1 && over >= (style.box ? 0.7 : 0.75)) {
        px *= over * 0.99;
        return [{ text: words, role: line.role, style, face, px, ink: line.ink }];
      }
      const broken = mayBreak ? balancedLines(words, maxWidth, (s) => ctx.measureText(s).width, 4, glue) : [words];
      return broken.map((t) => ({ text: t, role: line.role, style, face, px, ink: line.ink }));
    });
  const fits = (p: Placed[]) => p.length <= 6 && p.every((l) => { setFont(ctx, l.face.family, l.px, l.style); return ctx.measureText(l.text).width <= maxWidth; });
  let placed: Placed[] | null = null;
  for (let scale = 1; !placed && scale >= 0.8 - 1e-9; scale -= 0.05) { const p = lay(scale, false); if (fits(p)) placed = p; }
  for (let scale = 1; !placed && scale >= 0.7 - 1e-9; scale -= 0.05) { const p = lay(scale, true); if (fits(p) || scale < 0.75) placed = p; }

  // Lines never closer than their own height, and a little air where one part
  // of the headline gives way to the next.
  const leading = Math.max(text.leading, 1.05);
  const padOf = (l: Placed) => (l.style.box ? { x: l.px * 0.2, y: l.px * 0.14 } : { x: 0, y: 0 });
  const advance = (l: Placed, next: Placed | undefined) =>
    padOf(l).y * 2 + l.px * (next ? leading : 1) + (next && next.role !== l.role ? l.px * 0.12 : 0);
  const height = placed!.reduce((h, l, i) => h + advance(l, placed![i + 1]), 0);
  // A block in the lower half grows upwards from where the designer's ended;
  // either way it stays inside the post.
  const learned = input.layout.textBox;
  const low = !input.layout.placedText && (learned ? learned.y + learned.h / 2 > 0.5 : text.y > 0.5);
  const start = low && learned ? (learned.y + learned.h) * H - height : text.y * H;
  let y = Math.min(Math.max(start, 0.03 * H), 0.97 * H - height);

  const out: SetLine[] = [];
  for (const [i, line] of placed!.entries()) {
    setFont(wctx, line.face.family, line.px, line.style);
    const width = wctx.measureText(line.text).width;
    const x = text.align === 'center' ? x0 + (maxWidth - width) / 2 : text.align === 'right' ? x0 + maxWidth - width : x0;
    // A line's top: the box's padding first, when it has one.
    const pad = padOf(line);
    const top = y + pad.y;

    // A colour a person gave this line alone comes first; a boxed line keeps the ink its box reads with.
    const colour = line.style.box ? boxInk : line.ink ?? (line.style.accent ? accent : ink);
    let shadow = false;
    if (line.style.box) {
      wctx.save();
      wctx.fillStyle = line.style.box;
      wctx.fillRect(x - pad.x, top - pad.y, width + pad.x * 2, line.px * 1.0 + pad.y * 2);
      wctx.restore();
    } else {
      // A light word on a bright ground, or a dark one on a dark ground, gets a soft shadow.
      const behind = luminanceIn(background.data, W, H, { x, y: top, w: width, h: line.px });
      const lightInk = luminanceOf(colour) > 0.5;
      if (lightInk ? behind > 0.5 : behind < 0.35) {
        shadow = true;
        wctx.shadowColor = lightInk ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.55)';
        wctx.shadowBlur = line.px * 0.35;
        wctx.shadowOffsetY = line.px * 0.04;
      }
    }
    wctx.fillStyle = colour;
    wctx.textBaseline = 'top';
    wctx.fillText(line.text, x, top);
    wctx.shadowColor = 'transparent';
    wctx.shadowBlur = 0;
    wctx.shadowOffsetY = 0;
    out.push({
      text: line.text, role: line.role, box: { x, y: top, w: width, h: line.px },
      face: line.face.family.replace(/^CIP /, ''), file: line.face.file, substitute: line.face.substitute,
      font: line.style.font ?? line.face.family.replace(/^CIP /, ''),
      px: line.px, colour, spacing: ((line.style.tracking || 0) / 1000) * line.px, boxFill: line.style.box, shadow,
    });

    y += advance(line, placed![i + 1]);
  }
  ctx.drawImage(words, 0, 0);
  return encodedLater(canvas, words, out);
}

function setFont(ctx: SKRSContext2D, family: string, px: number, style: Pick<LayoutLine, 'tracking'>) {
  ctx.font = `${px.toFixed(1)}px "${family}"`;
  (ctx as unknown as { letterSpacing: string }).letterSpacing = `${((style.tracking || 0) / 1000) * px}px`;
}

function luminanceOf(hex: string): number {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex);
  if (!m) return 1;
  const [r, g, b] = [m[1], m[2], m[3]].map((v) => parseInt(v!, 16) / 255);
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function luminanceIn(data: Uint8ClampedArray, W: number, H: number, box: { x: number; y: number; w: number; h: number }): number {
  const x0 = Math.max(0, Math.round(box.x)); const x1 = Math.min(W, Math.round(box.x + box.w));
  const y0 = Math.max(0, Math.round(box.y)); const y1 = Math.min(H, Math.round(box.y + box.h));
  let sum = 0; let n = 0;
  const step = Math.max(1, Math.round(Math.sqrt(((x1 - x0) * (y1 - y0)) / 4000)));
  for (let y = y0; y < y1; y += step) for (let x = x0; x < x1; x += step) {
    const i = (y * W + x) * 4;
    sum += (0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!) / 255;
    n += 1;
  }
  return n ? sum / n : 0;
}

// --- more text, beside the headline ----------------------------------------------------

/**
 * A block of text a person added to the post besides its headline - a line
 * under it, an offer, a call to act - placed, sized and styled on its own.
 * Positions are shares of the post; the size is a share of its short side,
 * so a block keeps its look on a banner as on a square.
 */
export type TextBlock = {
  id: string;
  lines: HeadlineLine[];
  /** Its top-left corner, and how wide it may run. */
  x: number;
  y: number;
  width: number;
  /** A plain line's type size. A highlighted line is set larger, a closing one smaller. */
  size: number;
  align: 'left' | 'center' | 'right';
  weight: LayoutLine['weight'];
  italic: boolean;
  upper: boolean;
  shadow: boolean;
  font?: HeadlineFontId;
  ink?: string;
};

const PART_SCALE: Record<LayoutLine['role'], number> = { lead: 1, key: 1.4, tail: 0.75 };

/**
 * The added blocks, each on the one layer laid over the headline: its lines
 * in its face and colours - or each line's own - fitted to its width. Says
 * where each block and each line landed, for dragging and for the editors.
 */
export function setTextBlocks(blocks: TextBlock[], W: number, H: number): {
  canvas: Canvas; lines: SetLine[]; boxes: { id: string; x: number; y: number; w: number; h: number }[];
} {
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  const short = Math.min(W, H);
  const lines: SetLine[] = [];
  const boxes: { id: string; x: number; y: number; w: number; h: number }[] = [];
  for (const block of blocks) {
    const maxWidth = Math.max(0.05, block.width) * W;
    const x0 = block.x * W;
    let y = block.y * H;
    let left = Infinity; let right = -Infinity;
    for (const line of block.lines) {
      const cut = { weight: block.weight, italic: block.italic };
      const own = (line.font ?? block.font) as HeadlineFontId | undefined;
      const name = own && own in CHOICES ? headlineFontName(own, cut) : SHIPPED.poppins!(cut);
      const style: LayoutLine = {
        role: line.role, size: block.size, font: name, weight: block.weight, italic: block.italic,
        script: own === 'brittany-signature', upper: block.upper, tracking: 0, accent: false, box: null,
      };
      const face = faceFor(style);
      const words = block.upper ? printable(line.text).toUpperCase() : printable(line.text);
      let px = Math.max(8, block.size * short * PART_SCALE[line.role]);
      setFont(ctx, face.family, px, style);
      // Too wide for the block: smaller, as far as half its size, rather than off the post.
      const over = maxWidth / Math.max(1, ctx.measureText(words).width);
      if (over < 1) { px = Math.max(px * 0.5, px * over * 0.99); setFont(ctx, face.family, px, style); }
      const width = ctx.measureText(words).width;
      const x = block.align === 'center' ? x0 + (maxWidth - width) / 2 : block.align === 'right' ? x0 + maxWidth - width : x0;
      const colour = line.ink ?? block.ink ?? '#ffffff';
      if (block.shadow) {
        const light = luminanceOf(colour) > 0.5;
        ctx.shadowColor = light ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.5)';
        ctx.shadowBlur = px * 0.3;
        ctx.shadowOffsetY = px * 0.04;
      }
      ctx.fillStyle = colour;
      ctx.textBaseline = 'top';
      ctx.fillText(words, x, y);
      ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
      lines.push({
        text: words, role: line.role, box: { x, y, w: width, h: px },
        face: face.family.replace(/^CIP /, ''), file: face.file, substitute: face.substitute,
        font: face.family.replace(/^CIP /, ''), px, colour, spacing: 0, boxFill: null, shadow: block.shadow, layer: 'texts',
      });
      left = Math.min(left, x); right = Math.max(right, x + width);
      y += px * 1.12;
    }
    if (block.lines.length) {
      boxes.push({ id: block.id, x: left / W, y: block.y, w: (right - left) / W, h: (y - block.y * H) / H });
    }
  }
  return { canvas, lines, boxes };
}
