import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas } from '@napi-rs/canvas';

/**
 * The headline, set the way the brand's designers set it: the right capitals,
 * the brand's faces, every line on the same edge, the box behind its line.
 */

process.env.DATABASE_URL ??= 'postgres://unused@localhost:5432/unused';
const { balancedLines, caseLines, faceFor, setHeadline } = await import('../src/server/media/typography');
const { fitLayout } = await import('../src/server/brain/layouts');
type Spec = Parameters<typeof fitLayout>[0];

describe('capitals', () => {
  it('writes an occasion as a name, whatever the rule', () => {
    assert.deepEqual(caseLines(['happy new year', 'from all of us'], 'sentence'), ['Happy New Year', 'from all of us']);
    assert.deepEqual(caseLines(['wishing you a happy diwali'], 'sentence'), ['Wishing you a happy Diwali']);
  });

  it('keeps the brand\'s own names exactly as written', () => {
    assert.deepEqual(caseLines(['celebrate with magic moments and 8pm'], 'sentence', ['Magic Moments', '8PM']), ['Celebrate with Magic Moments and 8PM']);
    assert.deepEqual(caseLines(['raise a glass of 8pm'], 'upper', ['8PM']), ['RAISE A GLASS OF 8PM']);
  });

  it('gives one rule to the whole headline: a sentence runs on across its lines', () => {
    assert.deepEqual(caseLines(['SQUEEZE THE nectar,', 'sip the MAGIC'], 'sentence'), ['Squeeze the nectar,', 'sip the magic']);
    assert.deepEqual(caseLines(['the night is young.', 'pour another'], 'sentence'), ['The night is young.', 'Pour another']);
  });

  it('starts each new phrase with a capital, runs a broken one on, and keeps the names a writer capitalised', () => {
    assert.deepEqual(
      caseLines(['happy new year', "here's to new beginnings", 'celebrate responsibly'], 'sentence'),
      ['Happy New Year', "Here's to new beginnings", 'Celebrate responsibly'],
    );
    assert.deepEqual(caseLines(['Rainy night,', 'good company,', 'one bottle to share'], 'sentence'), ['Rainy night,', 'good company,', 'one bottle to share']);
    assert.deepEqual(caseLines(['raise a glass to', 'the year ahead'], 'sentence'), ['Raise a glass to', 'the year ahead']);
    assert.deepEqual(caseLines(['Palace dusk', 'Rajasthan reigns'], 'sentence'), ['Palace dusk', 'Rajasthan reigns']);
    assert.deepEqual(caseLines(['Sip The Golden Magic'], 'sentence'), ['Sip the golden magic']);
    // Written with capitals: a line the writer began small runs on.
    assert.deepEqual(caseLines(['An evening', 'fit for royalty'], 'sentence'), ['An evening', 'fit for royalty']);
  });

  it('in title case, leaves the small words small but never the first or last', () => {
    assert.deepEqual(caseLines(['sweet moments and smooth sips of the night'], 'title'), ['Sweet Moments and Smooth Sips of the Night']);
    assert.deepEqual(caseLines(['the spirit we live by'], 'title'), ['The Spirit We Live By']);
  });
});

describe('breaking lines', () => {
  const measure = (s: string) => s.length * 10;
  it('breaks evenly, and never leaves one word alone below', () => {
    const lines = balancedLines('Squeeze the nectar sip the magic', 200, measure);
    assert.deepEqual(lines, ['Squeeze the nectar', 'sip the magic']);
    for (const l of balancedLines('A toast to every new beginning ahead', 200, measure)) assert.ok(l.split(' ').length > 1, `"${l}" is alone`);
  });
  it('leaves a line that fits as it is', () => {
    assert.deepEqual(balancedLines('Cheers', 200, measure), ['Cheers']);
  });
});

describe('faces', () => {
  it('uses the brand\'s face when CIP holds it, and a named look-alike when it does not', () => {
    const poppins = faceFor({ font: 'Poppins-SemiBold', weight: 'bold', italic: false, script: false });
    assert.equal(poppins.substitute, false);
    const chloe = faceFor({ font: 'Chloe-Regular', weight: 'regular', italic: false, script: true });
    assert.equal(chloe.substitute, true);
    assert.match(chloe.file, /AbrilFatface/);
  });
});

describe('setting the headline', () => {
  const spec: Spec = {
    ratio: 1,
    logo: null,
    bottle: { cx: 0.75, base: 0.9, height: 0.7 },
    text: {
      x: 0.06, y: 0.3, width: 0.45, align: 'left', leading: 1.1, ink: '#ffffff', accent: '#ffd309',
      lines: [
        { role: 'lead', size: 0.06, font: 'Poppins-SemiBold', weight: 'bold', italic: false, script: false, upper: false, tracking: 0, accent: false, box: null },
        { role: 'key', size: 0.07, font: 'Poppins-SemiBold', weight: 'bold', italic: false, script: false, upper: false, tracking: 0, accent: false, box: '#ffffff' },
        { role: 'tail', size: 0.05, font: 'Chloe-Regular', weight: 'regular', italic: false, script: true, upper: false, tracking: 0, accent: true, box: null },
      ],
    },
  };
  const scene = () => {
    const c = createCanvas(1000, 1000);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#20140c';
    ctx.fillRect(0, 0, 1000, 1000);
    return c.toBuffer('image/png');
  };

  it('starts every line on the same edge, inside the block, in the capitals asked for', async () => {
    const layout = fitLayout(spec, 1);
    const set = await setHeadline({
      image: scene(), layout,
      lines: [{ text: 'happy new year', role: 'lead' }, { text: 'raise a glass', role: 'key' }, { text: 'with magic moments', role: 'tail' }],
      keep: ['Magic Moments'],
    });
    assert.deepEqual(set.lines.map((l) => l.text), ['Happy New Year', 'Raise a glass', 'with Magic Moments']);
    const left = set.lines[0]!.box.x;
    // Wider than the designer's words if it must be, but never up to the bottle.
    const edge = (layout.bottleBox!.x - 0.03) * 1000;
    for (const l of set.lines) {
      assert.ok(Math.abs(l.box.x - left) < 0.5, `"${l.text}" starts at ${l.box.x}, not ${left}`);
      assert.ok(l.box.x + l.box.w <= edge + 1, `"${l.text}" runs into the bottle`);
      assert.ok(l.box.y >= 0 && l.box.y + l.box.h <= 1000, `"${l.text}" leaves the post`);
    }
    for (const [a, b] of set.lines.slice(0, -1).map((l, i) => [l, set.lines[i + 1]!] as const)) {
      assert.ok(b.box.y >= a.box.y + a.box.h, `"${b.text}" overlaps "${a.text}"`);
    }
  });

  it('sets a short closing line a little smaller rather than split it', async () => {
    const fitted = fitLayout(spec, 1);
    const narrow = { ...fitted, text: { ...fitted.text!, width: 0.25 }, bottleBox: { ...fitted.bottleBox!, x: 0.45 } };
    const set = await setHeadline({ image: scene(), layout: narrow, lines: [{ text: 'cheers', role: 'lead' }, { text: 'share the moment', role: 'tail' }] });
    assert.deepEqual(set.lines.map((l) => l.text), ['Cheers', 'Share the moment']);
  });

  it('never runs past the bottle, however wide the block was made', async () => {
    const fitted = fitLayout(spec, 1);
    const wide = { ...fitted, text: { ...fitted.text!, width: 0.9 } };
    const set = await setHeadline({ image: scene(), layout: wide, lines: [{ text: 'celebrate with warmth and good company tonight', role: 'lead' }] });
    const edge = (fitted.bottleBox!.x - 0.03) * 1000;
    for (const l of set.lines) assert.ok(l.box.x + l.box.w <= edge + 1, `"${l.text}" runs into the bottle`);
  });

  it('puts the box behind its own line, the words dark on it', async () => {
    const set = await setHeadline({ image: scene(), layout: fitLayout(spec, 1), lines: [{ text: 'cheers', role: 'lead' }, { text: 'tonight', role: 'key' }] });
    const { createCanvas: cc, loadImage } = await import('@napi-rs/canvas');
    const img = await loadImage(set.bytes);
    const ctx = cc(1000, 1000).getContext('2d');
    ctx.drawImage(img, 0, 0);
    const key = set.lines[1]!.box;
    // Just left of the key word: inside its box's padding, so white.
    const [r] = ctx.getImageData(Math.round(key.x - 3), Math.round(key.y + key.h / 2), 1, 1).data;
    assert.ok(r! > 240, 'no box behind the key line');
    const lead = set.lines[0]!.box;
    const [r2] = ctx.getImageData(Math.round(lead.x - 3), Math.round(lead.y + lead.h / 2), 1, 1).data;
    assert.ok(r2! < 80, 'a box behind a line that has none');
  });

  it('says which faces stood in for the brand\'s own', async () => {
    const set = await setHeadline({ image: scene(), layout: fitLayout(spec, 1), lines: [{ text: 'cheers', role: 'lead' }, { text: 'tonight', role: 'tail' }] });
    assert.deepEqual(set.lines.map((l) => l.substitute), [false, true]);
  });
});
