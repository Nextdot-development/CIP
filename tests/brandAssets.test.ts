import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas } from '@napi-rs/canvas';

// The reading needs no database; the module only connects when asked to look one up.
process.env.DATABASE_URL ??= 'postgres://unused@localhost:5432/unused';
const { brandFromPath, kindOf, readPicture, toneOf, variantFromName } = await import('../src/server/brain/brandAssets');

/**
 * A brand's own pieces, read for what they are: from the picture itself, and
 * from where they were filed and what they are called.
 */

const ROSTER = ['8PM', 'Magic Moments', 'Whytehall', 'Royal Ranthambore', 'Rampur', 'Morpheus', 'Afri Bull'];

/** A picture on transparency: a w x h shape of one colour in a W x H frame. */
function shape(W: number, H: number, w: number, h: number, colour: string, ground: string | null = null) {
  const c = createCanvas(W, H);
  const ctx = c.getContext('2d');
  if (ground) { ctx.fillStyle = ground; ctx.fillRect(0, 0, W, H); }
  ctx.fillStyle = colour;
  ctx.fillRect((W - w) / 2, (H - h) / 2, w, h);
  return c.toBuffer('image/png');
}

describe('a brand asset, read', () => {
  it('takes the brand from the file name first, then the folders it is filed in', () => {
    assert.equal(brandFromPath('/MAGIC MOMENTS/chocolate.png', ROSTER), 'Magic Moments');
    assert.equal(brandFromPath('/WHYTHALL/New folder/rr-logo.png', ROSTER), 'Royal Ranthambore', 'the name beats the folder');
    assert.equal(brandFromPath('/radico bottles/8pm honey.png', ROSTER), '8PM');
    assert.equal(brandFromPath('/New folder/Untitled design (4).png', ROSTER), null);
  });

  it('reads a flavour, an edition or a size off the name', () => {
    assert.equal(variantFromName('Lemongrass&ginger.png'), 'Lemongrass & Ginger');
    assert.equal(variantFromName('GreenApple.png'), 'Green Apple');
    assert.equal(variantFromName('New - 8PM 1L Packshot.png'), '1L');
    assert.equal(variantFromName('8PM.png'), null);
  });

  it('tells a bottle from a logo from a finished post by the picture', async () => {
    const bottle = await readPicture(shape(400, 1000, 120, 900, '#a0522d'));
    assert.ok(bottle.transparent > 0.5);
    assert.deepEqual(kindOf('anything.png', bottle), { kind: 'bottle', cutout: true });
    const logo = await readPicture(shape(800, 400, 600, 200, '#ffffff'));
    assert.deepEqual(kindOf('anything.png', logo), { kind: 'logo', cutout: true });
    assert.equal(toneOf(logo), 'light');
    const post = await readPicture(shape(1080, 1080, 300, 600, '#ffd700', '#202020'));
    assert.deepEqual(kindOf('Happy new year.png', post), { kind: 'creative', cutout: false });
    // A name that says what it is, is believed.
    assert.equal(kindOf('MM logo.png', bottle).kind, 'logo');
  });
});
