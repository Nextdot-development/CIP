import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { alignFromWords, asksForGlass, capitalsFromWords, cornerFromWords, fontFromWords, inkFromWords, pickHeadline, styleOf, styleScene } from '../src/lib/brandStyle';

const kohinoor = styleOf([
  { attribute: 'background', value: 'black background' },
  { attribute: 'background', value: 'Candlelit, luxurious interiors and festive tables' },
  { attribute: 'lighting', value: 'warm' },
  { attribute: 'props', value: 'Diyas and marigolds at Diwali; Holi colours; cocktails with orange and cherry' },
  { attribute: 'headline style', value: 'Gold serif small capitals, a short line above a larger one, at the top or the foot' },
  { attribute: 'logo placement', value: 'top right' },
  { attribute: 'colour use', value: 'Deep crimson and black, with gold type' },
]);

describe('brand style, read from its facts', () => {
  it('takes a look said for one market or pack only for that market or pack', () => {
    const facts = [
      { attribute: 'background', value: 'Nigeria: bright flat colour cards with fruit' },
      { attribute: 'background', value: 'Europe: dark nostalgic evenings' },
      { attribute: 'background', value: 'Honey: sunny daylight by a pool' },
      { attribute: 'background', value: 'A bar at night' },
    ];
    assert.deepEqual(styleOf(facts, { market: 'Nigeria', request: 'a weekend post' }).backgrounds, ['Nigeria: bright flat colour cards with fruit', 'A bar at night']);
    assert.deepEqual(styleOf(facts, { market: 'Europe', request: '' }).backgrounds, ['Europe: dark nostalgic evenings', 'A bar at night']);
    assert.deepEqual(styleOf(facts, { market: 'Ghana', request: 'Honey summer post' }).backgrounds, ['Honey: sunny daylight by a pool', 'A bar at night']);
    assert.deepEqual(styleOf(facts).backgrounds, ['A bar at night']);
    // The scene says it without the scope.
    assert.match(styleScene(styleOf(facts, { market: 'Nigeria', request: '' }), 'a weekend post', 'Nigeria') ?? '', /^bright flat colour cards/);
  });

  it('chooses the line that shares the flavour of the post, not the brand name', () => {
    const lines = ['Make tonight a Magic Moment', 'A burst of orange in every sip', 'Pure raspberry bliss'];
    assert.equal(pickHeadline('Magic Moments orange flavour post', lines, 12, 'Magic Moments'), 'A burst of orange in every sip');
    assert.equal(pickHeadline('a raspberry night', lines, 12, 'Magic Moments'), 'Pure raspberry bliss');
  });

  it('keeps what never goes in the scene', () => {
    const s = styleOf([{ attribute: 'never in scene', value: 'plastic cups' }, { attribute: 'Never in scene', value: 'neon signs' }]);
    assert.deepEqual(s.never, ['plastic cups', 'neon signs']);
  });

  it('sets a plain packshot background aside', () => {
    assert.deepEqual(kohinoor.backgrounds, ['Candlelit, luxurious interiors and festive tables']);
  });

  it('reads the logo corner, the face, the colour and the alignment off words', () => {
    assert.equal(cornerFromWords('top right'), 'top-right');
    assert.equal(cornerFromWords('in the lower left corner'), 'bottom-left');
    assert.equal(cornerFromWords('centred'), null);
    assert.equal(fontFromWords('Gold serif capitals paired with a flowing gold script'), 'playfair-display');
    assert.equal(fontFromWords('A flowing script'), 'brittany-signature');
    assert.equal(fontFromWords('Clean sans-serif'), 'poppins');
    assert.equal(inkFromWords('Serif headline centred near the top, in cream, white or gold'), '#f3e6c8');
    assert.equal(alignFromWords('Serif headline centred near the top'), 'center');
    assert.equal(capitalsFromWords(kohinoor.headlineStyle), true);
  });

  it('paints the props of the occasion asked for, and only those', () => {
    const diwali = styleScene(kohinoor, 'A Diwali post with the bottle on a table');
    assert.match(diwali ?? '', /Diyas and marigolds/);
    assert.doesNotMatch(diwali ?? '', /Holi/);
    const plain = styleScene(kohinoor, 'The bottle on a bar counter in the evening');
    assert.doesNotMatch(plain ?? '', /Diyas|Holi/);
    assert.match(plain ?? '', /warm light/);
  });

  it('chooses the headline that shares the occasion, and no festival line for an ordinary post', () => {
    const lines = ['Elegance in every pour', 'For the jewels in your life, a Kohinoor this Diwali', 'This Holi, savor colors', 'The evening prepares itself'];
    assert.equal(pickHeadline('Diwali gifting post', lines), 'For the jewels in your life, a Kohinoor this Diwali');
    assert.equal(pickHeadline('Holi celebration', lines), 'This Holi, savor colors');
    for (const ask of ['A bar counter shot', 'Bottle on marble', 'A quiet tasting', 'Glass and bottle together']) {
      assert.ok(!/Diwali|Holi/.test(pickHeadline(ask, lines) ?? ''), ask);
    }
    assert.equal(pickHeadline('anything', []), null);
  });
});

describe('a scene painted with no glass in it', () => {
  it('leaves glasses, ice and drinks to be laid on afterwards, and keeps the rest', () => {
    const s = styleOf([{ attribute: 'background', value: 'Dark lounge' }, { attribute: 'props', value: 'A cut-crystal rocks glass with large ice cubes; Honey: honeycomb and a honey dipper; playing cards, a cocktail' }], { request: 'Honey: a post' });
    const scene = styleScene(s, 'Honey: a post') ?? '';
    assert.match(scene, /honeycomb/);
    assert.doesNotMatch(scene, /glass|ice|cocktail/i);
  });
});

describe('a glass painted only when it is asked for', () => {
  it('reads a glass or a drink in the request', () => {
    assert.equal(asksForGlass('A Honey post with a rocks glass and ice cubes'), true);
    assert.equal(asksForGlass('A G&T for summer'), true);
    assert.equal(asksForGlass('A sunny afternoon by the pool'), false);
  });
  it('keeps the brand glass and serve in the scene when asked', () => {
    const s = styleOf([{ attribute: 'background', value: 'Dark lounge' }, { attribute: 'props', value: 'A cut-crystal rocks glass with large ice cubes; playing cards' }, { attribute: 'serve', value: 'Neat in a rocks glass' }]);
    assert.match(styleScene(s, 'A post with a glass of whisky') ?? '', /rocks glass/);
    assert.doesNotMatch(styleScene(s, 'A quiet evening post') ?? '', /glass/);
  });
});
