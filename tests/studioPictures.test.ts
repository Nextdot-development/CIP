import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas } from '@napi-rs/canvas';
import { cutPlainBackground } from '../src/server/media/cutout';

process.env.DATABASE_URL ??= 'postgres://unused@localhost:5432/unused';
const { STACK, stackOf } = await import('../src/server/brain/layouts');
const { orderFrom, picturesFrom, choicesFrom, refitPicture } = await import('../src/server/media/arrange');
const { drawPictures } = await import('../src/server/media/composePost');

const alphaAt = (px: Uint8ClampedArray, w: number, x: number, y: number) => px[(y * w + x) * 4 + 3]!;

test('a plain white ground comes off; the white inside a glass, closed in by its rim, stays', () => {
  const W = 60, H = 60;
  const c = createCanvas(W, H);
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, W, H);
  // A "glass": a dark ring with white inside it.
  g.strokeStyle = '#333333'; g.lineWidth = 4; g.strokeRect(15, 15, 30, 30);
  const data = g.getImageData(0, 0, W, H).data;
  const out = cutPlainBackground(data, W, H);
  assert.equal(out.outcome, 'cut');
  assert.equal(alphaAt(out.pixels, W, 2, 2), 0, 'the ground outside goes clear');
  assert.equal(alphaAt(out.pixels, W, 30, 30), 255, 'the white inside the rim stays');
  assert.equal(alphaAt(out.pixels, W, 15, 30), 255, 'the rim stays');
});

test('a photograph - an edge of many colours - is left as it is', () => {
  const W = 40, H = 40;
  const c = createCanvas(W, H);
  const g = c.getContext('2d');
  for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) { g.fillStyle = `rgb(${(x * 37) % 255},${(y * 53) % 255},${(x * y) % 255})`; g.fillRect(x, y, 1, 1); }
  const out = cutPlainBackground(g.getImageData(0, 0, W, H).data, W, H);
  assert.equal(out.outcome, 'not-plain');
});

test('a picture already clear round its edge is said to be so, and not touched', () => {
  const W = 30, H = 30;
  const c = createCanvas(W, H);
  const g = c.getContext('2d');
  g.fillStyle = '#c00'; g.fillRect(10, 10, 10, 10);
  assert.equal(cutPlainBackground(g.getImageData(0, 0, W, H).data, W, H).outcome, 'already-clear');
});

test('an order set before pictures could be added takes them where they usually lie', () => {
  assert.deepEqual(stackOf(['bottle', 'headline', 'texts', 'logo']), [...STACK]);
  assert.deepEqual(stackOf(['logo', 'bottle', 'headline', 'texts']), ['logo', 'bottle', 'pictures', 'headline', 'texts']);
  assert.deepEqual(stackOf(['headline', 'texts', 'logo', 'bottle']), ['headline', 'texts', 'logo', 'bottle', 'pictures']);
  assert.deepEqual(orderFrom(['pictures', 'bottle', 'headline', 'texts', 'logo']), ['pictures', 'bottle', 'headline', 'texts', 'logo']);
  assert.throws(() => orderFrom(['bottle', 'bottle']));
});

test('added pictures are checked: a Drive id, a place near the post, a look in bounds', () => {
  const file = '0b6f1d2e-3c4a-4b5c-8d6e-7f8091a2b3c4';
  const [p] = picturesFrom([{ id: 'abcd12', file, aspect: 2, x: 0.4, y: 3, w: 9, rotate: 370, flip: true, opacity: 0, shadow: 1 }]);
  assert.deepEqual(p, { id: 'abcd12', file, aspect: 2, x: 0.4, y: 1.1, w: 1.5, rotate: 10, flip: true, opacity: 0.1, shadow: 1 });
  assert.throws(() => picturesFrom([{ id: 'abcd12', file: '../../etc' }]));
  assert.throws(() => picturesFrom([{ id: 'abcd12', file }, { id: 'abcd12', file }]));
  const current = { bottle: 'left' as const, size: 'medium' as const, logo: 'top-right' as const };
  assert.equal(choicesFrom({ pictures: [{ id: 'abcd12', file }] }, current).pictures?.length, 1);
  assert.equal(choicesFrom({ pictures: [] }, { ...current, pictures: [p!] }).pictures, undefined);
});

test('a picture is drawn at its place and width, its height from its own shape, mirrored when asked', async () => {
  // A picture twice as tall as wide: red on its left half, blue on its right.
  const src = createCanvas(20, 40);
  const s = src.getContext('2d');
  s.fillStyle = '#ff0000'; s.fillRect(0, 0, 10, 40);
  s.fillStyle = '#0000ff'; s.fillRect(10, 0, 10, 40);
  const bytes = await src.encode('png');
  const W = 200, H = 200;
  const pic = { id: 'abcd12', file: 'x', aspect: 2, x: 0.25, y: 0.1, w: 0.2 };
  const layer = await drawPictures([{ pic, bytes }], W, H);
  const at = (l: typeof layer, x: number, y: number) => Array.from(l.getContext('2d').getImageData(x, y, 1, 1).data);
  // 40 px wide at x 50..90, 80 px tall at y 20..100.
  assert.deepEqual(at(layer, 55, 60).slice(0, 3), [255, 0, 0]);
  assert.deepEqual(at(layer, 85, 60).slice(0, 3), [0, 0, 255]);
  assert.equal(at(layer, 55, 110)[3], 0, 'nothing below it');
  const flipped = await drawPictures([{ pic: { ...pic, flip: true }, bytes }], W, H);
  assert.deepEqual(at(flipped, 55, 60).slice(0, 3), [0, 0, 255]);
  const turned = await drawPictures([{ pic: { ...pic, rotate: 90 }, bytes }], W, H);
  // Turned a quarter about its middle (70, 60): now wide, from x 30 to 110.
  assert.ok(at(turned, 35, 60)[3]! > 200);
  assert.equal(at(turned, 70, 25)[3], 0);
});

test('in another shape, a picture keeps its size against the short side and its middle - not a banner wide', () => {
  const pic = { id: 'abcd12', file: 'x', aspect: 1, x: 0.38, y: 0.38, w: 0.24 };
  // A square post's glass, 259 px of 1080, taken to a 5:1 banner of 5400 x 1080.
  const banner = refitPicture(pic, 1, 5);
  assert.ok(Math.abs(banner.w * 5400 - 0.24 * 1080) < 1e-6);
  assert.ok(Math.abs(banner.w * banner.aspect * 5 - 0.24) < 1e-9, 'as tall against the banner as against the square');
  assert.ok(Math.abs(banner.x + banner.w / 2 - 0.5) < 1e-9 && Math.abs(banner.y + 0.12 - 0.5) < 1e-9, 'its middle where it was');
  // And to a story, 1080 x 1920: as wide as it was, since the short side is the width in both.
  const story = refitPicture(pic, 1, 9 / 16);
  assert.ok(Math.abs(story.w - 0.24) < 1e-9);
});

test('a glass on white made see-through: the white goes clear, the drink keeps its colour, the glass lines turn to light', async () => {
  const { seeThrough, lightOf } = await import('../src/server/media/cutout');
  // Four pixels: white, mid grey (a glass line), amber (the drink), clear.
  const px = new Uint8ClampedArray([255, 255, 255, 255, 120, 120, 120, 255, 220, 140, 30, 255, 0, 0, 0, 0]);
  const out = seeThrough(px, [255, 230, 190]);
  assert.ok(out[3]! < 20, 'white is let through');
  assert.ok(out[7]! > 120 && out[4]! > 200, 'a grey line becomes a light one, well seen');
  assert.ok(out[11]! > 200 && out[8]! > out[10]!, 'the drink stays, amber');
  assert.equal(out[15], 0, 'the clear stays clear');
  const warm = lightOf(new Uint8ClampedArray(Array.from({ length: 64 }, (_, i) => [200, 120, 40, 255][i % 4]!)));
  assert.ok(warm[0] > warm[2], 'a warm scene gives warm light');
});
