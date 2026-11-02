import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * The Bench's plan, settled against what the brand has: a layout and a pack
 * that exist, the person's own words kept, the brand's names written exactly.
 */

process.env.DATABASE_URL ??= 'postgres://unused@localhost:5432/unused';
const { DEFAULT_LAYOUT, describeLayout, givenWords, headlineLimit, pastHeadlines, settlePlan } = await import('../src/server/brain/bench');
type Draft = Parameters<typeof settlePlan>[0];

const squeeze = {
  name: 'Squeeze the nectar, sip the magic',
  spec: {
    ...DEFAULT_LAYOUT,
    text: { ...DEFAULT_LAYOUT.text!, lines: DEFAULT_LAYOUT.text!.lines.filter((l) => l.role !== 'tail') },
  },
};
const context = { request: 'A new year post for Whytehall Honey', brand: 'Whytehall', variants: ['Honey', null], layouts: [squeeze], brands: ['Whytehall', '8PM', 'Magic Moments'] };
const draft = (over: Partial<Draft['artDirector']> = {}, bm: Partial<Draft['brandManager']> = {}): Draft => ({
  creativeDirector: { idea: 'A first toast of the year.', scene: 'A polished bar at midnight.', mood: 'warm', light: 'left', surface: 'gloss', note: 'Midnight warmth.' },
  brandManager: { variant: 'Honey', keep: ['Happy New Year'], risks: [], note: 'Honey pack.', ...bm },
  artDirector: { layout: squeeze.name, casing: 'sentence', headline: [{ text: 'happy new year', role: 'lead' }, { text: 'sweeter by the sip', role: 'key' }], note: 'Two lines.', ...over },
});

describe('the Bench', () => {
  it('keeps a plan that fits what the brand has', () => {
    const plan = settlePlan(draft(), context);
    assert.equal(plan.layout.name, squeeze.name);
    assert.equal(plan.variant, 'Honey');
    assert.deepEqual(plan.headline.map((l) => l.role), ['lead', 'key']);
    assert.deepEqual(plan.settled, []);
    assert.ok(plan.keep.includes('Whytehall') && plan.keep.includes('Whytehall Honey') && plan.keep.includes('Happy New Year'));
  });

  it('replaces a layout or a pack that does not exist, and says so', () => {
    const plan = settlePlan(draft({ layout: 'Golden hour' }, { variant: 'Fire' }), context);
    assert.equal(plan.layout.name, squeeze.name);
    assert.equal(plan.variant, 'Honey', 'the pack the request names');
    assert.equal(plan.settled.length, 2);
  });

  it('uses only the parts the layout has', () => {
    const plan = settlePlan(draft({ headline: [{ text: 'cheers', role: 'lead' }, { text: 'to the year ahead', role: 'tail' }] }), context);
    // No tail in this layout; its closing words are set in the part it makes
    // stand out, which it does have.
    assert.deepEqual(plan.headline.map((l) => l.role), ['lead', 'key']);
  });

  it('keeps the words a person gave, word for word', () => {
    const request = 'Make a post with the text "Squeeze the nectar, sip the magic" for Whytehall Honey';
    assert.equal(givenWords(request), 'Squeeze the nectar, sip the magic');
    const rewritten = settlePlan(draft({ headline: [{ text: 'Sip the golden magic', role: 'lead' }] }), { ...context, request });
    assert.deepEqual(rewritten.headline, [{ text: 'Squeeze the nectar,', role: 'lead' }, { text: 'sip the magic', role: 'key' }]);
    // Broken differently is fine: the words are the same.
    const broken = settlePlan(draft({ headline: [{ text: 'Squeeze the nectar,', role: 'lead' }, { text: 'sip the magic', role: 'key' }] }), { ...context, request });
    assert.equal(broken.headline.length, 2);
    assert.deepEqual(broken.settled, []);
    // Unless a word is left alone on a line: then broken at their own comma.
    const stray = settlePlan(draft({ headline: [{ text: 'Squeeze the nectar,', role: 'lead' }, { text: 'sip the', role: 'key' }, { text: 'magic', role: 'key' }] }), { ...context, request });
    assert.deepEqual(stray.headline, [{ text: 'Squeeze the nectar,', role: 'lead' }, { text: 'sip the magic', role: 'key' }]);
  });

  it('holds the copy to house spelling and a headline\'s length', () => {
    const plan = settlePlan(draft({ headline: [
      { text: 'the smoothest honey whiskey', role: 'lead' }, { text: 'for every midnight toast', role: 'key' },
      { text: 'and every quiet moment after', role: 'lead' }, { text: 'shared with the people you love', role: 'lead' },
    ] }), context);
    assert.match(plan.headline[0]!.text, /whisky$/);
    assert.ok(plan.headline.reduce((n, l) => n + l.text.split(' ').length, 0) <= 12);
  });

  it('shows the standard pack when none is asked for, by its name when the brand names one', () => {
    const plan = settlePlan(draft({}, { variant: null }), { ...context, brand: 'Magic Moments', request: 'happy new year post', variants: ['Orange', 'Plain', 'Lemon'] });
    assert.equal(plan.variant, 'Plain');
  });

  it('writes names exactly, but not a pack\'s plain word or a whole sentence', () => {
    const plan = settlePlan(draft({}, { keep: ['Honey', 'Squeeze the nectar, sip the magic', 'Happy New Year'] }), context);
    assert.ok(!plan.keep.includes('Honey') && !plan.keep.some((k) => k.startsWith('Squeeze')));
    assert.ok(plan.keep.includes('Whytehall Honey') && plan.keep.includes('Happy New Year'));
  });

  it('notices a headline that repeats an earlier post', () => {
    const plan = settlePlan(draft({ headline: [{ text: 'Squeeze the nectar,', role: 'lead' }, { text: 'sip the magic', role: 'key' }] }), context);
    assert.match(plan.settled.join(' '), /earlier post/);
  });

  it('falls back to the house layout when the brand has none', () => {
    const plan = settlePlan(draft({ layout: 'default' }), { ...context, layouts: [] });
    assert.equal(plan.layout.name, 'default');
    assert.deepEqual(plan.settled, []);
  });

  it('describes a layout in words the bench can choose by', () => {
    const words = describeLayout(squeeze.name, squeeze.spec);
    assert.match(words, /2 lines - lead, key \(in the accent colour\); left-aligned on the left, top/);
    assert.match(words, /bottle right, tall; logo top-right/);
  });
});

describe('the person\'s words, broken well', () => {
  it('never leaves one of their words alone on a line', () => {
    const request = 'Sangam post, text: "Where great stories meet"';
    const plan = settlePlan(draft({ headline: [{ text: 'Where great', role: 'lead' }, { text: 'stories', role: 'key' }, { text: 'meet', role: 'key' }] }), { ...context, request });
    assert.deepEqual(plan.headline, [{ text: 'Where great stories meet', role: 'lead' }]);
  });
});

describe('headlines as long as the brand\'s own', () => {
  it('reads the brand\'s headlines off its layouts and the quoted lines of its posts', () => {
    const lines = pastHeadlines(
      ['Squeeze the nectar, sip the magic', 'A fountain of temptation'],
      [
        "The right-side headline reads 'A Richer way to Unwind' with 'Unwind' in large yellow letters",
        'Rich Notes For Rich Night',
        'Large text in the upper-left reads the brand name',
        "The curved white headline reads 'Looks like it's 8PM'",
        'Open Bottle. Open Memories. — Caption: Every memory tells a story worth revisiting.',
      ],
    );
    assert.deepEqual(lines, [
      'Squeeze the nectar, sip the magic', 'A fountain of temptation', 'A Richer way to Unwind',
      'Rich Notes For Rich Night', 'Open Bottle. Open Memories.',
    ]);
  });

  it('allows as many words as three in four of them keep within', () => {
    assert.equal(headlineLimit(['The gold standard', 'Shared pours', 'A fountain of temptation', 'Rich Notes For Rich Night', 'Squeeze the nectar, sip the magic', 'Catch the fire. Taste the heat']), 6);
    assert.equal(headlineLimit(['Shared pours', 'Gold']), 7, 'too few to read from');
    assert.equal(headlineLimit(['Gold', 'Rich', 'Warm', 'Bold']), 4, 'never under four');
  });

  it('shortens a long headline to that length, and sets the closing words in the part made to stand out', () => {
    const long = draft({ headline: [
      { text: 'Evening, turned honey-gold', role: 'lead' },
      { text: 'soft as a well-kept secret', role: 'lead' },
      { text: 'for small, warm gatherings', role: 'lead' },
    ] });
    assert.deepEqual(settlePlan(long, { ...context, maxWords: 6 }).headline.map((l) => l.text), ['Evening, turned honey-gold']);

    const two = settlePlan(draft({ headline: [{ text: 'Evening, turned', role: 'lead' }, { text: 'honey-gold', role: 'lead' }] }), { ...context, maxWords: 6 });
    assert.deepEqual(two.headline, [{ text: 'Evening, turned', role: 'lead' }, { text: 'honey-gold', role: 'key' }]);
  });
});
