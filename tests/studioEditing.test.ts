import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas, type Canvas } from '@napi-rs/canvas';

process.env.DATABASE_URL ??= 'postgres://unused@localhost:5432/unused';
const { shapeFrom, lockedFrom, styleFrom, textsFrom, picturesFrom } = await import('../src/server/media/arrange');
const { shapeCanvas, grade, drawPictures } = await import('../src/server/media/composePost');

const FILE = '0b6f1d2e-3c4a-4b5c-8d6e-7f8091a2b3c4';
const px = (c: Canvas, x: number, y: number) => Array.from(c.getContext('2d').getImageData(x, y, 1, 1).data);

test('a shape is checked: a known kind, real colours, short words, an outline only with a width', () => {
  assert.deepEqual(shapeFrom({ kind: 'badge', fill: '#D4202A', text: '  NEW \n', ink: '#fff', font: 'poppins' }),
    { kind: 'badge', fill: '#d4202a', text: 'NEW', ink: '#141414', font: 'poppins' });
  assert.deepEqual(shapeFrom({ kind: 'rect', fill: 'red', stroke: '#000000' }), { kind: 'rect', fill: '#ffffff' });
  assert.equal(shapeFrom({ kind: 'button', fill: '#ffffff', text: 'x'.repeat(90) }).text?.length, 40);
  assert.throws(() => shapeFrom({ kind: 'star' }));
});

test('a picture may be a shape with no file; a file picture keeps its crop, fade and tint in bounds', () => {
  const [shape, pic] = picturesFrom([
    { id: 'abcd12', aspect: 0.3, x: 0.1, y: 0.1, w: 0.3, shape: { kind: 'button', fill: '#ffffff', text: 'Shop now' } },
    { id: 'abcd13', file: FILE, aspect: 1, x: 0, y: 0, w: 0.2, crop: { l: 0.9, t: 0.1, r: 0, b: -1 }, feather: 3, tint: '#FF0000', tintAmount: 0.5 },
  ]);
  assert.equal(shape!.file, undefined);
  assert.equal(shape!.shape?.kind, 'button');
  assert.deepEqual(pic!.crop, { l: 0.45, t: 0.1, r: 0, b: 0 });
  assert.equal(pic!.feather, 1);
  assert.equal(pic!.tint, '#ff0000');
  assert.throws(() => picturesFrom([{ id: 'abcd12', aspect: 1, x: 0, y: 0, w: 0.2 }]), /not one in Drive/);
});

test('pieces held still are named pieces, each once', () => {
  assert.deepEqual(lockedFrom(['bottle', 'p:abcd12', 'bottle', 'nonsense', 't:ab', 42]), ['bottle', 'p:abcd12']);
});

test('the background, the whole post and the headline letters take their new looks, and go back as designed', () => {
  const s = styleFrom({ bgZoom: 9, bgX: -2, bgFlip: true, bgOverlay: '#C9A227', bgOverlayAmount: 0.5, warmth: 0.4, saturation: -1, textStroke: 0.06, ink2: '#ffcc00' });
  assert.deepEqual(s, { bgZoom: 3, bgX: -1, bgFlip: true, bgOverlay: '#c9a227', bgOverlayAmount: 0.5, warmth: 0.4, saturation: -1, textStroke: 0.06, ink2: '#ffcc00' });
  const back = styleFrom({ bgZoom: 1, bgX: 0, bgFlip: false, warmth: null, ink2: null }, s);
  assert.equal(back.bgZoom, undefined);
  assert.equal(back.bgX, undefined);
  assert.equal(back.bgFlip, undefined);
  assert.equal(back.warmth, undefined);
  assert.equal(back.ink2, undefined);
  assert.throws(() => styleFrom({ bgOverlay: 'gold' }));
});

test('a block of text keeps its letter and line spacing, outline and second colour', () => {
  const [b] = textsFrom([{ id: 'abcd12', lines: [{ text: 'Hi', role: 'lead' }], spacing: 2, lineHeight: 1.4, stroke: 0.05, strokeInk: '#7A0000', ink2: '#ffcc00' }]);
  assert.equal(b!.spacing, 0.6);
  assert.equal(b!.lineHeight, 1.4);
  assert.equal(b!.stroke, 0.05);
  assert.equal(b!.strokeInk, '#7a0000');
  assert.equal(b!.ink2, '#ffcc00');
  const [plain] = textsFrom([{ id: 'abcd12', lines: [{ text: 'Hi', role: 'lead' }], strokeInk: '#000000' }]);
  assert.equal(plain!.strokeInk, undefined, 'no outline colour without an outline');
});

test('shapes are drawn in their colours, with clear corners where they are round', () => {
  const button = shapeCanvas({ kind: 'button', fill: '#ff0000' }, 200, 60);
  assert.deepEqual(px(button, 100, 30).slice(0, 3), [255, 0, 0]);
  assert.equal(px(button, 1, 1)[3], 0, 'a pill has no corners');
  const box = shapeCanvas({ kind: 'rect', fill: '#00ff00', stroke: '#0000ff', strokeW: 0.2 }, 100, 100);
  assert.deepEqual(px(box, 50, 50).slice(0, 3), [0, 255, 0]);
  assert.deepEqual(px(box, 3, 50).slice(0, 3), [0, 0, 255], 'the outline round it');
  const circle = shapeCanvas({ kind: 'circle', fill: '#ffffff' }, 100, 100);
  assert.equal(px(circle, 2, 2)[3], 0);
});

test('the whole post graded: warmer is redder and less blue; black and white has no colour', () => {
  const c = createCanvas(4, 4);
  const g = c.getContext('2d');
  g.fillStyle = '#808080'; g.fillRect(0, 0, 4, 4);
  grade(c, { warmth: 1 });
  const [r, , b] = px(c, 1, 1);
  assert.ok(r! > 128 && b! < 128);
  const d = createCanvas(4, 4);
  d.getContext('2d').fillStyle = '#ff0000'; d.getContext('2d').fillRect(0, 0, 4, 4);
  grade(d, { saturation: -1 });
  const [rr, gg, bb] = px(d, 1, 1);
  assert.ok(Math.abs(rr! - gg!) < 3 && Math.abs(gg! - bb!) < 3);
});

test('a picture cropped is drawn from the part kept, its edges faded when asked', async () => {
  const src = createCanvas(100, 100);
  const s = src.getContext('2d');
  s.fillStyle = '#ff0000'; s.fillRect(0, 0, 50, 100);
  s.fillStyle = '#0000ff'; s.fillRect(50, 0, 50, 100);
  const bytes = await src.encode('png');
  // Its left half cut off: all blue, half as tall again as wide.
  const pic = { id: 'abcd12', file: 'x', aspect: 2, x: 0, y: 0, w: 0.5, crop: { l: 0.5, t: 0, r: 0, b: 0 } };
  const layer = await drawPictures([{ pic, bytes }], 200, 400);
  assert.deepEqual(px(layer, 50, 100).slice(0, 3), [0, 0, 255]);
  assert.equal(px(layer, 50, 210)[3], 0, '100 wide, 200 tall: nothing below');
  const soft = await drawPictures([{ pic: { ...pic, feather: 1 }, bytes }], 200, 400);
  assert.ok(px(soft, 1, 100)[3]! < 120, 'its edge faded');
  assert.ok(px(soft, 50, 100)[3]! > 200, 'its middle not');
});

test('a picture with a reflection shows it upside down below its foot, fading; without one, nothing is there', async () => {
  const src = createCanvas(40, 40);
  const g = src.getContext('2d');
  g.fillStyle = '#ff0000'; g.fillRect(0, 0, 40, 20);
  g.fillStyle = '#0000ff'; g.fillRect(0, 20, 40, 20);
  const bytes = await src.encode('png');
  const pic = { id: 'abcd12', file: 'x', aspect: 1, x: 0.25, y: 0.1, w: 0.5 };
  // 100 wide, 100 tall from y 40: its foot at y 140.
  const plain = await drawPictures([{ pic, bytes }], 200, 400);
  assert.equal(px(plain, 100, 145)[3], 0);
  const shown = await drawPictures([{ pic: { ...pic, mirror: 1 }, bytes }], 200, 400);
  const near = px(shown, 100, 143);
  assert.ok(near[3]! > 40 && near[2]! > near[0]!, 'just below the foot: the blue that was at its foot');
  assert.ok(px(shown, 100, 188)[3]! < near[3]!, 'fading further down');
});
