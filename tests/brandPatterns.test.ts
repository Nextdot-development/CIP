import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * What a creative is held to: the brand's standing patterns, not everything it
 * was ever seen doing; and only the rules that can apply to what it is.
 */

process.env.DATABASE_URL ??= 'postgres://unused@localhost:5432/unused';
const { standingPatterns } = await import('../src/server/brain/brandPatterns');
const { rulesFor } = await import('../src/server/brain/checker');
type Fact = Parameters<typeof standingPatterns>[0][number];

let n = 0;
const fact = (attribute: string, value: string, evidenceCount: number, brand: string | null = null, section: Fact['section'] = 'visual'): Fact => ({
  id: `f${++n}`, section, attribute, value, kind: 'derived', confidence: 0.8, evidenceCount, updatedAt: '', markets: [], brand,
});
const said = (facts: Fact[]) => facts.map((f) => `${f.attribute}: ${f.value}`);

describe('the brand\'s standing patterns', () => {
  it('takes what a person confirmed over what the files mostly show', () => {
    const confirmed = { ...fact('logo placement', 'bottom right', 3, 'Whytehall'), kind: 'preference' as const };
    const kept = standingPatterns([fact('logo placement', 'top right', 20, 'Whytehall'), confirmed], 'Whytehall');
    assert.deepEqual(said(kept), ['logo placement: bottom right']);
  });

  it('keeps what the brand plainly does, counting the same thing said several ways as one', () => {
    const kept = standingPatterns([
      fact('logo placement', 'top-right', 41), fact('logo placement', 'top-right corner', 18), fact('logo placement', 'top-left', 4),
      fact('headline placement', 'upper third centred', 34), fact('headline placement', 'top-centred', 23), fact('headline placement', 'top-left', 14),
    ], null);
    assert.deepEqual(said(kept), ['logo placement: top-right', 'headline placement: upper third centred']);
    assert.equal(kept[0]!.evidenceCount, 59);
  });

  it('holds nobody to a pattern the brand does not plainly have', () => {
    const kept = standingPatterns([fact('headline case', 'all caps', 12), fact('headline case', 'Title case', 9)], null);
    assert.deepEqual(kept, []);
  });

  it('sets aside what describes a document, one pack or one campaign', () => {
    const kept = standingPatterns([
      fact('documentType', 'Investor Presentation', 3), fact('yAxisLabel', 'Realisation (Rs./case)', 3),
      fact('contact email', 'investor@radico.co.in', 3), fact('palette', '#fefefe', 9),
      fact('flavour text', 'LEMONGRASS & GINGER', 2, 'Magic Moments'), fact('bottle cap text', 'WHYTEHALL', 3, 'Magic Moments'),
      fact('headline text', 'JAMUN BOLE TOH', 11), fact('positioning language', 'UNDERRATED. UNAPOLOGETIC. UNFORGETTABLE.', 2, 'Magic Moments', 'content'),
      fact('logo scale', 'small', 28, 'Magic Moments'),
    ], 'Magic Moments');
    assert.deepEqual(said(kept), ['logo scale: small']);
  });

  it('takes the brand\'s own pattern over the house\'s, and never another brand\'s', () => {
    const kept = standingPatterns([
      fact('headline case', 'all caps', 60), fact('headline case', 'sentence case', 9, '8PM'),
      fact('logo placement', 'top-left', 20, 'Whytehall'),
    ], '8PM');
    assert.deepEqual(said(kept), ['headline case: sentence case']);
  });

  it('holds the house to its logo and headline, not to a background its packshots happen to share', () => {
    const kept = standingPatterns([fact('background colour', 'solid black', 26), fact('logo scale', 'small', 87)], null);
    assert.deepEqual(said(kept), ['logo scale: small']);
    const own = standingPatterns([fact('background', 'black', 6, '8PM')], '8PM');
    assert.deepEqual(said(own), ['background: black']);
  });

  it('for judging, leaves out a mood board that cannot be met or missed', () => {
    const board = fact('recurring visual language', 'black; ivory; metallic gold; crest; crown; filigree', 2, 'Whytehall');
    assert.equal(standingPatterns([board], 'Whytehall', { forChecking: true }).length, 0);
    assert.equal(standingPatterns([board], 'Whytehall').length, 1, 'still there for a brief');
  });
});

describe('the rules for what a creative is', () => {
  const rule = (text: string, category = 'other', ruleType = 'prohibited') => ({ rule: text, category, ruleType });
  const rules = [
    rule('Only in a brand-extension (surrogate) creative - one advertising soda - the alcoholic product must not be shown.', 'claim', 'conditional'),
    rule('Do not alter, distort, recolour, stretch, rotate or otherwise modify an approved brand logo.'),
    rule('Product packaging must not be distorted or incorrectly generated.'),
    rule('Carry "Drink Responsibly".', 'disclaimer', 'mandatory'),
    rule('Where the creative is meant to communicate the product, the approved pack should be visible.', 'other', 'contextual'),
    rule('Competitor brand logos must not appear.'),
  ];

  it('judges an uploaded creative against every rule', () => {
    assert.equal(rulesFor(rules, { generated: false, composed: false }).length, rules.length);
  });

  it('never asks a picture CIP made for legal lines, or treats it as a surrogate', () => {
    const kept = rulesFor(rules, { generated: true, composed: false }).map((r) => r.rule);
    assert.ok(!kept.some((r) => /surrogate|Drink Responsibly/.test(r)));
    assert.ok(kept.some((r) => /distorted/.test(r)), 'a drawn pack can still be drawn wrong');
  });

  it('never faults the design of the approved pack and logo a composed post placed unchanged', () => {
    const kept = rulesFor(rules, { generated: true, composed: true }).map((r) => r.rule);
    assert.deepEqual(kept, [
      'Where the creative is meant to communicate the product, the approved pack should be visible.',
      'Competitor brand logos must not appear.',
    ]);
  });
});
