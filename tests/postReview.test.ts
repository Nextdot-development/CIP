import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * The Bench's review of a finished post, and the fixes: rebuilt from the same
 * parts where that is enough, the scene painted again once where it is not,
 * and copy that breaks a rule handed back to a person.
 */

process.env.DATABASE_URL ??= 'postgres://unused@localhost:5432/unused';
const { fixesFor, reviewAndFix } = await import('../src/server/media/postReview');
const { NO_TWEAKS, tweaked } = await import('../src/server/media/composePost');
const { DEFAULT_LAYOUT } = await import('../src/server/brain/bench');
const { fitLayout } = await import('../src/server/brain/layouts');
type Fault = Parameters<typeof fixesFor>[0][number];
type Review = Awaited<ReturnType<Parameters<typeof reviewAndFix>[0]['review']>>;

const fault = (f: Fault['fault'], direction: Fault['direction'] = null, detail = 'x'): Fault => ({ fault: f, detail, direction });

describe('what the Bench finds, and the fix', () => {
  it('moves a floating bottle down onto the surface, and a sunk one up', () => {
    assert.ok(fixesFor([fault('bottle_floating', 'down')], NO_TWEAKS, false).tweaks.bottleShift > 0);
    assert.ok(fixesFor([fault('bottle_floating', 'up')], NO_TWEAKS, false).tweaks.bottleShift < 0);
  });

  it('paints the scene again when moving the bottle has not found the surface', () => {
    const moved = { ...NO_TWEAKS, bottleShift: 0.07 };
    const fix = fixesFor([fault('bottle_floating', 'down')], moved, false);
    assert.equal(fix.tweaks.bottleShift, 0.07);
    assert.match(fix.rescene!, /surface the bottle stands on/);
  });

  it('fixes the words and the logo by rebuilding, without a new scene', () => {
    const fix = fixesFor([fault('words_hard_to_read'), fault('words_cramped'), fault('logo_hard_to_read'), fault('bottle_too_big')], NO_TWEAKS, false);
    assert.equal(fix.rescene, null);
    assert.ok(fix.tweaks.scrim > 0 && fix.tweaks.textWidth > 1 && fix.tweaks.textScale < 1 && fix.tweaks.logoShade === 1 && fix.tweaks.bottleScale < 1);
    assert.equal(fix.fixed.length, 4);
  });

  it('paints the scene again, once, for a fault in the scene', () => {
    const first = fixesFor([fault('scene_has_text', null, 'A sign reads OPEN.')], NO_TWEAKS, false);
    assert.match(first.rescene!, /No letters.*A sign reads OPEN/);
    const again = fixesFor([fault('scene_has_text', null, 'A sign reads OPEN.')], NO_TWEAKS, true);
    assert.equal(again.rescene, null);
    assert.equal(again.unresolved.length, 1);
  });

  it('hands copy that breaks a rule to a person, never rewrites it', () => {
    const fix = fixesFor([fault('copy_breaks_rule', null, 'Implies success.')], NO_TWEAKS, false);
    assert.equal(fix.rescene, null);
    assert.deepEqual(fix.unresolved, ['Headline: Implies success.']);
  });
});

describe('the tweaks on the layout', () => {
  it('moves the bottle about its base and widens the words', () => {
    const layout = fitLayout(DEFAULT_LAYOUT, 1);
    const b = layout.bottleBox!;
    const t = tweaked(layout, { ...NO_TWEAKS, bottleShift: 0.03, bottleScale: 0.9, textWidth: 1.2 });
    assert.ok(Math.abs(t.bottleBox!.y + t.bottleBox!.h - (b.y + b.h + 0.03)) < 1e-9, 'the base moved down');
    assert.ok(Math.abs(t.bottleBox!.h - b.h * 0.9) < 1e-9);
    assert.ok(Math.abs(t.bottleBox!.x + t.bottleBox!.w / 2 - (b.x + b.w / 2)) < 1e-9, 'still centred where it was');
    assert.ok(Math.abs(t.text!.width - layout.text!.width * 1.2) < 1e-9);
  });
});

describe('reviewing and fixing', () => {
  const review = (faults: Fault[], score = 6): Review => ({ creativeDirector: 'cd', brandManager: 'bm', artDirector: 'ad', faults, score, usage: {} });
  const harness = (reviews: Review[]) => {
    const built: { scene: string; tweaks: typeof NO_TWEAKS }[] = [];
    const scenes: string[] = [];
    return {
      built, scenes,
      run: (opts: { regenerate?: boolean; maxReviews?: number } = {}) => reviewAndFix({
        scene: Buffer.from('scene-1'),
        build: async (scene, tweaks) => {
          built.push({ scene: scene.toString(), tweaks });
          return { bytes: Buffer.from(''), width: 1, height: 1, logo: null, substitutes: [], tweaks };
        },
        review: async () => reviews.shift() ?? review([], 9),
        regenerate: opts.regenerate === false ? null : async (note) => { scenes.push(note); return Buffer.from(`scene-${scenes.length + 1}`); },
        maxReviews: opts.maxReviews,
      }),
    };
  };

  it('stops at once when the Bench finds nothing', async () => {
    const h = harness([review([], 9)]);
    const out = await h.run();
    assert.equal(h.built.length, 1);
    assert.equal(out.rounds.length, 1);
  });

  it('rebuilds with the fix, and looks again', async () => {
    const h = harness([review([fault('bottle_floating', 'down')]), review([], 9)]);
    const out = await h.run();
    assert.equal(h.built.length, 2);
    assert.ok(h.built[1]!.tweaks.bottleShift > 0);
    assert.deepEqual(out.rounds.map((r) => r.score), [6, 9]);
    assert.deepEqual(out.rounds[0]!.fixed, ['Moved the bottle down onto the surface.']);
  });

  it('paints a new scene for a scene fault, and starts the bottle afresh on it', async () => {
    const h = harness([review([fault('bottle_floating', 'down'), fault('scene_has_bottle', null, 'A second bottle on the left.')]), review([], 8)]);
    await h.run();
    assert.equal(h.scenes.length, 1);
    assert.match(h.scenes[0]!, /No bottles.*second bottle/);
    assert.equal(h.built[1]!.scene, 'scene-2');
    assert.equal(h.built[1]!.tweaks.bottleShift, 0);
  });

  it('without a way to paint again, reports the scene fault instead', async () => {
    const h = harness([review([fault('scene_flawed', null, 'The table melts.')])]);
    const out = await h.run({ regenerate: false });
    assert.equal(h.built.length, 1);
    assert.deepEqual(out.unresolved, ['The table melts.']);
  });

  it('keeps the post it has when a review fails', async () => {
    const out = await reviewAndFix({
      scene: Buffer.from('s'),
      build: async (_s, tweaks) => ({ bytes: Buffer.from('post'), width: 1, height: 1, logo: null, substitutes: [], tweaks }),
      review: async () => { throw new Error('down'); },
    });
    assert.equal(out.post.bytes.toString(), 'post');
    assert.equal(out.rounds.length, 0);
  });
});
