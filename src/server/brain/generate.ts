import 'server-only';
import type { CompanyScope } from '../db';
import { generateImage, generateVideo } from '../media/generation';
import type { MediaGenerationDTO } from '../media/types';
import { ANALYSABLE_IMAGE_TYPES, BRAIN_LIMITS } from './providers/types';
import { linkBriefToGeneration, planGeneration, promptFromBrief } from './planner';
import type { PlannedGeneration } from './planner';
import { FORMAT_LABELS, closestAspectRatio } from './providers/types';
import type { CreativeFormat } from './providers/types';
import { imageGenerationProvider, videoGenerationProvider } from '../media/providers';

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

  const summary = summarise(plan, shapeFor(input, plan.brief.format));
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
    .slice(0, BRAIN_LIMITS.maxReferences)
    .map((reference) => reference.fileId);

  // The shape the brief asked for, mapped onto what the chosen generator can
  // actually produce. A caller that named a ratio keeps it — this only fills in
  // the gap where nobody said, which used to mean a square whatever was asked
  // for: "banner" and "story" both came back 1024x1024.
  const shape = shapeFor(input, plan.brief.format);

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

type ChosenShape = { aspectRatio: string | null; exact: boolean };

/**
 * The shape to ask the generator for.
 *
 * Only consulted when the caller named no ratio of its own. Videos and images
 * have different lists of what they will accept, so the format is matched
 * against whichever one is about to be used rather than against a fixed table.
 */
function shapeFor(input: BrainGenerateInput, format: CreativeFormat): ChosenShape {
  if (typeof input.aspectRatio === 'string' || typeof input.resolution === 'string') {
    return { aspectRatio: null, exact: true };
  }

  const supported =
    input.mediaType === 'image'
      ? imageGenerationProvider(input.provider as never).aspectRatios
      : videoGenerationProvider().resolutions;

  return closestAspectRatio(format, supported);
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
