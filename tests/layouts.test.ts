import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * A brand's layouts: learned from its designers' files, and fitted to any
 * post and any bottle the way a designer fits them.
 */

// Nothing here reads the database; the module only connects when asked to.
process.env.DATABASE_URL ??= 'postgres://unused@localhost:5432/unused';
const { adaptLayout, fitLayout, learnLayout } = await import('../src/server/brain/layouts');
type Spec = NonNullable<ReturnType<typeof learnLayout>>;

/** A post as Photoshop files it: a background, a bottle, a logo, and the words. */
const post = {
  width: 1000,
  height: 1000,
  children: [
    { name: 'Background', left: 0, top: 0, right: 1000, bottom: 1000 },
    { name: 'Whtehall Whisky bottle', left: 560, top: 50, right: 910, bottom: 920 },
    { name: 'Whytehall-logo-(Honey-White)', left: 810, top: 25, right: 975, bottom: 210 },
    // A shading layer behind the logo, running off the edge: never the logo.
    { name: 'Layer 10 copy', left: 780, top: -5, right: 1010, bottom: 300 },
    // A white box behind the third line only.
    { name: 'Rectangle 1', left: 40, top: 482, right: 400, bottom: 553, vectorFill: { color: { r: 255, g: 255, b: 255 } } },
    {
      name: 'headline', left: 45, top: 330, right: 420, bottom: 630,
      text: {
        text: 'Squeeze\rthe nectar,\rsip the\rmagic',
        transform: [1.5, 0, 0, 1.5, 0, 0],
        style: { fontSize: 46, leading: 50, font: { name: 'Poppins-SemiBold' }, fillColor: { r: 255, g: 255, b: 255 } },
        styleRuns: [
          { length: 28, style: { font: { name: 'Poppins-SemiBold' }, fontSize: 46, fillColor: { r: 255, g: 255, b: 255 } } },
          { length: 5, style: { font: { name: 'Chloe-Regular' }, fontSize: 65, fillColor: { r: 255, g: 211, b: 9 } } },
        ],
        paragraphStyle: { justification: 'left' },
      },
    },
  ],
};

describe('learning a layout from a designer\'s file', () => {
  const spec = learnLayout(post as never, /bottle/i)!;

  it('reads the logo, the bottle and the words, as shares of the post', () => {
    const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} is not ${b}`);
    assert.equal(spec.logo!.corner, 'top-right', 'the logo, not the shading behind it');
    near(spec.logo!.width, 0.165); near(spec.logo!.insetX, 0.025); near(spec.logo!.insetY, 0.025);
    near(spec.bottle!.cx, 0.735); near(spec.bottle!.base, 0.92); near(spec.bottle!.height, 0.87);
    assert.equal(spec.text!.align, 'left');
    assert.equal(spec.text!.x, 0.045);
  });

  it('sets the words as the file does: the plain lines, the boxed line, and the key word in the accent and its own face', () => {
    const lines = spec.text!.lines;
    assert.deepEqual(lines.map((l) => l.role), ['lead', 'lead', 'key', 'key']);
    assert.deepEqual(lines.map((l) => l.box), [null, null, '#ffffff', null], 'the box is behind its own line only');
    assert.equal(lines[0]!.font, 'Poppins-SemiBold');
    assert.equal(lines[0]!.weight, 'bold');
    assert.equal(lines[3]!.font, 'Chloe-Regular');
    assert.ok(lines[3]!.script && lines[3]!.accent);
    assert.equal(spec.text!.ink, '#ffffff');
    assert.equal(spec.text!.accent, '#ffd309');
    // The size the file shows, scaled as Photoshop scales it.
    assert.ok(Math.abs(lines[0]!.size - 0.069) < 1e-9);
  });

  it('learns nothing from a file of one bottle', () => {
    assert.equal(learnLayout({ width: 500, height: 1500, children: [{ name: '8PM bottle', left: 100, top: 100, right: 400, bottom: 1400 }] } as never, /bottle/i), null);
  });
});

describe('fitting a layout to a post and a bottle', () => {
  const spec: Spec = learnLayout(post as never, /bottle/i)!;
  const words: Spec = { ...spec, text: { ...spec.text!, y: 0.7, x: 0.09, width: 0.43 } };
  const hit = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

  for (const layout of [spec, words, { ...spec, bottle: null }]) {
    for (const ratio of [1, 0.8, 9 / 16, 16 / 9, 4 / 1]) {
      for (const aspect of [0.22, 0.32, 0.5]) {
        it(`keeps the bottle clear of the words and the logo, inside the post - ${ratio.toFixed(2)}, a bottle ${aspect} wide`, () => {
          const fit = fitLayout(layout, ratio, aspect);
          const b = fit.bottleBox!;
          assert.ok(!hit(b, fit.textBox!), 'the bottle is on the words');
          assert.ok(!fit.logoBox || !hit(b, fit.logoBox), 'the bottle is on the logo');
          assert.ok(b.x >= -1e-9 && b.x + b.w <= 1 + 1e-9 && b.y >= -1e-9 && b.y + b.h <= 1 + 1e-9, 'the bottle leaves the post');
          assert.ok(b.h >= 0.2, 'the bottle has shrunk to nothing');
        });
      }
    }
  }

  it('keeps the logo the same size against the short side, in a story and a banner', () => {
    const square = adaptLayout(spec, 1).logo!;
    const story = adaptLayout(spec, 9 / 16).logo!;
    const banner = adaptLayout(spec, 16 / 9).logo!;
    assert.ok(Math.abs(story.width - square.width) < 1e-9, 'a story is as wide as a square post');
    assert.ok(Math.abs(banner.width * (16 / 9) - square.width) < 1e-9, 'a banner\'s logo is as long as a square post\'s');
    // In a story the logo sits below the phone's own bar.
    assert.ok(story.insetY >= 0.07);
  });
});
