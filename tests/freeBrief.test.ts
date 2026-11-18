import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freeBrief, aiPlanning } from '../src/server/brain/freeBrief';
import type { BriefInput } from '../src/server/brain/providers/types';

process.env.DATABASE_URL ??= 'postgres://unused@localhost:5432/unused';
const { freeDraft } = await import('../src/server/brain/bench');

const input = (over: Partial<BriefInput> = {}): BriefInput => ({
  requestText: 'A warm evening post for Whytehall Honey on a dark wooden bar counter. Headline: "Golden moments"',
  mediaType: 'image',
  brandFacts: [
    { section: 'visual', attribute: 'lighting', value: 'warm, low, golden', confidence: 0.9 },
    { section: 'visual', attribute: 'colour palette', value: '#c9a227', confidence: 0.8 },
    { section: 'content', attribute: 'tone of voice', value: 'Refined, celebratory', confidence: 0.7 },
  ],
  relevantAssets: [], successfulExamples: [], negativeExamples: [],
  lessons: [{ polarity: 'avoid', statement: 'Cluttered tables', confidence: 0.6 }],
  knownCampaigns: ['Diwali', 'World Cup'], knownProducts: [],
  complianceRules: [{ rule: 'Do not depict underage people.', requirement: 'forbidden', category: 'audience', kind: 'prohibited', allowed: [], prohibited: [] }],
  ...over,
} as BriefInput);

test('planning is free unless asked for', () => {
  delete process.env.CIP_AI_PLANNING;
  assert.equal(aiPlanning(), false);
});

test('a brief with no model: the request, the brand\'s look and rules - never a question', () => {
  const b = freeBrief(input());
  assert.equal(b.clarificationQuestion, null, 'two campaigns on record, and still no question');
  assert.match(b.generationPrompt, /^A warm evening post for Whytehall Honey/);
  assert.match(b.generationPrompt, /lighting: warm, low, golden/);
  assert.doesNotMatch(b.generationPrompt, /#c9a227/, 'a hex code is not a look');
  assert.match(b.generationPrompt, /Never: Cluttered tables; Do not depict underage people\./);
  assert.ok(b.generationPrompt.length <= 3800);
  assert.equal(b.format, 'feed_post');
});

test('a post laid out with no model takes its scene, light and surface from the request', () => {
  const d = freeDraft('A warm evening post on a dark wooden bar counter, golden light from the side. Headline: "Golden moments"', 'Whytehall', []);
  assert.equal(d.creativeDirector.surface, 'gloss');
  assert.equal(d.creativeDirector.light, 'left');
  assert.match(d.creativeDirector.mood, /warm/);
  assert.doesNotMatch(d.creativeDirector.scene, /Golden moments/, 'the headline is not the scene');
  assert.match(d.creativeDirector.scene, /bar counter/);
});
