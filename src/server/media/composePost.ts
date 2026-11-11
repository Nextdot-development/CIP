import 'server-only';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import type { Canvas } from '@napi-rs/canvas';
import { withCompanyScope, type CompanyScope } from '../db';
import { planPost, type BenchPlan } from '../brain/bench';
import { brandAssets, type BrandAsset } from '../brain/brandAssets';
import { adaptLayout, arrangeLayout, choicesOf, fitLayout, placeLayout, type FittedLayout, type LayoutSpec, type Placement, type PostChoices, type PostStyle } from '../brain/layouts';
import { readFile } from '../drive/service';
import { placeBottle } from './bottleComposite';
import { imageGenerationProvider } from './providers';
import { measureHeadline, setHeadline, type Casing, type HeadlineLine, type SetLine } from './typography';
import { reviewAndFix, type ReviewRound } from './postReview';
import { brain } from '../brain/providers';
import { readPalette } from '../brain/palette';

/**
 * A post made the way the brand's designers make one: a photographed scene, the
 * real bottle stood in it, the headline set in the brand's type, the approved
 * logo in its corner - each where the chosen layout puts it, at any size.
 *
 * The image model paints the scene and nothing else. It is told where the
 * bottle will stand, where the words will go and which corner the logo takes,
 * and to keep those places clear; it is never asked for a bottle, a label, a
 * logo or a word, which it would get wrong.
 */

/** The sizes CIP delivers: 1080 on the short side, as the platforms take them. */
export function postSize(ratio: number): { width: number; height: number } {
  return ratio >= 1
    ? { width: Math.round(1080 * ratio), height: 1080 }
    : { width: 1080, height: Math.round(1080 / ratio) };
}

/** Of the shapes a generator makes, the one that loses least when cropped to the post. */
export function generationShape(ratio: number, offered: readonly string[]): { label: string; ratio: number } {
  const shapes = offered.map((label) => {
    const [w, h] = label.split(':').map(Number);
    return { label, ratio: w! / h! };
  }).filter((s) => Number.isFinite(s.ratio));
  return shapes.sort((a, b) => Math.abs(Math.log(a.ratio / ratio)) - Math.abs(Math.log(b.ratio / ratio)))[0] ?? { label: '1:1', ratio: 1 };
}

type Box = { x: number; y: number; w: number; h: number };

/**
 * Where a place in the post lands in the picture generated for it: the post is
 * a centred crop of the generated frame, so the generator is told positions
 * in its own frame.
 */
export function inGenerated(box: Box, postRatio: number, genRatio: number): Box {
  if (genRatio > postRatio) {
    const keep = postRatio / genRatio; // the share of the width kept
    return { x: (1 - keep) / 2 + box.x * keep, y: box.y, w: box.w * keep, h: box.h };
  }
  const keep = genRatio / postRatio; // the share of the height kept
  return { x: box.x, y: (1 - keep) / 2 + box.y * keep, w: box.w, h: box.h * keep };
}

const pct = (v: number) => `${Math.round(Math.min(1, Math.max(0, v)) * 100)}%`;
const across = (x: number) => (x < 0.38 ? 'left' : x > 0.62 ? 'right' : 'centre');

/** A colour in the words a photographer uses: "deep amber", "navy blue", "ivory". */
export function colourName(hex: string): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex);
  if (!m) return '';
  const [r, g, b] = [m[1], m[2], m[3]].map((v) => parseInt(v!, 16) / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const light = (max + min) / 2;
  const sat = max === min ? 0 : (max - min) / (1 - Math.abs(2 * light - 1));
  if (sat < 0.15) return light > 0.85 ? 'white' : light > 0.65 ? 'ivory grey' : light > 0.3 ? 'grey' : 'black';
  const d = max - min;
  const hue = 60 * (max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4);
  const name =
    hue < 15 || hue >= 345 ? 'red' : hue < 40 ? (light < 0.35 ? 'brown' : 'amber') : hue < 55 ? 'gold' : hue < 70 ? 'yellow'
    : hue < 160 ? 'green' : hue < 200 ? 'teal' : hue < 250 ? 'blue' : hue < 290 ? 'purple' : 'magenta';
  const tone = light < 0.25 ? 'deep ' : light > 0.75 ? 'pale ' : '';
  return name === 'blue' && light < 0.3 ? 'navy blue' : `${tone}${name}`;
}

/** The brief for the scene: the bench's picture of it, the craft, and the places to keep clear. */
export function scenePrompt(
  plan: Pick<BenchPlan, 'scene'>,
  layout: FittedLayout,
  postRatio: number,
  genRatio: number,
  packColours: string[] = [],
  /**
   * A scene for a post arranged by hand, where the bottle may yet stand left,
   * centre or right: the surface is kept clear across the whole frame rather
   * than at one spot, and the quiet space on both sides.
   */
  options: {
    open?: boolean;
    /** How the brand's own posts were set, for a scene that belongs with them. */
    brandScenes?: string[];
    /** What the brand pours, for any glass in the scene. */
    drink?: { kind: string | null; colour: string | null; variant?: string | null };
  } = {},
): string {
  const lines: string[] = [];
  lines.push(
    'A photograph for a premium spirits advertisement, made by a top still-life photographer: the background ' +
    'plate only, into which the product will be placed afterwards. ' +
    `${plan.scene.description.replace(/\s+/g, ' ').trim()}`,
  );
  lines.push(
    `Mood: ${plan.scene.mood}. ${plan.scene.light === 'front' ? 'Soft frontal key light' : `Key light from the ${plan.scene.light}`}, ` +
    'motivated by a light source in the scene, with a gentle rim of light across the product\'s spot so a bottle ' +
    'there would separate from the background.',
  );
  lines.push(
    'Camera: full-frame, 50mm lens at f/8 for deep focus, at the height of the surface looking very slightly down, level ' +
    'horizon, no tilt. Clear and crisp from front to back: the surface, the props and the setting behind all in ' +
    'focus and cleanly lit, with no blur, no bokeh, no haze, fog, smoke, dust, grain or glow over anything. ' +
    'Rich, true colour grade with deep but detailed shadows; no HDR look, no oversharpening.',
  );
  if (options.brandScenes?.length) {
    lines.push(
      'In the brand\'s own photographic style - its posts have been set like this, and this scene belongs with them ' +
      `in place, props, light and colour, without copying any: ${options.brandScenes.slice(0, 5).join(' / ')}.`,
    );
  }
  lines.push(drinkLine(options.drink));
  const named = [...new Set(packColours.map(colourName).filter(Boolean))];
  if (named.length) {
    lines.push(`The product's own colours are ${named.join(', ')}: choose tones for the scene that flatter them and let the product stand out, never matching it exactly.`);
  }
  lines.push(
    'Balance: props and light spread so the frame feels balanced around the product\'s spot, with the quiet side ' +
    'for the words left open. Few objects, each deliberate; nothing cluttered or random.',
  );
  lines.push('Composition - these places must be kept as described:');
  if (options.open) {
    const base = layout.bottleBox ? inGenerated(layout.bottleBox, postRatio, genRatio) : { y: 0.3, h: 0.62 };
    const light = luminanceOf(layout.text?.ink ?? '#ffffff') > 0.5;
    lines.push(
      `- The ${plan.scene.surface === 'gloss' ? 'polished ' : ''}surface runs level across the whole width of the frame, its ` +
      `front edge about ${pct(base.y + base.h + 0.02)} down, sharp and clear from the left edge to the right, so a bottle about ` +
      `${pct(base.h)} of the frame's height can be stood anywhere on it later - left, centre or right. Nothing stands on its ` +
      'front; props sit only behind, low, or at the very edges.',
      `- Above the surface the frame is calm and uncluttered on both sides, plain and evenly ${light ? 'dark' : 'light'}, ` +
      'with no bright lights, no busy detail and no faces: words may go on either side, or across the top.',
      '- All four corners plain and quiet, for a logo.',
    );
  }
  if (layout.bottleBox && !options.open) {
    const b = inGenerated(layout.bottleBox, postRatio, genRatio);
    const base = b.y + b.h;
    lines.push(
      `- A clear spot on the ${plan.scene.surface === 'gloss' ? 'polished' : ''} surface ${across(b.x + b.w / 2)} of centre, about ${pct(b.x + b.w / 2)} across, ` +
      `where a bottle about ${pct(b.h)} of the frame's height will be stood later, its base about ${pct(base)} down. The surface must run under ` +
      `that spot, level and in focus, and nothing may stand in front of it or between ${pct(b.x - 0.04)} and ${pct(b.x + b.w + 0.04)} across above it.`,
    );
  }
  if (layout.textBox && !options.open) {
    const t = inGenerated(layout.textBox, postRatio, genRatio);
    const light = luminanceOf(layout.text?.ink ?? '#ffffff') > 0.5;
    lines.push(
      `- The area from ${pct(t.x)} to ${pct(t.x + t.w)} across and ${pct(t.y - 0.04)} to ${pct(t.y + t.h + 0.04)} down is for words: ` +
      `calm, uncluttered, plain and evenly ${light ? 'dark' : 'light'}, with no bright lights, no busy detail and no faces in it.`,
    );
  }
  if (layout.logoBox && layout.logo && !options.open) {
    lines.push(`- The ${layout.logo.corner.replace('-', ' ')} corner plain and quiet, for a logo.`);
  }
  lines.push(
    'There are no bottles, packaging or labels anywhere, and no text, letters, numbers, signs, logos or watermarks - ' +
    'no health warning, "Drink Responsibly" line, age mark, disclaimer or dark strip of small print along any edge. ' +
    'Natural colour, real materials, believable light, nothing cartoonish or illustrated.',
  );
  return lines.join('\n');
}

/**
 * A glass in the scene holds the brand's own drink, in its own colour - a
 * whisky post with an empty tumbler, or one of clear spirit, reads as wrong.
 */
export function drinkLine(drink?: { kind: string | null; colour: string | null; variant?: string | null }): string {
  const kind = drink?.kind?.toLowerCase() ?? null;
  // A flavour is poured in its own colour, not the plain spirit's.
  const flavour = drink?.variant && !STANDARD_PACK.test(drink.variant) ? drink.variant : null;
  const colour = flavour
    ? `the true colour of ${flavour}`
    : drink?.colour ?? (kind ? DRINK_COLOURS.find(([k]) => k.test(kind))?.[1] ?? null : null);
  const what = [colour, kind].filter(Boolean).join(' ');
  return 'Any glass in the scene is never empty: it holds the brand\'s own drink' +
    (what ? ` - ${what} - ` : ' ') +
    'poured to a natural level, real liquid with true colour, catching the light' +
    (kind && /whisk|rum|brandy|cognac/.test(kind) ? ', ice optional' : '') +
    '. No other drink, no other colour of liquid, no empty or half-wiped glass.';
}

const STANDARD_PACK = /^(plain|original|classic|regular|standard)$/i;

/** The colour a drink is poured, when the brand's files do not say. */
const DRINK_COLOURS: [RegExp, string][] = [
  [/whisk|bourbon|scotch|malt/, 'deep golden amber'],
  [/dark rum|rum/, 'rich dark amber'],
  [/brandy|cognac/, 'warm reddish amber'],
  [/vodka|gin|white spirit/, 'crystal-clear'],
  [/red wine/, 'deep ruby red'],
  [/white wine/, 'pale straw gold'],
];

/**
 * A post's parts, each alone on its own transparent layer, bottom to top -
 * what a designer gets in a Photoshop file - and its headline as live text.
 */
export type PostLayers = {
  background: Buffer;
  shadow: Buffer | null;
  /** The bottle's mirror on a glossy surface. Absent on layers set before it was its own. */
  reflection?: Buffer | null;
  bottle: Buffer | null;
  headline: Buffer;
  logo: Buffer | null;
  lines: SetLine[];
};

type Frac = { x: number; y: number; w: number; h: number };
export type PostBoxes = {
  bottle: Frac | null;
  /** Where the shadow lies, as cast and then moved by hand - what a person drags. Absent on posts set before it could be. */
  shadow?: Frac | null;
  /** The point it turns about: the bottle's foot, moved with it. */
  shadowPivot?: { x: number; y: number } | null;
  /** The reflection's, the same way. */
  reflection?: Frac | null;
  reflectionPivot?: { x: number; y: number } | null;
  logo: Frac | null;
  text: Frac | null;
  /** The left edge the words are laid out from, which their box may sit inside of. */
  textAnchor: { x: number } | null;
};

export type BuiltPost = {
  bytes: Buffer;
  /** The flat post, encoded when first asked for - the same bytes as `bytes` when those were made. */
  flat: () => Promise<Buffer>;
  width: number;
  height: number;
  /** Only when asked for: the layers it was built from. */
  layers?: PostLayers;
  /** Where each piece landed, in fractions of the post: what a person drags. */
  boxes: PostBoxes;
  /** What was used, and what stood in for what the brand did not supply. */
  logo: string | null;
  substitutes: string[];
  /** The tweaks it was built with, once any were needed. */
  tweaks: PostTweaks;
};

/**
 * What a post can be rebuilt with, short of painting its scene again: the
 * bottle moved up or down and resized, the words given more width and a
 * darker ground, the logo's corner shaded.
 */
export type PostTweaks = {
  /** Down the post, as a share of its height; negative is up. */
  bottleShift: number;
  bottleScale: number;
  textWidth: number;
  /** Added to the shading behind the words. */
  scrim: number;
  /** The headline's size: a little smaller sits on fewer, fuller lines. */
  textScale: number;
  /** Shading behind the logo: 0 only when it needs it, 1 always, 2 stronger. */
  logoShade: number;
};
export const NO_TWEAKS: PostTweaks = { bottleShift: 0, bottleScale: 1, textWidth: 1, scrim: 0, textScale: 1, logoShade: 0 };

/** The layout with the tweaks applied: the bottle about its base, the words wider. */
export function tweaked(layout: FittedLayout, t: PostTweaks): FittedLayout {
  let bottleBox = layout.bottleBox;
  if (bottleBox && (t.bottleShift || t.bottleScale !== 1)) {
    const h = bottleBox.h * t.bottleScale;
    const w = bottleBox.w * t.bottleScale;
    const base = Math.min(0.995, bottleBox.y + bottleBox.h + t.bottleShift);
    const cx = bottleBox.x + bottleBox.w / 2;
    bottleBox = { x: cx - w / 2, y: Math.max(0.01, base - h), w, h: Math.min(h, base - 0.01) };
  }
  const text = layout.text && t.textWidth !== 1 ? { ...layout.text, width: layout.text.width * t.textWidth } : layout.text;
  const textBox = layout.textBox && t.textWidth !== 1 ? { ...layout.textBox, w: layout.textBox.w * t.textWidth } : layout.textBox;
  return { ...layout, bottleBox, text, textBox };
}

/** At least this much of each side of a scene is kept, however different the post's shape. */
export const SCENE_KEPT = 0.78;

/**
 * A scene laid into a frame. Cropped from its centre when that loses little.
 * When the frame is another shape - a story from a square scene - cropping
 * would cut away most of it, so the scene is kept as far as it can be and the
 * frame past it filled from its own edges, softened, with the seam feathered.
 * A taller frame keeps the scene at the bottom, where its surface and the
 * bottle are; a wider one keeps it centred.
 */
export function drawScene(
  ctx: ReturnType<ReturnType<typeof createCanvas>['getContext']>,
  scene: Awaited<ReturnType<typeof loadImage>>,
  W: number,
  H: number,
): void {
  const have = scene.width / scene.height;
  const want = W / H;
  const sw = have > want ? scene.height * want : scene.width;
  const sh = have > want ? scene.height : scene.width / want;
  const kept = Math.min(sw / scene.width, sh / scene.height);
  if (kept >= SCENE_KEPT) {
    ctx.drawImage(scene, (scene.width - sw) / 2, (scene.height - sh) / 2, sw, sh, 0, 0, W, H);
    return;
  }
  // The fill: the scene itself, covering the frame, softened out of detail -
  // softened small and drawn up, which looks the same and takes a fraction of the time.
  const k = 1 / 8;
  const fill = createCanvas(Math.max(1, Math.round(W * k)), Math.max(1, Math.round(H * k)));
  const fc = fill.getContext('2d');
  fc.filter = `blur(${Math.max(1, Math.round(Math.max(W, H) * 0.03 * k))}px)`;
  const cover = Math.max(fill.width / scene.width, fill.height / scene.height) * 1.06;
  fc.drawImage(scene, (fill.width - scene.width * cover) / 2, (fill.height - scene.height * cover) / 2, scene.width * cover, scene.height * cover);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(fill, 0, 0, W, H);
  // The scene, losing no more than it must of its long side.
  const wide = have > want;
  const dw = wide ? W / SCENE_KEPT : H * have / SCENE_KEPT;
  const dh = dw / have;
  const dx = (W - dw) / 2;
  const dy = wide ? H - dh : (H - dh) / 2;
  const piece = createCanvas(Math.ceil(dw), Math.ceil(dh));
  const p = piece.getContext('2d');
  p.drawImage(scene, 0, 0, dw, dh);
  // Feathered into the fill where it ends.
  p.globalCompositeOperation = 'destination-in';
  const f = wide ? dh * 0.12 : dw * 0.1;
  const g = wide ? p.createLinearGradient(0, 0, 0, f) : p.createLinearGradient(Math.max(0, -dx), 0, Math.max(0, -dx) + f, 0);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,0,1)');
  p.fillStyle = g;
  p.fillRect(0, 0, dw, dh);
  if (!wide) {
    const right = p.createLinearGradient(dw - Math.max(0, -dx) - f, 0, dw - Math.max(0, -dx), 0);
    right.addColorStop(0, 'rgba(0,0,0,1)');
    right.addColorStop(1, 'rgba(0,0,0,0)');
    p.fillStyle = right;
    p.fillRect(0, 0, dw, dh);
  }
  ctx.drawImage(piece, dx, dy);
}

/**
 * The post, put together from its parts: the scene cropped to size, the words'
 * ground calmed where the scene is too busy for them, the bottle, the
 * headline, the logo. No model here; the same parts give the same post.
 */
export async function buildPost(input: {
  scene: Buffer;
  ratio: number;
  layout: FittedLayout;
  plan: Pick<BenchPlan, 'headline' | 'casing' | 'keep'> & { scene: Pick<BenchPlan['scene'], 'surface'> };
  bottle: Buffer | null;
  logos: { name: string; bytes: Buffer; asset: Pick<BrandAsset, 'tone' | 'bbox' | 'width' | 'height'> }[];
  tweaks?: PostTweaks;
  /** Also hand back each part on its own layer, for an editor. */
  layers?: boolean;
  /** The flat post is not needed yet: encode it only when flat() is asked. */
  flatLater?: boolean;
  /** How a person set the headline and the bottle to look. */
  style?: PostStyle;
  /** The bottle turned, and the shadow moved, as a person left them. */
  turn?: { bottle?: number; shadow?: Placement['shadow']; reflection?: Placement['reflection'] };
}): Promise<BuiltPost> {
  const { width: W, height: H } = postSize(input.ratio);
  const tweaks = input.tweaks ?? NO_TWEAKS;
  const layout = tweaked(input.layout, tweaks);

  // The scene, cropped from its centre to the post and scaled to size - or,
  // for a post of another shape than it was painted for, kept and extended.
  const scene = await loadImage(input.scene);
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  drawScene(ctx, scene, W, H);

  // The words' ground: a scene that left it busy or bright gets the soft
  // shading a designer paints behind words, fading out towards the bottle.
  if (layout.textBox && layout.text) {
    const t = layout.textBox;
    const area = ctx.getImageData(Math.round(t.x * W), Math.round(t.y * H), Math.max(1, Math.round(t.w * W)), Math.max(1, Math.round(t.h * H)));
    const { mean, spread } = toneOf(area.data);
    const lightInk = luminanceOf(layout.text.ink) > 0.5;
    const need = lightInk ? Math.max(mean - 0.3, 0) * 1.4 + Math.max(spread - 0.12, 0) * 1.6 : Math.max(0.6 - mean, 0) * 1.4;
    const alpha = Math.min(0.75, Math.min(0.6, need) + tweaks.scrim);
    if (alpha > 0.05) {
      const fromLeft = t.x + t.w / 2 < 0.5;
      const reach = fromLeft ? (t.x + t.w + 0.12) * W : (1 - t.x + 0.12) * W;
      const g = fromLeft ? ctx.createLinearGradient(0, 0, reach, 0) : ctx.createLinearGradient(W, 0, W - reach, 0);
      const ink = lightInk ? '0,0,0' : '255,255,255';
      g.addColorStop(0, `rgba(${ink},${alpha})`);
      g.addColorStop(0.65, `rgba(${ink},${alpha * 0.75})`);
      g.addColorStop(1, `rgba(${ink},0)`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }
  }
  // Each stage draws on the one before as it is, a canvas; nothing is encoded
  // to a PNG and read back between them - that was most of the time a change
  // took - and what is kept is encoded once, at the end, all at the same time.
  const background = canvas;
  let picture: Canvas = canvas;

  // The real bottle, stood where the layout puts it.
  let packLayers: { shadow: Canvas; reflection: Canvas; bottle: Canvas } | null = null;
  let shadowBox: Frac | null = null;
  let shadowPivot: { x: number; y: number } | null = null;
  let reflectionBox: Frac | null = null;
  let reflectionPivot: { x: number; y: number } | null = null;
  if (input.bottle && layout.bottleBox) {
    const b = layout.bottleBox;
    const placed = await placeBottle({ scene: picture, bottle: input.bottle, place: { cx: b.x + b.w / 2, base: b.y + b.h, height: b.h }, surface: input.plan.scene.surface, light: 'auto', shadow: input.style?.shadow, bright: input.style?.bright,
      cast: { soft: input.style?.shadowSoft, angle: input.style?.shadowAngle, length: input.style?.shadowLength },
      mirror: { strength: input.style?.reflection, soft: input.style?.reflectionSoft },
      rotate: input.turn?.bottle, moveShadow: input.turn?.shadow, moveReflection: input.turn?.reflection });
    picture = placed.canvas;
    packLayers = placed.layerCanvases;
    shadowBox = placed.shadowBox;
    shadowPivot = placed.shadowPivot;
    reflectionBox = placed.reflectionBox;
    reflectionPivot = placed.reflectionPivot;
  }

  // The headline.
  // Lined up and coloured as the person chose, when they did.
  const align = input.style?.align;
  const wordsLayout = align && layout.text ? { ...layout, text: { ...layout.text, align } } : layout;
  const set = await setHeadline({ image: picture, layout: wordsLayout, lines: input.plan.headline, casing: input.plan.casing, keep: input.plan.keep, scale: tweaks.textScale, colours: input.style?.ink ? { ink: input.style.ink } : undefined });
  // A line of the plan broken down to a lone word means the block was too
  // narrow for it: set again, wider, as far as the bottle allows.
  const planned = new Set(input.plan.headline.map((l) => l.text.trim().toLowerCase()));
  const lone = set.lines.some((l) => !l.text.includes(' ') && !planned.has(l.text.trim().toLowerCase()));
  if (lone && tweaks.textWidth < 1.5) return buildPost({ ...input, tweaks: { ...tweaks, textWidth: tweaks.textWidth * 1.25, textScale: Math.max(0.85, tweaks.textScale * 0.95) } });
  picture = set.canvas;

  // The logo: the version that stands out against where it lands.
  let logoName: string | null = null;
  let logoLayer: Canvas | null = null;
  let logoBox: Frac | null = null;
  if (layout.logoBox && input.logos.length) {
    const out = picture;
    // The logo and any shading behind it on a layer of their own, laid over.
    const mark = createCanvas(W, H);
    const c = mark.getContext('2d');
    const box = layout.logoBox;
    const under = toneOf(out.getContext('2d').getImageData(Math.round(box.x * W), Math.round(box.y * H), Math.max(1, Math.round(box.w * W)), Math.max(1, Math.round(box.h * H))).data).mean;
    const wanted = under < 0.55 ? 'light' : 'dark';
    const logo = input.logos.find((l) => l.asset.tone === wanted) ?? input.logos.find((l) => l.asset.tone === 'colour') ?? input.logos[0]!;
    const pic = await loadImage(logo.bytes);
    const [lx, ly, lw, lh] = logo.asset.bbox;
    const w = box.w * W;
    const h = w * ((lh * pic.height) / (lw * pic.width));
    // No version stands out against this corner (the brand gave no white
    // one, say): the logo stays exactly as approved, and the corner behind it
    // is shaded softly, as a designer would, until it reads.
    const own = logoTone(pic);
    const level = Math.max(tweaks.logoShade, Math.abs(own - under) < 0.3 ? 1 : 0);
    if (level > 0) {
      const cx = box.x * W + w / 2;
      const cy = box.y * H + h / 2;
      const r = Math.max(w, h) * 1.3;
      const shade = own > 0.5 ? '0,0,0' : '255,255,255';
      const glow = c.createRadialGradient(cx, cy, 0, cx, cy, r);
      const k = level >= 2 ? 1.45 : 1;
      glow.addColorStop(0, `rgba(${shade},${0.5 * k})`);
      glow.addColorStop(0.35, `rgba(${shade},${0.36 * k})`);
      glow.addColorStop(0.7, `rgba(${shade},${0.12 * k})`);
      glow.addColorStop(1, `rgba(${shade},0)`);
      c.fillStyle = glow;
      c.fillRect(cx - r, cy - r, r * 2, r * 2);
    }
    c.drawImage(pic, lx * pic.width, ly * pic.height, lw * pic.width, lh * pic.height, box.x * W, box.y * H, w, h);
    logoBox = { x: box.x, y: box.y, w: box.w, h: h / H };
    out.getContext('2d').drawImage(mark, 0, 0);
    logoName = logo.name;
    if (input.layers) logoLayer = mark;
  }

  const substitutes = [...new Set(set.lines.filter((l) => l.substitute).map((l) => l.face))];
  // Encoded side by side, off the main thread: the post, and its layers when asked for.
  // A layer just as it was last time is not encoded again - moving the logo
  // leaves the background, the bottle and the words as they were.
  const png = (c: Canvas | null) => (c ? keptPng(c) : Promise.resolve(null));
  // The flat post, when it can follow the answer, is encoded only when asked for.
  let flatPng: Promise<Buffer> | null = input.flatLater ? null : picture.encode('png');
  const flat = () => (flatPng ??= picture.encode('png'));
  const [bytes, bg, shadow, mirror, pack, words, mark] = await Promise.all([
    input.flatLater ? null : flatPng,
    input.layers ? png(background) : null,
    input.layers ? png(packLayers?.shadow ?? null) : null,
    // A post with no reflection has no reflection layer: nothing empty handed to an editor.
    input.layers && reflectionBox ? png(packLayers?.reflection ?? null) : null,
    input.layers ? png(packLayers?.bottle ?? null) : null,
    input.layers ? png(set.layerCanvas) : null,
    input.layers ? png(logoLayer) : null,
  ]);
  const layers: PostLayers | undefined = input.layers
    ? { background: bg!, shadow, reflection: mirror, bottle: pack, headline: words!, logo: mark, lines: set.lines }
    : undefined;
  // The words' box is where they were set, not where the layout meant them.
  const set_ = set.lines;
  const text = set_.length
    ? (() => {
        const x0 = Math.min(...set_.map((l) => l.box.x)); const y0 = Math.min(...set_.map((l) => l.box.y));
        const x1 = Math.max(...set_.map((l) => l.box.x + l.box.w)); const y1 = Math.max(...set_.map((l) => l.box.y + l.box.h * 1.15));
        return { x: x0 / W, y: y0 / H, w: (x1 - x0) / W, h: (y1 - y0) / H };
      })()
    : null;
  const boxes: PostBoxes = { bottle: packLayers ? layout.bottleBox : null, shadow: packLayers ? shadowBox : null, shadowPivot: packLayers ? shadowPivot : null,
    reflection: packLayers ? reflectionBox : null, reflectionPivot: packLayers ? reflectionPivot : null, logo: logoBox, text, textAnchor: layout.text ? { x: layout.text.x } : null };
  const post: BuiltPost = { bytes: bytes!, flat, width: W, height: H, logo: logoName, substitutes, tweaks, layers, boxes };
  if (input.flatLater) {
    Object.defineProperty(post, 'bytes', { get() { throw new Error('This post is encoded later: ask flat() for it.'); } });
  }
  return post;
}

/**
 * Layers encoded lately, by what their pixels are: the same picture is the
 * same PNG, so a layer a change left alone is handed back as it was rather
 * than encoded again - half a second each, at full size.
 */
const encoded = new Map<string, Promise<Buffer>>();
async function keptPng(c: Canvas): Promise<Buffer> {
  const { createHash } = await import('node:crypto');
  const key = `${c.width}x${c.height}:${createHash('sha1').update(c.data()).digest('hex')}`;
  const known = encoded.get(key);
  if (known) {
    // Kept the longest when used the most.
    encoded.delete(key);
    encoded.set(key, known);
    return known;
  }
  const made = c.encode('png');
  encoded.set(key, made);
  made.catch(() => encoded.delete(key));
  if (encoded.size > 24) encoded.delete(encoded.keys().next().value!);
  return made;
}

export type ComposedPost = FinishedPost & {
  plan: BenchPlan;
  prompt: string;
  bottle: string | null;
};

/** A post planned and ready to be made: the scene to ask for, and what to do with it. */
export type PreparedPost = {
  plan: BenchPlan;
  /** The scene, as the generator is to be asked for it. */
  prompt: string;
  bottle: string | null;
  /**
   * The post, from the scene the generator made: built, looked at by the
   * Bench and fixed. `regenerate` paints the scene again with a note, when a
   * fault is in the scene itself; `deadline` stops new work past it.
   */
  finish: (scene: Buffer, options?: { regenerate?: ((note: string) => Promise<Buffer>) | null; deadline?: number; review?: boolean }) => Promise<FinishedPost>;
};

/**
 * Everything a composed post is put together from, short of its scene - which
 * is kept beside it. With the two, the post can be set again with other words,
 * in a second and for nothing: no scene to paint, no model to ask.
 */
export type PostRecipe = {
  brand: string;
  variant: string | null;
  bottleFileId: string | null;
  layoutName: string;
  spec: LayoutSpec;
  ratio: number;
  casing: Casing;
  keep: string[];
  surface: 'matte' | 'gloss';
  /** What the Bench's review settled on: the bottle's place and size, the words' ground. */
  tweaks: PostTweaks;
  /**
   * Where a person put the pieces, layer by layer. Absent, the layout's own
   * places stand - a post made before posts were arranged by hand.
   */
  choices?: PostChoices;
};

export type FinishedPost = BuiltPost & {
  rounds: ReviewRound[];
  unresolved: string[];
  /** The scene the post stands on - a second one, when the review had it painted again. */
  scene: Buffer;
  recipe: PostRecipe;
};

/**
 * The pieces of a post, fitted to its words: the bottle, the logos that read
 * on it, the layout fitted to both - and the post built from a scene with them.
 */
async function assemble(
  scope: CompanyScope,
  given: Pick<PostRecipe, 'brand' | 'variant' | 'bottleFileId' | 'spec' | 'ratio' | 'casing' | 'keep' | 'surface' | 'choices'> & { headline: HeadlineLine[] },
) {
  // The layout as a person arranged it, when they have.
  const r = given.choices ? { ...given, spec: arrangeLayout(given.spec, given.choices) } : given;
  const [bottle, allLogos, bottles] = await Promise.all([
    r.bottleFileId && r.spec.bottle ? brandFile(scope, r.bottleFileId) : Promise.resolve(null),
    held(`logos:${scope.companyId}:${r.brand}:${r.variant ?? ''}`, () => logosFor(scope, r.brand, r.variant)),
    held(`bottles:${scope.companyId}:${r.brand}:${r.variant ?? ''}`, () => brandAssets(scope, { brand: r.brand, kind: 'bottle', variant: r.variant })),
  ]);
  const logos = r.spec.logo ? allLogos : [];
  const bottleAsset = bottles.find((b) => b.fileId === r.bottleFileId)?.asset ?? null;
  const bottleAspect = bottleAsset ? (bottleAsset.bbox[2] * bottleAsset.width) / (bottleAsset.bbox[3] * bottleAsset.height) : 0.32;
  const logoAspect = logos[0] ? aspectOf(logos[0].asset) : 0.8;
  // Fitted to these words: a longer headline than the designer's pushes the
  // bottle across, or below the words in a story, rather than being squeezed.
  const adapted = adaptLayout(r.spec, r.ratio);
  const words = adapted.text ? measureHeadline(adapted.text, r.headline, r.ratio, r.casing, r.keep) : null;
  // Then whatever a person dragged, exactly where they left it.
  const layout = placeLayout(fitLayout(r.spec, r.ratio, bottleAspect, logoAspect, words), r.choices?.place, r.ratio, bottleAspect, logoAspect);
  // Only the logos in the same shape as the one the layout was fitted to.
  const sameShape = logos.filter((l) => Math.abs(aspectOf(l.asset) - logoAspect) < 0.15);
  // A post with its headline taken off keeps the words, to put back.
  const plan = { headline: r.choices?.headline === 'none' ? [] : r.headline, casing: r.casing, keep: r.keep, scene: { surface: r.surface } };
  return {
    bottle,
    layout,
    build: (scene: Buffer, tweaks: PostTweaks, options: { layers?: boolean; flatLater?: boolean } = {}) =>
      buildPost({ scene, ratio: r.ratio, layout, plan, bottle: bottle?.body ?? null, logos: sameShape.length ? sameShape : logos, tweaks, layers: options.layers, flatLater: options.flatLater, style: r.choices?.style,
        turn: { bottle: r.choices?.place?.bottle?.rotate, shadow: r.choices?.place?.shadow, reflection: r.choices?.place?.reflection } }),
  };
}

/**
 * A composed post set again with other words, on the scene it was made on:
 * the bottle, logo and layout as they were, fitted to the new headline. The
 * review's fixes to the bottle are kept; the words start fresh. Moved by
 * hand, the bottle stands where it was put, and the review's nudges go.
 */
export async function rebuildPost(
  scope: CompanyScope,
  recipe: PostRecipe,
  scene: Buffer,
  headline: HeadlineLine[],
  options: { layers?: boolean; flatLater?: boolean } = {},
): Promise<BuiltPost> {
  const { build } = await assemble(scope, { ...recipe, headline });
  const tweaks = recipe.choices ? { ...recipe.tweaks, bottleShift: 0, bottleScale: 1 } : recipe.tweaks;
  const size = recipe.choices?.style?.textSize ?? 1;
  return build(scene, { ...tweaks, textWidth: 1, textScale: (recipe.choices?.place?.text?.scale ?? 1) * size }, options);
}

/**
 * The colours a headline may take on this post: the ones the brand's
 * designer set its words in, the colours of its own pack, and white and
 * near-black, which read on anything. Measured from files CIP holds; nothing is spent.
 */
export async function headlineInks(scope: CompanyScope, recipe: Pick<PostRecipe, 'spec' | 'bottleFileId'>): Promise<string[]> {
  const own = [recipe.spec.text?.ink, recipe.spec.text?.accent].filter((c): c is string => Boolean(c));
  const pack = recipe.bottleFileId
    ? await held(`inks:${scope.companyId}:${recipe.bottleFileId}`, async () =>
        (await readPalette((await brandFile(scope, recipe.bottleFileId!)).body, 'image/png')).filter((c) => c.share >= 0.05).slice(0, 4).map((c) => c.hex))
        .catch(() => [] as string[])
    : [];
  return [...new Set([...own, ...pack, '#ffffff', '#141414'].map((c) => c.toLowerCase()))].filter((c) => /^#[0-9a-f]{6}$/.test(c)).slice(0, 8);
}

/**
 * Where a new post's pieces start: where the person last put them on this
 * brand's posts of the same shape - the bottle's side and size, the logo's
 * corner, and anything dragged - or the layout's own places when nothing has
 * been arranged yet. Read from the posts already kept; nothing is asked of a
 * model. The headline is always shown on a new post, whatever was done before.
 */
export async function learnedChoices(scope: CompanyScope, brand: string, ratio: number, spec: LayoutSpec): Promise<PostChoices> {
  const own = choicesOf(spec);
  const [last] = await withCompanyScope(scope, (tx) => tx<{ choices: PostChoices | null }[]>`
    select output_metadata->'composed'->'recipe'->'choices' as choices
      from media_generations
     where company_id = ${scope.companyId}
       and output_metadata->'composed'->'recipe'->>'brand' = ${brand}
       and output_metadata->'composed'->>'arrangedAt' is not null
       and abs((output_metadata->'composed'->'recipe'->>'ratio')::float - ${ratio}) < 0.01
     order by output_metadata->'composed'->>'arrangedAt' desc
     limit 1
  `).catch(() => []);
  return mergeLearned(own, last?.choices ?? null);
}

/** The layout's own places, with what a person chose before laid over them - only for pieces this layout has. */
export function mergeLearned(own: PostChoices, learned: PostChoices | null): PostChoices {
  if (!learned) return own;
  const place = { ...(learned.place ?? {}) };
  const bottle = own.bottle === 'none' ? 'none' : learned.bottle === 'none' ? own.bottle : learned.bottle;
  if (bottle === 'none') delete place.bottle;
  const logo = own.logo === 'none' ? 'none' : learned.logo === 'none' ? own.logo : learned.logo;
  if (logo === 'none') delete place.logo;
  return {
    bottle,
    size: learned.size ?? own.size,
    logo,
    ...(Object.keys(place).length ? { place } : {}),
  };
}

/** Whether a brand has what a composed post needs: a bottle cut out on transparency. */
export async function canCompose(scope: CompanyScope, brand: string | null): Promise<boolean> {
  if (!brand) return false;
  const bottles = await brandAssets(scope, { brand, kind: 'bottle' }).catch(() => []);
  return bottles.some((b) => b.asset.cutout);
}

/**
 * A post planned: the bench's plan, the layout fitted to the post and its
 * pieces, and the brief for a scene in `generatorShape` (one of the
 * generator's own, like "2:3") that the post will be cropped from.
 */
export async function preparePost(
  scope: CompanyScope,
  input: {
    request: string; brand: string; ratio: number; generatorShape: string; market?: string | null;
    /**
     * A post to be arranged layer by layer: its scene painted to take the
     * bottle anywhere, and the layout's places kept as choices a person can
     * change - for nothing, once the scene is made.
     */
    layered?: boolean;
    /** Planned from what CIP holds, no model asked: for a post on a picture the person brought. */
    noModel?: boolean;
  },
): Promise<PreparedPost> {
  const plan = await planPost(scope, input);
  const recipe: Omit<PostRecipe, 'tweaks'> = {
    brand: input.brand,
    variant: plan.variant,
    bottleFileId: plan.bottleFileId,
    layoutName: plan.layout.name,
    spec: plan.layout.spec,
    ratio: input.ratio,
    casing: plan.casing,
    keep: plan.keep,
    surface: plan.scene.surface,
    ...(input.layered ? { choices: await learnedChoices(scope, input.brand, input.ratio, plan.layout.spec) } : {}),
  };
  const { bottle, layout, build } = await assemble(scope, { ...recipe, headline: plan.headline });
  const [gw, gh] = input.generatorShape.split(':').map(Number);
  // The pack's own colours, measured from its photograph, for a scene that flatters them.
  const packColours = bottle ? (await readPalette(bottle.body, 'image/png')).filter((c) => c.share >= 0.08).slice(0, 3).map((c) => c.hex) : [];
  const prompt = scenePrompt(plan, layout, input.ratio, gw && gh ? gw / gh : input.ratio, packColours, { open: input.layered, brandScenes: plan.pastScenes, drink: { ...plan.drink, variant: plan.variant } });
  const headline = plan.headline.map((l) => l.text).join(' / ');
  return {
    plan,
    prompt,
    bottle: bottle?.file.name ?? null,
    finish: async (scene, options = {}) => {
      if (options.review === false || process.env.CIP_BENCH_REVIEW === 'off') {
        return { ...(await build(scene, NO_TWEAKS)), rounds: [], unresolved: [], scene, recipe: { ...recipe, tweaks: NO_TWEAKS } };
      }
      const { post, rounds, unresolved, scene: stood } = await reviewAndFix({
        scene,
        build,
        regenerate: options.regenerate ?? null,
        deadline: options.deadline,
        review: async (built) => {
          const image = await forReview(built.bytes);
          const b = bottle ? tweaked(layout, built.tweaks).bottleBox : null;
          const pct = (v: number) => `${Math.round(v * 100)}%`;
          const pack = b ? `from ${pct(b.x - 0.04)} to ${pct(b.x + b.w + 0.04)} across and ${pct(b.y)} to ${pct(b.y + b.h)} down` : null;
          return brain().reviewPost({ image: { bytes: image.bytes, mimeType: image.mimeType }, brand: input.brand, idea: plan.idea, headline, pack, rules: plan.rules });
        },
      });
      return { ...post, rounds, unresolved, scene: stood, recipe: { ...recipe, tweaks: post.tweaks } };
    },
  };
}

/**
 * A post for a brand, from a request, made in one go: the bench plans it, the
 * scene is made for the layout, and the brand's own pieces are put into it.
 */
export async function composePost(
  scope: CompanyScope,
  input: { request: string; brand: string; ratio: number; market?: string | null; quality?: 'medium' | 'high' },
): Promise<ComposedPost> {
  const provider = imageGenerationProvider();
  const shape = generationShape(input.ratio, provider.aspectRatios);
  const prepared = await preparePost(scope, { ...input, generatorShape: shape.label });
  const generated = await provider.generate({ prompt: prepared.prompt, references: [], aspectRatio: shape.label, imageSize: input.quality });
  const built = await prepared.finish(generated.assets[0]!.bytes, {
    regenerate: async (note) => (await provider.generate({ prompt: `${prepared.prompt}\n${note}`, references: [], aspectRatio: shape.label, imageSize: input.quality })).assets[0]!.bytes,
  });
  return { ...built, plan: prepared.plan, prompt: prepared.prompt, bottle: prepared.bottle };
}

const aspectOf = (a: Pick<BrandAsset, 'bbox' | 'width' | 'height'>) => (a.bbox[3] * a.height) / (a.bbox[2] * a.width);

/** The brand's logos, the pack's own first, each with its bytes. */
/**
 * A brand's logos and bottles, held for a minute once read: a person placing
 * the pieces sets the post again on every drop, and asking the database for
 * the same files each time was most of a second of the wait.
 */
const HELD_FOR_MS = 60_000;
const heldFiles = new Map<string, { at: number; value: Promise<unknown> }>();
function held<T>(key: string, read: () => Promise<T>): Promise<T> {
  const known = heldFiles.get(key);
  if (known && Date.now() - known.at < HELD_FOR_MS) return known.value as Promise<T>;
  const value = read();
  heldFiles.set(key, { at: Date.now(), value });
  value.catch(() => heldFiles.delete(key));
  if (heldFiles.size > 40) heldFiles.delete(heldFiles.keys().next().value!);
  return value;
}

async function logosFor(scope: CompanyScope, brand: string, variant: string | null) {
  const all = await brandAssets(scope, { brand, kind: 'logo', variant });
  const own = variant ? all.filter((l) => l.asset.variant?.toLowerCase() === variant.toLowerCase()) : all.filter((l) => !l.asset.variant);
  const chosen = (own.length ? own : all).slice(0, 4);
  return Promise.all(chosen.map(async (l) => ({ name: l.name, asset: l.asset, bytes: (await brandFile(scope, l.fileId)).body })));
}

/** How light a logo's own ink is, its transparent ground left out. */
function logoTone(pic: Awaited<ReturnType<typeof loadImage>>): number {
  const scale = Math.min(1, 200 / Math.max(pic.width, pic.height));
  const c = createCanvas(Math.max(1, Math.round(pic.width * scale)), Math.max(1, Math.round(pic.height * scale))).getContext('2d');
  c.drawImage(pic, 0, 0, c.canvas.width, c.canvas.height);
  const data = c.getImageData(0, 0, c.canvas.width, c.canvas.height).data;
  let sum = 0; let weight = 0;
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3]! / 255;
    if (a < 0.2) continue;
    sum += a * (0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!) / 255;
    weight += a;
  }
  return weight ? sum / weight : 0.5;
}

function toneOf(data: Uint8ClampedArray): { mean: number; spread: number } {
  let sum = 0; let sq = 0; let n = 0;
  const step = Math.max(1, Math.floor(data.length / 4 / 6000)) * 4;
  for (let i = 0; i < data.length; i += step) {
    const l = (0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!) / 255;
    sum += l; sq += l * l; n += 1;
  }
  const mean = n ? sum / n : 0;
  return { mean, spread: n ? Math.sqrt(Math.max(0, sq / n - mean * mean)) : 0 };
}

function luminanceOf(hex: string): number {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex);
  if (!m) return 1;
  const [r, g, b] = [m[1], m[2], m[3]].map((v) => parseInt(v!, 16) / 255);
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** The post as the Bench looks at it: a JPEG 1280 on its long side, quick to send and plenty to judge. */
async function forReview(png: Buffer): Promise<{ bytes: Buffer; mimeType: string }> {
  const img = await loadImage(png);
  const scale = Math.min(1, 1280 / Math.max(img.width, img.height));
  const c = createCanvas(Math.round(img.width * scale), Math.round(img.height * scale));
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return { bytes: c.toBuffer('image/jpeg', 88), mimeType: 'image/jpeg' };
}

/**
 * A brand file's bytes, kept in memory once read. A bottle or a logo in the
 * library is the approved file and does not change under its id, and the
 * same few are read for every post of a brand - and again, from storage, for
 * every change of a post's words.
 */
const brandFiles = new Map<string, Promise<Awaited<ReturnType<typeof readFile>>>>();
const BRAND_FILES_KEPT = 40;

function brandFile(scope: CompanyScope, fileId: string): ReturnType<typeof readFile> {
  const key = `${scope.companyId}:${fileId}`;
  const known = brandFiles.get(key);
  if (known) return known;
  const read = readFile(scope, fileId);
  brandFiles.set(key, read);
  // A failed read is not kept: the next one tries again.
  read.catch(() => brandFiles.delete(key));
  if (brandFiles.size > BRAND_FILES_KEPT) brandFiles.delete(brandFiles.keys().next().value!);
  return read;
}
