import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas, loadImage } from '@napi-rs/canvas';

/**
 * A post put together from its parts: the scene at the size asked for, the
 * real bottle and the words where the layout puts them, the logo version that
 * reads against its corner.
 */

process.env.DATABASE_URL ??= 'postgres://unused@localhost:5432/unused';
const { buildPost, colourName, generationShape, inGenerated, postSize, scenePrompt } = await import('../src/server/media/composePost');
const { DEFAULT_LAYOUT } = await import('../src/server/brain/bench');
const { fitLayout } = await import('../src/server/brain/layouts');

const png = (w: number, h: number, paint: (ctx: ReturnType<ReturnType<typeof createCanvas>['getContext']>) => void) => {
  const c = createCanvas(w, h);
  paint(c.getContext('2d'));
  return c.toBuffer('image/png');
};
const plan = {
  headline: [{ text: 'happy new year', role: 'lead' as const }, { text: 'raise a toast', role: 'key' as const }],
  casing: 'sentence' as const,
  keep: [],
  scene: { description: 'A polished bar at night.', mood: 'warm', light: 'left' as const, surface: 'gloss' as const },
};

describe('sizes and shapes', () => {
  it('delivers 1080 on the short side', () => {
    assert.deepEqual(postSize(1), { width: 1080, height: 1080 });
    assert.deepEqual(postSize(0.8), { width: 1080, height: 1350 });
    assert.deepEqual(postSize(9 / 16), { width: 1080, height: 1920 });
    assert.deepEqual(postSize(16 / 9), { width: 1920, height: 1080 });
  });

  it('generates the shape that loses least to the crop', () => {
    const offered = ['1:1', '3:2', '2:3'];
    assert.equal(generationShape(0.8, offered).label, '2:3');
    assert.equal(generationShape(9 / 16, offered).label, '2:3');
    assert.equal(generationShape(16 / 9, offered).label, '3:2');
    assert.equal(generationShape(1, offered).label, '1:1');
  });

  it('tells the generator places in its own frame, which the post is a centred crop of', () => {
    // A 9:16 story cut from a 2:3 frame keeps the middle 84% of its width.
    const box = inGenerated({ x: 0, y: 0.5, w: 1, h: 0.25 }, 9 / 16, 2 / 3);
    assert.ok(Math.abs(box.x - 0.078125) < 1e-9 && Math.abs(box.w - 0.84375) < 1e-9 && box.y === 0.5);
  });
});

describe('the scene brief', () => {
  it('keeps the bottle\'s spot, the words\' ground and the logo\'s corner clear, and asks for no bottle or words', () => {
    const prompt = scenePrompt(plan, fitLayout(DEFAULT_LAYOUT, 1), 1, 1);
    assert.match(prompt, /A polished bar at night/);
    assert.match(prompt, /clear spot on the polished surface right of centre/);
    assert.match(prompt, /is for words: calm, uncluttered, out of focus and evenly dark/);
    assert.match(prompt, /top right corner plain/);
    assert.match(prompt, /no bottles, packaging or labels anywhere, and no text/);
  });
});

describe('the craft in the scene brief', () => {
  it('names the pack\'s colours as a photographer would, and asks for a scene that flatters them', () => {
    assert.equal(colourName('#5a2d0c'), 'deep brown');
    assert.equal(colourName('#d08a2a'), 'amber');
    assert.equal(colourName('#c9a227'), 'gold');
    assert.equal(colourName('#1b2a4a'), 'navy blue');
    assert.equal(colourName('#f5f5f2'), 'white');
    const prompt = scenePrompt(plan, fitLayout(DEFAULT_LAYOUT, 1), 1, 1, ['#5a2d0c', '#c9a227']);
    assert.match(prompt, /product's own colours are deep brown, gold/);
    assert.match(prompt, /85mm lens/);
    assert.match(prompt, /Balance:/);
  });
});

describe('putting the post together', () => {
  const scene = png(1024, 1536, (ctx) => { ctx.fillStyle = '#e8e0d0'; ctx.fillRect(0, 0, 1024, 1536); });
  const bottle = png(200, 600, (ctx) => { ctx.fillStyle = '#7a3c10'; ctx.fillRect(50, 20, 100, 560); });
  const logo = (colour: string) => png(300, 200, (ctx) => { ctx.fillStyle = colour; ctx.fillRect(0, 0, 300, 200); });
  const asset = (tone: 'light' | 'dark') => ({ tone, bbox: [0, 0, 1, 1] as [number, number, number, number], width: 300, height: 200 });

  it('crops the scene to the post, stands the bottle and sets the words where the layout says', async () => {
    const layout = fitLayout(DEFAULT_LAYOUT, 0.8, 1 / 3, 2 / 3);
    const post = await buildPost({ scene, ratio: 0.8, layout, plan, bottle, logos: [] });
    assert.equal(post.width, 1080);
    assert.equal(post.height, 1350);
    const img = await loadImage(post.bytes);
    const ctx = createCanvas(img.width, img.height).getContext('2d');
    ctx.drawImage(img, 0, 0);
    const b = layout.bottleBox!;
    const [r, g] = ctx.getImageData(Math.round((b.x + b.w / 2) * 1080), Math.round((b.y + b.h / 2) * 1350), 1, 1).data;
    assert.ok(r! < 200 && g! < 150, 'no bottle where the layout stands it');
  });

  it('puts the logo version that reads: dark on a light corner', async () => {
    const layout = fitLayout(DEFAULT_LAYOUT, 1, 1 / 3, 2 / 3);
    const post = await buildPost({
      scene, ratio: 1, layout, plan, bottle: null,
      logos: [{ name: 'white', bytes: logo('#ffffff'), asset: asset('light') }, { name: 'black', bytes: logo('#000000'), asset: asset('dark') }],
    });
    assert.equal(post.logo, 'black');
  });

  it('shades the corner behind a logo that has no version to read against it, and leaves the logo as it is', async () => {
    const layout = fitLayout(DEFAULT_LAYOUT, 1, 1 / 3, 2 / 3);
    const post = await buildPost({ scene, ratio: 1, layout, plan, bottle: null, logos: [{ name: 'white', bytes: logo('#ffffff'), asset: asset('light') }] });
    const img = await loadImage(post.bytes);
    const ctx = createCanvas(img.width, img.height).getContext('2d');
    ctx.drawImage(img, 0, 0);
    const box = layout.logoBox!;
    const [inside] = ctx.getImageData(Math.round((box.x + box.w / 2) * 1080), Math.round((box.y + 0.01) * 1080), 1, 1).data;
    assert.equal(inside, 255, 'the logo was changed');
    const [beside] = ctx.getImageData(Math.round((box.x - 0.01) * 1080), Math.round((box.y + 0.02) * 1080), 1, 1).data;
    assert.ok(beside! < 200, 'no shade behind the logo');
  });
});
