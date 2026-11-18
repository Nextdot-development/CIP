import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { alignFromWords, capitalsFromWords, cornerFromWords, fontFromWords, inkFromWords, pickHeadline, styleOf, styleScene } from '../src/lib/brandStyle';

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
