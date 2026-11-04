import 'server-only';
import { withCompanyScope } from '../db';
import type { CompanyScope } from '../db';
import { choicesOf, type Corner, type Placement, type PostChoices } from '../brain/layouts';
import { brandDrink, pastScenes } from '../brain/bench';
import { drinkLine, rebuildPost, type PostBoxes, type PostLayers, type PostRecipe } from './composePost';
import { getGeneration, keepScene, sceneOf, validateProviderChoice } from './generation';
import { imageGenerationProvider } from './providers';
import { MEDIA_LIMITS } from './providers/types';
import { exportPost, type ExportFormat } from './layeredExport';
import { headlineFrom } from './retext';
import { getMediaAsset, mediaStorageKey, putMediaAsset } from './storage';
import type { HeadlineLine } from './typography';
import { MediaProviderUnavailable, MediaRejected, type MediaGenerationDTO } from './types';

/**
 * A composed post arranged layer by layer: the scene stays as it was painted,
 * and the bottle, the logo and the words are placed where a person puts them.
 *
 * The scene was kept beside the post and so was everything it was built from,
 * so every change is the post set again - a second or two, no model asked,
 * nothing spent - and the post is changed where it is rather than copied, so
 * a few tries do not fill the history with versions.
 */

const BOTTLE = new Set(['left', 'center', 'right', 'none']);
const SIZE = new Set(['small', 'medium', 'large']);
const LOGO = new Set(['top-left', 'top-right', 'bottom-left', 'bottom-right', 'none']);
const HEADLINE = new Set(['shown', 'none']);

/** The choices as sent, checked; anything not sent keeps what it was. */
export function choicesFrom(raw: unknown, current: PostChoices): PostChoices {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const pick = <T extends string>(value: unknown, allowed: Set<string>, was: T): T => {
    if (value === undefined) return was;
    if (typeof value !== 'string' || !allowed.has(value)) throw new MediaRejected('That is not a place the layers can go.');
    return value as T;
  };
  const bottle = pick(r.bottle, BOTTLE, current.bottle);
  const size = pick(r.size, SIZE, current.size);
  const logo = pick<Corner | 'none'>(r.logo, LOGO, current.logo);
  const headline = pick<'shown' | 'none'>(r.headline, HEADLINE, current.headline ?? 'shown');

  // A preset puts its piece back where the layout puts it, so whatever was
  // dragged there before goes - and a bottle on another side moves the words.
  const place: Placement = { ...(current.place ?? {}) };
  if (r.bottle !== undefined || r.size !== undefined) { delete place.bottle; if (r.bottle !== undefined) delete place.text; }
  if (r.logo !== undefined) delete place.logo;
  const sent = (r.place && typeof r.place === 'object' ? r.place : {}) as Record<string, unknown>;
  for (const piece of ['bottle', 'logo', 'text'] as const) {
    if (!(piece in sent)) continue;
    if (sent[piece] === null) { delete place[piece]; continue; }
    (place as Record<string, unknown>)[piece] = placementOf(piece, sent[piece]);
  }
  return { bottle, size, logo, ...(headline === 'none' ? { headline } : {}), ...(Object.keys(place).length ? { place } : {}) };
}

/** One dragged piece, checked: numbers, on the post, a sensible size. */
function placementOf(piece: 'bottle' | 'logo' | 'text', raw: unknown) {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const num = (key: string, min: number, max: number) => {
    const v = r[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new MediaRejected('That is not a place the layers can go.');
    return Math.min(max, Math.max(min, v));
  };
  if (piece === 'bottle') return { cx: num('cx', -0.2, 1.2), base: num('base', 0.1, 1.3), height: num('height', 0.08, 1.2) };
  if (piece === 'logo') return { x: num('x', -0.2, 1), y: num('y', -0.2, 1), w: num('w', 0.03, 0.8) };
  return { x: num('x', -0.2, 1), y: num('y', -0.2, 1), scale: num('scale', 0.3, 3) };
}

type Composed = {
  recipe?: PostRecipe; scene?: boolean; headline?: HeadlineLine[];
  /** When it was last arranged, and which arrangement its kept layers show. */
  arrangedAt?: string; layersAt?: string;
  /** Where each piece landed in those layers, for dragging them. */
  layerBoxes?: PostBoxes;
  /** What each kept layer holds, so one that has not changed is neither sent nor fetched again. */
  layerHashes?: LayerHashes;
  /** The brief its background was painted from, to paint another. */
  scenePrompt?: string;
  /** Whether an earlier background is kept to go back to, and how many were made. */
  previousScene?: boolean;
  backgrounds?: number;
} & Record<string, unknown>;

async function composedOf(scope: CompanyScope, generationId: string) {
  // This company's, or not found.
  await getGeneration(scope, generationId);
  const [row] = await withCompanyScope(scope, (tx) => tx<{ composed: Composed | null; storage_path: string | null }[]>`
    select output_metadata->'composed' as composed, storage_path
      from media_generations where id = ${generationId} and company_id = ${scope.companyId}
  `);
  const composed = row?.composed;
  if (!composed?.recipe || !composed.scene || !composed.headline?.length || !row?.storage_path) {
    throw new MediaRejected('This picture was made in one piece, so its parts cannot be moved. Make a new post to arrange it layer by layer.');
  }
  return { composed, recipe: composed.recipe, headline: composed.headline, key: row.storage_path };
}

/**
 * A post's scene, held for a while once read: a person placing the pieces
 * sets the post again on every drop, and the scene never changes - fetching
 * it from storage each time was most of the wait.
 */
const scenes = new Map<string, Buffer>();
async function keptScene(scope: CompanyScope, generationId: string): Promise<Buffer> {
  const key = `${scope.companyId}:${generationId}`;
  const held = scenes.get(key);
  if (held) return held;
  const scene = await sceneOf(scope, generationId);
  scenes.set(key, scene);
  // A handful of posts at a time; the oldest goes first.
  if (scenes.size > 12) scenes.delete(scenes.keys().next().value!);
  return scene;
}

/** Where a post's layers are now, for a post that has never been arranged as well as one that has. */
export function currentChoices(recipe: PostRecipe): PostChoices {
  return recipe.choices ?? choicesOf(recipe.spec);
}

/**
 * Moves a post's layers: `choices` for the bottle and logo, `lines` for the
 * words. Returns the post as it now is.
 */
export async function arrangePost(
  scope: CompanyScope,
  generationId: string,
  body: { choices?: unknown; lines?: unknown },
): Promise<{ generation: MediaGenerationDTO; layers: LayerManifest }> {
  const { composed, recipe, headline: was, key } = await composedOf(scope, generationId);
  const choices = choicesFrom(body.choices, currentChoices(recipe));
  const headline = body.lines === undefined ? was : headlineFrom(body.lines);
  const arranged: PostRecipe = { ...recipe, choices };

  const post = await rebuildPost(scope, arranged, await keptScene(scope, generationId), headline, { layers: true });
  // Only the layers that changed are sent; the background, never moved, stays where it is.
  const [, layerHashes] = await Promise.all([
    putMediaAsset(key, post.bytes, 'image/png'),
    storeLayers(scope, generationId, post.layers!, composed.layerHashes),
  ]);
  const arrangedAt = new Date().toISOString();
  await withCompanyScope(scope, async (tx) => {
    await tx`
      update media_generation_assets set file_size = ${post.bytes.byteLength}, width = ${post.width}, height = ${post.height}
       where generation_id = ${generationId} and company_id = ${scope.companyId} and storage_path = ${key}
    `;
    await tx`
      update media_generations
         set width = ${post.width}, height = ${post.height},
             output_metadata = coalesce(output_metadata, '{}'::jsonb)
               || ${tx.json({ composed: { ...composed, recipe: arranged, headline, arrangedAt, layersAt: arrangedAt, layerBoxes: post.boxes, layerHashes } } as never)}
       where id = ${generationId} and company_id = ${scope.companyId}
    `;
  });
  return {
    generation: (await getGeneration(scope, generationId)).generation,
    layers: manifestOf(post.width, post.height, arrangedAt, choices, post.boxes, layerHashes),
  };
}

// --- the layers, one file each ---------------------------------------------------------

export const LAYER_NAMES = ['background', 'shadow', 'bottle', 'headline', 'logo'] as const;
export type LayerName = (typeof LAYER_NAMES)[number];

const layerKey = (scope: CompanyScope, generationId: string, name: LayerName) =>
  mediaStorageKey(scope.companyId, generationId, `layer-${name}`, 'png');

/** A fully transparent picture, for a part the post does not have. */
async function emptyLayer(width: number, height: number): Promise<Buffer> {
  const { createCanvas } = await import('@napi-rs/canvas');
  return createCanvas(width, height).toBuffer('image/png');
}

export type LayerHashes = Partial<Record<LayerName, string>>;

/**
 * Keeps a post's layers, and says what each holds. A layer the same as the
 * one already kept is not sent again: moving the logo leaves the background,
 * the bottle and the words as they were, and only the logo goes.
 */
async function storeLayers(scope: CompanyScope, generationId: string, layers: PostLayers, kept?: LayerHashes): Promise<LayerHashes> {
  const { loadImage } = await import('@napi-rs/canvas');
  const { createHash } = await import('node:crypto');
  const size = await loadImage(layers.background);
  const empty = await emptyLayer(size.width, size.height);
  const hashes: LayerHashes = {};
  await Promise.all(LAYER_NAMES.map(async (name) => {
    const bytes = layers[name] ?? empty;
    const hash = createHash('sha1').update(bytes).digest('hex').slice(0, 16);
    hashes[name] = hash;
    if (kept?.[name] === hash) return;
    await putMediaAsset(layerKey(scope, generationId, name), bytes, 'image/png');
    // The page asks for it straight after; it need not come back from storage.
    const at = `${scope.companyId}:${generationId}:${name}`;
    justSet.delete(at);
    justSet.set(at, { hash, bytes });
    if (justSet.size > 40) justSet.delete(justSet.keys().next().value!);
  }));
  return hashes;
}

/** The layers set most recently, by post and name, with what they hold. */
const justSet = new Map<string, { hash: string; bytes: Buffer }>();

export type LayerManifest = {
  width: number;
  height: number;
  version: string;
  /** `v` changes only when that layer does, so the page fetches only what moved. */
  layers: { name: LayerName; present: boolean; v: string }[];
  boxes: PostBoxes;
  choices: PostChoices;
};

function manifestOf(width: number, height: number, version: string, choices: PostChoices, boxes: PostBoxes, hashes?: LayerHashes): LayerManifest {
  return {
    width,
    height,
    version,
    layers: LAYER_NAMES.map((name) => ({
      name,
      present: name === 'background'
        || (name === 'headline' ? choices.headline !== 'none' : name === 'logo' ? choices.logo !== 'none' : choices.bottle !== 'none'),
      v: hashes?.[name] ?? version,
    })),
    boxes,
    choices,
  };
}

/**
 * The layers of a post as they stand, made once from its scene for a post
 * whose layers were never kept - and kept, so the next look is a read.
 * What the page draws a post from, layer over layer.
 */
export async function postLayers(scope: CompanyScope, generationId: string): Promise<LayerManifest> {
  const { composed, recipe, headline } = await composedOf(scope, generationId);
  const version = String(composed.arrangedAt ?? 'made');
  const choices = currentChoices(recipe);
  if (composed.layersAt !== version || !composed.layerBoxes) {
    const post = await rebuildPost(scope, { ...recipe, choices }, await keptScene(scope, generationId), headline, { layers: true });
    const hashes = await storeLayers(scope, generationId, post.layers!);
    await withCompanyScope(scope, (tx) => tx`
      update media_generations
         set output_metadata = coalesce(output_metadata, '{}'::jsonb)
           || ${tx.json({ composed: { ...composed, layersAt: version, layerBoxes: post.boxes, layerHashes: hashes } } as never)}
       where id = ${generationId} and company_id = ${scope.companyId}
    `);
    return manifestOf(post.width, post.height, version, choices, post.boxes, hashes);
  }
  const { generation } = await getGeneration(scope, generationId);
  return manifestOf(generation.width ?? 1080, generation.height ?? 1080, version, choices, composed.layerBoxes, composed.layerHashes);
}

/** One layer's picture - straight from memory when it was just set here. */
export async function layerFile(scope: CompanyScope, generationId: string, name: string, v?: string | null): Promise<Buffer> {
  if (!(LAYER_NAMES as readonly string[]).includes(name)) throw new MediaRejected('There is no such layer.');
  await composedOf(scope, generationId);
  const fresh = justSet.get(`${scope.companyId}:${generationId}:${name}`);
  if (fresh && v && fresh.hash === v) return fresh.bytes;
  return getMediaAsset(layerKey(scope, generationId, name as LayerName));
}

/** The post as a file an editor opens, every part on its own layer. Nothing is spent. */
export async function exportLayers(scope: CompanyScope, generationId: string, format: ExportFormat): Promise<Buffer> {
  const { recipe, headline } = await composedOf(scope, generationId);
  const post = await rebuildPost(scope, { ...recipe, choices: currentChoices(recipe) }, await keptScene(scope, generationId), headline, { layers: true });
  return exportPost({ bytes: post.bytes, width: post.width, height: post.height, layers: post.layers! }, format);
}

// --- a new background ------------------------------------------------------------------

const BACKGROUND_NOTE_MAX = 400;

/**
 * Paints the post a new background, and sets the post again on it with the
 * bottle, the logo and the words just where they were.
 *
 * The one thing here that is paid for: a single new picture, from the brief
 * the first background was painted from with what the person asked added -
 * "diyas and rangoli on a terrace at night". The background it replaces is
 * kept, so a person who preferred it can go back for nothing.
 */
export async function newBackground(scope: CompanyScope, generationId: string, raw: unknown): Promise<MediaGenerationDTO> {
  const note = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().slice(0, BACKGROUND_NOTE_MAX) : '';
  const { composed, recipe, headline, key } = await composedOf(scope, generationId);
  const [row] = await withCompanyScope(scope, (tx) => tx<{ input_metadata: { aspectRatio?: string; imageSize?: string; providerChoice?: string } | null }[]>`
    select input_metadata from media_generations where id = ${generationId} and company_id = ${scope.companyId}
  `);
  const meta = row?.input_metadata ?? {};
  const provider = imageGenerationProvider(validateProviderChoice(meta.providerChoice ?? null));
  if (!provider.configured && provider.name !== 'fake-image') throw new MediaProviderUnavailable('Image generation is not configured.');

  const [brandScenes, drink] = await Promise.all([pastScenes(scope, recipe.brand), brandDrink(scope, recipe.brand)]);
  const brief = clearBrief(typeof composed.scenePrompt === 'string' && composed.scenePrompt
    ? composed.scenePrompt
    : fallbackBrief(composed, recipe), brandScenes);
  const asked = note
    ? `What this background must show, as the person asked - this leads: ${note}. Keep every place described above clear for the bottle, the words and the logo.`
    : 'A different background from the last one, in the same spirit and the same style.';
  const prompt = [
    brief,
    asked,
    CLEAR,
    drinkLine({ ...drink, variant: recipe.variant }),
    'Still no bottles, packs, labels, text, letters, logos, warnings or disclaimers anywhere.',
  ].join('\n').slice(0, MEDIA_LIMITS.maxPromptChars);

  const made = await provider.generate({
    prompt,
    references: [],
    aspectRatio: meta.aspectRatio ?? undefined,
    imageSize: meta.imageSize ?? undefined,
  });
  const scene = made.assets[0]?.bytes;
  if (!scene) throw new MediaRejected('No background came back. Nothing was changed.');

  // The old one kept to go back to, then the new one in its place.
  const was = await keptScene(scope, generationId);
  await putMediaAsset(mediaStorageKey(scope.companyId, generationId, 'scene-previous', 'png'), was, 'image/png');
  await keepScene(scope, generationId, scene);
  scenes.set(`${scope.companyId}:${generationId}`, scene);

  return setOnScene(scope, generationId, { composed, recipe, headline, key }, scene, {
    backgrounds: Number(composed.backgrounds ?? 1) + 1,
    backgroundNote: note || null,
    previousScene: true,
  });
}

/** Back to the background before the newest one - and the newest kept, to swap back. Nothing is spent. */
export async function previousBackground(scope: CompanyScope, generationId: string): Promise<MediaGenerationDTO> {
  const found = await composedOf(scope, generationId);
  if (!found.composed.previousScene) throw new MediaRejected('There is no earlier background for this post.');
  const before = await getMediaAsset(mediaStorageKey(scope.companyId, generationId, 'scene-previous', 'png'));
  const now = await keptScene(scope, generationId);
  await putMediaAsset(mediaStorageKey(scope.companyId, generationId, 'scene-previous', 'png'), now, 'image/png');
  await keepScene(scope, generationId, before);
  scenes.set(`${scope.companyId}:${generationId}`, before);
  return setOnScene(scope, generationId, found, before, {});
}

/** The post set again on a scene, its picture and layers replaced where they are. */
async function setOnScene(
  scope: CompanyScope,
  generationId: string,
  found: { composed: Composed; recipe: PostRecipe; headline: HeadlineLine[]; key: string },
  scene: Buffer,
  extra: Record<string, unknown>,
): Promise<MediaGenerationDTO> {
  const { composed, recipe, headline, key } = found;
  const arranged = { ...recipe, choices: currentChoices(recipe) };
  const post = await rebuildPost(scope, arranged, scene, headline, { layers: true });
  const [, layerHashes] = await Promise.all([
    putMediaAsset(key, post.bytes, 'image/png'),
    storeLayers(scope, generationId, post.layers!, composed.layerHashes),
  ]);
  const arrangedAt = new Date().toISOString();
  await withCompanyScope(scope, (tx) => tx`
    update media_generations
       set output_metadata = coalesce(output_metadata, '{}'::jsonb)
         || ${tx.json({ composed: { ...composed, ...extra, recipe: arranged, headline, arrangedAt, layersAt: arrangedAt, layerBoxes: post.boxes, layerHashes } } as never)}
     where id = ${generationId} and company_id = ${scope.companyId}
  `);
  return (await getGeneration(scope, generationId)).generation;
}

/** A background is always painted clear: nothing soft, nothing hazy. */
const CLEAR = 'The whole picture clear and crisp from front to back, everything in focus and cleanly lit - no blur, no bokeh, no haze, fog, smoke, grain or glow.';

/**
 * A brief kept from before backgrounds were painted clear, with its soft
 * focus taken out - and the brand's own pictures added, when it had none.
 */
function clearBrief(brief: string, scenes: string[]): string {
  const sharp = brief
    .replace(/85mm lens at f\/2\.8/g, '50mm lens at f/8 for deep focus')
    .replace(/;? ?the background falls away into soft, creamy bokeh\.?/gi, '.')
    .replace(/out of focus and evenly/g, 'plain and evenly');
  if (!scenes.length || /photographic style/.test(sharp)) return sharp;
  return `${sharp}\nIn the brand's own photographic style - its pictures have been set like this, and this scene belongs with them in place, props, light and colour, without copying any: ${scenes.slice(0, 5).join(' / ')}.`;
}

/**
 * The brief for a post made before briefs were kept: its idea, in the
 * brand's look, with the surface clear for the bottle anywhere.
 */
function fallbackBrief(composed: Composed, recipe: PostRecipe): string {
  const idea = typeof composed.idea === 'string' ? composed.idea : '';
  return [
    'A photograph for a premium spirits advertisement, made by a top still-life photographer: the background plate only, ' +
      `into which the product will be placed afterwards. ${idea}`,
    'Camera: full-frame, 50mm lens at f/8 for deep focus, at the height of the surface looking very slightly down, level horizon. ' +
      'Everything sharp, from the surface to the setting behind.',
    `- The ${recipe.surface === 'gloss' ? 'polished ' : ''}surface runs level across the whole width of the frame in the lower ` +
      'third, clear from left to right, so a bottle can be stood anywhere on it later.',
    '- Above it the frame is calm and uncluttered on both sides, for words. All four corners plain and quiet, for a logo.',
  ].join('\n');
}
