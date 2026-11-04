import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { readPsd } from 'ag-psd';

/**
 * A post arranged layer by layer: the bottle and logo where a person puts
 * them, the words moved to the side the bottle leaves, and the post handed
 * over as an editor's file with every part on its own layer.
 */

process.env.DATABASE_URL ??= 'postgres://unused@localhost:5432/unused';
const { buildPost, scenePrompt } = await import('../src/server/media/composePost');
const { exportPost } = await import('../src/server/media/layeredExport');
const { choicesFrom } = await import('../src/server/media/arrange');
const { DEFAULT_LAYOUT } = await import('../src/server/brain/bench');
const { arrangeLayout, choicesOf, fitLayout, placeLayout } = await import('../src/server/brain/layouts');

const png = (w: number, h: number, colour: string, box?: [number, number, number, number]) => {
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = colour;
  ctx.fillRect(...(box ?? [0, 0, w, h]));
  return c.toBuffer('image/png');
};
const plan = {
  headline: [{ text: 'lights of diwali', role: 'lead' as const }, { text: 'golden as honey', role: 'key' as const }],
  casing: 'sentence' as const,
  keep: [],
  scene: { description: 'A warm room at dusk, diyas on the sill.', mood: 'warm', light: 'left' as const, surface: 'matte' as const },
};

describe('arranging the layers', () => {
  it('reads the places a layout already makes', () => {
    assert.deepEqual(choicesOf(DEFAULT_LAYOUT), { bottle: 'right', size: 'large', logo: 'top-right' });
  });

  it('puts the words on the side the bottle leaves, and above it when it stands in the middle', () => {
    const left = fitLayout(arrangeLayout(DEFAULT_LAYOUT, { bottle: 'left', size: 'medium', logo: 'top-right' }), 1);
    assert.ok(left.bottleBox!.x + left.bottleBox!.w < left.textBox!.x, 'the words did not move right of the bottle');

    const right = fitLayout(arrangeLayout(DEFAULT_LAYOUT, { bottle: 'right', size: 'medium', logo: 'top-left' }), 1);
    assert.ok(right.textBox!.x + right.textBox!.w < right.bottleBox!.x, 'the words did not stay left of the bottle');
    assert.equal(right.logo!.corner, 'top-left');

    const centre = fitLayout(arrangeLayout(DEFAULT_LAYOUT, { bottle: 'center', size: 'medium', logo: 'top-left' }), 1);
    const b = centre.bottleBox!;
    assert.ok(Math.abs(b.x + b.w / 2 - 0.5) < 0.02, 'the bottle left the middle');
    assert.ok(centre.textBox!.y + centre.textBox!.h < b.y, 'the words are not above the bottle');
  });

  it('leaves out a bottle or a logo that is not wanted, and sizes the bottle as asked', () => {
    const none = arrangeLayout(DEFAULT_LAYOUT, { bottle: 'none', size: 'medium', logo: 'none' });
    assert.equal(none.bottle, null);
    assert.equal(none.logo, null);
    const small = arrangeLayout(DEFAULT_LAYOUT, { bottle: 'left', size: 'small', logo: 'top-right' }).bottle!.height;
    const large = arrangeLayout(DEFAULT_LAYOUT, { bottle: 'left', size: 'large', logo: 'top-right' }).bottle!.height;
    assert.ok(large > small);
  });

  it('takes only places the layers can go, keeping what was not sent', () => {
    const was = { bottle: 'right', size: 'medium', logo: 'top-right' } as const;
    assert.deepEqual(choicesFrom({ bottle: 'left' }, was), { ...was, bottle: 'left' });
    assert.throws(() => choicesFrom({ bottle: 'upside down' }, was), /not a place/);
    assert.throws(() => choicesFrom({ logo: 'middle' }, was), /not a place/);
  });
});

describe('a background for any arrangement', () => {
  it('asks for the surface clear across the whole frame rather than at one spot', () => {
    const prompt = scenePrompt(plan, fitLayout(DEFAULT_LAYOUT, 1), 1, 1, [], { open: true });
    assert.match(prompt, /runs level across the whole width/);
    assert.match(prompt, /left, centre or right/);
    assert.match(prompt, /All four corners plain/);
    assert.doesNotMatch(prompt, /clear spot on the/);
    assert.match(prompt, /no health warning/);
  });
});

describe('the post as an editor\'s file', async () => {
  const scene = png(1024, 1024, '#3a2a1c');
  const bottle = png(200, 600, '#c98a1a', [50, 20, 100, 560]);
  const logo = png(300, 200, '#ffffff');
  const layout = fitLayout(arrangeLayout(DEFAULT_LAYOUT, { bottle: 'left', size: 'medium', logo: 'top-right' }), 1, 1 / 3, 2 / 3);
  const post = await buildPost({
    scene, ratio: 1, layout, plan, bottle,
    logos: [{ name: 'white', bytes: logo, asset: { tone: 'light', bbox: [0, 0, 1, 1], width: 300, height: 200 } }],
    layers: true,
  });
  const file = { bytes: post.bytes, width: post.width, height: post.height, layers: post.layers! };

  it('builds the same post from its layers', async () => {
    const layers = post.layers!;
    const flat = createCanvas(post.width, post.height);
    const ctx = flat.getContext('2d');
    for (const part of [layers.background, layers.shadow, layers.bottle, layers.headline, layers.logo]) {
      if (part) ctx.drawImage(await loadImage(part), 0, 0);
    }
    const made = createCanvas(post.width, post.height);
    made.getContext('2d').drawImage(await loadImage(post.bytes), 0, 0);
    const a = ctx.getImageData(0, 0, post.width, post.height).data;
    const b = made.getContext('2d').getImageData(0, 0, post.width, post.height).data;
    let off = 0;
    for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i]! - b[i]!) > 3) off += 1;
    assert.ok(off / (a.length / 4) < 0.002, `${off} pixels differ`);
    assert.deepEqual(layers.lines.map((l) => l.text), ['Lights of Diwali', 'Golden as honey']);
  });

  it('hands Photoshop every part on its own layer, and each line as live text', async () => {
    const bytes = await exportPost(file, 'psd');
    const psd = readPsd(new Uint8Array(bytes).buffer, { skipLayerImageData: true, skipCompositeImageData: true, skipThumbnail: true });
    assert.deepEqual(psd.children!.map((l) => l.name), ['Background', 'Bottle shadow', 'Bottle', 'Headline', 'Logo']);
    const words = psd.children!.find((l) => l.name === 'Headline')!.children!;
    assert.deepEqual(words.map((l) => l.text?.text).sort(), ['Golden as honey', 'Lights of Diwali']);
  });

  it('hands Illustrator the parts as layers and the words as text', async () => {
    const svg = (await exportPost(file, 'svg')).toString('utf8');
    for (const id of ['Background', 'Bottle-shadow', 'Bottle', 'Headline', 'Logo']) assert.match(svg, new RegExp(`<g id="${id}">`));
    assert.match(svg, /<text id="headline-1"[^>]*>Lights of Diwali<\/text>/);
    assert.match(svg, /xlink:href="data:image\/png;base64,/);
  });

  it('makes a one-page PDF at the post\'s size', async () => {
    const pdf = await exportPost(file, 'pdf');
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  });
});

describe('where the layers are kept', async () => {
  const { assertSafeKey } = await import('../src/server/drive/storage');
  const { mediaStorageKey } = await import('../src/server/media/storage');
  const { LAYER_NAMES } = await import('../src/server/media/arrange');
  const company = '11111111-1111-4111-8111-111111111111';
  const generation = '22222222-2222-4222-8222-222222222222';

  it('keeps each of the five layers beside the post, and nothing a caller could name', () => {
    for (const name of LAYER_NAMES) assert.doesNotThrow(() => assertSafeKey(mediaStorageKey(company, generation, `layer-${name}`, 'png')));
    assert.throws(() => assertSafeKey(mediaStorageKey(company, generation, 'layer-anything', 'png')));
    assert.throws(() => assertSafeKey(mediaStorageKey(company, generation, 'layer-logo/../scene', 'png')));
  });

  it('keeps the background before the newest one, to go back to', () => {
    assert.doesNotThrow(() => assertSafeKey(mediaStorageKey(company, generation, 'scene-previous', 'png')));
    assert.throws(() => assertSafeKey(mediaStorageKey(company, generation, 'scene-older', 'png')));
  });
});

describe('pieces placed by hand', () => {
  it('stands each piece exactly where it was dropped, at the size it was left', () => {
    const fitted = fitLayout(DEFAULT_LAYOUT, 1, 1 / 3, 2 / 3);
    const placed = placeLayout(fitted, {
      bottle: { cx: 0.4, base: 0.8, height: 0.5 },
      logo: { x: 0.05, y: 0.82, w: 0.2 },
      text: { x: 0.55, y: 0.1, scale: 1.2 },
    }, 1, 1 / 3, 2 / 3);
    const b = placed.bottleBox!;
    assert.ok(Math.abs(b.x + b.w / 2 - 0.4) < 1e-9 && Math.abs(b.y + b.h - 0.8) < 1e-9 && b.h === 0.5);
    assert.deepEqual(placed.logoBox, { x: 0.05, y: 0.82, w: 0.2, h: 0.2 * (2 / 3) });
    assert.equal(placed.text!.x, 0.55);
    assert.equal(placed.text!.y, 0.1);
    assert.equal(placed.placedText, true);
  });

  it('takes a dragged place as numbers only, and lets a preset take its piece back', () => {
    const was = { bottle: 'right', size: 'medium', logo: 'top-right' } as const;
    const dragged = choicesFrom({ place: { bottle: { cx: 0.3, base: 0.9, height: 0.6 }, text: { x: 0.5, y: 0.1, scale: 1 } } }, was);
    assert.deepEqual(dragged.place!.bottle, { cx: 0.3, base: 0.9, height: 0.6 });
    assert.throws(() => choicesFrom({ place: { bottle: { cx: 'left', base: 0.9, height: 0.6 } } }, was), /not a place/);
    // A bottle sent back to a side goes there, and the words with it.
    const reset = choicesFrom({ bottle: 'left' }, dragged);
    assert.equal(reset.place, undefined);
    // Out-of-range numbers are held to the post.
    assert.equal(choicesFrom({ place: { logo: { x: 5, y: 0, w: 0.2 } } }, was).place!.logo!.x, 1);
  });

  it('sets the post with the words where they were dragged, and says where everything landed', async () => {
    const scene = png(1024, 1024, '#3a2a1c');
    const bottle = png(200, 600, '#c98a1a', [50, 20, 100, 560]);
    const layout = placeLayout(fitLayout(DEFAULT_LAYOUT, 1, 1 / 3, 2 / 3), { text: { x: 0.1, y: 0.6, scale: 1 }, bottle: { cx: 0.75, base: 0.9, height: 0.5 } }, 1, 1 / 3, 2 / 3);
    const post = await buildPost({ scene, ratio: 1, layout, plan, bottle, logos: [] });
    assert.ok(Math.abs(post.boxes.text!.y - 0.6) < 0.01, `the words start at ${post.boxes.text!.y}`);
    assert.ok(Math.abs(post.boxes.text!.x - 0.1) < 0.01);
    assert.ok(Math.abs(post.boxes.bottle!.h - 0.5) < 1e-9);
  });
});

describe('a post without its headline', () => {
  it('takes the headline off and puts it back, keeping its place and its words', () => {
    const was = { bottle: 'right', size: 'medium', logo: 'top-right', place: { text: { x: 0.1, y: 0.2, scale: 1 } } } as const;
    const off = choicesFrom({ headline: 'none' }, was);
    assert.equal(off.headline, 'none');
    assert.deepEqual(off.place, was.place);
    assert.equal(choicesFrom({ headline: 'shown' }, off).headline, undefined);
    assert.throws(() => choicesFrom({ headline: 'maybe' }, was), /not a place/);
  });
});
