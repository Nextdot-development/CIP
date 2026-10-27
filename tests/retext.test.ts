import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/**
 * Changing a composed post's words without making it again: the new headline
 * checked, and the scene it stands on kept where only it can be.
 */

process.env.DATABASE_URL ??= 'postgres://unused@localhost:5432/unused';
const { headlineFrom } = await import('../src/server/media/retext');
const { assertSafeKey } = await import('../src/server/drive/storage');
const { mediaStorageKey } = await import('../src/server/media/storage');

describe('the new headline', () => {
  it('takes the lines as typed, tidied, each in a part the layout has', () => {
    assert.deepEqual(
      headlineFrom([{ text: '  happy   holi ', role: 'lead' }, { text: 'colours of joy', role: 'key' }, { text: '', role: 'tail' }]),
      [{ text: 'happy holi', role: 'lead' }, { text: 'colours of joy', role: 'key' }],
    );
    assert.deepEqual(headlineFrom([{ text: 'cheers', role: 'shout' }]), [{ text: 'cheers', role: 'lead' }]);
  });

  it('refuses what a post cannot carry', () => {
    assert.throws(() => headlineFrom('happy holi'), /lines/);
    assert.throws(() => headlineFrom([{ text: '   ' }]), /at least one line/);
    assert.throws(() => headlineFrom(Array.from({ length: 5 }, () => ({ text: 'a line' }))), /at most 4 lines/);
    assert.throws(() => headlineFrom([{ text: 'x'.repeat(81) }]), /80 characters/);
    assert.throws(() => headlineFrom(Array.from({ length: 4 }, () => ({ text: 'one two three four five six' }))), /20 words/);
  });
});

describe('where the scene is kept', () => {
  it('is a fixed place beside the generation, and nowhere a caller could choose', () => {
    const company = randomUUID();
    const generation = randomUUID();
    assert.doesNotThrow(() => assertSafeKey(mediaStorageKey(company, generation, 'scene', 'png')));
    assert.throws(() => assertSafeKey(mediaStorageKey(company, generation, 'scene-of-something', 'png')));
    assert.throws(() => assertSafeKey(`companies/${company}/media/${generation}/../scene.png`));
  });
});
