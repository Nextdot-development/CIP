import 'server-only';
import { withCompanyScope } from '../db';
import type { CompanyScope } from '../db';
import { STACK, choicesOf, type Corner, type Placement, type PostChoices, type PostStyle, type StackGroup } from '../brain/layouts';
import { brandDrink, headlineSuggestions, pastScenes } from '../brain/bench';
import { drinkLine, headlineInks, rebuildPost, type PostBoxes, type PostLayers, type PostRecipe } from './composePost';
import { generationIn, getGeneration, keepScene, sceneOf, validateProviderChoice } from './generation';
import { imageGenerationProvider } from './providers';
import { MEDIA_LIMITS } from './providers/types';
import { exportPost, type ExportFormat } from './layeredExport';
import { headlineFrom } from './retext';
import { forgetMediaAsset, getMediaAsset, mediaStorageKey, putMediaAsset } from './storage';
import { HEADLINE_FONTS, headlineFontIsOwn, type HeadlineLine, type TextBlock } from './typography';
import { MediaNotFound, MediaProviderUnavailable, MediaRejected, type MediaGenerationDTO } from './types';

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
  for (const piece of ['bottle', 'logo', 'text', 'shadow', 'reflection'] as const) {
    if (!(piece in sent)) continue;
    if (sent[piece] === null) { delete place[piece]; continue; }
    (place as Record<string, unknown>)[piece] = placementOf(piece, sent[piece]);
  }
  const style = styleFrom(r.style, current.style);
  const texts = r.texts === undefined ? current.texts ?? [] : textsFrom(r.texts);
  const order = r.order === undefined ? current.order : r.order === null ? undefined : orderFrom(r.order);
  return {
    bottle, size, logo,
    ...(headline === 'none' ? { headline } : {}),
    ...(Object.keys(place).length ? { place } : {}),
    ...(Object.keys(style).length ? { style } : {}),
    ...(texts.length ? { texts } : {}),
    ...(order && order.join() !== STACK.join() ? { order } : {}),
  };
}

/** Which piece lies over which, as sent: each of them once. */
export function orderFrom(raw: unknown): StackGroup[] {
  if (!Array.isArray(raw) || raw.length !== STACK.length || STACK.some((g) => !raw.includes(g))) {
    throw new MediaRejected('Send the order of the bottle, headline, text and logo, each once.');
  }
  return raw as StackGroup[];
}

const TEXT_ID = /^[a-z0-9]{4,12}$/;
const MAX_TEXTS = 6;

/** The added text blocks as sent, each checked: its words as a headline's are, its place and look kept in bounds. */
export function textsFrom(raw: unknown): TextBlock[] {
  if (!Array.isArray(raw)) throw new MediaRejected('Send the added text as a list of blocks.');
  if (raw.length > MAX_TEXTS) throw new MediaRejected(`A post takes at most ${MAX_TEXTS} blocks of text besides its headline.`);
  const seen = new Set<string>();
  return raw.map((b) => {
    const r = (b && typeof b === 'object' ? b : {}) as Record<string, unknown>;
    const id = typeof r.id === 'string' && TEXT_ID.test(r.id) ? r.id : null;
    if (!id || seen.has(id)) throw new MediaRejected('Each block of text needs an id of its own.');
    seen.add(id);
    const num = (key: string, min: number, max: number, plain: number) => {
      const v = r[key];
      return typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : plain;
    };
    const font = typeof r.font === 'string' && HEADLINE_FONTS.some((f) => f.id === r.font) ? r.font as TextBlock['font'] : undefined;
    const ink = typeof r.ink === 'string' && /^#[0-9a-f]{6}$/i.test(r.ink) ? r.ink.toLowerCase() : undefined;
    return {
      id,
      lines: headlineFrom(r.lines),
      x: num('x', -0.2, 1, 0.07),
      y: num('y', -0.2, 1, 0.78),
      width: num('width', 0.08, 1.2, 0.6),
      size: num('size', 0.015, 0.2, 0.045),
      align: r.align === 'center' || r.align === 'right' ? r.align : 'left',
      weight: r.weight === 'regular' || r.weight === 'black' ? r.weight : 'bold',
      italic: r.italic === true,
      upper: r.upper === true,
      shadow: r.shadow !== false,
      ...(font ? { font } : {}),
      ...(ink ? { ink } : {}),
    };
  });
}

const INK = /^#[0-9a-f]{6}$/i;
const ALIGN = new Set(['left', 'center', 'right']);

/** The look as sent, checked: anything not sent keeps what it was, and null puts it back as the layout has it. */
export function styleFrom(raw: unknown, current: PostStyle = {}): PostStyle {
  if (raw === undefined) return { ...current };
  if (!raw || typeof raw !== 'object') throw new MediaRejected('That is not a look the post can take.');
  const r = raw as Record<string, unknown>;
  const out: PostStyle = { ...current };
  const num = (key: 'textSize' | 'shadow' | 'bright' | 'shadowSoft' | 'shadowAngle' | 'shadowLength' | 'reflection' | 'reflectionSoft'
    | 'logoBright' | 'logoShadow' | 'logoOpacity' | 'bgBright' | 'bgBlur', min: number, max: number) => {
    const v = r[key];
    if (v === undefined) return;
    if (v === null) { delete out[key]; return; }
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new MediaRejected('That is not a look the post can take.');
    out[key] = Math.round(Math.min(max, Math.max(min, v)) * 100) / 100;
  };
  if (r.ink !== undefined) {
    if (r.ink === null) delete out.ink;
    else if (typeof r.ink === 'string' && INK.test(r.ink)) out.ink = r.ink.toLowerCase();
    else throw new MediaRejected('That is not a colour the headline can take.');
  }
  if (r.font !== undefined) {
    if (r.font === null) delete out.font;
    else if (typeof r.font === 'string' && HEADLINE_FONTS.some((f) => f.id === r.font)) out.font = r.font;
    else throw new MediaRejected('That is not a face the headline can be set in.');
  }
  if (r.backing !== undefined) {
    if (r.backing === null) delete out.backing;
    else if (r.backing === 'none' || r.backing === 'box') out.backing = r.backing;
    else throw new MediaRejected('That is not something the headline can stand on.');
  }
  if (r.backingInk !== undefined) {
    if (r.backingInk === null) delete out.backingInk;
    else if (typeof r.backingInk === 'string' && INK.test(r.backingInk)) out.backingInk = r.backingInk.toLowerCase();
    else throw new MediaRejected('That is not a colour the box can take.');
  }
  if (r.align !== undefined) {
    if (r.align === null) delete out.align;
    else if (typeof r.align === 'string' && ALIGN.has(r.align)) out.align = r.align as PostStyle['align'];
    else throw new MediaRejected('That is not a way the headline can line up.');
  }
  num('textSize', 0.6, 1.6);
  num('shadow', 0, 3);
  num('bright', -0.3, 0.3);
  num('shadowSoft', 0.2, 3);
  num('shadowAngle', -1.6, 1.6);
  num('shadowLength', 0.3, 3);
  num('reflection', 0, 2);
  num('reflectionSoft', 0, 3);
  num('logoBright', -0.4, 0.4);
  num('logoShadow', 0, 2);
  num('logoOpacity', 0.15, 1);
  num('bgBright', -0.5, 0.5);
  num('bgBlur', 0, 1);
  // Back to as the layout has it: nothing to keep.
  if (out.textSize === 1) delete out.textSize;
  if (out.shadow === 1) delete out.shadow;
  if (out.bright === 0) delete out.bright;
  if (out.shadowSoft === 1) delete out.shadowSoft;
  if (out.shadowLength === 1) delete out.shadowLength;
  if (out.reflection === 1) delete out.reflection;
  if (out.reflectionSoft === 0) delete out.reflectionSoft;
  if (out.logoBright === 0) delete out.logoBright;
  if (out.logoShadow === 0) delete out.logoShadow;
  if (out.logoOpacity === 1) delete out.logoOpacity;
  if (out.bgBright === 0) delete out.bgBright;
  if (out.bgBlur === 0) delete out.bgBlur;
  return out;
}

/** One dragged piece, checked: numbers, on the post, a sensible size. */
function placementOf(piece: 'bottle' | 'logo' | 'text' | 'shadow' | 'reflection', raw: unknown) {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const num = (key: string, min: number, max: number) => {
    const v = r[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new MediaRejected('That is not a place the layers can go.');
    return Math.min(max, Math.max(min, v));
  };
  // Turned: kept between -180 and 180, and none at all when it is all but upright.
  const turned = (v: number) => { const d = ((((v + 180) % 360) + 360) % 360) - 180; return Math.abs(d) < 0.5 ? 0 : Math.round(d * 10) / 10; };
  if (piece === 'bottle') {
    const rotate = r.rotate === undefined ? 0 : turned(num('rotate', -720, 720));
    return { cx: num('cx', -0.2, 1.2), base: num('base', 0.1, 1.3), height: num('height', 0.08, 1.2), ...(rotate ? { rotate } : {}) };
  }
  if (piece === 'shadow' || piece === 'reflection') return { dx: num('dx', -1, 1), dy: num('dy', -1, 1), scale: num('scale', 0.2, 4), rotate: turned(num('rotate', -720, 720)) };
  if (piece === 'logo') {
    const rotate = r.rotate === undefined ? 0 : turned(num('rotate', -720, 720));
    return { x: num('x', -0.2, 1), y: num('y', -0.2, 1), w: num('w', 0.03, 0.8), ...(rotate ? { rotate } : {}) };
  }
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
  /** What measuring the post found to look at, when its layers were last set. */
  layerChecks?: (DesignCheck | string)[];
  /** The brief its background was painted from, to paint another. */
  scenePrompt?: string;
  /** Whether an earlier background is kept to go back to, and how many were made. */
  previousScene?: boolean;
  backgrounds?: number;
} & Record<string, unknown>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Found = { composed: Composed; recipe: PostRecipe; headline: HeadlineLine[]; key: string; width: number | null; height: number | null };

/**
 * Posts as this server last read or wrote them, by post. Used only when the
 * page says which arrangement it is looking at and it is this one - so a
 * save need not read the post first - and never across companies. Any other
 * time, the database is asked.
 */
const known = new Map<string, Found & { companyId: string }>();
const versionOf = (composed: Composed) => String(composed.arrangedAt ?? 'made');
function remember(scope: CompanyScope, generationId: string, found: Found) {
  known.delete(generationId);
  known.set(generationId, { ...found, companyId: scope.companyId });
  if (known.size > 30) known.delete(known.keys().next().value!);
}

async function composedOf(scope: CompanyScope, generationId: string, version?: string | null): Promise<Found> {
  // This company's, or not found - asked once: every trip to the database is a wait the person sees.
  if (!UUID.test(generationId)) throw new MediaNotFound();
  const held = known.get(generationId);
  if (version && held && held.companyId === scope.companyId && versionOf(held.composed) === version) return held;
  const [row] = await withCompanyScope(scope, (tx) => tx<{ composed: Composed | null; storage_path: string | null; width: number | null; height: number | null }[]>`
    select output_metadata->'composed' as composed, storage_path, width, height
      from media_generations where id = ${generationId} and company_id = ${scope.companyId}
  `);
  if (!row) throw new MediaNotFound();
  const composed = row.composed;
  if (!composed?.recipe || !composed.scene || !composed.headline?.length || !row?.storage_path) {
    throw new MediaRejected('This picture was made in one piece, so its parts cannot be moved. Make a new post to arrange it layer by layer.');
  }
  const found = { composed, recipe: composed.recipe, headline: composed.headline, key: row.storage_path, width: row.width, height: row.height };
  remember(scope, generationId, found);
  return found;
}

/**
 * A post's scene, held for a while once read: a person placing the pieces
 * sets the post again on every drop, and the scene never changes - fetching
 * it from storage each time was most of the wait.
 */
const scenes = new Map<string, Buffer>();
/** When a post's scene last changed: what it is kept under, here and on the server's disk. */
const sceneVersion = (composed: Composed) => String(composed.sceneAt ?? 'base');
async function keptScene(scope: CompanyScope, generationId: string, version: string): Promise<Buffer> {
  // By when it last changed: one painted again on another server is a new scene here too.
  const key = `${scope.companyId}:${generationId}:${version}`;
  const held = scenes.get(key);
  if (held) return held;
  const scene = await sceneOf(scope, generationId, version);
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
/**
 * The finished picture of each post, sent to storage one after another: the
 * studio draws from the layers, so the flat picture can follow the answer -
 * but a later arrangement must never be overwritten by an earlier one.
 */
const flatWrites = new Map<string, Promise<unknown>>();
function writeFlat(generationId: string, task: () => Promise<unknown>): Promise<unknown> {
  const next = (flatWrites.get(generationId) ?? Promise.resolve()).then(task, task);
  const kept = next.catch(() => undefined);
  flatWrites.set(generationId, kept);
  void kept.then(() => { if (flatWrites.get(generationId) === kept) flatWrites.delete(generationId); });
  return next;
}

export async function arrangePost(
  scope: CompanyScope,
  generationId: string,
  /** `version`: the arrangement the page is looking at, so the post need not be read again when it is the latest. */
  body: { choices?: unknown; lines?: unknown; version?: unknown },
  /**
   * Work that can finish after the answer is sent - the flat picture, which
   * the studio does not draw from. Given none, it is done before answering.
   */
  later?: (task: () => Promise<unknown>) => void,
): Promise<{ generation: MediaGenerationDTO; layers: LayerManifest; fresh: Partial<Record<LayerName, string>> }> {
  const { composed, recipe, headline: was, key } = await composedOf(scope, generationId, typeof body.version === 'string' ? body.version : null);
  const choices = choicesFrom(body.choices, currentChoices(recipe));
  const headline = body.lines === undefined ? was : headlineFrom(body.lines);
  const arranged: PostRecipe = { ...recipe, choices };

  // The flat picture is encoded only once it is to be stored - after the answer, when it can be.
  const post = await rebuildPost(scope, arranged, await keptScene(scope, generationId, sceneVersion(composed)), headline, { layers: true, flatLater: Boolean(later) });
  const arrangedAt = new Date().toISOString();
  // Only the layers that changed are sent; the background, never moved, stays where it is.
  const flat = () => writeFlat(generationId, async () => {
    const bytes = await post.flat();
    await putMediaAsset(key, bytes, 'image/png');
    await withCompanyScope(scope, async (tx) => {
      await tx`
        update media_generation_assets set file_size = ${bytes.byteLength}, width = ${post.width}, height = ${post.height}
         where generation_id = ${generationId} and company_id = ${scope.companyId} and storage_path = ${key}
      `;
      // The flat picture is this arrangement's now - and may be kept by a browser as that - unless a later one came first.
      if (later) {
        await tx`
          update media_generations
             set output_metadata = jsonb_set(output_metadata, '{composed,flatAt}', to_jsonb(${arrangedAt}::text))
           where id = ${generationId} and company_id = ${scope.companyId}
             and output_metadata->'composed'->>'arrangedAt' = ${arrangedAt}
        `;
      }
    });
  });
  const [, stored, layerChecks] = await Promise.all([
    later ? null : flat(),
    storeLayers(scope, generationId, post.layers!, composed.layerHashes, later),
    designChecks(post, choices),
  ]);
  if (later) later(flat);
  const layerHashes = stored.hashes;
  const next: Composed = {
    ...composed, recipe: arranged, headline, arrangedAt, layersAt: arrangedAt, layerBoxes: post.boxes, layerHashes, layerChecks,
    // Stored already when not left for later; otherwise marked once it is.
    flatAt: later ? undefined : arrangedAt,
  };
  // Kept, and the post read back as it now is, in the one transaction - sent together.
  const generation = await withCompanyScope(scope, async (tx) => {
    // Sent first, so the read after it sees it: a query goes when it is executed, in that order.
    const update = tx`
      update media_generations
         set width = ${post.width}, height = ${post.height},
             output_metadata = coalesce(output_metadata, '{}'::jsonb)
               || ${tx.json({ composed: next } as never)}
       where id = ${generationId} and company_id = ${scope.companyId}
    `.execute();
    const [, now] = await Promise.all([update, generationIn(tx, generationId)]);
    if (!now) throw new MediaNotFound();
    return now;
  });
  // Kept, so the next change to it need not read it back.
  remember(scope, generationId, { composed: next, recipe: arranged, headline, key, width: post.width, height: post.height });
  return {
    generation,
    layers: manifestOf(post.width, post.height, arrangedAt, choices, post.boxes, layerHashes, layerChecks),
    // The layers that changed, handed over with the answer, so the page shows them without asking again.
    fresh: Object.fromEntries((Object.entries(stored.changed) as [LayerName, Buffer][]).map(([n, b]) => [n, b.toString('base64')])),
  };
}

// --- the layers, one file each ---------------------------------------------------------

export const LAYER_NAMES = ['background', 'shadow', 'reflection', 'bottle', 'headline', 'texts', 'logo'] as const;
export type LayerName = (typeof LAYER_NAMES)[number];

const layerKey = (scope: CompanyScope, generationId: string, name: LayerName) =>
  mediaStorageKey(scope.companyId, generationId, `layer-${name}`, 'png');

/** A fully transparent picture, for a part the post does not have - one per size, made once. */
const empties = new Map<string, Promise<Buffer>>();
function emptyLayer(width: number, height: number): Promise<Buffer> {
  const key = `${width}x${height}`;
  let made = empties.get(key);
  if (!made) {
    made = import('@napi-rs/canvas').then(({ createCanvas }) => createCanvas(width, height).encode('png'));
    empties.set(key, made);
  }
  return made;
}

/** A PNG's size, read from its header rather than by opening the picture. */
const pngSize = (png: Buffer) => ({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) });

export type LayerHashes = Partial<Record<LayerName, string>>;

/**
 * Keeps a post's layers, and says what each holds. A layer the same as the
 * one already kept is not sent again: moving the logo leaves the background,
 * the bottle and the words as they were, and only the logo goes.
 */
async function storeLayers(
  scope: CompanyScope,
  generationId: string,
  layers: PostLayers,
  kept?: LayerHashes,
  /**
   * Given, the layers are sent to storage after the answer: the page is
   * handed the ones that changed with it, and does not fetch them.
   */
  later?: (task: () => Promise<unknown>) => void,
): Promise<{ hashes: LayerHashes; changed: Partial<Record<LayerName, Buffer>> }> {
  const { createHash } = await import('node:crypto');
  const size = pngSize(layers.background);
  const empty = await emptyLayer(size.width, size.height);
  const hashes: LayerHashes = {};
  const changed: Partial<Record<LayerName, Buffer>> = {};
  for (const name of LAYER_NAMES) {
    const bytes = layers[name] ?? empty;
    const hash = createHash('sha1').update(bytes).digest('hex').slice(0, 16);
    hashes[name] = hash;
    if (kept?.[name] === hash) continue;
    changed[name] = bytes;
    // Asked for straight after, it need not come back from storage.
    const at = `${scope.companyId}:${generationId}:${name}`;
    justSet.delete(at);
    justSet.set(at, { hash, bytes });
    if (justSet.size > 40) justSet.delete(justSet.keys().next().value!);
  }
  const send = () => writeFlat(generationId, () => Promise.all((Object.entries(changed) as [LayerName, Buffer][])
    .map(([name, bytes]) => putMediaAsset(layerKey(scope, generationId, name), bytes, 'image/png'))));
  if (later) later(send);
  else await send();
  return { hashes, changed };
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
  /** What a designer would point at, measured, each with its fix when it has one: nothing is spent. */
  checks: DesignCheck[];
};

function manifestOf(width: number, height: number, version: string, choices: PostChoices, boxes: PostBoxes, hashes?: LayerHashes, checks: (DesignCheck | string)[] = []): LayerManifest {
  return {
    width,
    height,
    version,
    layers: LAYER_NAMES.map((name) => ({
      name,
      present: name === 'background'
        || (name === 'texts' ? Boolean(choices.texts?.length)
          : name === 'headline' ? choices.headline !== 'none' : name === 'logo' ? choices.logo !== 'none' : choices.bottle !== 'none'),
      v: hashes?.[name] ?? version,
    })),
    boxes,
    choices,
    checks: checks.map((c) => (typeof c === 'string' ? { text: c } : c)),
  };
}

/**
 * The layers of a post as they stand, made once from its scene for a post
 * whose layers were never kept - and kept, so the next look is a read.
 * What the page draws a post from, layer over layer.
 */
export async function postLayers(scope: CompanyScope, generationId: string): Promise<LayerManifest> {
  const { composed, recipe, headline, width, height, key } = await composedOf(scope, generationId);
  const version = String(composed.arrangedAt ?? 'made');
  const choices = currentChoices(recipe);
  // Set again, too, for a post kept before its shadow could be grabbed: once, and then read.
  const boxes = composed.layerBoxes;
  if (composed.layersAt !== version || !boxes || (boxes.bottle && !("reflectionPivot" in boxes))) {
    const post = await rebuildPost(scope, { ...recipe, choices }, await keptScene(scope, generationId, sceneVersion(composed)), headline, { layers: true });
    // The flat post too: an arrangement set without its pictures (put back by hand, say) is caught up whole.
    const [{ hashes }, checks] = await Promise.all([
      storeLayers(scope, generationId, post.layers!),
      designChecks(post, choices),
      composed.arrangedAt ? putMediaAsset(key, post.bytes, 'image/png') : null,
    ]);
    await withCompanyScope(scope, (tx) => tx`
      update media_generations
         set output_metadata = coalesce(output_metadata, '{}'::jsonb)
           || ${tx.json({ composed: { ...composed, layersAt: version, ...(composed.arrangedAt ? { flatAt: version } : {}), layerBoxes: post.boxes, layerHashes: hashes, layerChecks: checks } } as never)}
       where id = ${generationId} and company_id = ${scope.companyId}
    `);
    known.delete(generationId);
    return manifestOf(post.width, post.height, version, choices, post.boxes, hashes, checks);
  }
  return manifestOf(width ?? 1080, height ?? 1080, version, choices, boxes, composed.layerHashes, composed.layerChecks ?? []);
}

/**
 * One layer's picture - straight from memory when it was just set here - and
 * whether it is the very version asked for. One still on its way to storage
 * is not: the stored one is sent, but must not be kept under the new version.
 */
export async function layerFile(scope: CompanyScope, generationId: string, name: string, v?: string | null): Promise<{ bytes: Buffer; exact: boolean }> {
  if (!(LAYER_NAMES as readonly string[]).includes(name)) throw new MediaRejected('There is no such layer.');
  await composedOf(scope, generationId);
  const fresh = justSet.get(`${scope.companyId}:${generationId}:${name}`);
  if (fresh && v && fresh.hash === v) return { bytes: fresh.bytes, exact: true };
  const key = layerKey(scope, generationId, name as LayerName);
  const { createHash } = await import('node:crypto');
  const holds = (b: Buffer) => createHash('sha1').update(b).digest('hex').slice(0, 16) === v;
  if (v) {
    // Kept on this server under its hash: read from storage once, then from here.
    const kept = await getMediaAsset(key, `layer:${v}`);
    if (holds(kept)) return { bytes: kept, exact: true };
    // Not that version yet - still on its way, from another server: let go of it, and send what is there.
    await forgetMediaAsset(key, `layer:${v}`);
    return { bytes: kept, exact: false };
  }
  return { bytes: await getMediaAsset(key), exact: false };
}

/** The other shapes a post can be taken away in, from the same background. */
export const EXPORT_SHAPES: Record<string, number> = {
  '1:1': 1, '4:5': 0.8, '9:16': 9 / 16, '16:9': 16 / 9,
  // What Radico's briefs ask for besides posts: A-size posters (A2, A3 - one shape), a standee,
  // a billboard, Jumia's banners and a shelf unit's panels.
  '1:1.414': 1 / Math.SQRT2, '1:2': 0.5, '4:3': 4 / 3, '5:1': 5, '720:261': 720 / 261, '41:16': 41 / 16, '18:60': 18 / 60,
};

/**
 * The post as a file an editor opens, every part on its own layer. Nothing is
 * spent. In another shape it is laid out again for that shape on the same
 * background - the bottle's side, the logo's corner and the words kept, the
 * exact spots a person dragged them to left to the layout, since a spot on a
 * square is not the same spot on a story.
 */
export async function exportLayers(scope: CompanyScope, generationId: string, format: ExportFormat, shape?: string | null): Promise<Buffer> {
  const { recipe, headline, composed } = await composedOf(scope, generationId);
  const choices = currentChoices(recipe);
  const ratio = shape ? EXPORT_SHAPES[shape] : undefined;
  const other = ratio !== undefined && Math.abs(ratio - recipe.ratio) > 0.01;
  const arranged: PostRecipe = other
    ? { ...recipe, ratio: ratio!, choices: { ...sidesOf(choices), place: undefined } }
    : { ...recipe, choices };
  const post = await rebuildPost(scope, arranged, await keptScene(scope, generationId, sceneVersion(composed)), headline, { layers: true });
  return exportPost({ bytes: post.bytes, width: post.width, height: post.height, layers: post.layers! }, format);
}

/**
 * The side and corner a person dragged the pieces to, as the presets a post
 * of another shape is laid out from: a bottle dropped on the left stays on the
 * left, a logo dragged to the top right stays there.
 */
export function sidesOf(choices: PostChoices): PostChoices {
  const p = choices.place;
  const bottle = p?.bottle && choices.bottle !== 'none'
    ? (p.bottle.cx < 0.4 ? 'left' : p.bottle.cx > 0.6 ? 'right' : 'center')
    : choices.bottle;
  const logo = p?.logo && choices.logo !== 'none'
    ? (`${p.logo.y + 0.05 < 0.5 ? 'top' : 'bottom'}-${p.logo.x + p.logo.w / 2 < 0.5 ? 'left' : 'right'}` as Corner)
    : choices.logo;
  return { ...choices, bottle, logo };
}

// --- what to look at, before it goes out -----------------------------------------------

/**
 * What a designer would point at on a post, found by measuring it rather than
 * by asking a model: a logo too small to read on a phone, a piece against or
 * past the edge, the words over the bottle or the logo, and words hard to read
 * on the background behind them. Nothing is spent.
 */
export type DesignCheck = {
  text: string;
  /**
   * The change that puts it right, ready to send as it is - what a designer
   * would do: move the piece in, make the logo bigger, take the words off the
   * bottle, give the headline a colour that reads. Absent when there is no one obvious fix.
   */
  fix?: { choices: Record<string, unknown> };
};

/** How far in from each edge a piece is put back: the margin the studio's guides show. */
const SAFE = 0.05;
type Frac = { x: number; y: number; w: number; h: number };

export async function designChecks(
  post: { width: number; height: number; boxes: PostBoxes; layers?: PostLayers },
  /** The choices it was set with: a fix for the words keeps their size. */
  choices?: PostChoices,
): Promise<DesignCheck[]> {
  const out: DesignCheck[] = [];
  const { bottle, logo, text } = post.boxes;
  const name = { bottle: 'bottle', logo: 'logo', text: 'headline' } as const;
  // Margins and sizes in shares of the short side, across and down: on a square post these are the
  // shares of the post they always were; on a banner, 3% of its width would be a third of its height.
  const short = Math.min(post.width, post.height);
  const sx = short / post.width;
  const sy = short / post.height;
  // Along one side, kept inside the margin - or as near as a piece that big can be.
  const inside = (v: number, size: number) => (size >= 1 - 2 * SAFE ? SAFE : Math.min(1 - SAFE - size, Math.max(SAFE, v)));
  const placed = (piece: 'bottle' | 'logo' | 'text', b: Frac, x: number, y: number) => {
    if (piece === 'logo') return { place: { logo: { x, y, w: b.w } } };
    if (piece === 'text') {
      const anchor = post.boxes.textAnchor?.x ?? b.x;
      return { place: { text: { x: anchor + (x - b.x), y, scale: choices?.place?.text?.scale ?? 1 } } };
    }
    // A bottle stands where it stood; only its top is kept off the edge.
    const top = Math.max(SAFE, b.y);
    return { place: { bottle: { cx: x + b.w / 2, base: b.y + b.h, height: b.y + b.h - top } } };
  };
  if (logo && logo.w < 0.07 * sx) {
    const w = 0.1 * sx;
    const h = logo.h * (w / logo.w);
    out.push({
      text: 'The logo is small - it may not read on a phone. Pull its corner to make it bigger.',
      fix: { choices: { place: { logo: { x: inside(logo.x, w), y: inside(logo.y, h), w } } } },
    });
  }
  for (const [piece, b] of [['bottle', bottle], ['logo', logo], ['text', text]] as const) {
    if (!b) continue;
    const fix = { choices: placed(piece, b, inside(b.x, b.w), piece === 'bottle' ? b.y : inside(b.y, b.h)) };
    const outside = b.x < -0.005 || b.y < -0.005 || b.x + b.w > 1.005 || (piece !== 'bottle' && b.y + b.h > 1.005);
    if (outside) { out.push({ text: `Part of the ${name[piece]} is outside the post and will be cut off.`, fix }); continue; }
    const tight = b.x < 0.03 * sx || b.y < 0.03 * sy || b.x + b.w > 1 - 0.03 * sx || (piece !== 'bottle' && b.y + b.h > 1 - 0.03 * sy);
    if (tight) out.push({ text: `The ${name[piece]} is very close to the edge - some screens may cut it. Move it in a little.`, fix });
  }
  const overlap = (a: typeof text, b: typeof text) => {
    if (!a || !b) return 0;
    const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    return w > 0 && h > 0 ? (w * h) / Math.max(1e-6, Math.min(a.w * a.h, b.w * b.h)) : 0;
  };
  // The corner of the post farthest from a piece: where the logo goes to be out of its way.
  const awayFrom = (b: Frac): Corner => `${b.y + b.h / 2 < 0.5 ? 'bottom' : 'top'}-${b.x + b.w / 2 < 0.5 ? 'right' : 'left'}` as Corner;
  if (text && bottle && overlap(text, bottle) > 0.08) {
    // The words to the other side of the bottle, when they fit there.
    const right = bottle.x + bottle.w / 2 < 0.5;
    const x = right ? bottle.x + bottle.w + 0.03 : SAFE;
    const fits = right ? x + text.w <= 1 - SAFE + 0.001 : x + text.w <= bottle.x - 0.03;
    out.push({ text: 'The headline runs over the bottle. Move one of them.', ...(fits ? { fix: { choices: placed('text', text, x, text.y) } } : {}) });
  }
  if (text && logo && overlap(text, logo) > 0.05) out.push({ text: 'The headline touches the logo. Move one of them.', fix: { choices: { logo: awayFrom(text) } } });
  if (logo && bottle && overlap(logo, bottle) > 0.1) out.push({ text: 'The logo sits on the bottle. Move one of them.', fix: { choices: { logo: awayFrom(bottle) } } });
  // Each line's colour against what is behind it.
  if (post.layers?.lines.length) {
    const { createCanvas, loadImage } = await import('@napi-rs/canvas');
    const bg = await loadImage(post.layers.background);
    const k = Math.min(1, 360 / Math.max(bg.width, bg.height));
    const small = createCanvas(Math.max(1, Math.round(bg.width * k)), Math.max(1, Math.round(bg.height * k)));
    const c = small.getContext('2d');
    c.drawImage(bg, 0, 0, small.width, small.height);
    let worst = Infinity;
    let behindWorst = 0.5;
    for (const line of post.layers.lines) {
      if (line.boxFill) continue; // set on its own box: it reads on that
      const x = Math.max(0, Math.floor(line.box.x * k));
      const y = Math.max(0, Math.floor(line.box.y * k));
      const w = Math.min(small.width - x, Math.max(1, Math.ceil(line.box.w * k)));
      const h = Math.min(small.height - y, Math.max(1, Math.ceil(line.box.h * k)));
      if (w <= 0 || h <= 0) continue;
      const data = c.getImageData(x, y, w, h).data;
      let sum = 0; let n = 0;
      for (let i = 0; i < data.length; i += 4) { sum += lum(data[i]!, data[i + 1]!, data[i + 2]!); n++; }
      const behind = n ? sum / n : 0.5;
      const ink = hexLum(line.colour);
      if (ink === null) continue;
      const contrast = (Math.max(ink, behind) + 0.05) / (Math.min(ink, behind) + 0.05);
      if (contrast < worst) { worst = contrast; behindWorst = behind; }
    }
    if (worst < 2.5) {
      // White on what is dark, near-black on what is light: whichever reads better there.
      const ink = (1 + 0.05) / (behindWorst + 0.05) >= (behindWorst + 0.05) / (hexLum('#141414')! + 0.05) ? '#ffffff' : '#141414';
      out.push({ text: 'Part of the headline is hard to read on the background behind it. Move it to a calmer, darker or lighter part.', fix: { choices: { style: { ink } } } });
    }
  }
  return out;
}

const channel = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
const lum = (r: number, g: number, b: number) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
function hexLum(hex: string): number | null {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex);
  return m ? lum(parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)) : null;
}

// --- other headlines --------------------------------------------------------------------

/** Other headlines to try on a post - its words broken another way, the brand's own - for nothing. */
export async function headlineOptions(scope: CompanyScope, generationId: string) {
  const { recipe, headline } = await composedOf(scope, generationId);
  const roles = new Set((recipe.spec.text?.lines ?? []).map((l) => l.role));
  if (!roles.size) roles.add('lead');
  // The colours the headline may take come with them: the brand's own, read once the step opens.
  const [options, inks] = await Promise.all([headlineSuggestions(scope, recipe.brand, headline, roles), headlineInks(scope, recipe)]);
  // The faces to choose from, and which are set from the brand's own files rather than a free stand-in.
  const fonts = HEADLINE_FONTS.map((f) => ({ id: f.id, label: f.label, own: headlineFontIsOwn(f.id) }));
  return { options, inks, fonts };
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
/** How carefully a new background is painted: the person's choice, each costing more than the last. */
export const BACKGROUND_QUALITIES = ['standard', 'better', 'best'] as const;
export type BackgroundQuality = (typeof BACKGROUND_QUALITIES)[number];

/** A quality in the provider's own words: OpenAI's low/medium/high, Gemini's sizes. */
export function providerQuality(sizes: readonly string[], quality: BackgroundQuality): string | undefined {
  if (quality === 'standard') return undefined;
  const wanted = quality === 'best' ? ['high', '2K'] : ['medium', '1K'];
  return wanted.find((s) => sizes.includes(s));
}

export async function newBackground(scope: CompanyScope, generationId: string, raw: unknown, quality?: unknown): Promise<MediaGenerationDTO> {
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
    // A background is painted at the least it costs, whatever the post was first made at.
    imageSize: quality === undefined ? undefined : (BACKGROUND_QUALITIES as readonly unknown[]).includes(quality)
      ? providerQuality(provider.imageSizes, quality as BackgroundQuality)
      : undefined,
  });
  const scene = made.assets[0]?.bytes;
  if (!scene) throw new MediaRejected('No background came back. Nothing was changed.');

  // The old one kept to go back to, then the new one in its place - marked with when, so no server keeps the old.
  const was = await keptScene(scope, generationId, sceneVersion(composed));
  await putMediaAsset(mediaStorageKey(scope.companyId, generationId, 'scene-previous', 'png'), was, 'image/png');
  await keepScene(scope, generationId, scene);
  const sceneAt = new Date().toISOString();
  scenes.set(`${scope.companyId}:${generationId}:${sceneAt}`, scene);

  return setOnScene(scope, generationId, { composed, recipe, headline, key }, scene, {
    sceneAt,
    backgrounds: Number(composed.backgrounds ?? 1) + 1,
    backgroundNote: note || null,
    previousScene: true,
  });
}

/** The most a picture brought in as a background may weigh, and the longest side it is kept at. */
export const OWN_BACKGROUND_MAX_BYTES = 15 * 1024 * 1024;
const OWN_BACKGROUND_SIDE = 2048;

/**
 * A picture the person brought, as the post's background: the bottle, the
 * logo and the words set on it just where they were. No model is asked
 * anything and nothing is spent. The background it replaces is kept, so the
 * one before is a click away.
 */
export async function ownBackground(scope: CompanyScope, generationId: string, picture: { bytes: Buffer; mimeType: string }): Promise<MediaGenerationDTO> {
  const found = await composedOf(scope, generationId);
  const scene = await pictureForPost(picture, found.recipe.ratio);

  // The old one kept to go back to, then this one in its place - marked with when, so no server keeps the old.
  const was = await keptScene(scope, generationId, sceneVersion(found.composed));
  await putMediaAsset(mediaStorageKey(scope.companyId, generationId, 'scene-previous', 'png'), was, 'image/png');
  await keepScene(scope, generationId, scene);
  const sceneAt = new Date().toISOString();
  scenes.set(`${scope.companyId}:${generationId}:${sceneAt}`, scene);

  return setOnScene(scope, generationId, found, scene, {
    sceneAt,
    backgrounds: Number(found.composed.backgrounds ?? 1) + 1,
    backgroundNote: null,
    ownBackground: true,
    previousScene: true,
  });
}

/**
 * A picture the person brought, ready to be a post's background: checked,
 * read, cut to the post's shape from its middle and kept no bigger than a
 * post needs, as a PNG like every scene.
 */
export async function pictureForPost(picture: { bytes: Buffer; mimeType: string }, ratio: number): Promise<Buffer> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(picture.mimeType)) {
    throw new MediaRejected('Bring a PNG, JPG or WebP picture for the background.');
  }
  if (picture.bytes.byteLength === 0) throw new MediaRejected('That picture is empty.');
  if (picture.bytes.byteLength > OWN_BACKGROUND_MAX_BYTES) throw new MediaRejected('That picture is over 15 MB. Bring a smaller one.');
  const { createCanvas, loadImage } = await import('@napi-rs/canvas');
  const img = await loadImage(picture.bytes).catch(() => null);
  if (!img || img.width < 200 || img.height < 200) throw new MediaRejected('That picture could not be read, or is too small to be a background.');
  // Cut to the post's shape from its middle, as a designer would place a photo: all of it
  // sharp, none of it stretched or filled out softly the way a painted scene of another shape is.
  const cw = Math.min(img.width, img.height * ratio);
  const ch = cw / ratio;
  const k = Math.min(1, OWN_BACKGROUND_SIDE / Math.max(cw, ch));
  const c = createCanvas(Math.round(cw * k), Math.round(ch * k));
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, (img.width - cw) / 2, (img.height - ch) / 2, cw, ch, 0, 0, c.width, c.height);
  return c.encode('png');
}

/** Back to the background before the newest one - and the newest kept, to swap back. Nothing is spent. */
export async function previousBackground(scope: CompanyScope, generationId: string): Promise<MediaGenerationDTO> {
  const found = await composedOf(scope, generationId);
  if (!found.composed.previousScene) throw new MediaRejected('There is no earlier background for this post.');
  const before = await getMediaAsset(mediaStorageKey(scope.companyId, generationId, 'scene-previous', 'png'));
  const now = await keptScene(scope, generationId, sceneVersion(found.composed));
  await putMediaAsset(mediaStorageKey(scope.companyId, generationId, 'scene-previous', 'png'), now, 'image/png');
  await keepScene(scope, generationId, before);
  const sceneAt = new Date().toISOString();
  scenes.set(`${scope.companyId}:${generationId}:${sceneAt}`, before);
  return setOnScene(scope, generationId, found, before, { sceneAt });
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
  const [, { hashes: layerHashes }, layerChecks] = await Promise.all([
    putMediaAsset(key, post.bytes, 'image/png'),
    storeLayers(scope, generationId, post.layers!, composed.layerHashes),
    designChecks(post, arranged.choices),
  ]);
  const arrangedAt = new Date().toISOString();
  await withCompanyScope(scope, (tx) => tx`
    update media_generations
       set output_metadata = coalesce(output_metadata, '{}'::jsonb)
         || ${tx.json({ composed: { ...composed, ...extra, recipe: arranged, headline, arrangedAt, layersAt: arrangedAt, flatAt: arrangedAt, layerBoxes: post.boxes, layerHashes, layerChecks } } as never)}
     where id = ${generationId} and company_id = ${scope.companyId}
  `);
  known.delete(generationId);
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
