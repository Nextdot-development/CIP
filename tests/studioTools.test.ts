import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas, loadImage } from '@napi-rs/canvas';

/**
 * What the layer studio offers for nothing: a post measured for what a
 * designer would point at, other headlines to try, a start where the person
 * last put the pieces, other sizes from the same background, and a quality
 * asked for in each generator's own words.
 */

process.env.DATABASE_URL ??= 'postgres://unused@localhost:5432/unused';
const { drawScene, mergeLearned, SCENE_KEPT } = await import('../src/server/media/composePost');
const { choicesFrom, designChecks, providerQuality, sidesOf, styleFrom } = await import('../src/server/media/arrange');
const { arrangeLayout, fitLayout } = await import('../src/server/brain/layouts');
const { DEFAULT_LAYOUT } = await import('../src/server/brain/bench');
const { suggestHeadlines } = await import('../src/server/brain/bench');

const box = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });
const png = (w: number, h: number, colour: string) => {
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = colour;
  ctx.fillRect(0, 0, w, h);
  return c.toBuffer('image/png');
};
const line = (colour: string, b: { x: number; y: number; w: number; h: number }) => ({
  text: 'x', role: 'lead' as const, box: b, face: 'f', file: null, font: 'f', substitute: false, px: 40, colour, spacing: 0, boxFill: null, shadow: null,
}) as never;

describe('a post measured, before it goes out', () => {
  const clean = { bottle: box(0.6, 0.3, 0.25, 0.6), logo: box(0.08, 0.06, 0.15, 0.06), text: box(0.08, 0.35, 0.4, 0.2), textAnchor: { x: 0.08 } };

  it('says nothing about a post laid out well', async () => {
    assert.deepEqual(await designChecks({ width: 1080, height: 1080, boxes: clean }), []);
  });

  it('points at a small logo, a piece against or past the edge, and pieces on top of each other', async () => {
    const small = await designChecks({ width: 1080, height: 1080, boxes: { ...clean, logo: box(0.08, 0.06, 0.05, 0.03) } });
    assert.ok(small.some((c) => /logo is small/.test(c.text)));
    const edge = await designChecks({ width: 1080, height: 1080, boxes: { ...clean, text: box(0.01, 0.35, 0.4, 0.2) } });
    assert.ok(edge.some((c) => /headline is very close to the edge/.test(c.text)));
    const out = await designChecks({ width: 1080, height: 1080, boxes: { ...clean, logo: box(0.9, 0.06, 0.15, 0.06) } });
    assert.ok(out.some((c) => /logo is outside/.test(c.text)));
    const over = await designChecks({ width: 1080, height: 1080, boxes: { ...clean, text: box(0.55, 0.4, 0.35, 0.2) } });
    assert.ok(over.some((c) => /headline runs over the bottle/.test(c.text)));
  });

  it('lets the bottle stand on the bottom edge, as it does', async () => {
    const standing = await designChecks({ width: 1080, height: 1080, boxes: { ...clean, bottle: box(0.6, 0.38, 0.25, 0.62) } });
    assert.deepEqual(standing, []);
  });

  it('points at words that do not stand out from the background behind them', async () => {
    const layers = { background: png(1080, 1080, '#f4f4f4'), shadow: null, bottle: null, headline: png(4, 4, '#000'), logo: null };
    const pale = await designChecks({ width: 1080, height: 1080, boxes: clean, layers: { ...layers, lines: [line('#ffffff', { x: 90, y: 380, w: 400, h: 60 })] } });
    assert.ok(pale.some((c) => /hard to read/.test(c.text)));
    const dark = await designChecks({ width: 1080, height: 1080, boxes: clean, layers: { ...layers, lines: [line('#1a1a1a', { x: 90, y: 380, w: 400, h: 60 })] } });
    assert.deepEqual(dark, []);
  });
});

describe('other headlines, for nothing', () => {
  const roles = new Set(['lead', 'key'] as const);
  const current = [{ text: 'Squeeze the nectar,', role: 'lead' as const }, { text: 'sip the magic', role: 'key' as const }];

  it('breaks the same words at other places, and offers them on one line', () => {
    const options = suggestHeadlines(current, roles, []);
    assert.ok(options.length >= 2);
    assert.ok(options.every((o) => o.from === 'words'));
    assert.ok(options.some((o) => o.lines.length === 1 && o.lines[0]!.text === 'Squeeze the nectar, sip the magic'));
    // Never the headline the post already has.
    assert.ok(!options.some((o) => o.lines.map((l) => l.text).join('|') === 'Squeeze the nectar,|sip the magic'));
  });

  it('offers the brand\'s own headlines, no longer than its headlines run', () => {
    const past = ['A richer way, to unwind', 'Golden moments, shared', 'Made for the nights that turn into stories and then into long mornings after'];
    const brand = suggestHeadlines(current, roles, past).filter((o) => o.from === 'brand');
    assert.deepEqual(brand.map((o) => o.lines.map((l) => l.text)), [['A richer way,', 'to unwind'], ['Golden moments,', 'shared']]);
  });
});

describe('a new post starts where the pieces were last put', () => {
  const own = { bottle: 'right' as const, size: 'medium' as const, logo: 'top-right' as const };

  it('takes the side, size, corner and dragged places a person chose before', () => {
    const learned = { bottle: 'left' as const, size: 'large' as const, logo: 'bottom-left' as const, headline: 'none' as const, place: { logo: { x: 0.05, y: 0.85, w: 0.2 } } };
    const merged = mergeLearned(own, learned);
    assert.equal(merged.bottle, 'left');
    assert.equal(merged.size, 'large');
    assert.equal(merged.logo, 'bottom-left');
    assert.deepEqual(merged.place, { logo: { x: 0.05, y: 0.85, w: 0.2 } });
    // A new post always has its headline.
    assert.equal(merged.headline, undefined);
  });

  it('keeps the layout\'s own places when nothing was arranged, and never adds a piece the layout leaves out', () => {
    assert.deepEqual(mergeLearned(own, null), own);
    const noLogo = mergeLearned({ ...own, logo: 'none' }, { ...own, logo: 'top-left', place: { logo: { x: 0.1, y: 0.1, w: 0.2 } } });
    assert.equal(noLogo.logo, 'none');
    assert.equal(noLogo.place, undefined);
  });
});

describe('another size from the same background', () => {
  it('keeps the side and corner a person dragged the pieces to', () => {
    const sides = sidesOf({ bottle: 'right', size: 'medium', logo: 'bottom-left', place: { bottle: { cx: 0.23, base: 0.8, height: 0.6 }, logo: { x: 0.84, y: 0.02, w: 0.14 } } });
    assert.equal(sides.bottle, 'left');
    assert.equal(sides.logo, 'top-right');
  });

  it('keeps a bottle chosen for the left on the left of a wide post, with the words on the right', () => {
    const wide = fitLayout(arrangeLayout(DEFAULT_LAYOUT, { bottle: 'left', size: 'medium', logo: 'top-right' }), 16 / 9);
    assert.ok(wide.bottleBox!.x + wide.bottleBox!.w / 2 < 0.45);
    assert.ok(wide.textBox!.x > 0.45);
    const story = fitLayout(arrangeLayout(DEFAULT_LAYOUT, { bottle: 'left', size: 'medium', logo: 'top-right' }), 9 / 16);
    assert.ok(story.bottleBox!.x + story.bottleBox!.w / 2 < 0.45);
  });


  it('crops a scene that is nearly the right shape, and keeps most of one that is not', async () => {
    const scene = await loadImage(png(1024, 1024, '#336699'));
    // A story from a square: most of the square kept, standing at the bottom.
    const story = createCanvas(1080, 1920);
    drawScene(story.getContext('2d'), scene, 1080, 1920);
    const px = (x: number, y: number) => Array.from(story.getContext('2d').getImageData(x, y, 1, 1).data);
    assert.deepEqual(px(540, 1900).slice(0, 3), [0x33, 0x66, 0x99]);
    // The top is filled from the scene's own colour, not left empty.
    assert.ok(px(540, 20)[3]! > 200);
    assert.ok(SCENE_KEPT > 0.7 && SCENE_KEPT < 0.9);
  });
});

describe('quality, in each generator\'s own words', () => {
  it('asks OpenAI for medium or high, Gemini for a bigger picture, and leaves standard to the generator', () => {
    assert.equal(providerQuality(['auto', 'low', 'medium', 'high'], 'best'), 'high');
    assert.equal(providerQuality(['auto', 'low', 'medium', 'high'], 'better'), 'medium');
    assert.equal(providerQuality(['512', '1K', '2K', '4K'], 'best'), '2K');
    assert.equal(providerQuality(['auto', 'low', 'medium', 'high'], 'standard'), undefined);
  });
});

describe('a check comes with its fix', () => {
  const clean = { bottle: box(0.6, 0.3, 0.25, 0.6), logo: box(0.08, 0.06, 0.15, 0.06), text: box(0.08, 0.35, 0.4, 0.2), textAnchor: { x: 0.08 } };
  const fixOf = async (boxes: typeof clean, pattern: RegExp) =>
    (await designChecks({ width: 1080, height: 1080, boxes })).find((c) => pattern.test(c.text))?.fix?.choices as Record<string, any> | undefined;

  it('moves a piece at the edge back inside the margin, and makes a small logo bigger', async () => {
    const logo = await fixOf({ ...clean, logo: box(0.9, 0.06, 0.15, 0.06) }, /logo is outside/);
    assert.ok(logo!.place.logo.x + 0.15 <= 0.951 && logo!.place.logo.x >= 0.05);
    const words = await fixOf({ ...clean, text: box(0.01, 0.35, 0.4, 0.2) }, /headline is very close/);
    // The words keep their anchor's offset: moved by as much as their box moved.
    assert.ok(Math.abs(words!.place.text.x - (0.08 + (0.05 - 0.01))) < 1e-9);
    assert.equal(words!.place.text.scale, 1);
    const small = await fixOf({ ...clean, logo: box(0.08, 0.06, 0.05, 0.03) }, /logo is small/);
    assert.equal(small!.place.logo.w, 0.1);
  });

  it('takes the words off the bottle to its other side, and the logo to the corner away from what it touches', async () => {
    const off = await fixOf({ ...clean, text: box(0.55, 0.4, 0.3, 0.2) }, /runs over the bottle/);
    assert.ok(off!.place.text.x < 0.2);
    const corner = await fixOf({ ...clean, logo: box(0.1, 0.36, 0.15, 0.06) }, /touches the logo/);
    assert.equal(corner!.logo, 'bottom-right');
  });

  it('gives words that do not read a colour that does', async () => {
    const layers = { background: png(1080, 1080, '#f4f4f4'), shadow: null, bottle: null, headline: png(4, 4, '#000'), logo: null };
    const [pale] = await designChecks({ width: 1080, height: 1080, boxes: clean, layers: { ...layers, lines: [line('#ffffff', { x: 90, y: 380, w: 400, h: 60 })] } });
    assert.deepEqual(pale!.fix!.choices, { style: { ink: '#141414' } });
  });
});

describe('the look of the headline and the bottle, as a person sets it', () => {
  it('keeps what is sent, checked, and lets null put it back as designed', () => {
    const set = styleFrom({ ink: '#FFAA00', align: 'center', textSize: 5, shadow: 0.5, bright: -1 });
    assert.deepEqual(set, { ink: '#ffaa00', align: 'center', textSize: 1.6, shadow: 0.5, bright: -0.3 });
    assert.deepEqual(styleFrom({ ink: null, shadow: 1 }, set), { align: 'center', textSize: 1.6, bright: -0.3 });
    assert.deepEqual(styleFrom(undefined, set), set);
    assert.throws(() => styleFrom({ ink: 'red' }));
    assert.throws(() => styleFrom({ align: 'justify' }));
  });

  it('is kept with the other choices, and a preset place leaves it as it is', () => {
    const current = { bottle: 'right' as const, size: 'medium' as const, logo: 'top-left' as const, style: { shadow: 0 } };
    assert.deepEqual(choicesFrom({ bottle: 'left' }, current).style, { shadow: 0 });
    assert.equal(choicesFrom({ style: { shadow: null } }, current).style, undefined);
  });

  it('casts no shadow at 0, a darker one when strong, and lightens the bottle when asked', async () => {
    const { placeBottle } = await import('../src/server/media/bottleComposite');
    const bottle = (() => { const c = createCanvas(60, 200); const x = c.getContext('2d'); x.fillStyle = '#806040'; x.fillRect(0, 0, 60, 200); return c.toBuffer('image/png'); })();
    const scene = png(400, 400, '#c8c8c8');
    const place = { cx: 0.5, base: 0.85, height: 0.5 };
    const shadowSum = async (shadow?: number) => {
      const p = await placeBottle({ scene, bottle, place, light: 'left', shadow });
      const d = p.layerCanvases.shadow.getContext('2d').getImageData(0, 0, 400, 400).data;
      let a = 0; for (let i = 3; i < d.length; i += 4) a += d[i]!;
      return a;
    };
    const [none, soft, plain, strong] = await Promise.all([shadowSum(0), shadowSum(0.5), shadowSum(), shadowSum(1.6)]);
    assert.equal(none, 0);
    assert.ok(soft < plain && plain < strong);
    const mid = async (bright?: number) => {
      const p = await placeBottle({ scene, bottle, place, light: 'front', bright });
      return p.layerCanvases.bottle.getContext('2d').getImageData(200, 200, 1, 1).data[0]!;
    };
    assert.ok((await mid(0.2)) > (await mid()));
    assert.ok((await mid(-0.2)) < (await mid()));
  });
});

describe('the shadow shaped by hand, as in an editor', () => {
  it('keeps its softness, direction and length, checked, and lets an angle of 0 mean straight back', () => {
    assert.deepEqual(styleFrom({ shadowSoft: 9, shadowAngle: -5, shadowLength: 0.1 }), { shadowSoft: 3, shadowAngle: -1.6, shadowLength: 0.3 });
    assert.deepEqual(styleFrom({ shadowAngle: 0 }), { shadowAngle: 0 });
    assert.deepEqual(styleFrom({ shadowAngle: null, shadowSoft: 1 }, { shadowAngle: 0.4, shadowSoft: 2 }), {});
  });

  it('falls the way it is turned, and reaches as far as it is drawn out', async () => {
    const { placeBottle } = await import('../src/server/media/bottleComposite');
    const bottle = (() => { const c = createCanvas(60, 200); const x = c.getContext('2d'); x.fillStyle = '#806040'; x.fillRect(0, 0, 60, 200); return c.toBuffer('image/png'); })();
    const scene = png(400, 400, '#c8c8c8');
    const place = { cx: 0.5, base: 0.7, height: 0.5 };
    // Where the shadow's weight lies, across and below the foot.
    const centre = async (cast: { angle?: number; length?: number }) => {
      const p = await placeBottle({ scene, bottle, place, light: 'front', cast });
      const d = p.layerCanvases.shadow.getContext('2d').getImageData(0, 0, 400, 400).data;
      let sx = 0; let sy = 0; let n = 0;
      for (let y = 0; y < 400; y++) for (let x = 0; x < 400; x++) { const a = d[(y * 400 + x) * 4 + 3]!; sx += x * a; sy += y * a; n += a; }
      return { x: sx / n, y: sy / n };
    };
    const [left, right] = await Promise.all([centre({ angle: -1.2 }), centre({ angle: 1.2 })]);
    assert.ok(left.x < 195 && right.x > 205);
    const [short, long] = await Promise.all([centre({ angle: 1.2, length: 0.5 }), centre({ angle: 1.2, length: 2.5 })]);
    assert.ok(long.x - 200 > short.x - 200);
  });
});

describe('the bottle turned, and its shadow moved, sized and turned by hand', () => {
  const current = { bottle: 'left' as const, size: 'medium' as const, logo: 'top-right' as const };

  it('keeps a turn, brought within a half turn either way, and none when it is all but upright', () => {
    const turned = choicesFrom({ place: { bottle: { cx: 0.3, base: 0.9, height: 0.6, rotate: 370 } } }, current);
    assert.equal(turned.place!.bottle!.rotate, 10);
    const upright = choicesFrom({ place: { bottle: { cx: 0.3, base: 0.9, height: 0.6, rotate: 0.2 } } }, current);
    assert.equal(upright.place!.bottle!.rotate, undefined);
    const shadow = choicesFrom({ place: { shadow: { dx: 0.1, dy: -0.02, scale: 9, rotate: -200 } } }, current);
    assert.deepEqual(shadow.place!.shadow, { dx: 0.1, dy: -0.02, scale: 4, rotate: 160 });
    assert.equal(choicesFrom({ place: { shadow: null } }, shadow).place, undefined);
    assert.throws(() => choicesFrom({ place: { shadow: { dx: 'a', dy: 0, scale: 1, rotate: 0 } } }, current));
  });

  it('draws the shadow where it was moved, and says where it now is', async () => {
    const { placeBottle } = await import('../src/server/media/bottleComposite');
    const bottle = (() => { const c = createCanvas(60, 200); const x = c.getContext('2d'); x.fillStyle = '#806040'; x.fillRect(0, 0, 60, 200); return c.toBuffer('image/png'); })();
    const scene = png(400, 400, '#c8c8c8');
    const place = { cx: 0.5, base: 0.7, height: 0.5 };
    const still = await placeBottle({ scene, bottle, place, light: 'front' });
    const moved = await placeBottle({ scene, bottle, place, light: 'front', moveShadow: { dx: 0.2, dy: 0.1, scale: 1.5, rotate: 30 } });
    const a = still.shadowBox!; const b = moved.shadowBox!;
    // It turns and sizes about the bottle's foot, which moved by as much as the shadow did.
    const pa = still.shadowPivot!; const pb = moved.shadowPivot!;
    assert.ok(Math.abs(pa.x - 0.5) < 0.01 && Math.abs(pa.y - 0.7) < 0.01);
    assert.ok(Math.abs(pb.x - pa.x - 0.2) < 1e-6 && Math.abs(pb.y - pa.y - 0.1) < 1e-6);
    assert.ok(Math.abs(b.w / a.w - 1.5) < 1e-6);
    // Grown out from the foot: each edge as far again from it.
    assert.ok(Math.abs((pb.x - b.x) - (pa.x - a.x) * 1.5) < 1e-6);
    // What is drawn went with it: the shadow's weight is to the right of where it was.
    const weight = (p: typeof still) => {
      const d = p.layerCanvases.shadow.getContext('2d').getImageData(0, 0, 400, 400).data;
      let sx = 0; let n = 0;
      for (let i = 3; i < d.length; i += 4) { sx += ((i - 3) / 4 % 400) * d[i]!; n += d[i]!; }
      return sx / n;
    };
    assert.ok(weight(moved) > weight(still) + 40);
  });

  it('turns the bottle about its middle', async () => {
    const { placeBottle } = await import('../src/server/media/bottleComposite');
    const bottle = (() => { const c = createCanvas(40, 200); const x = c.getContext('2d'); x.fillStyle = '#806040'; x.fillRect(0, 0, 40, 200); return c.toBuffer('image/png'); })();
    const scene = png(400, 400, '#c8c8c8');
    const place = { cx: 0.5, base: 0.8, height: 0.5 };
    const alphaAt = async (rotate: number, x: number, y: number) =>
      (await placeBottle({ scene, bottle, place, light: 'front', rotate })).layerCanvases.bottle.getContext('2d').getImageData(x, y, 1, 1).data[3]!;
    // Upright, the bottle fills its middle column; on its side, it lies across the middle instead.
    assert.ok((await alphaAt(0, 200, 130)) > 200);
    assert.ok((await alphaAt(90, 200, 130)) < 30);
    assert.ok((await alphaAt(90, 140, 220)) > 200);
  });
});

describe('a shadow turned all the way round', () => {
  it('stays joined at the bottle\'s foot, darkest there, whichever way it falls', async () => {
    const { placeBottle } = await import('../src/server/media/bottleComposite');
    const bottle = (() => { const c = createCanvas(60, 200); const x = c.getContext('2d'); x.fillStyle = '#806040'; x.fillRect(0, 0, 60, 200); return c.toBuffer('image/png'); })();
    const scene = png(400, 400, '#c8c8c8');
    const place = { cx: 0.5, base: 0.6, height: 0.4 };
    for (const rotate of [0, 90, 180, 270]) {
      const p = await placeBottle({ scene, bottle, place, light: 'left', shadow: 2, moveShadow: { dx: 0, dy: 0, scale: 1, rotate } });
      const ctx = p.layerCanvases.shadow.getContext('2d');
      const at = (x: number, y: number) => ctx.getImageData(x, y, 1, 1).data[3]!;
      // At the foot there is shadow, however it was turned.
      assert.ok(at(200, 242) > 60, `joined at the foot when turned ${rotate}`);
    }
  });
});

describe('the shadow, the reflection and the bottle, each on its own', () => {
  it('moves each one alone: the others stay just where they were', async () => {
    const { placeBottle } = await import('../src/server/media/bottleComposite');
    const bottle = (() => { const c = createCanvas(60, 200); const x = c.getContext('2d'); x.fillStyle = '#806040'; x.fillRect(0, 0, 60, 200); return c.toBuffer('image/png'); })();
    const scene = png(400, 400, '#c8c8c8');
    const place = { cx: 0.5, base: 0.6, height: 0.4 };
    const alpha = (c: any) => Array.from((c.getContext('2d').getImageData(0, 0, 400, 400).data as Uint8ClampedArray).filter((_, i) => i % 4 === 3));
    const still = await placeBottle({ scene, bottle, place, light: 'left', surface: 'gloss' });
    // The reflection lies under the foot, on a layer of its own; the bottle's layer has nothing there.
    assert.ok(still.layerCanvases.reflection.getContext('2d').getImageData(200, 260, 1, 1).data[3]! > 20);
    assert.equal(still.layerCanvases.bottle.getContext('2d').getImageData(200, 260, 1, 1).data[3], 0);
    assert.ok(still.reflectionBox && still.reflectionPivot);

    const shadowMoved = await placeBottle({ scene, bottle, place, light: 'left', surface: 'gloss', moveShadow: { dx: 0.25, dy: 0.1, scale: 1, rotate: 120 } });
    assert.deepEqual(alpha(shadowMoved.layerCanvases.reflection), alpha(still.layerCanvases.reflection));
    assert.deepEqual(alpha(shadowMoved.layerCanvases.bottle), alpha(still.layerCanvases.bottle));

    const reflectionMoved = await placeBottle({ scene, bottle, place, light: 'left', surface: 'gloss', moveReflection: { dx: -0.2, dy: 0.05, scale: 0.8, rotate: 45 } });
    assert.deepEqual(alpha(reflectionMoved.layerCanvases.shadow), alpha(still.layerCanvases.shadow));
    assert.deepEqual(alpha(reflectionMoved.layerCanvases.bottle), alpha(still.layerCanvases.bottle));
    assert.notDeepEqual(alpha(reflectionMoved.layerCanvases.reflection), alpha(still.layerCanvases.reflection));
    assert.ok(Math.abs(reflectionMoved.reflectionPivot!.x - still.reflectionPivot!.x + 0.2) < 1e-6);
  });

  it('has no reflection on a surface that does not reflect, nor under a turned bottle', async () => {
    const { placeBottle } = await import('../src/server/media/bottleComposite');
    const bottle = (() => { const c = createCanvas(60, 200); const x = c.getContext('2d'); x.fillStyle = '#806040'; x.fillRect(0, 0, 60, 200); return c.toBuffer('image/png'); })();
    const scene = png(400, 400, '#c8c8c8');
    const place = { cx: 0.5, base: 0.6, height: 0.4 };
    assert.equal((await placeBottle({ scene, bottle, place, light: 'left', surface: 'matte' })).reflectionBox, null);
    assert.equal((await placeBottle({ scene, bottle, place, light: 'left', surface: 'gloss', rotate: 20 })).reflectionBox, null);
  });
});

describe('the reflection set on its own', () => {
  it('keeps its strength and softness, checked, apart from the shadow and the bottle', async () => {
    // Softness 0 is as the surface gives it: nothing to keep.
    assert.deepEqual(styleFrom({ reflection: 5, reflectionSoft: -1 }), { reflection: 2 });
    assert.deepEqual(styleFrom({ reflection: 1, reflectionSoft: 0 }), {});
    const { placeBottle } = await import('../src/server/media/bottleComposite');
    const bottle = (() => { const c = createCanvas(60, 200); const x = c.getContext('2d'); x.fillStyle = '#806040'; x.fillRect(0, 0, 60, 200); return c.toBuffer('image/png'); })();
    const scene = png(400, 400, '#c8c8c8');
    const place = { cx: 0.5, base: 0.6, height: 0.4 };
    const sum = (c: any) => { let a = 0; const d = c.getContext('2d').getImageData(0, 0, 400, 400).data; for (let i = 3; i < d.length; i += 4) a += d[i]; return a; };
    const plain = await placeBottle({ scene, bottle, place, light: 'left', surface: 'gloss' });
    const faint = await placeBottle({ scene, bottle, place, light: 'left', surface: 'gloss', mirror: { strength: 0.3 } });
    const none = await placeBottle({ scene, bottle, place, light: 'left', surface: 'gloss', mirror: { strength: 0 } });
    assert.ok(sum(faint.layerCanvases.reflection) < sum(plain.layerCanvases.reflection));
    assert.equal(sum(none.layerCanvases.reflection), 0);
    // The shadow and the bottle are just as they were.
    assert.equal(sum(faint.layerCanvases.shadow), sum(plain.layerCanvases.shadow));
    assert.equal(sum(faint.layerCanvases.bottle), sum(plain.layerCanvases.bottle));
    // Softer: spread wider, below the foot, than it was.
    const reach = (c: any) => { const d = c.getContext('2d').getImageData(0, 0, 400, 400).data; let lo = 400; for (let y = 0; y < 400; y++) for (let x = 0; x < 400; x++) if (d[(y * 400 + x) * 4 + 3] > 4 && x < lo) lo = x; return lo; };
    const soft = await placeBottle({ scene, bottle, place, light: 'left', surface: 'gloss', mirror: { soft: 2 } });
    assert.ok(reach(soft.layerCanvases.reflection) < reach(plain.layerCanvases.reflection));
  });
});

describe('a post on one\'s own picture, planned with no model asked', () => {
  it('takes the person\'s quoted words, else one of the brand\'s own headlines, and the pack the request names', async () => {
    const { freeDraft, settlePlan } = await import('../src/server/brain/bench');
    const layouts = [{ name: 'Squeeze the nectar', spec: DEFAULT_LAYOUT }];
    const ctx = { brand: 'Whytehall', variants: [null, 'Honey'], layouts, maxWords: 12 };
    const quoted = 'Whytehall Honey on my rooftop photo "Light it up, together"';
    const own = settlePlan(freeDraft(quoted, 'Whytehall', ['Squeeze the nectar, sip the magic']), { ...ctx, request: quoted });
    assert.equal(own.headline.map((l) => l.text).join(' '), 'Light it up, together');
    assert.equal(own.variant, 'Honey');
    assert.equal(own.layout.name, 'Squeeze the nectar');
    const plain = 'Whytehall on my photo';
    const past = settlePlan(freeDraft(plain, 'Whytehall', ['Squeeze the nectar, sip the magic']), { ...ctx, request: plain });
    assert.equal(past.headline.map((l) => l.text).join(' '), 'Squeeze the nectar, sip the magic');
    assert.equal(past.scene.surface, 'matte');
    // With nothing to go on, the brand's name.
    const bare = settlePlan(freeDraft('', 'Whytehall', []), { ...ctx, request: '' });
    assert.deepEqual(bare.headline.map((l) => l.text), ['Whytehall']);
  });
});
