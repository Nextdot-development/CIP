import 'server-only';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createCanvas, GlobalFonts, loadImage } from '@napi-rs/canvas';
import type { SKRSContext2D } from '@napi-rs/canvas';
import type { FittedLayout, LayoutLine } from '../brain/layouts';

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

export type HeadlineLine = { text: string; role: LayoutLine['role'] };
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
/** Constantia is part of Windows and Office; where it is installed, it is the face itself. */
const SYSTEM_FACES: Record<string, string> = {
  'constantia': 'constan.ttf', 'constantia-bold': 'constanb.ttf', 'constantia-italic': 'constani.ttf', 'constantia-bolditalic': 'constanz.ttf',
};

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
export function caseLines(lines: string[], casing: Casing, keep: string[] = []): string[] {
  if (casing === 'as-written') return lines;
  let sentenceStart = true;
  const out = lines.map((line, n) => {
    if (casing === 'upper') return line.toUpperCase();
    const words = line.split(/(\s+)/);
    return words.map((token, i) => {
      if (/^\s+$/.test(token) || token === '') return token;
      const bare = token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}']+$/gu, '');
      let word = token;
      if (casing === 'title') {
        const first = i === 0 && n === 0;
        const last = i === words.length - 1 && n === lines.length - 1;
        word = MINOR.has(bare.toLowerCase()) && !first && !last ? token.toLowerCase() : capital(token.toLowerCase());
      } else {
        word = sentenceStart ? capital(token.toLowerCase()) : token.toLowerCase();
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

export type SetHeadline = {
  bytes: Buffer;
  /** Each line as set, where it landed in pixels, and the face it was set in. */
  lines: { text: string; role: LayoutLine['role']; box: { x: number; y: number; w: number; h: number }; face: string; substitute: boolean }[];
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
export async function setHeadline(input: {
  image: Buffer;
  layout: FittedLayout;
  lines: HeadlineLine[];
  casing?: Casing;
  keep?: string[];
  colours?: { ink?: string; accent?: string; boxInk?: string };
}): Promise<SetHeadline> {
  const img = await loadImage(input.image);
  const W = img.width;
  const H = img.height;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const text = input.layout.text;
  if (!text || input.lines.length === 0) return { bytes: canvas.toBuffer('image/png'), lines: [] };

  const ink = input.colours?.ink ?? text.ink;
  const accent = input.colours?.accent ?? text.accent ?? '#f5c242';
  const boxInk = input.colours?.boxInk ?? '#141414';
  const casing = input.casing ?? 'sentence';
  const cased = caseLines(input.lines.map((l) => l.text), casing, input.keep);
  const styleFor = (role: LayoutLine['role']) =>
    text.lines.find((l) => l.role === role) ?? text.lines.find((l) => l.role === 'lead') ?? text.lines[0]!;

  // The block's width is what the designer's words took; a headline of other
  // words may take a little more, up to the bottle or the margin, but no more.
  const x0 = text.x * W;
  const bottle = input.layout.bottleBox;
  const edge = bottle && bottle.x > text.x ? bottle.x - 0.03 : 0.97;
  const maxWidth = Math.max(text.width, Math.min(edge - text.x, text.width * 1.4)) * W;
  const background = ctx.getImageData(0, 0, W, H);

  // Fit: the lines as the planner wrote them, a little smaller if need be;
  // only then broken, evenly, and smaller again if the block still will not fit.
  type Placed = { text: string; role: LayoutLine['role']; style: LayoutLine; face: Face; px: number };
  const glue = [...(input.keep ?? []), ...OCCASIONS];
  const lay = (scale: number, mayBreak: boolean): Placed[] =>
    input.lines.flatMap((line, i) => {
      const style = styleFor(line.role);
      const face = faceFor(style);
      let px = Math.max(8, style.size * H * scale);
      const words = style.upper || casing === 'upper' ? cased[i]!.toUpperCase() : cased[i]!;
      setFont(ctx, face.family, px, style);
      // A boxed line is one phrase in one box: made smaller before it is split.
      const over = maxWidth / ctx.measureText(words).width;
      if (style.box && over < 1 && over >= 0.7) {
        px *= over * 0.99;
        return [{ text: words, role: line.role, style, face, px }];
      }
      const broken = mayBreak ? balancedLines(words, maxWidth, (s) => ctx.measureText(s).width, 4, glue) : [words];
      return broken.map((t) => ({ text: t, role: line.role, style, face, px }));
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
  const low = learned ? learned.y + learned.h / 2 > 0.5 : text.y > 0.5;
  const start = low && learned ? (learned.y + learned.h) * H - height : text.y * H;
  let y = Math.min(Math.max(start, 0.03 * H), 0.97 * H - height);

  const out: SetHeadline['lines'] = [];
  for (const [i, line] of placed!.entries()) {
    setFont(ctx, line.face.family, line.px, line.style);
    const width = ctx.measureText(line.text).width;
    const x = text.align === 'center' ? x0 + (maxWidth - width) / 2 : text.align === 'right' ? x0 + maxWidth - width : x0;
    // A line's top: the box's padding first, when it has one.
    const pad = padOf(line);
    const top = y + pad.y;

    if (line.style.box) {
      ctx.save();
      ctx.fillStyle = line.style.box;
      ctx.fillRect(x - pad.x, top - pad.y, width + pad.x * 2, line.px * 1.0 + pad.y * 2);
      ctx.restore();
    } else {
      // A light word on a bright ground, or a dark one on a dark ground, gets a soft shadow.
      const colour = line.style.accent ? accent : ink;
      const behind = luminanceIn(background.data, W, H, { x, y: top, w: width, h: line.px });
      const lightInk = luminanceOf(colour) > 0.5;
      if (lightInk ? behind > 0.5 : behind < 0.35) {
        ctx.shadowColor = lightInk ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.55)';
        ctx.shadowBlur = line.px * 0.35;
        ctx.shadowOffsetY = line.px * 0.04;
      }
    }
    ctx.fillStyle = line.style.box ? boxInk : line.style.accent ? accent : ink;
    ctx.textBaseline = 'top';
    ctx.fillText(line.text, x, top);
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    out.push({ text: line.text, role: line.role, box: { x, y: top, w: width, h: line.px }, face: line.face.family.replace(/^CIP /, ''), substitute: line.face.substitute });

    y += advance(line, placed![i + 1]);
  }
  return { bytes: canvas.toBuffer('image/png'), lines: out };
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
