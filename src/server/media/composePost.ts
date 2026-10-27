import 'server-only';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import type { CompanyScope } from '../db';
import { planPost, type BenchPlan } from '../brain/bench';
import { brandAssets, type BrandAsset } from '../brain/brandAssets';
import { adaptLayout, fitLayout, type FittedLayout, type LayoutSpec } from '../brain/layouts';
import { readFile } from '../drive/service';
import { placeBottle } from './bottleComposite';
import { imageGenerationProvider } from './providers';
import { measureHeadline, setHeadline, type Casing, type HeadlineLine } from './typography';
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
    'Camera: full-frame, 85mm lens at f/2.8, at the height of the surface looking very slightly down, level ' +
    'horizon, no tilt. The surface in the foreground is sharp; the background falls away into soft, creamy bokeh. ' +
    'Rich, cinematic colour grade with deep but detailed shadows; no haze, no HDR look, no oversharpening.',
  );
  const named = [...new Set(packColours.map(colourName).filter(Boolean))];
  if (named.length) {
    lines.push(`The product's own colours are ${named.join(', ')}: choose tones for the scene that flatter them and let the product stand out, never matching it exactly.`);
  }
  lines.push(
    'Balance: props and light spread so the frame feels balanced around the product\'s spot, with the quiet side ' +
    'for the words left open. Few objects, each deliberate; nothing cluttered or random.',
  );
  lines.push('Composition - these places must be kept as described:');
  if (layout.bottleBox) {
    const b = inGenerated(layout.bottleBox, postRatio, genRatio);
    const base = b.y + b.h;
    lines.push(
      `- A clear spot on the ${plan.scene.surface === 'gloss' ? 'polished' : ''} surface ${across(b.x + b.w / 2)} of centre, about ${pct(b.x + b.w / 2)} across, ` +
      `where a bottle about ${pct(b.h)} of the frame's height will be stood later, its base about ${pct(base)} down. The surface must run under ` +
      `that spot, level and in focus, and nothing may stand in front of it or between ${pct(b.x - 0.04)} and ${pct(b.x + b.w + 0.04)} across above it.`,
    );
  }
  if (layout.textBox) {
    const t = inGenerated(layout.textBox, postRatio, genRatio);
    const light = luminanceOf(layout.text?.ink ?? '#ffffff') > 0.5;
    lines.push(
      `- The area from ${pct(t.x)} to ${pct(t.x + t.w)} across and ${pct(t.y - 0.04)} to ${pct(t.y + t.h + 0.04)} down is for words: ` +
      `calm, uncluttered, out of focus and evenly ${light ? 'dark' : 'light'}, with no bright lights, no sharp objects and no faces in it.`,
    );
  }
  if (layout.logoBox && layout.logo) {
    lines.push(`- The ${layout.logo.corner.replace('-', ' ')} corner plain and quiet, for a logo.`);
  }
  lines.push(
    'There are no bottles, packaging or labels anywhere, and no text, letters, numbers, signs, logos or watermarks. ' +
    'Natural colour, real materials, believable light, nothing cartoonish or illustrated.',
  );
  return lines.join('\n');
}

export type BuiltPost = {
  bytes: Buffer;
  width: number;
  height: number;
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
}): Promise<BuiltPost> {
  const { width: W, height: H } = postSize(input.ratio);
  const tweaks = input.tweaks ?? NO_TWEAKS;
  const layout = tweaked(input.layout, tweaks);

  // The scene, cropped from its centre to the post and scaled to size.
  const scene = await loadImage(input.scene);
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  const have = scene.width / scene.height;
  const sw = have > input.ratio ? scene.height * input.ratio : scene.width;
  const sh = have > input.ratio ? scene.height : scene.width / input.ratio;
  ctx.drawImage(scene, (scene.width - sw) / 2, (scene.height - sh) / 2, sw, sh, 0, 0, W, H);

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
  let bytes = canvas.toBuffer('image/png');

  // The real bottle, stood where the layout puts it.
  if (input.bottle && layout.bottleBox) {
    const b = layout.bottleBox;
    bytes = (await placeBottle({ scene: bytes, bottle: input.bottle, place: { cx: b.x + b.w / 2, base: b.y + b.h, height: b.h }, surface: input.plan.scene.surface, light: 'auto' })).bytes;
  }

  // The headline.
  const set = await setHeadline({ image: bytes, layout, lines: input.plan.headline, casing: input.plan.casing, keep: input.plan.keep, scale: tweaks.textScale });
  // A line of the plan broken down to a lone word means the block was too
  // narrow for it: set again, wider, as far as the bottle allows.
  const planned = new Set(input.plan.headline.map((l) => l.text.trim().toLowerCase()));
  const lone = set.lines.some((l) => !l.text.includes(' ') && !planned.has(l.text.trim().toLowerCase()));
  if (lone && tweaks.textWidth < 1.5) return buildPost({ ...input, tweaks: { ...tweaks, textWidth: tweaks.textWidth * 1.25, textScale: Math.max(0.85, tweaks.textScale * 0.95) } });
  bytes = set.bytes;

  // The logo: the version that stands out against where it lands.
  let logoName: string | null = null;
  if (layout.logoBox && input.logos.length) {
    const img = await loadImage(bytes);
    const out = createCanvas(W, H);
    const c = out.getContext('2d');
    c.drawImage(img, 0, 0);
    const box = layout.logoBox;
    const under = toneOf(c.getImageData(Math.round(box.x * W), Math.round(box.y * H), Math.max(1, Math.round(box.w * W)), Math.max(1, Math.round(box.h * H))).data).mean;
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
    bytes = out.toBuffer('image/png');
    logoName = logo.name;
  }

  const substitutes = [...new Set(set.lines.filter((l) => l.substitute).map((l) => l.face))];
  return { bytes, width: W, height: H, logo: logoName, substitutes, tweaks };
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
  r: Pick<PostRecipe, 'brand' | 'variant' | 'bottleFileId' | 'spec' | 'ratio' | 'casing' | 'keep' | 'surface'> & { headline: HeadlineLine[] },
) {
  const [bottle, logos, bottles] = await Promise.all([
    r.bottleFileId ? brandFile(scope, r.bottleFileId) : Promise.resolve(null),
    logosFor(scope, r.brand, r.variant),
    brandAssets(scope, { brand: r.brand, kind: 'bottle', variant: r.variant }),
  ]);
  const bottleAsset = bottles.find((b) => b.fileId === r.bottleFileId)?.asset ?? null;
  const bottleAspect = bottleAsset ? (bottleAsset.bbox[2] * bottleAsset.width) / (bottleAsset.bbox[3] * bottleAsset.height) : 0.32;
  const logoAspect = logos[0] ? aspectOf(logos[0].asset) : 0.8;
  // Fitted to these words: a longer headline than the designer's pushes the
  // bottle across, or below the words in a story, rather than being squeezed.
  const adapted = adaptLayout(r.spec, r.ratio);
  const words = adapted.text ? measureHeadline(adapted.text, r.headline, r.ratio, r.casing, r.keep) : null;
  const layout = fitLayout(r.spec, r.ratio, bottleAspect, logoAspect, words);
  // Only the logos in the same shape as the one the layout was fitted to.
  const sameShape = logos.filter((l) => Math.abs(aspectOf(l.asset) - logoAspect) < 0.15);
  const plan = { headline: r.headline, casing: r.casing, keep: r.keep, scene: { surface: r.surface } };
  return {
    bottle,
    layout,
    build: (scene: Buffer, tweaks: PostTweaks) =>
      buildPost({ scene, ratio: r.ratio, layout, plan, bottle: bottle?.body ?? null, logos: sameShape.length ? sameShape : logos, tweaks }),
  };
}

/**
 * A composed post set again with other words, on the scene it was made on:
 * the bottle, logo and layout as they were, fitted to the new headline. The
 * review's fixes to the bottle are kept; the words start fresh.
 */
export async function rebuildPost(scope: CompanyScope, recipe: PostRecipe, scene: Buffer, headline: HeadlineLine[]): Promise<BuiltPost> {
  const { build } = await assemble(scope, { ...recipe, headline });
  return build(scene, { ...recipe.tweaks, textWidth: 1, textScale: 1 });
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
  input: { request: string; brand: string; ratio: number; generatorShape: string; market?: string | null },
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
  };
  const { bottle, layout, build } = await assemble(scope, { ...recipe, headline: plan.headline });
  const [gw, gh] = input.generatorShape.split(':').map(Number);
  // The pack's own colours, measured from its photograph, for a scene that flatters them.
  const packColours = bottle ? (await readPalette(bottle.body, 'image/png')).filter((c) => c.share >= 0.08).slice(0, 3).map((c) => c.hex) : [];
  const prompt = scenePrompt(plan, layout, input.ratio, gw && gh ? gw / gh : input.ratio, packColours);
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
  const generated = await provider.generate({ prompt: prepared.prompt, references: [], aspectRatio: shape.label, imageSize: input.quality ?? 'high' });
  const built = await prepared.finish(generated.assets[0]!.bytes, {
    regenerate: async (note) => (await provider.generate({ prompt: `${prepared.prompt}\n${note}`, references: [], aspectRatio: shape.label, imageSize: input.quality ?? 'high' })).assets[0]!.bytes,
  });
  return { ...built, plan: prepared.plan, prompt: prepared.prompt, bottle: prepared.bottle };
}

const aspectOf = (a: Pick<BrandAsset, 'bbox' | 'width' | 'height'>) => (a.bbox[3] * a.height) / (a.bbox[2] * a.width);

/** The brand's logos, the pack's own first, each with its bytes. */
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
