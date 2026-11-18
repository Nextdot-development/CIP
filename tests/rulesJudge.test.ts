import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judge, type JudgedRule, type PostFacts } from '../src/server/brain/rulesJudge';

const rule = (r: Partial<JudgedRule> & Pick<JudgedRule, 'rule'>): JudgedRule => ({
  id: 'r', code: null, domain: null, ruleType: 'mandatory', severity: 'major', requirement: 'required', allowed: [], prohibited: [], format: 'all', ...r,
});
const post = (p: Partial<PostFacts> = {}): PostFacts => ({
  brand: 'Whytehall', variant: 'Honey', words: ['Golden moments, poured slow'], ownBottle: true,
  logo: { on: true, box: { x: 0.75, y: 0.05, w: 0.18, h: 0.08 }, rotate: 0, opacity: 1, bright: 0, shadow: 0 }, ...p,
});

test('the logo: in its corner, untouched, big enough - answered from the post itself', () => {
  const corner = rule({ domain: 'Logo', rule: 'The brand logo should sit in the top-right corner.', format: 'image' });
  assert.equal(judge(corner, post()).status, 'passed');
  assert.equal(judge(corner, post({ logo: { ...post().logo, box: { x: 0.05, y: 0.85, w: 0.18, h: 0.08 } } })).status, 'broke');
  const untouched = rule({ domain: 'Logo', requirement: 'forbidden', rule: 'Do not alter, distort, recolour, stretch, rotate or otherwise modify an approved logo.' });
  assert.equal(judge(untouched, post()).status, 'passed');
  const turned = judge(untouched, post({ logo: { ...post().logo, rotate: 12, shadow: 1 } }));
  assert.equal(turned.status, 'broke');
  assert.match(turned.why, /turned 12°.*shadow/);
});

test('the words: a quoted word ruled out is found; British spelling checked', () => {
  const spelling = rule({ domain: 'Language', rule: 'Use British English spelling. "Whisky", never "Whiskey".' });
  assert.equal(judge(spelling, post()).status, 'passed');
  assert.equal(judge(spelling, post({ words: ['The finest whiskey'] })).status, 'broke');
  const banned = rule({ requirement: 'forbidden', rule: 'Never use the words "best in the world".', prohibited: ['"best in the world"'] });
  assert.equal(judge(banned, post({ words: ['Simply the best in the world!'] })).status, 'broke');
});

test('a tagline never with a call to action', () => {
  const r = rule({ domain: 'Copy', requirement: 'forbidden', rule: '"Untold Stories from India" is used as a closer, and never paired with a call to action or a promotional offer.' });
  assert.equal(judge(r, post({ words: ['Untold Stories from India'] })).status, 'passed');
  assert.equal(judge(r, post({ words: ['Untold Stories from India', 'Shop now'] })).status, 'broke');
});

test('what the background shows is for eyes, not guessed; a film\'s rule is not for a picture', () => {
  const people = rule({ domain: 'Alcohol Compliance', requirement: 'forbidden', rule: 'Do not depict underage people consuming alcohol.', prohibited: ['Minors', 'Young-looking people'] });
  assert.equal(judge(people, post()).status, 'look');
  const driving = rule({ domain: 'Alcohol Compliance', requirement: 'forbidden', rule: 'Do not depict or imply drinking and driving.', prohibited: ['Driving after drinking'] });
  assert.equal(judge(driving, post()).status, 'look', 'an idea a picture shows is not passed because its words are absent');
  assert.equal(judge(rule({ domain: 'Audio', rule: 'No lyrics about excess.' }), post()).status, 'not-for-this');
  assert.equal(judge(rule({ rule: 'The end card carries the logo.', format: 'video' }), post()).status, 'not-for-this');
});

test('the pack is the brand\'s own; a rule that also rules out things in the scene still asks for a look', () => {
  const pack = rule({ domain: 'Pack / Product', rule: 'Where the creative is meant to communicate the product, the approved pack should be visible.' });
  assert.equal(judge(pack, post()).status, 'passed');
  assert.equal(judge(pack, post({ ownBottle: false })).status, 'look');
  const flavour = rule({ domain: 'Visual', rule: 'A flavour named in the request is the variant whose approved pack is shown. Do not add the flavour itself (honey, bees) to the picture unless asked.' });
  const v = judge(flavour, post());
  assert.equal(v.status, 'look');
  assert.match(v.why, /own cut-out for Honey/);
});
