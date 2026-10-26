import 'server-only';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import type { CompanyScope } from '../db';
import { planPost, type BenchPlan } from '../brain/bench';
import { brandAssets, type BrandAsset } from '../brain/brandAssets';
import { fitLayout, type FittedLayout } from '../brain/layouts';
import { readFile } from '../drive/service';
import { placeBottle } from './bottleComposite';
import { imageGenerationProvider } from './providers';
import { setHeadline } from './typography';

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

/** The brief for the scene: the bench's picture of it, and the places to keep clear. */
export function scenePrompt(plan: Pick<BenchPlan, 'scene'>, layout: FittedLayout, postRatio: number, genRatio: number): string {
  const lines: string[] = [];
  lines.push(
    'A photograph for a premium spirits advertisement: the background plate only, shot on a full-frame camera. ' +
    `${plan.scene.description.replace(/\s+/g, ' ').trim()}`,
  );
  lines.push(`Mood: ${plan.scene.mood}. ${plan.scene.light === 'front' ? 'Soft frontal key light.' : `Key light from the ${plan.scene.light}.`}`);
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
};

/**
 * The post, put together from its parts: the scene cropped to size, the words'
 * ground calmed where the scene is too busy for them, the bottle, the
 * headline, the logo. No model here; the same parts give the same post.
 */
export async function buildPost(input: {
  scene: Buffer;
  ratio: number;
  layout: FittedLayout;
  plan: Pick<BenchPlan, 'headline' | 'casing' | 'keep' | 'scene'>;
  bottle: Buffer | null;
  logos: { name: string; bytes: Buffer; asset: Pick<BrandAsset, 'tone' | 'bbox' | 'width' | 'height'> }[];
}): Promise<BuiltPost> {
  const { width: W, height: H } = postSize(input.ratio);
  const layout = input.layout;

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
    const alpha = Math.min(0.6, need);
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
  const set = await setHeadline({ image: bytes, layout, lines: input.plan.headline, casing: input.plan.casing, keep: input.plan.keep });
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
    if (Math.abs(own - under) < 0.3) {
      const cx = box.x * W + w / 2;
      const cy = box.y * H + h / 2;
      const r = Math.max(w, h) * 1.3;
      const shade = own > 0.5 ? '0,0,0' : '255,255,255';
      const glow = c.createRadialGradient(cx, cy, 0, cx, cy, r);
      glow.addColorStop(0, `rgba(${shade},0.5)`);
      glow.addColorStop(0.35, `rgba(${shade},0.36)`);
      glow.addColorStop(0.7, `rgba(${shade},0.12)`);
      glow.addColorStop(1, `rgba(${shade},0)`);
      c.fillStyle = glow;
      c.fillRect(cx - r, cy - r, r * 2, r * 2);
    }
    c.drawImage(pic, lx * pic.width, ly * pic.height, lw * pic.width, lh * pic.height, box.x * W, box.y * H, w, h);
    bytes = out.toBuffer('image/png');
    logoName = logo.name;
  }

  const substitutes = [...new Set(set.lines.filter((l) => l.substitute).map((l) => l.face))];
  return { bytes, width: W, height: H, logo: logoName, substitutes };
}

export type ComposedPost = BuiltPost & {
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
  /** The post, from the scene the generator made. */
  finish: (scene: Buffer) => Promise<BuiltPost>;
};

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

  // The pieces, read before the layout is fitted: their shapes decide it.
  const [bottle, logos, bottles] = await Promise.all([
    plan.bottleFileId ? readFile(scope, plan.bottleFileId) : Promise.resolve(null),
    logosFor(scope, input.brand, plan.variant),
    brandAssets(scope, { brand: input.brand, kind: 'bottle', variant: plan.variant }),
  ]);
  const bottleAsset = bottles.find((b) => b.fileId === plan.bottleFileId)?.asset ?? null;
  const bottleAspect = bottleAsset ? (bottleAsset.bbox[2] * bottleAsset.width) / (bottleAsset.bbox[3] * bottleAsset.height) : 0.32;
  const logo = logos[0];
  const logoAspect = logo ? aspectOf(logo.asset) : 0.8;
  const layout = fitLayout(plan.layout.spec, input.ratio, bottleAspect, logoAspect);
  const [gw, gh] = input.generatorShape.split(':').map(Number);
  const prompt = scenePrompt(plan, layout, input.ratio, gw && gh ? gw / gh : input.ratio);

  // Only the logos in the same shape as the one the layout was fitted to.
  const sameShape = logos.filter((l) => Math.abs(aspectOf(l.asset) - logoAspect) < 0.15);
  return {
    plan,
    prompt,
    bottle: bottle?.file.name ?? null,
    finish: (scene) => buildPost({ scene, ratio: input.ratio, layout, plan, bottle: bottle?.body ?? null, logos: sameShape.length ? sameShape : logos }),
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
  const built = await prepared.finish(generated.assets[0]!.bytes);
  return { ...built, plan: prepared.plan, prompt: prepared.prompt, bottle: prepared.bottle };
}

const aspectOf = (a: Pick<BrandAsset, 'bbox' | 'width' | 'height'>) => (a.bbox[3] * a.height) / (a.bbox[2] * a.width);

/** The brand's logos, the pack's own first, each with its bytes. */
async function logosFor(scope: CompanyScope, brand: string, variant: string | null) {
  const all = await brandAssets(scope, { brand, kind: 'logo', variant });
  const own = variant ? all.filter((l) => l.asset.variant?.toLowerCase() === variant.toLowerCase()) : all.filter((l) => !l.asset.variant);
  const chosen = (own.length ? own : all).slice(0, 4);
  return Promise.all(chosen.map(async (l) => ({ name: l.name, asset: l.asset, bytes: (await readFile(scope, l.fileId)).body })));
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
