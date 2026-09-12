import 'server-only';
import type { CompanyScope } from '../db';
import { generateImage, generateVideo } from '../media/generation';
import type { MediaGenerationDTO } from '../media/types';
import { ANALYSABLE_IMAGE_TYPES, BRAIN_LIMITS } from './providers/types';
import { linkBriefToGeneration, planGeneration, promptFromBrief } from './planner';
import type { PlannedGeneration } from './planner';
import { FORMAT_ASPECT, FORMAT_LABELS, closestAspectRatio } from './providers/types';
import type { CreativeFormat } from './providers/types';
import { imageGenerationProvider, videoGenerationProvider } from '../media/providers';
import { MEDIA_LIMITS } from '../media/providers/types';
import { requestedShape, sameShape } from '../media/reframe';
import type { TargetShape } from '../media/reframe';

/**
 * Generating with the Brain in front.
 *
 * The existing image and video providers are used unchanged — this decides
 * *what* to ask them for, and they still do the generating. Provider selection,
 * rate limiting, storage and the media record all behave exactly as they did.
 *
 * Two outcomes. Either the Brain had enough to work with and a generation
 * happened, or it did not and a question comes back instead. It never guesses
 * at something it was asked to be sure about.
 */

export type BrainGenerationResult =
  | {
      status: 'generated';
      generation: MediaGenerationDTO;
      briefId: string;
      /** Safe to show: what the Brain decided, minus its reasoning. */
      plan: BrainPlanSummary;
    }
  | {
      status: 'needs_clarification';
      briefId: string;
      question: string;
      plan: BrainPlanSummary;
    };

/**
 * What a caller may see of a plan.
 *
 * The brief's directions and rules, which are useful and safe. Not the raw
 * provider output, and not anything about how the conclusion was reached.
 */
export type BrainPlanSummary = {
  taskType: string;
  /** The shape the piece has to be, and what it is called. */
  format: CreativeFormat;
  formatLabel: string;
  /** The ratio actually requested, when the Brain chose it rather than a caller. */
  aspectRatio: string | null;
  /** False when the generator has nothing the right shape for this format. */
  exactShape: boolean;
  /**
   * The shape handed back, when it is not the one the generator makes.
   *
   * Set whenever the picture is cut to size after being generated, so the UI
   * can say what was delivered rather than what was asked of the vendor.
   */
  deliveredShape: string | null;
  platform: string | null;
  campaign: string | null;
  product: string | null;
  brandRules: string[];
  learnedPreferences: string[];
  avoid: string[];
  references: { fileId: string; fileName: string }[];
  confidence: number;
};

export type BrainGenerateInput = {
  requestText: string;
  mediaType: 'image' | 'video';
  /** Passed through to the existing provider selection. Never overridden here. */
  provider?: unknown;
  aspectRatio?: unknown;
  imageSize?: unknown;
  resolution?: unknown;
  durationSeconds?: unknown;
  idempotencyKey?: unknown;
  /** An answer to a question the Brain asked earlier. */
  clarification?: string | null;
  /** Which market this is for. The Brain asks when it matters and nobody said. */
  market?: string | null;
  /**
   * Called once the brief exists, before the generator is asked for anything.
   *
   * There are two long waits inside this one call — retrieving what the company
   * knows and writing a brief from it, then making the picture — and from
   * outside they look like one. This is the boundary between them, so a caller
   * that streams can report the first as finished instead of guessing at it on
   * a timer.
   */
  onPlanned?: (plan: BrainPlanSummary, briefId: string) => void;
};

export async function generateWithBrain(
  scope: CompanyScope,
  input: BrainGenerateInput,
): Promise<BrainGenerationResult> {
  const plan = await planGeneration(scope, {
    requestText: input.requestText,
    mediaType: input.mediaType,
    clarification: input.clarification ?? null,
    market: input.market ?? null,
  });

  const summary = summarise(plan, shapeFor(input, plan.brief.format, input.requestText));
  input.onPlanned?.(summary, plan.briefId);

  if (plan.clarificationQuestion) {
    return {
      status: 'needs_clarification',
      briefId: plan.briefId,
      question: plan.clarificationQuestion,
      plan: summary,
    };
  }

  const prompt = promptFromBrief(plan.brief);

  // Only images can be reference images, and only the ones a generator will
  // accept. A PDF that informed the brief is not something to attach to it.
  const referenceFileIds = plan.references
    .filter((reference) => isUsableReference(reference.fileType))
    // Never more than the generator will take. These were two independent
    // numbers — the Brain attached four, the media layer accepted three — and
    // the mismatch threw before a record was written, so a request produced a
    // brief, no picture, and nothing that said why. What a generator accepts
    // is a fact about the generator, so that is the one that wins.
    .slice(0, Math.min(BRAIN_LIMITS.maxReferences, MEDIA_LIMITS.maxReferenceImages))
    .map((reference) => reference.fileId);

  // The shape the brief asked for, mapped onto what the chosen generator can
  // actually produce. A caller that named a ratio keeps it — this only fills in
  // the gap where nobody said, which used to mean a square whatever was asked
  // for: "banner" and "story" both came back 1024x1024.
  const shape = shapeFor(input, plan.brief.format, input.requestText);

  const generation =
    input.mediaType === 'image'
      ? await generateImage(scope, {
          prompt,
          // Provider selection is the caller's, exactly as before. The Brain
          // decides what to generate, never which vendor generates it.
          provider: input.provider,
          referenceFileIds,
          aspectRatio: input.aspectRatio ?? shape.aspectRatio,
          imageSize: input.imageSize,
          idempotencyKey: input.idempotencyKey,
          // The generator makes the nearest shape it has; this is the one the
          // person asked for, and the one that comes back.
          deliverShape: shape.deliver,
        })
      : await generateVideo(scope, {
          prompt,
          referenceFileId: referenceFileIds[0] ?? null,
          resolution: input.resolution ?? shape.aspectRatio,
          durationSeconds: input.durationSeconds,
          idempotencyKey: input.idempotencyKey,
        });

  // Now the generation exists, the brief can point at it — so a result can
  // always be traced back to the decision that produced it.
  await linkBriefToGeneration(scope, plan.briefId, generation.id);

  return { status: 'generated', generation, briefId: plan.briefId, plan: summary };
}

type ChosenShape = {
  /** The shape the generator is asked for, from its own list. */
  aspectRatio: string | null;
  /** Whether that is the shape that was actually wanted. */
  exact: boolean;
  /** The shape to deliver, when it differs from what the generator makes. */
  deliver: TargetShape | null;
};

/**
 * The shape to ask the generator for, and the shape to hand back.
 *
 * Two different things, and conflating them was the bug. A generator makes a
 * handful of shapes; a person asks for whatever their placement needs. Asked
 * for "ar 4:5", CIP ignored the words entirely, made a 3:2 from the format,
 * and printed "crop it to size afterwards" — handing its own job back.
 *
 * Now the request is read for a shape, the nearest available one is generated,
 * and the result is cut to what was asked for. A shape named in the request
 * beats the one implied by the format, because it is the more specific thing
 * somebody said.
 */
function shapeFor(
  input: BrainGenerateInput,
  format: CreativeFormat,
  requestText: string,
): ChosenShape {
  // A caller that named a ratio through the API has already decided; nothing
  // here second-guesses it.
  if (typeof input.aspectRatio === 'string' || typeof input.resolution === 'string') {
    return { aspectRatio: null, exact: true, deliver: null };
  }

  const supported =
    input.mediaType === 'image'
      ? imageGenerationProvider(input.provider as never).aspectRatios
      : videoGenerationProvider().resolutions;

  const asked = requestedShape(requestText);

  if (asked) {
    const nearest = nearestSupported(asked.ratio, supported);
    return {
      aspectRatio: nearest,
      // Exact either way now: what comes back is the shape that was asked for,
      // whether the generator could make it directly or it had to be cut.
      // Video cannot be cut here, so it is only exact when it truly matches.
      exact: input.mediaType === 'image' || nearest === null || sameShape(ratioOf(nearest) ?? asked.ratio, asked.ratio),
      // Only images are re-cut. Re-encoding a video to crop it is a different
      // job with its own costs, and claiming it here would be a lie.
      deliver: input.mediaType === 'image' ? asked : null,
    };
  }

  const fromFormat = closestAspectRatio(format, supported);
  if (input.mediaType !== 'image' || fromFormat.exact || !fromFormat.aspectRatio) {
    return { ...fromFormat, deliver: null };
  }

  // The format wants proportions the generator has not got — a 3:1 banner
  // against a generator whose widest is 3:2. Cut it to the format's own shape
  // rather than returning something a third as wide and saying so.
  const want = FORMAT_ASPECT[format].ratio;
  return {
    aspectRatio: fromFormat.aspectRatio,
    exact: true,
    deliver: { ratio: want, label: FORMAT_ASPECT[format].canvas, pixels: null },
  };
}

/** The ratio a "w:h" string names, or null if it does not name one. */
function ratioOf(value: string): number | null {
  const [w, h] = value.split(':').map(Number);
  return w && h ? w / h : null;
}

/** Whichever of the generator's shapes is closest, so the crop takes least. */
function nearestSupported(want: number, supported: readonly string[]): string | null {
  let best: { value: string; ratio: number } | null = null;
  for (const option of supported) {
    const ratio = ratioOf(option);
    if (ratio === null) continue;
    if (best === null || Math.abs(Math.log(ratio / want)) < Math.abs(Math.log(best.ratio / want))) {
      best = { value: option, ratio };
    }
  }
  return best?.value ?? null;
}

function summarise(plan: PlannedGeneration, shape?: ChosenShape): BrainPlanSummary {
  return {
    taskType: plan.brief.taskType,
    format: plan.brief.format,
    formatLabel: FORMAT_LABELS[plan.brief.format],
    aspectRatio: shape?.aspectRatio ?? null,
    // False when the generator has nothing the right shape — a 3:1 banner
    // against a generator whose widest is 3:2. Said out loud rather than
    // returning something a third as wide as was asked for.
    exactShape: shape?.exact ?? true,
    deliveredShape: shape?.deliver?.label ?? null,
    platform: plan.brief.platform,
    campaign: plan.brief.campaign,
    product: plan.brief.product,
    brandRules: plan.brief.brandRules.slice(0, 12),
    learnedPreferences: plan.brief.learnedPreferences.slice(0, 8),
    avoid: plan.brief.avoid.slice(0, 8),
    // File names and ids only. Never a storage path.
    references: plan.references.map((r) => ({ fileId: r.fileId, fileName: r.fileName })),
    confidence: plan.confidence,
  };
}

function isUsableReference(fileType: string): boolean {
  const mime =
    { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' }[
      fileType.toLowerCase()
    ] ?? null;
  return mime !== null && (ANALYSABLE_IMAGE_TYPES as readonly string[]).includes(mime);
}
