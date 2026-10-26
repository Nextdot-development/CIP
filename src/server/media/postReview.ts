import 'server-only';
import type { PostFault, PostReview } from '../brain/providers/types';
import { NO_TWEAKS, type BuiltPost, type PostTweaks } from './composePost';

/**
 * The Bench looks at the finished post, and what it finds is put right.
 *
 * Most faults are fixed by rebuilding from the same parts - the bottle moved
 * down onto the surface or made smaller, the words given more room or a
 * calmer ground, the logo's corner shaded - which takes a second and costs
 * nothing. A fault in the scene itself (a sign painted into it, a second
 * bottle, a prop through the pack) means painting the scene again, with the
 * fault named; that is done once at most. Copy that breaks a rule is not
 * rewritten here: it is handed back, named, for a person.
 */

export type ReviewRound = {
  score: number;
  faults: { fault: PostFault; detail: string }[];
  notes: { creativeDirector: string; brandManager: string; artDirector: string };
  /** What was done about it. */
  fixed: string[];
};

/** How far a bottle is moved for one "floating" fault, as a share of the height. */
const STEP = 0.035;

/**
 * What to change for the faults found: new tweaks, and when the scene itself
 * is at fault, the note to paint it again with. `rescened` says the scene has
 * already been painted again once.
 */
export function fixesFor(
  faults: { fault: PostFault; detail: string; direction: 'up' | 'down' | null }[],
  current: PostTweaks,
  rescened: boolean,
): { tweaks: PostTweaks; rescene: string | null; fixed: string[]; unresolved: string[] } {
  const tweaks = { ...current };
  const scene: string[] = [];
  const fixed: string[] = [];
  const unresolved: string[] = [];
  for (const f of faults) {
    switch (f.fault) {
      case 'bottle_floating': {
        const by = f.direction === 'up' ? -STEP : STEP;
        // Moved twice the same way and still not standing: the surface is
        // not where the scene was asked to put it.
        if (Math.abs(tweaks.bottleShift + by) > STEP * 2.5) {
          scene.push('The surface the bottle stands on must run level under its spot, clearly visible, with its front edge below the bottle\'s base.');
        } else {
          tweaks.bottleShift += by;
          fixed.push(`Moved the bottle ${by > 0 ? 'down' : 'up'} onto the surface.`);
        }
        break;
      }
      case 'bottle_too_big':
        if (tweaks.bottleScale > 0.75) { tweaks.bottleScale *= 0.88; fixed.push('Made the bottle smaller.'); } else unresolved.push(f.detail);
        break;
      case 'bottle_too_small':
        if (tweaks.bottleScale < 1.2) { tweaks.bottleScale *= 1.1; fixed.push('Made the bottle larger.'); } else unresolved.push(f.detail);
        break;
      case 'words_hard_to_read':
        if (tweaks.scrim < 0.4) { tweaks.scrim += 0.2; fixed.push('Darkened the ground behind the words.'); } else unresolved.push(f.detail);
        break;
      case 'words_cramped':
        // More room where there is any, and a touch smaller: beside the
        // bottle the room runs out, and the type has to give.
        if (tweaks.textScale > 0.75) {
          tweaks.textWidth = Math.min(1.6, tweaks.textWidth * 1.2);
          tweaks.textScale *= 0.9;
          fixed.push('Set the headline a little smaller, with more room.');
        } else unresolved.push(f.detail);
        break;
      case 'logo_hard_to_read':
        if (tweaks.logoShade < 2) { tweaks.logoShade += 1; fixed.push('Shaded the corner behind the logo.'); } else unresolved.push(f.detail);
        break;
      case 'bottle_blocked':
        scene.push(`Nothing may stand in front of or through the bottle's spot. ${f.detail}`);
        break;
      case 'scene_has_text':
        scene.push(`No letters, numbers, signs or logos anywhere in the scene. ${f.detail}`);
        break;
      case 'scene_has_bottle':
        scene.push(`No bottles, cans or packs anywhere in the scene. ${f.detail}`);
        break;
      case 'scene_flawed':
      case 'scene_off_brief':
      case 'scene_breaks_rule':
        scene.push(f.detail);
        break;
      case 'copy_breaks_rule':
        unresolved.push(`Headline: ${f.detail}`);
        break;
    }
  }
  if (scene.length && rescened) unresolved.push(...scene);
  const rescene = scene.length && !rescened ? `Fix in this version: ${scene.join(' ')}` : null;
  if (rescene) fixed.push('Painted the scene again.');
  return { tweaks, rescene, fixed, unresolved };
}

/**
 * The post reviewed and fixed until the Bench passes it, or the reviews or
 * the time run out. Returns the best post made, with what each round found.
 */
export async function reviewAndFix(input: {
  scene: Buffer;
  build: (scene: Buffer, tweaks: PostTweaks) => Promise<BuiltPost>;
  review: (post: BuiltPost) => Promise<PostReview>;
  /** Paints the scene again with a note; absent, scene faults are only reported. */
  regenerate?: ((note: string) => Promise<Buffer>) | null;
  maxReviews?: number;
  /** No new review or new scene is started after this (ms since the epoch). */
  deadline?: number;
}): Promise<{ post: BuiltPost; rounds: ReviewRound[]; unresolved: string[] }> {
  const maxReviews = input.maxReviews ?? 3;
  const deadline = input.deadline ?? Infinity;
  let scene = input.scene;
  let rescened = !input.regenerate;
  let post = await input.build(scene, NO_TWEAKS);
  const rounds: ReviewRound[] = [];
  let unresolved: string[] = [];

  for (let n = 0; n < maxReviews && Date.now() < deadline; n++) {
    let review: PostReview;
    try {
      // Tried twice: a busy provider is the usual reason, and the post is worth a second look.
      review = await input.review(post).catch(() => input.review(post));
    } catch {
      break; // A review that fails leaves the post as it is: it was already made.
    }
    const plan = fixesFor(review.faults, post.tweaks, rescened);
    const round: ReviewRound = {
      score: review.score,
      faults: review.faults.map((f) => ({ fault: f.fault, detail: f.detail })),
      notes: { creativeDirector: review.creativeDirector, brandManager: review.brandManager, artDirector: review.artDirector },
      fixed: [],
    };
    rounds.push(round);
    unresolved = plan.unresolved;
    // Nothing found, or nothing more that can be done: this is the post.
    if (review.faults.length === 0 || (plan.fixed.length === 0 && !plan.rescene)) break;
    // The last review's fixes are applied too; there is just no one to look at them again.
    let fresh = false;
    if (plan.rescene && input.regenerate && Date.now() < deadline) {
      try {
        scene = await input.regenerate(plan.rescene);
        rescened = true;
        fresh = true;
      } catch {
        plan.fixed = plan.fixed.filter((f) => f !== 'Painted the scene again.');
        rescened = true;
      }
    }
    round.fixed = plan.fixed;
    // A new scene has its surface somewhere new: the bottle starts from the layout again.
    post = await input.build(scene, fresh ? { ...plan.tweaks, bottleShift: 0 } : plan.tweaks);
  }
  return { post, rounds, unresolved };
}
