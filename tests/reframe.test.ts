import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { reframe, requestedShape, sameShape } from '../src/server/media/reframe';

/**
 * Delivering the shape somebody asked for.
 *
 * No database and no provider: this is arithmetic on pixels and on the words
 * of a request. What it is really testing is that "ar 4:5" produces a 4:5
 * picture, rather than the nearest thing the vendor sells plus an instruction
 * to crop it yourself.
 */

/** A solid image of a given size, so a crop is measurable. */
async function image(width: number, height: number): Promise<Buffer> {
  const { createCanvas } = await import('@napi-rs/canvas');
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#c8a24b';
  ctx.fillRect(0, 0, width, height);
  return canvas.toBuffer('image/png');
}

async function sizeOf(bytes: Buffer): Promise<{ width: number; height: number }> {
  const { loadImage } = await import('@napi-rs/canvas');
  const loaded = await loadImage(bytes);
  return { width: loaded.width, height: loaded.height };
}

describe('reading a shape out of a request', () => {
  it('takes a ratio the person marked as one', () => {
    assert.equal(requestedShape('a banner of 8pm honey. ar 4:5')?.label, '4:5');
    assert.equal(requestedShape('aspect ratio 16:9 please')?.label, '16:9');
    assert.equal(requestedShape('ratio 2:3')?.label, '2:3');
  });

  it('takes a bare ratio when it is unmistakably one', () => {
    assert.equal(requestedShape('make it 9:16 for stories')?.label, '9:16');
    assert.equal(requestedShape('1:1 for the grid')?.label, '1:1');
  });

  it('reads a shape however it was typed', () => {
    // Each of these came back null, so a banner fell through to 3:1.
    assert.equal(requestedShape('diwali banner 4:4')?.label, '1:1');
    assert.equal(requestedShape('banner in 4:4 and 1:1')?.label, '1:1');
    assert.equal(requestedShape('banner 1 : 1')?.label, '1:1');
    assert.equal(requestedShape('banner 1:1ratio me')?.label, '1:1');
    assert.equal(requestedShape('banner 1x1')?.label, '1:1');
    assert.equal(requestedShape('banner size 1*1')?.label, '1:1');
    assert.equal(requestedShape('banner 1：1')?.label, '1:1');
    assert.equal(requestedShape('ar 8:10')?.label, '4:5');
    assert.equal(requestedShape('size 4 by 5')?.label, '4:5');
    assert.equal(requestedShape('a square post for Diwali')?.label, '1:1');
    assert.equal(requestedShape('banner square m bnao')?.label, '1:1');
  });

  it('reads pixels with a unit on the end', () => {
    const shape = requestedShape('banner 1080x1080px');
    assert.deepEqual(shape?.pixels, { width: 1080, height: 1080 });
  });

  it('does not read a grid, a case count or a landmark as a crop', () => {
    assert.equal(requestedShape('a 3x3 grid of posts'), null);
    assert.equal(requestedShape('12 x 750ml bottles on a bar'), null);
    assert.equal(requestedShape('a billboard in Times Square'), null);
    assert.equal(requestedShape('launch at 10:10 tonight'), null);
  });

  it('does not read a time or a score as a crop', () => {
    // This library is full of a brand called 8PM, and people write times.
    assert.equal(requestedShape('a post for 8PM to run at 8:30 in the evening'), null);
    assert.equal(requestedShape('the 7:45 slot'), null);
  });

  it('takes exact pixels over anything else', () => {
    const shape = requestedShape('billboard at 1920x480');
    assert.equal(shape?.label, '1920x480');
    assert.deepEqual(shape?.pixels, { width: 1920, height: 480 });
    assert.ok(sameShape(shape!.ratio, 4), `ratio came out ${shape!.ratio}`);
  });

  it('says nothing when the request says nothing', () => {
    assert.equal(requestedShape('a warm celebratory banner for Diwali'), null);
  });
});

describe('cutting a generated picture to the shape asked for', () => {
  it('crops the width when the generated image is too wide', async () => {
    // 3:2 generated, 4:5 wanted: the height is all usable, the width is not.
    const framed = await reframe(await image(1500, 1000), 'image/png', {
      ratio: 4 / 5,
      label: '4:5',
      pixels: null,
    });

    assert.ok(framed, 'the picture could not be re-cut');
    assert.equal(framed!.changed, true);
    assert.equal(framed!.height, 1000, 'height should be kept whole');
    assert.equal(framed!.width, 800);

    const actual = await sizeOf(framed!.bytes);
    assert.ok(sameShape(actual.width / actual.height, 4 / 5), 'the delivered file is not 4:5');
  });

  it('crops the height when the generated image is too tall', async () => {
    const framed = await reframe(await image(1000, 1500), 'image/png', {
      ratio: 4 / 5,
      label: '4:5',
      pixels: null,
    });

    assert.ok(framed);
    assert.equal(framed!.width, 1000, 'width should be kept whole');
    assert.equal(framed!.height, 1250);
  });

  it('leaves a picture that is already the right shape alone', async () => {
    const original = await image(1024, 1024);
    const framed = await reframe(original, 'image/png', { ratio: 1, label: '1:1', pixels: null });

    assert.ok(framed);
    assert.equal(framed!.changed, false, 're-encoding a picture that already fits loses quality');
    assert.ok(framed!.bytes.equals(original));
  });

  it('hits exact pixels when those were named', async () => {
    const framed = await reframe(await image(1536, 1024), 'image/png', {
      ratio: 1080 / 1350,
      label: '1080x1350',
      pixels: { width: 1080, height: 1350 },
    });

    assert.ok(framed);
    // 1350 is taller than the 1024 that was generated, so the exact pixels
    // cannot be met without inventing detail. Proportions are kept instead.
    const actual = await sizeOf(framed!.bytes);
    assert.ok(
      sameShape(actual.width / actual.height, 1080 / 1350),
      `wanted 1080x1350 proportions, got ${actual.width}x${actual.height}`,
    );
    assert.ok(actual.height <= 1024, 'the picture was enlarged, which invents detail');
  });

  it('delivers exact pixels when the generated picture is big enough', async () => {
    const framed = await reframe(await image(2000, 2000), 'image/png', {
      ratio: 1080 / 1350,
      label: '1080x1350',
      pixels: { width: 1080, height: 1350 },
    });

    assert.ok(framed);
    const actual = await sizeOf(framed!.bytes);
    assert.deepEqual(actual, { width: 1080, height: 1350 });
  });

  it('hands back nothing it cannot decode, rather than failing in its place', async () => {
    const framed = await reframe(Buffer.from('not an image', 'utf8'), 'image/png', {
      ratio: 1,
      label: '1:1',
      pixels: null,
    });

    // The caller keeps the original bytes. This step improves a result and
    // must never be the reason there is no result.
    assert.equal(framed, null);
  });
});
