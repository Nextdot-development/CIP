import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ??= 'postgres://unused@localhost:5432/unused';
const { marketName, mergedMarkets } = await import('../src/server/brain/markets');

test('a market typed in any case is the one known spelling', () => {
  assert.equal(marketName('india'), 'India');
  assert.equal(marketName('  NIGERIA '), 'Nigeria');
  assert.equal(marketName("côte d'ivoire"), "Côte d'Ivoire");
  assert.equal(marketName('Mars  Colony'), 'Mars Colony');
});

test('markets that differ only in case are offered once, with their files together', () => {
  const merged = mergedMarkets([
    { market: 'India', files: 43, facts: 10 },
    { market: 'Nigeria', files: 129, facts: 20 },
    { market: 'india', files: 1, facts: 0 },
    { market: 'mars colony', files: 1, facts: 0 },
    { market: 'Mars Colony', files: 3, facts: 1 },
  ]);
  assert.deepEqual(merged.map((m) => [m.market, m.files]), [['Nigeria', 129], ['India', 44], ['Mars Colony', 4]]);
});
