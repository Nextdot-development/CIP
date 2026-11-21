import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { COLLECTION, STANDARD, marketsFor, packFamily, packsOf, variantForPack } from '../src/lib/packs';

describe("a brand's packs, as a person chooses between them", () => {
  it('puts every picture of one pack together', () => {
    assert.equal(packFamily('Fire with box'), 'Fire');
    assert.equal(packFamily('Asava with nest'), 'Asava');
    assert.equal(packFamily('Asava tilted'), 'Asava');
    assert.equal(packFamily('Jugalbandi 6 with box'), 'Jugalbandi');
    assert.equal(packFamily('With box'), STANDARD);
    assert.equal(packFamily(null), STANDARD);
    assert.equal(packFamily('750ml with tube'), STANDARD);
    assert.equal(packFamily('Pocket Pack'), STANDARD);
    assert.equal(packFamily('Range of four'), COLLECTION);
    assert.equal(packFamily('Black and Gold'), COLLECTION);
  });

  it('offers Standard first and Collection last', () => {
    assert.deepEqual(packsOf(['Honey', 'Fire with box', null, 'Range of four', 'Chocolate']), [STANDARD, 'Chocolate', 'Fire', 'Honey', COLLECTION]);
  });

  it('shows the pack on its own before the pack with its box', () => {
    assert.equal(variantForPack('Fire', ['Fire with box', 'Fire', 'Honey']), 'Fire');
    assert.equal(variantForPack('Fire', ['Fire with box']), 'Fire with box');
    assert.equal(variantForPack(STANDARD, ['Mini', null, 'Flask']), null);
    assert.equal(variantForPack('Honey', ['Fire']), undefined);
  });
});

describe("the markets offered for a brand", () => {
  const markets = ['West Africa', 'Nigeria', 'Europe', 'India', 'Ghana', "Côte d'Ivoire", 'Singapore', 'Togo', 'Uganda'];
  it('offers only the markets its facts name', () => {
    assert.deepEqual(marketsFor(['Europe', 'Nigeria and Europe'], markets), ['Nigeria', 'Europe']);
    assert.deepEqual(marketsFor(["Ghana and Côte d'Ivoire"], markets), ['Ghana', "Côte d'Ivoire"]);
    assert.deepEqual(marketsFor(['India, the UK, the US and Singapore'], markets), ['India', 'Singapore']);
  });
  it('takes a region in with its countries, and offers everything when nothing is named', () => {
    assert.deepEqual(marketsFor(['West Africa'], markets), ['West Africa', 'Nigeria', 'Ghana', "Côte d'Ivoire", 'Togo']);
    assert.deepEqual(marketsFor([], markets), markets);
  });
});
