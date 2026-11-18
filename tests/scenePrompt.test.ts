import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ??= 'postgres://unused@localhost:5432/unused';
const { scenePrompt } = await import('../src/server/media/composePost');
const { fitLayout } = await import('../src/server/brain/layouts');
const { DEFAULT_LAYOUT } = await import('../src/server/brain/bench');

const scene = (description: string) => ({ scene: { description, mood: 'warm', light: 'left' as const, surface: 'gloss' as const } });
const layout = fitLayout(DEFAULT_LAYOUT, 0.8, 1 / 3, 2 / 3);

test('a scene the planner wrote at length is still sent within what the generator takes, with every place and every "no text" kept', () => {
  const long = 'A dark wooden bar counter with golden light and honey tones. '.repeat(60);
  const past = Array.from({ length: 5 }, (_, i) => `Past post ${i}: ${'an amber-lit bar with brass taps and leather stools, '.repeat(12)}`);
  const prompt = scenePrompt(scene(long), layout, 0.8, 2 / 3, ['#c9a227'], { open: true, brandScenes: past, drink: { kind: 'whisky', colour: null } });
  assert.ok(prompt.length <= 3800, `was ${prompt.length}`);
  assert.match(prompt, /no text, letters, numbers/);
  assert.match(prompt, /surface runs level across the whole width/);
  assert.match(prompt, /A dark wooden bar counter/);
});

test('a scene of ordinary length is sent whole, with the brand\'s past scenes', () => {
  const prompt = scenePrompt(scene('A dark wooden bar counter at dusk.'), layout, 0.8, 2 / 3, [], { brandScenes: ['an amber-lit bar'] });
  assert.match(prompt, /A dark wooden bar counter at dusk\./);
  assert.match(prompt, /an amber-lit bar/);
});
