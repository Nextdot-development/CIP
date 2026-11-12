import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * The lines on a brand's card are the words it says, taken from how a model
 * described the picture they were on - never the description itself.
 */
process.env.DATABASE_URL ??= 'postgres://unused@localhost:5432/unused';
const { spokenWords } = await import('../src/server/brain/brandIdentity');

describe('the words a brand says, out of a description of them', () => {
  it('takes what is in quotes, and not a word picked out of the line again', () => {
    assert.equal(spokenWords('"When chocolate takes the lead" displayed over the hero product shot'), 'When chocolate takes the lead');
    assert.equal(spokenWords("The right-side headline reads 'A Richer way to Unwind' with 'Unwind' in large yellow letters"), 'A Richer way to Unwind');
    assert.equal(spokenWords("Large text in the upper-left reads 'Open Bottle.' and 'Open Memories.'"), 'Open Bottle. Open Memories.');
  });

  it('takes what comes before "appears", "printed" and the like, and drops an aside in brackets', () => {
    assert.equal(spokenWords('Refined. Rich. Unexpected appears centred in the lower third in yellow'), 'Refined. Rich. Unexpected');
    assert.equal(spokenWords('Exceptionally Smooth (8PM Honey)'), 'Exceptionally Smooth');
    assert.equal(spokenWords('Time of Your Life'), 'Time of Your Life');
  });

  it('gives nothing for a description with no words of its own', () => {
    assert.equal(spokenWords('Bold white text on the bottle label'), null);
  });
});
