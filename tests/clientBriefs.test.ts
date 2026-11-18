import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestFor } from '../src/lib/briefRequest';

test('a brief piece becomes a request that names the brand, market, size, products and what the brief asks', () => {
  const text = requestFor(
    { brands: ['8PM'], market: 'Ghana', skus: ['8PM regular bottle'], notes: ['Campaign line: "Time of Your Life"', 'No Radico logo.'] },
    { what: 'Shelf top panel', size: '41 x 16 in', ratio: '41:16' },
  );
  assert.equal(text, 'Shelf top panel for 8PM, Ghana. Size: 41 x 16 in (41:16). Products: 8PM regular bottle. Brief: Campaign line: "Time of Your Life". No Radico logo.');
});

test('a piece with no brand, market or size asks only for what it is', () => {
  assert.equal(requestFor({ brands: [], market: null, skus: [], notes: [] }, { what: 'Wall G1' }), 'Wall G1.');
  assert.equal(requestFor({ brands: [], market: null, skus: [], notes: [] }, { what: 'A2 poster', ratio: '1:1.414' }), 'A2 poster. Shape: 1:1.414.');
});

test('a piece that names its brand is for that brand alone', () => {
  const brief = { brands: ['8PM', 'Magic Moments', 'Old Admiral'], market: 'Uganda', skus: [], notes: [] };
  assert.equal(requestFor(brief, { what: 'A2 poster - Magic Moments', ratio: '1:1.414' }), 'A2 poster - Magic Moments, Uganda. Shape: 1:1.414.');
  assert.equal(requestFor(brief, { what: 'High-res logos' }), 'High-res logos for 8PM, Magic Moments, Old Admiral, Uganda.');
});
