import 'server-only';
import { withCompanyScope } from '../db';
import type { CompanyScope } from '../db';

/**
 * How a brand's designers lay out a post, as numbers: where the logo goes and
 * how big, where the bottle stands and how tall, where the words sit and how
 * each line is set. Learned from their own Photoshop files and kept per brand.
 *
 * Every measure is a fraction of the post - widths of its width, heights and
 * type sizes of its height - so a layout learned at 3000 pixels holds at 1080,
 * and adaptLayout carries it to another shape the way a designer would: the
 * same margins, the same logo, the words and the bottle moved to suit.
 */

export type Corner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

export type LayoutLine = {
  /** lead: the opening words; key: the word made to stand out; tail: the closing aside. */
  role: 'lead' | 'key' | 'tail';
  /** Type size, as a fraction of the post's height. */
  size: number;
  /** The face it was set in, by its PostScript name, when the file said. */
  font: string | null;
  weight: 'regular' | 'bold' | 'black';
  italic: boolean;
  /** Script and display faces read as such: Chloe, Berkshire Swash. */
  script: boolean;
  upper: boolean;
  /** Letter spacing in thousandths of an em, as Photoshop counts it. */
  tracking: number;
  /** In the brand's accent rather than the text colour. */
  accent: boolean;
  /** Set on a solid box - "Enriched" on white - with the box's colour. */
  box: string | null;
};

export type LayoutSpec = {
  /** Width over height of the post it was learned from. */
  ratio: number;
  logo: { corner: Corner; width: number; insetX: number; insetY: number } | null;
  /**
   * Centre across, the line it stands on, and its height. `chosen`: a person
   * put it on this side, and a post of another shape keeps it there.
   */
  bottle: { cx: number; base: number; height: number; chosen?: boolean } | null;
  text: {
    x: number;
    y: number;
    width: number;
    align: 'left' | 'center' | 'right';
    /** Line height over type size. */
    leading: number;
    lines: LayoutLine[];
    /** The colour the plain lines were set in, and the accent's. */
    ink: string;
    accent: string | null;
  } | null;
};

export type BrandLayout = { id: string; brand: string | null; name: string; source: string | null; spec: LayoutSpec };

// --- learning from a Photoshop file ---------------------------------------------

/** The parts of an ag-psd layer this reads. */
type PsdLayer = {
  name?: string;
  hidden?: boolean;
  left?: number; top?: number; right?: number; bottom?: number;
  blendMode?: string;
  opacity?: number;
  vectorFill?: { color?: { r: number; g: number; b: number } };
  adjustment?: unknown;
  text?: {
    text: string;
    transform?: number[];
    style?: { font?: { name?: string }; fontSize?: number; tracking?: number; fontCaps?: number; leading?: number; fillColor?: { r: number; g: number; b: number } };
    styleRuns?: { length: number; style?: { font?: { name?: string }; fontSize?: number; fillColor?: { r: number; g: number; b: number }; fontCaps?: number; tracking?: number } }[];
    paragraphStyle?: { justification?: string };
  };
  children?: PsdLayer[];
};

const hex = (c?: { r: number; g: number; b: number }) =>
  c ? `#${[c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}` : null;
const SCRIPT = /chloe|swash|script|brush|ananda|signature|calligraph|hand/i;
const weightOf = (font: string | null): LayoutLine['weight'] =>
  !font ? 'regular' : /black|heavy|extrabold|ultra/i.test(font) ? 'black' : /bold|semibold|demi/i.test(font) ? 'bold' : 'regular';

/** What a layer is, when its name is one of the brand's own pieces. */
export type KnownPiece = (layerName: string) => { kind: 'bottle' | 'logo' | 'creative' | 'other'; brand: string | null } | null;

/**
 * A layout read off a parsed Photoshop file: the visible text set as lines,
 * the bottle as the tall picture standing in the frame, the logo as the small
 * mark nearest a top corner - by name first where a layer is one of the
 * brand's own pieces. Returns null when there is nothing to learn: a file of a
 * single bottle or logo, with no words laid out against it.
 */
export function learnLayout(
  psd: { width: number; height: number; children?: PsdLayer[] },
  bottleNames: RegExp,
  known: KnownPiece = () => null,
): LayoutSpec | null {
  // A file holding two posts side by side (artboards) is learned from the first.
  let frame = { x: 0, y: 0, w: psd.width, h: psd.height };
  let layers = psd.children ?? [];
  const groups = layers.filter((l) => l.children && !l.hidden);
  if (groups.length >= 2 && groups[0]!.name && groups.every((g) => g.name!.startsWith(groups[0]!.name!.replace(/\s*\d+$/, '')))) {
    const boxes = flat(groups[0]!.children!).filter((l) => !l.text && (l.bottom ?? 0) - (l.top ?? 0) > psd.height * 0.95);
    const panel = boxes[0];
    if (panel) {
      frame = { x: panel.left ?? 0, y: 0, w: (panel.right ?? 0) - (panel.left ?? 0), h: psd.height };
      layers = groups[0]!.children!;
    }
  }
  const all = flat(layers).filter((l) => !l.hidden);
  const fx = (v: number) => (v - frame.x) / frame.w;
  const fy = (v: number) => (v - frame.y) / frame.h;
  const W = (l: PsdLayer) => ((l.right ?? 0) - (l.left ?? 0)) / frame.w;
  const H = (l: PsdLayer) => ((l.bottom ?? 0) - (l.top ?? 0)) / frame.h;

  // The text: every visible line, top to bottom.
  const texts = all.filter((l) => l.text && l.text.text.trim()).sort((a, b) => (a.top ?? 0) - (b.top ?? 0));
  const shapes = all.filter((l) => l.vectorFill?.color && W(l) < 0.9 && H(l) < 0.5);
  const lines: (LayoutLine & { colour: string | null; top: number })[] = [];
  let leading = 1.1;
  let align: 'left' | 'center' | 'right' = 'left';
  for (const layer of texts) {
    const t = layer.text!;
    const scale = Math.abs(t.transform?.[3] ?? 1) || 1;
    const runs = t.styleRuns?.length ? t.styleRuns : [{ length: t.text.length, style: t.style }];
    align = t.paragraphStyle?.justification === 'center' ? 'center' : t.paragraphStyle?.justification === 'right' ? 'right' : 'left';
    if (t.style?.leading && t.style.fontSize) leading = Math.max(0.8, Math.min(1.6, t.style.leading / t.style.fontSize));
    // Lines as the file breaks them, each taking the style of the run its first letter is in.
    let at = 0;
    const parts = t.text.split(/\r|\n/);
    for (const [i, part] of parts.entries()) {
      let run = runs[0]!;
      let pos = 0;
      for (const r of runs) { if (at < pos + r.length) { run = r; break; } pos += r.length; }
      at += part.length + 1;
      if (!part.trim()) continue;
      const font = run.style?.font?.name ?? t.style?.font?.name ?? null;
      const size = ((run.style?.fontSize ?? t.style?.fontSize ?? 0) * scale) / frame.h;
      // A box sits behind one line, not the whole block: this line's band of
      // the layer, and a shape covering most of it.
      const bandTop = (layer.top ?? 0) + ((layer.bottom ?? 0) - (layer.top ?? 0)) * (i / parts.length);
      const bandBottom = (layer.top ?? 0) + ((layer.bottom ?? 0) - (layer.top ?? 0)) * ((i + 1) / parts.length);
      const box = shapes.find((s) => overlaps(s, layer) &&
        Math.min(bandBottom, s.bottom ?? 0) - Math.max(bandTop, s.top ?? 0) >= (bandBottom - bandTop) * 0.5);
      lines.push({
        role: 'lead', size: size || H(layer) / Math.max(1, parts.length) * 0.75, font, weight: weightOf(font),
        italic: /italic|oblique/i.test(font ?? ''), script: SCRIPT.test(font ?? ''),
        upper: (run.style?.fontCaps ?? t.style?.fontCaps ?? 0) === 2 || (part.trim() === part.trim().toUpperCase() && /[A-Z]/.test(part)),
        tracking: run.style?.tracking ?? t.style?.tracking ?? 0, accent: false, box: box ? hex(box.vectorFill!.color) : null,
        colour: hex(run.style?.fillColor ?? t.style?.fillColor), top: fy((layer.top ?? 0)) + i * 0.0001,
      });
    }
  }
  // The plain colour is the commonest; a line in another is in the accent. The
  // biggest or accented line is the key; a small italic last line the tail.
  const counts = new Map<string, number>();
  for (const l of lines) if (l.colour && !l.box) counts.set(l.colour, (counts.get(l.colour) ?? 0) + 1);
  const ink = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '#ffffff';
  const accentColour = lines.find((l) => l.colour && l.colour !== ink && !l.box)?.colour ?? null;
  const biggest = Math.max(0, ...lines.map((l) => l.size));
  for (const l of lines) {
    l.accent = Boolean(accentColour && l.colour === accentColour);
    if (l.accent || l.box || (l.size >= biggest * 1.25 && lines.length > 1)) l.role = 'key';
  }
  const last = lines.at(-1);
  const family = (font: string | null) => (font ?? '').split('-')[0]!.toLowerCase();
  if (last && lines.length > 1 && last.role === 'lead' &&
      (last.italic || last.size < biggest * 0.8 || family(last.font) !== family(lines[0]!.font))) last.role = 'tail';

  const textBox = texts.length
    ? {
        x: fx(Math.min(...texts.map((l) => l.left ?? 0))),
        y: fy(Math.min(...texts.map((l) => l.top ?? 0))),
        width: Math.max(...texts.map((l) => (l.right ?? 0))) / 1 - Math.min(...texts.map((l) => l.left ?? 0)),
      }
    : null;

  // The bottle: a tall picture standing in the frame - by name when it says.
  const pictures = all.filter((l) => !l.text && !l.vectorFill && !l.adjustment && W(l) > 0.02 && W(l) < 0.7 && H(l) > 0.2);
  const isBottle = (l: PsdLayer) => (known(l.name ?? '')?.kind === 'bottle' ? 2 : bottleNames.test(l.name ?? '') ? 1 : 0);
  const standing = pictures
    .filter((l) => H(l) / W(l) * (frame.h / frame.w) > 1.3 && (l.blendMode ?? 'normal') === 'normal')
    .sort((a, b) => isBottle(b) - isBottle(a) || H(b) - H(a))[0];
  // One running off the foot of the frame is held by somebody, not standing:
  // a lifestyle shot, whose bottle cannot be placed the same way.
  const bottle = standing && fy(standing.bottom ?? 0) < 0.975 ? standing : undefined;

  // The logo: a small mark in the top band, nearest a corner.
  const isLogo = (l: PsdLayer) => (known(l.name ?? '')?.kind === 'logo' ? 2 : /logo|wordmark/i.test(l.name ?? '') ? 1 : 0);
  const logo = all
    .filter((l) => !l.text && !l.vectorFill && !l.adjustment && l !== standing &&
      fy(l.top ?? 0) < 0.12 && W(l) > 0.03 && W(l) < 0.3 && H(l) < 0.3 &&
      // A layer that runs off the frame is shading behind the logo, not the logo.
      fx(l.left ?? 0) >= 0 && fx(l.right ?? 0) <= 1.001 && fy(l.top ?? 0) >= -0.001)
    .sort((a, b) => isLogo(b) - isLogo(a) ||
      Math.min(fx(a.left ?? 0), 1 - fx(a.right ?? 0)) - Math.min(fx(b.left ?? 0), 1 - fx(b.right ?? 0)))[0];

  // A post lays words out against a bottle or a logo; anything less is a single picture.
  if (!textBox || (!bottle && !logo)) return null;
  return {
    ratio: frame.w / frame.h,
    logo: logo
      ? (() => {
          const right = 1 - fx(logo.right ?? 0) < fx(logo.left ?? 0);
          return {
            corner: (right ? 'top-right' : 'top-left') as Corner,
            width: W(logo),
            insetX: right ? 1 - fx(logo.right ?? 0) : fx(logo.left ?? 0),
            insetY: Math.max(0, fy(logo.top ?? 0)),
          };
        })()
      : null,
    bottle: bottle ? { cx: fx(((bottle.left ?? 0) + (bottle.right ?? 0)) / 2), base: Math.min(1, fy(bottle.bottom ?? 0)), height: H(bottle) } : null,
    text: textBox
      ? {
          x: textBox.x, y: textBox.y, width: textBox.width / frame.w, align, leading,
          lines: lines.map(({ colour: _c, top: _t, ...l }) => l),
          ink, accent: accentColour,
        }
      : null,
  };
}

function flat(layers: PsdLayer[]): PsdLayer[] {
  return layers.flatMap((l) => (l.hidden ? [] : l.children ? flat(l.children) : [l]));
}

function overlaps(a: PsdLayer, b: PsdLayer): boolean {
  return (a.left ?? 0) < (b.right ?? 0) && (b.left ?? 0) < (a.right ?? 0) && (a.top ?? 0) < (b.bottom ?? 0) && (b.top ?? 0) < (a.bottom ?? 0);
}

// --- carrying a layout to another shape -------------------------------------------

/** Where a phone's own interface covers a story: kept clear of words and logo. */
const STORY_SAFE = { top: 0.12, bottom: 0.18 };

/**
 * A layout carried to a post of another shape, the way a designer resizes one:
 * the logo the same size against the short side and the same distance in; the
 * words the same size against the short side, at the same left edge; the
 * bottle the same share of the height. A story stacks the words above the
 * bottle, clear of the phone's interface; a wide banner sets the words in the
 * left third and the bottle beside them.
 */
export function adaptLayout(spec: LayoutSpec, ratio: number): LayoutSpec {
  if (Math.abs(Math.log(ratio / spec.ratio)) < 0.02) return spec;
  // Sizes held against the short side: a 4% logo margin stays 4% of the short edge.
  const shortFrom = Math.min(spec.ratio, 1); // short side over height, before
  const shortTo = Math.min(ratio, 1);
  // A share of the width, kept the same length against the short side.
  const byWidth = (v: number) => v * (spec.ratio / shortFrom) * (shortTo / ratio);
  const byHeight = (v: number) => (v * shortTo) / shortFrom;

  const logo = spec.logo
    ? {
        ...spec.logo,
        width: Math.min(0.3, byWidth(spec.logo.width)),
        insetX: byWidth(spec.logo.insetX),
        insetY: Math.max(ratio < 0.7 ? STORY_SAFE.top * 0.6 : 0, byHeight(spec.logo.insetY)),
      }
    : null;

  // A bottle a person put on the left of a wide post keeps the left, and the words take the right.
  const leftInWide = ratio > 1.4 && Boolean(spec.bottle?.chosen) && spec.bottle!.cx < 0.4;
  const text = spec.text
    ? {
        ...spec.text,
        lines: spec.text.lines.map((l) => ({ ...l, size: byHeight(l.size) * (ratio < 0.7 ? 1.15 : 1) })),
        x: leftInWide ? 0.56 : byWidth(spec.text.x),
        // A story stacks the bottle below the words, so they may run the full width.
        width: ratio < 0.7 ? 1 - 2 * byWidth(spec.text.x) : Math.min(ratio > 1.4 ? 0.36 : 0.62, byWidth(spec.text.width)),
        y: ratio < 0.7 ? STORY_SAFE.top + 0.04 : ratio > 1.4 ? Math.max(0.12, spec.text.y) : spec.text.y * (spec.ratio / Math.max(ratio, 0.01)) ** 0.25,
      }
    : null;

  let bottle = spec.bottle;
  if (bottle) {
    if (ratio < 0.7) {
      // Story: the bottle below the words, a little right of centre as the posts have it.
      // A side a person chose is kept, as far as a story's width allows.
      const cx = bottle.chosen ? Math.max(0.38, Math.min(0.62, bottle.cx)) : Math.max(0.5, Math.min(0.62, bottle.cx));
      bottle = { cx, base: 1 - STORY_SAFE.bottom, height: Math.min(0.5, bottle.height * 0.75), chosen: bottle.chosen };
    } else if (ratio > 1.4) {
      // Wide: the bottle in the right half, as tall as the frame allows.
      bottle = { cx: leftInWide ? 0.34 : 0.66, base: 0.92, height: Math.min(0.82, bottle.height * 1.25), chosen: bottle.chosen };
    } else {
      bottle = { ...bottle, height: Math.min(0.9, bottle.height * (spec.ratio / ratio) ** 0.5) };
    }
  }
  return { ratio, logo, bottle, text };
}

// --- kept per brand -------------------------------------------------------------------

export async function brandLayouts(scope: CompanyScope, brand: string | null): Promise<BrandLayout[]> {
  const rows = await withCompanyScope(scope, (tx) => tx<{ id: string; brand: string | null; name: string; source: string | null; spec: LayoutSpec }[]>`
    select id, brand, name, source, spec from brand_layouts
     where company_id = ${scope.companyId} and (brand is null or brand = ${brand})
     order by (brand is null), name
  `);
  return rows;
}

export async function saveLayout(scope: CompanyScope, layout: { brand: string | null; name: string; source: string | null; spec: LayoutSpec }): Promise<void> {
  await withCompanyScope(scope, (tx) => tx`
    insert into brand_layouts (company_id, brand, name, source, ratio, spec)
    values (${scope.companyId}, ${layout.brand}, ${layout.name}, ${layout.source}, ${layout.spec.ratio}, ${tx.json(layout.spec as never)})
    on conflict (company_id, name) do update set brand = excluded.brand, source = excluded.source,
      ratio = excluded.ratio, spec = excluded.spec
  `);
}

// --- arranging by hand --------------------------------------------------------------

/**
 * Where a person put each piece of a post, layer by layer: the bottle left,
 * centre or right and how big, the logo in a corner, or either left out.
 */
export type PostChoices = {
  bottle: 'left' | 'center' | 'right' | 'none';
  size: 'small' | 'medium' | 'large';
  logo: Corner | 'none';
  /** Whether the post carries its headline. Absent means it does. */
  headline?: 'shown' | 'none';
  /**
   * Where a person dragged a piece to and how big they made it, in fractions
   * of the post: it stands exactly there, whatever the layout would do. Each
   * is cleared when that piece is put back on a preset place.
   */
  place?: Placement;
  /** How the headline and the bottle look, as a person set them. Absent: as the layout has them. */
  style?: PostStyle;
};

export type PostStyle = {
  /** The headline's colour - one of the brand's own. */
  ink?: string;
  /** The headline's lines against each other. */
  align?: 'left' | 'center' | 'right';
  /** The headline's size against the layout's. */
  textSize?: number;
  /** How strong the bottle's shadow is: 0 none, 1 as the scene casts it. */
  shadow?: number;
  /** The bottle lighter (above 0) or darker (below). */
  bright?: number;
  /** The shadow's edge: below 1 sharper, above softer. */
  shadowSoft?: number;
  /** Which way the shadow falls: below 0 to the left, above to the right. Absent: away from the scene's light. */
  shadowAngle?: number;
  /** How far the shadow reaches against as the scene casts it. */
  shadowLength?: number;
  /** How strong the reflection is: 0 none, 1 as the surface gives it, up to 2. */
  reflection?: number;
  /** How soft the reflection is: 0 as the surface gives it, more for a blurrier one. */
  reflectionSoft?: number;
};

export type Placement = {
  /** The bottle's centre across, the line it stands on, its height, and how far it is turned (degrees, clockwise). */
  bottle?: { cx: number; base: number; height: number; rotate?: number };
  /**
   * The shadow moved off where the scene casts it, as a person dragged it:
   * how far (fractions of the post), how big against as cast, and how far turned (degrees).
   * It goes with the bottle when the bottle moves.
   */
  shadow?: { dx: number; dy: number; scale: number; rotate: number };
  /** The reflection moved, sized and turned the same way, on its own. */
  reflection?: { dx: number; dy: number; scale: number; rotate: number };
  /** The logo's left edge, top edge and width. */
  logo?: { x: number; y: number; w: number };
  /** The headline's left edge and top, and its size against the layout's. */
  text?: { x: number; y: number; scale: number };
};

const BOTTLE_CX = { left: 0.27, center: 0.5, right: 0.73 } as const;
const BOTTLE_HEIGHT = { small: 0.5, medium: 0.62, large: 0.74 } as const;

/** The choices a layout already makes, for a post nobody has arranged yet. */
export function choicesOf(spec: LayoutSpec): PostChoices {
  const cx = spec.bottle?.cx ?? 0.7;
  const height = spec.bottle?.height ?? 0.62;
  return {
    bottle: spec.bottle === null ? 'none' : cx < 0.4 ? 'left' : cx > 0.6 ? 'right' : 'center',
    size: height < 0.56 ? 'small' : height < 0.68 ? 'medium' : 'large',
    logo: spec.logo?.corner ?? 'none',
  };
}

/**
 * A layout arranged as a person chose: the brand's own type kept - its faces,
 * sizes, colours and parts - and the pieces moved. The words take the side
 * the bottle leaves; with the bottle in the middle they go above it, centred,
 * clear of the logo's corner. fitLayout then fits it as it fits any layout.
 */
export function arrangeLayout(spec: LayoutSpec, choices: PostChoices): LayoutSpec {
  const margin = 0.07;
  const logo = choices.logo === 'none'
    ? null
    : { ...(spec.logo ?? { width: 0.16, insetX: 0.04, insetY: 0.04 }), corner: choices.logo };
  const bottle = choices.bottle === 'none'
    ? null
    : { cx: BOTTLE_CX[choices.bottle], base: spec.bottle?.base ?? 0.92, height: BOTTLE_HEIGHT[choices.size], chosen: true };
  if (!spec.text) return { ...spec, logo, bottle };

  const logoTop = logo !== null && logo.corner.startsWith('top');
  const below = logoTop ? logo.insetY + logo.width * 0.9 + 0.03 : margin;
  const text = choices.bottle === 'left'
    ? { ...spec.text, x: 0.5, width: 0.43, align: 'left' as const }
    : choices.bottle === 'right'
      ? { ...spec.text, x: margin, width: 0.43, align: 'left' as const }
      : choices.bottle === 'center'
        ? { ...spec.text, x: margin + 0.05, width: 1 - 2 * (margin + 0.05), align: 'center' as const, y: Math.max(below, 0.08) }
        : { ...spec.text, x: margin, width: 1 - 2 * margin, align: spec.text.align };
  // A block that starts under the logo's corner moves down past it.
  const underLogo = logoTop && (logo!.corner === 'top-left' ? text.x < 0.3 : text.x + text.width > 0.7);
  return { ...spec, logo, bottle, text: underLogo ? { ...text, y: Math.max(text.y, below) } : text };
}

// --- fitting the pieces ------------------------------------------------------------

/** Where each piece goes on a post, in fractions of its width and height. */
export type FittedLayout = LayoutSpec & {
  bottleBox: { x: number; y: number; w: number; h: number } | null;
  textBox: { x: number; y: number; w: number; h: number } | null;
  logoBox: { x: number; y: number; w: number; h: number } | null;
  /** Put there by hand: the words start at their top and make way for nothing. */
  placedText?: boolean;
};

/**
 * A fitted layout with the pieces a person dragged standing exactly where
 * they were dropped, at the size they were left. Nothing is moved out of
 * anything's way - that was the person's call.
 */
export function placeLayout(
  layout: FittedLayout,
  place: Placement | undefined,
  ratio: number,
  bottleAspect: number,
  logoAspect: number,
): FittedLayout {
  if (!place) return layout;
  let out = layout;
  if (place.bottle && out.bottle) {
    const { cx, base, height } = place.bottle;
    const w = (height * bottleAspect) / ratio;
    out = { ...out, bottle: { cx, base, height }, bottleBox: { x: cx - w / 2, y: base - height, w, h: height } };
  }
  if (place.logo && out.logo) {
    const { x, y, w } = place.logo;
    out = { ...out, logoBox: { x, y, w, h: w * ratio * logoAspect } };
  }
  if (place.text && out.text) {
    const { x, y } = place.text;
    out = {
      ...out,
      text: { ...out.text, x, y },
      textBox: out.textBox ? { ...out.textBox, x, y } : null,
      placedText: true,
    };
  }
  return out;
}

/** The space a designer keeps between pieces, as a fraction of the short side. */
const GAP = 0.03;

/**
 * A layout fitted to one post and one bottle, as a designer fits it: the
 * bottle kept below the logo and clear of the words - moved across first,
 * made smaller only when it must - and everything inside the margins. A
 * layout learned without a bottle (it was part of the photograph) has one
 * placed where the house places it: beside the words, standing low.
 *
 * `bottleAspect` is the bottle's own width over height; `logoAspect` the
 * logo's height over width.
 */
export function fitLayout(
  spec: LayoutSpec,
  ratio: number,
  bottleAspect = 0.32,
  logoAspect = 0.8,
  /**
   * The headline this post will carry: its longest line's width as a share of
   * the post's width at the layout's sizes, and its number of lines. Other
   * words than the designer's take other room, and the bottle makes way for
   * them - as far as a headline should spread, no further.
   */
  words?: { width: number; lines: number } | null,
): FittedLayout {
  const adapted = adaptLayout(spec, ratio);
  const s = words && adapted.text
    ? {
        ...adapted,
        text: {
          ...adapted.text,
          width: Math.max(adapted.text.width, Math.min(words.width * 1.03, ratio < 0.7 ? 1 - 2 * adapted.text.x : ratio > 1.4 ? 0.45 : 0.55)),
        },
      }
    : adapted;
  const margin = GAP * Math.min(1, ratio); // the short side's share, as a share of the height
  const marginX = GAP * Math.min(1, ratio) / ratio;

  const logoBox = s.logo
    ? (() => {
        // A logo taller than the house's own is kept to the same area, not
        // the same width: a tall mark the width of a wide one dwarfs the post.
        const w = s.logo.width * Math.min(1, Math.sqrt(0.8 / logoAspect));
        const h = (w * ratio) * logoAspect;
        const x = s.logo.corner.endsWith('right') ? 1 - s.logo.insetX - w : s.logo.insetX;
        return { x, y: s.logo.insetY, w, h };
      })()
    : null;

  const textBox = s.text
    ? {
        x: s.text.x,
        y: s.text.y,
        w: s.text.width,
        h: (() => {
          const own = s.text.lines.reduce((n, l, i) => n + l.size * (i === s.text!.lines.length - 1 ? 1 : s.text!.leading), 0);
          // More lines than the designer set take more height, at their average
          // size; fewer take less, so a two-line headline does not hold the
          // room of the four lines the layout was made for.
          const extra = words ? Math.max(0, words.lines - s.text.lines.length) : 0;
          const fewer = words && words.lines < s.text.lines.length ? words.lines / s.text.lines.length : 1;
          return (own + extra * (own / s.text.lines.length) * s.text.leading) * fewer;
        })(),
      }
    : null;

  let bottle = s.bottle ?? {
    // Beside the words; in a story, below them.
    cx: ratio < 0.7 ? 0.55 : textBox && s.text?.align !== 'right' ? Math.min(0.75, Math.max(0.6, textBox.x + textBox.w + 0.2)) : 0.5,
    base: ratio < 0.7 ? 1 - STORY_SAFE.bottom : 0.88,
    height: ratio < 0.7 ? 0.45 : 0.55,
  };
  const widthOf = (height: number) => (height * bottleAspect) / ratio;
  const boxOf = (b: typeof bottle) => ({ x: b.cx - widthOf(b.height) / 2, y: b.base - b.height, w: widthOf(b.height), h: b.height });
  const overlap = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }, pad: number) =>
    a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;

  // Inside the margins, on every side.
  bottle = { ...bottle, base: Math.min(bottle.base, 1 - margin), height: Math.min(bottle.height, bottle.base - margin) };
  bottle = { ...bottle, cx: Math.min(Math.max(bottle.cx, marginX + widthOf(bottle.height) / 2), 1 - marginX - widthOf(bottle.height) / 2) };

  // Clear of the words: across first, as far as the right margin allows; then
  // smaller, keeping its foot where it stands.
  // Words across most of the width leave no side to move to: the bottle keeps
  // its place and stands below them, as short as it must be.
  if (textBox && textBox.w > 0.6 && overlap(boxOf(bottle), textBox, marginX)) {
    // A wider gap than beside: the key words are often set larger than measured.
    const below = bottle.base - (textBox.y + textBox.h + margin * 2.5);
    bottle = { ...bottle, height: Math.max(0.2, Math.min(bottle.height, below)) };
  }
  // A bottle on the left of the words makes way to the left, as far as the margin allows.
  if (textBox && overlap(boxOf(bottle), textBox, marginX) && bottle.cx < textBox.x + textBox.w / 2 && textBox.x > 0.3) {
    const wanted = textBox.x - marginX - widthOf(bottle.height) / 2;
    const nearest = marginX + widthOf(bottle.height) / 2;
    bottle = { ...bottle, cx: Math.max(Math.min(bottle.cx, wanted), nearest) };
    if (overlap(boxOf(bottle), textBox, marginX)) {
      const room = textBox.x - 2 * marginX;
      const height = Math.max(0.2, Math.min(bottle.height, room > 0 ? (room * ratio) / bottleAspect : 0));
      bottle = { ...bottle, height, cx: marginX + widthOf(height) / 2 };
    }
  }
  if (textBox && overlap(boxOf(bottle), textBox, marginX)) {
    const wanted = textBox.x + textBox.w + marginX + widthOf(bottle.height) / 2;
    const furthest = 1 - marginX - widthOf(bottle.height) / 2;
    bottle = { ...bottle, cx: Math.min(Math.max(bottle.cx, wanted), furthest) };
    if (overlap(boxOf(bottle), textBox, marginX)) {
      // Still in the way. Two ways out, and the one that keeps the bottle
      // bigger wins: shorter, standing below the words; or narrower, beside
      // them against the right margin.
      const below = textBox.y + textBox.h + margin < bottle.base ? bottle.base - (textBox.y + textBox.h + margin) : 0;
      const room = 1 - 2 * marginX - (textBox.x + textBox.w);
      const beside = room > 0 ? (room * ratio) / bottleAspect : 0;
      const height = Math.max(0.2, Math.min(bottle.height, Math.max(below, beside)));
      bottle = beside >= below
        ? { ...bottle, height, cx: 1 - marginX - widthOf(height) / 2 }
        : { ...bottle, height };
    }
  }

  // Below the logo, where they share the same side of the post.
  if (logoBox && overlap(boxOf(bottle), logoBox, marginX * 0.5)) {
    const top = logoBox.y + logoBox.h + margin;
    bottle = { ...bottle, height: Math.max(0.2, Math.min(bottle.height, bottle.base - top)) };
  }

  return { ...s, bottle, bottleBox: boxOf(bottle), textBox, logoBox };
}
