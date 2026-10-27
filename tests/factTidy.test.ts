import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * One way of saying each fact: spellings of one claim counted as one, what is
 * not about a brand left out, and a fact read only off one brand's files
 * given to that brand.
 */

process.env.DATABASE_URL ??= 'postgres://unused@localhost:5432/unused';
const tidyModule = await import('../src/server/brain/factTidy');
const { tidyFact, attributeName, isNeutralHex } = tidyModule;
const { planTidy } = await import('../src/server/brain/brandDnaTidy');
type Row = Parameters<typeof planTidy>[0][number];

const fact = (attribute: string, value: string, brand: string | null = null) =>
  ({ section: 'visual' as const, attribute, value, brand });

describe('a fact said one way', () => {
  it('names an attribute the same however the model spelled it', () => {
    for (const spelling of ['colourPalette', 'colour_palette', 'Colour palette', 'colours', 'dominant colours', 'colorScheme']) {
      assert.equal(attributeName(spelling), 'palette', spelling);
    }
    assert.equal(attributeName('typography'), 'font');
    assert.equal(attributeName('logo_location'), 'logo placement');
    assert.equal(attributeName('tone_of_voice'), 'tone of voice');
    assert.equal(attributeName('productPresentation'), 'product presentation');
  });

  it('says a placement, a case and a scale one way', () => {
    assert.equal(tidyFact(fact('logo placement', 'Top-right corner'))?.value, 'top right');
    assert.equal(tidyFact(fact('logo placement', 'top-right'))?.value, 'top right');
    assert.equal(tidyFact(fact('headline placement', 'upper third, centred'))?.value, 'top centre');
    assert.equal(tidyFact(fact('headline case', 'ALL CAPS'))?.value, 'all caps');
    assert.equal(tidyFact(fact('headline case', 'Uppercase'))?.value, 'all caps');
    assert.equal(tidyFact(fact('headline case', 'Title Case'))?.value, 'title case');
    assert.equal(tidyFact(fact('logo scale', 'Small'))?.value, 'small');
  });

  it('puts an older wording on the same answers the analysis now chooses from', () => {
    const { DESIGN_ANSWERS } = tidyModule;
    for (const [said, cell] of [
      ['centre left', 'middle left'], ['Right-centre', 'middle right'], ['centred', 'centre'], ['middle', 'centre'],
      ['top', 'top centre'], ['lower third', 'bottom centre'], ['left top', 'top left'], ['right', 'middle right'],
    ] as const) {
      const value = tidyFact(fact('product placement', said))?.value;
      assert.equal(value, cell, said);
      assert.ok((DESIGN_ANSWERS.placement as readonly string[]).includes(value!), said);
    }
    for (const [said, scale] of [['about a quarter', 'medium'], ['Dominant', 'large'], ['tiny', 'small'], ['a third', 'medium']] as const) {
      assert.equal(tidyFact(fact('logo scale', said))?.value, scale, said);
    }
  });

  it('keeps the words of a description, a line of copy and a rule', () => {
    assert.equal(tidyFact(fact('headline text', 'JAMUN BOLE TOH'))?.value, 'JAMUN BOLE TOH');
    assert.equal(tidyFact(fact('mood', 'Warm, golden-hour light.'))?.value, 'Warm, golden-hour light');
    assert.equal(
      tidyFact(fact('logo placement', 'Logo sits in the top-right with generous clear space around it on every format'))?.value,
      'Logo sits in the top-right with generous clear space around it on every format',
    );
  });

  it('leaves out what is not about a brand', () => {
    for (const [attribute, value] of [
      ['documentType', 'Investor Presentation'], ['yAxisLabel', 'Realisation (Rs./case)'], ['salutation', 'Dear Brod,'],
      ['contact_email', 'investor@example.com'], ['footer', 'Page 3'], ['signatory', 'A person'], ['gross margin', '42%'],
      ['logo placement', 'unknown'],
    ] as const) {
      assert.equal(tidyFact(fact(attribute, value)), null, attribute);
    }
  });

  it('takes white and black for a background, not a brand colour', () => {
    for (const hex of ['#ffffff', '#FEFDFE', '#fdfcfc', '#000000', '#020201', '#0b0a0c']) assert.ok(isNeutralHex(hex), hex);
    for (const hex of ['#0d84e9', '#ff8a19', '#5a2d0c', '#808080']) assert.ok(!isNeutralHex(hex), hex);
    assert.equal(tidyFact(fact('palette', '#FFFFFF')), null);
    assert.equal(tidyFact(fact('colourPalette', '#0D84E9'))?.value, '#0d84e9');
  });
});

let n = 0;
const row = (attribute: string, value: string, more: Partial<Row> = {}): Row => ({
  id: `f${++n}`, section: 'visual', attribute, value, brand: null, status: 'active', evidence_count: 1,
  file_brands: [], unbranded_files: true, ...more,
});

describe('tidying what is on record', () => {
  it('makes one fact of a claim said several ways, keeping the one already saying it', () => {
    const exact = row('logo placement', 'top right', { evidence_count: 2 });
    const corner = row('logo placement', 'top-right corner', { evidence_count: 9 });
    const caps = row('Logo_Placement', 'Top-Right');
    const plan = planTidy([exact, corner, caps]);
    assert.deepEqual(plan.keep, []);
    assert.deepEqual(plan.merged.map((m) => [m.id, m.into]).sort(), [[corner.id, exact.id], [caps.id, exact.id]]);
  });

  it('gives the claim the best-evidenced fact\'s place when none says it exactly', () => {
    const a = row('colourPalette', '#0D84E9', { evidence_count: 1 });
    const b = row('colour_palette', '#0d84e9', { evidence_count: 4 });
    const plan = planTidy([a, b]);
    assert.deepEqual(plan.keep, [{ id: b.id, attribute: 'palette', value: '#0d84e9', brand: null, status: 'active', kind: 'observed' }]);
    assert.deepEqual(plan.merged, [{ id: a.id, into: b.id }]);
  });

  it('sets aside what is not about a brand, and leaves a person\'s rejection alone', () => {
    const junk = row('documentType', 'Investor Presentation');
    const rejected = row('documentType', 'Annual report', { status: 'rejected' });
    assert.deepEqual(planTidy([junk, rejected]).setAside, [junk.id]);
  });

  it('keeps a claim rejected in every wording it was rejected in', () => {
    const rejected = row('headline case', 'ALL CAPS', { status: 'rejected' });
    const again = row('headline case', 'all caps', { evidence_count: 5 });
    const plan = planTidy([rejected, again]);
    assert.deepEqual(plan.keep, [{ id: again.id, attribute: 'headline case', value: 'all caps', brand: null, status: 'rejected', kind: 'observed' }]);
  });

  it('keeps a claim confirmed in whichever wording a person confirmed it', () => {
    const said = row('logo placement', 'top right', { evidence_count: 9 });
    const confirmed = row('logo placement', 'Top-right corner', { kind: 'preference' });
    const plan = planTidy([said, confirmed]);
    assert.deepEqual(plan.keep, [{ id: said.id, attribute: 'logo placement', value: 'top right', brand: null, status: 'active', kind: 'preference' }]);
    assert.deepEqual(plan.merged, [{ id: confirmed.id, into: said.id }]);
  });

  it('gives a house fact to the one brand whose files it was read from', () => {
    const whytehall = row('logo placement', 'top right', { file_brands: ['Whytehall'], unbranded_files: false });
    const mixed = row('logo placement', 'top right corner', { file_brands: ['Whytehall', '8PM'], unbranded_files: false });
    const plan = planTidy([whytehall, mixed]);
    assert.equal(plan.attributed, 1);
    // The house keeps its claim on the words; Whytehall gets its own, and nothing
    // is merged across the two.
    assert.deepEqual(plan.keep.map((k) => [k.id, k.value, k.brand]).sort(), [
      [mixed.id, 'top right', null], [whytehall.id, 'top right', 'Whytehall'],
    ].sort());
    assert.deepEqual(plan.merged, []);
  });

  it('changes nothing the second time', () => {
    const rows = [
      row('logo placement', 'top right', { evidence_count: 3 }),
      row('logo placement', 'top-right corner'),
      row('colourPalette', '#ffffff'),
    ];
    const first = planTidy(rows);
    const after = rows.map((r) => {
      const kept = first.keep.find((k) => k.id === r.id);
      const into = first.merged.find((m) => m.id === r.id)?.into;
      return {
        ...r, ...(kept ?? {}),
        status: first.setAside.includes(r.id) ? 'set_aside' : into ? 'merged' : kept?.status ?? r.status,
      };
    });
    const second = planTidy(after);
    assert.deepEqual(second.keep, []);
    assert.deepEqual(second.setAside, []);
    assert.deepEqual(second.merged, first.merged);
  });
});
