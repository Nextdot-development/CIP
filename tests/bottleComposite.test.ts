import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { placeBottle } from '../src/server/media/bottleComposite';

/**
 * The brand's own bottle, placed into a scene: exactly as designed, scaled
 * evenly, with what makes it belong added around it.
 */

/** A scene: darker on the right, the light from the left, a surface below. */
function scene(): Buffer {
  const c = createCanvas(1000, 1000);
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 1000, 0);
  g.addColorStop(0, '#b0702a');
  g.addColorStop(1, '#1a1008');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 1000, 1000);
  ctx.fillStyle = '#5a3a20';
  ctx.fillRect(0, 700, 1000, 300);
  return c.toBuffer('image/png');
}

/** A bottle on transparency with margins around it: a dark glass, a bright label. */
function bottle(): Buffer {
  const c = createCanvas(400, 1200);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#7a3c10';
  ctx.fillRect(100, 100, 200, 1000);
  ctx.fillStyle = '#ffd700';
  ctx.fillRect(130, 600, 140, 300);
  return c.toBuffer('image/png');
}

async function pixel(bytes: Buffer, x: number, y: number) {
  const img = await loadImage(bytes);
  const c = createCanvas(img.width, img.height).getContext('2d');
  c.drawImage(img, 0, 0);
  return Array.from(c.getImageData(x, y, 1, 1).data.slice(0, 3));
}

describe('placing the real bottle in a scene', () => {
  it('scales it evenly to the height asked for, standing on its line, its own margins trimmed', async () => {
    const placed = await placeBottle({ scene: scene(), bottle: bottle(), place: { cx: 0.6, base: 0.75, height: 0.5 } });
    // 200 x 1000 once trimmed, so 100 x 500 at half the scene's height.
    assert.deepEqual(placed.box, { x: 550, y: 250, w: 100, h: 500 });
  });

  it('keeps the label as designed: lit, never recoloured', async () => {
    const placed = await placeBottle({ scene: scene(), bottle: bottle(), place: { cx: 0.6, base: 0.75, height: 0.5 } });
    // The label's middle (it spans 500-650 down): yellow still, and no more than a little darker.
    const [r, g, b] = await pixel(placed.bytes, 600, 575);
    assert.ok(r! > 200 && g! > 160 && b! < 90, `the label became ${r},${g},${b}`);
  });

  it('reads the light from the brighter side, and shades the far side', async () => {
    const placed = await placeBottle({ scene: scene(), bottle: bottle(), place: { cx: 0.6, base: 0.75, height: 0.5 } });
    assert.equal(placed.light, 'left');
    const near = await pixel(placed.bytes, 556, 400);
    const far = await pixel(placed.bytes, 644, 400);
    assert.ok(near[0]! > far[0]!, 'the side towards the light is the lighter');
  });

  it('grounds it with a shadow where it stands, and a reflection on a gloss surface only', async () => {
    const plain = await pixel(scene(), 600, 760);
    const matte = await placeBottle({ scene: scene(), bottle: bottle(), place: { cx: 0.6, base: 0.75, height: 0.5 }, surface: 'matte' });
    const shadowed = await pixel(matte.bytes, 600, 752);
    assert.ok(shadowed[0]! < plain[0]! - 20, 'no shadow under the foot');
    // Below the foot, a gloss surface shows the bottle; a matte one does not.
    const gloss = await placeBottle({ scene: scene(), bottle: bottle(), place: { cx: 0.6, base: 0.75, height: 0.5 }, surface: 'gloss' });
    const mirrored = await pixel(gloss.bytes, 600, 790);
    const bare = await pixel(matte.bytes, 600, 790);
    assert.notDeepEqual(mirrored, bare);
  });
});
