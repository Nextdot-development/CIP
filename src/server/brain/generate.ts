import 'server-only';
import type { CompanyScope } from '../db';
import { generateImage, generateVideo } from '../media/generation';
import type { MediaGenerationDTO } from '../media/types';
import { ANALYSABLE_IMAGE_TYPES, BRAIN_LIMITS } from './providers/types';
import { linkBriefToGeneration, planGeneration, promptFromBrief } from './planner';
import { runCheck } from './checker';
import type { CreativeCheck } from './checker';
import type { PlannedGeneration } from './planner';
import { FORMAT_ASPECT, FORMAT_LABELS, closestAspectRatio } from './providers/types';
import type { CreativeFormat } from './providers/types';
import {
  allowedImageChoices,
  imageGenerationProvider,
  videoGenerationProvider,
} from '../media/providers';
import { MEDIA_LIMITS } from '../media/providers/types';
import type { ImageGenerationProvider, ImageProviderChoice } from '../media/providers/types';
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
      /** What the checker said about it. Null for a video, which is made later. */
      qc: GenerationQc | null;
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
  /** The ratio the generator was asked for, which is one of its own. */
  aspectRatio: string | null;
  /**
   * Whether what comes back is cut down from the generator's own shape.
   *
   * The page used to say "your generator makes 1:1, so CIP makes that and cuts
   * it to 1:1 for you" — true of the mechanism and nonsense to read, because
   * nothing was cut at all.
   */
  cropped: boolean;
  /** Set when CIP used a generator other than the one named, and why. */
  switchedProvider: { to: ImageProviderChoice; because: string } | null;
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
  /** Disclaimers this market requires, which the prompt carries. */
  mustCarry: string[];
  /**
   * The photographs of the product that went to the generator.
   *
   * Empty means CIP has never been shown this product, and the bottle in the
   * result is the generator's own invention.
   */
  productShots: string[];
  /** What ratings suggest but have not yet confirmed. Not in the brief. */
  pendingLessons: { statement: string; evidenceCount: number }[];
  references: { fileId: string; fileName: string }[];
  confidence: number;
};

/** A rule a generated picture was found to break. */
export type BrokenRule = { rule: string; message: string; severity: 'critical' | 'warning' };

/**
 * Whether what CIP made passed its own checker, and what it took.
 *
 * Nothing CIP makes is called right until the checker has looked at it. A
 * picture that breaks a rule is made again with the fault named, a couple of
 * times, and if it still breaks one it is handed over saying which - never
 * as if it were fine.
 */
export type GenerationQc = {
  verdict: 'passed' | 'failed' | 'unchecked';
  /** The check of the picture handed back. */
  checkId: string | null;
  /** What the picture handed back still breaks. Empty when it passed. */
  broke: BrokenRule[];
  /** Pictures made in all, the first included. */
  attempts: number;
  /** Why it stopped where it did. */
  stopped: 'passed' | 'out_of_tries' | 'out_of_time' | 'generation_failed' | 'check_failed';
  /** The versions made before the one handed back, and what each broke. */
  earlier: { generationId: string; broke: string[] }[];
};

/** Progress through the check, for a caller that streams it. */
export type QcProgress =
  // A version exists. Shown at once, while it is checked: the wait for the
  // verdict, and for any version made again, is not a wait to see anything.
  | { stage: 'made'; attempt: number; generationId: string }
  | { stage: 'checking'; attempt: number }
  | { stage: 'fixing'; attempt: number; broke: string[] };

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
  /**
   * A picture CIP made earlier, to build this one from.
   *
   * "The same thing at 9:16", "less text on it" - each of those started again
   * from nothing, and came back a different picture that happened to obey the
   * same brief.
   */
  basedOnGenerationId?: unknown;
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
  /** Called as the picture is checked and, when it breaks a rule, made again. */
  onQc?: (progress: QcProgress) => void;
};

export async function generateWithBrain(
  scope: CompanyScope,
  input: BrainGenerateInput,
): Promise<BrainGenerationResult> {
  const started = Date.now();
  // Read before planning, because the brief is composed for the shape. The
  // answer to a question counts as much as the request: a square said only in
  // reply used to be dropped, and the banner came back 3:1.
  //
  // A shape picked on the page or named through the API is the more deliberate
  // act, so it beats one found in the words. Both are read the same way, so
  // "1080x1350" works wherever "4:5" does.
  const named = typeof input.aspectRatio === 'string' ? requestedShape(input.aspectRatio) : null;
  const asked =
    named ?? requestedShape([input.requestText, input.clarification].filter(Boolean).join('. '));

  const plan = await planGeneration(scope, {
    requestText: input.requestText,
    mediaType: input.mediaType,
    clarification: input.clarification ?? null,
    market: input.market ?? null,
    requestedShape: asked?.label ?? null,
  });

  // Which generator, now that the shape is known.
  const generator = generatorFor(input, asked);

  // The shape the brief asked for, mapped onto what that generator can actually
  // produce. This fills in the gap where nobody said, which used to mean a
  // square whatever was asked for: "banner" and "story" both came back
  // 1024x1024.
  const shape = shapeFor(input, plan.brief.format, asked, generator.choice);

  const summary = summarise(plan, shape, generator.switched);
  input.onPlanned?.(summary, plan.briefId);

  if (plan.clarificationQuestion) {
    return {
      status: 'needs_clarification',
      briefId: plan.briefId,
      question: plan.clarificationQuestion,
      plan: summary,
    };
  }

  // Only images can be reference images, and only the ones a generator will
  // accept. A PDF that informed the brief is not something to attach to it.
  const attached = plan.references
    .filter((reference) => isUsableReference(reference.fileType))
    // Never more than the generator will take. These were two independent
    // numbers — the Brain attached four, the media layer accepted three — and
    // the mismatch threw before a record was written, so a request produced a
    // brief, no picture, and nothing that said why. What a generator accepts
    // is a fact about the generator, so that is the one that wins.
    .slice(0, Math.min(BRAIN_LIMITS.maxReferences, MEDIA_LIMITS.maxReferenceImages));
  const referenceFileIds = attached.map((reference) => reference.fileId);

  const shots = attached.filter((reference) =>
    plan.productShots.some((shot) => shot.fileId === reference.fileId),
  ).length;

  // Both notes appended in one go, and the prompt trimmed once. Appending them
  // separately meant the second one's trim could cut the first one off.
  // With a brand, its approved logo is placed afterwards: every ask to draw
  // one comes out of the prompt, and the corner it goes in is asked for first.
  const stamping = input.mediaType === 'image' && Boolean(plan.brief.brand);
  const briefPrompt = stamping ? `${LOGO_LEAD} ${withoutLogoAsks(promptFromBrief(plan.brief))}` : promptFromBrief(plan.brief);
  const prompt =
    input.mediaType === 'image'
      ? withNotes(briefPrompt, [
          referenceNote(attached.length, shots),
          framingNote(shape),
          LEGAL_LINES_NOTE,
          stamping ? LOGO_NOTE : null,
        ])
      : withNotes(briefPrompt, [LEGAL_LINES_NOTE]);

  const generation =
    input.mediaType === 'image'
      ? await generateImage(scope, {
          prompt,
          // The caller's choice, unless it cannot make the shape that was asked
          // for and the other one can. Which is the only thing the Brain is
          // allowed to overrule about a vendor, and it says so in the plan.
          provider: generator.choice ?? input.provider,
          referenceFileIds,
          // Always one of that generator's own shapes. A ratio it does not make
          // used to be sent straight through and refused, so picking 4:5 with
          // OpenAI selected produced an error instead of a picture.
          aspectRatio: shape.aspectRatio,
          imageSize: input.imageSize,
          idempotencyKey: input.idempotencyKey,
          // The generator makes the nearest shape it has; this is the one the
          // person asked for, and the one that comes back.
          deliverShape: shape.deliver,
          basedOnGenerationId: input.basedOnGenerationId,
          stampLogoFor: plan.brief.brand ?? null,
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

  // A video is made by the worker, minutes from now; it is checked there.
  if (input.mediaType !== 'image' || generation.status !== 'completed') {
    return { status: 'generated', generation, briefId: plan.briefId, plan: summary, qc: null };
  }

  const checked = await checkAndFix(scope, {
    first: generation,
    briefId: plan.briefId,
    started,
    onQc: input.onQc,
    remake: (from, broke) =>
      generateImage(scope, {
        prompt: withNotes(prompt, [fixNote(broke)]),
        provider: generator.choice ?? input.provider,
        referenceFileIds,
        aspectRatio: shape.aspectRatio,
        imageSize: input.imageSize,
        // Never the first one's key: that would hand back the same picture.
        idempotencyKey: undefined,
        deliverShape: shape.deliver,
        // Built on the picture that failed, so what was right about it stays
        // and only the fault is changed.
        basedOnGenerationId: from.id,
      }),
  });

  return {
    status: 'generated',
    generation: checked.generation,
    briefId: plan.briefId,
    plan: summary,
    qc: checked.qc,
  };
}

/** Times a picture is made again to fix what the checker found. */
function maxFixes(): number {
  const value = Number(process.env.CIP_QC_MAX_FIXES);
  return Number.isInteger(value) && value >= 0 ? value : 2;
}

/**
 * How long into a request another attempt may still start.
 *
 * A request has five minutes before the platform kills it with nothing
 * anybody can read. An attempt - make, then check - is about a minute and a
 * half, so one is not started past this.
 */
function qcBudgetMs(): number {
  const value = Number(process.env.CIP_QC_BUDGET_MS);
  return Number.isFinite(value) && value > 0 ? value : 150_000;
}

/**
 * The rules a checked picture breaks.
 *
 * Rules, not patterns: a picture unlike the brand's usual work is a matter of
 * taste and a person's call, and remaking it for that would chase a style.
 * Only critical and warning findings - a note is not a failure - and never
 * one a person has already disputed.
 */
export function rulesBroken(check: CreativeCheck): BrokenRule[] {
  return check.flags
    .filter((f) => f.status !== 'disputed' && f.citedRule && f.severity !== 'note')
    .map((f) => ({ rule: f.citedRule!.rule, message: f.message, severity: f.severity as BrokenRule['severity'] }));
}

/** What the generator is told the last version got wrong. */
function fixNote(broke: BrokenRule[]): string {
  const faults = broke
    .slice(0, 6)
    .map((b) => `"${b.rule}" (${b.message.replace(/\s+/g, ' ').slice(0, 160)})`)
    .join('; ');
  return (
    `IMPORTANT - the previous version was rejected by brand compliance review for breaking: ${faults}. ` +
    'Keep everything else about it, and make sure this version obeys every one of these rules.'
  );
}

/**
 * Checks a picture CIP just made, and makes it again while it breaks a rule.
 *
 * Each attempt is checked by the same checker a person would use, so "passed"
 * means exactly what it means on the QC page. The picture handed back is the
 * first that passed, or failing that the one that broke the fewest rules -
 * and it says what it still breaks.
 */
async function checkAndFix(
  scope: CompanyScope,
  input: {
    first: MediaGenerationDTO;
    briefId: string;
    started: number;
    onQc?: (progress: QcProgress) => void;
    remake: (from: MediaGenerationDTO, broke: BrokenRule[]) => Promise<MediaGenerationDTO>;
  },
): Promise<{ generation: MediaGenerationDTO; qc: GenerationQc }> {
  const tried: { generation: MediaGenerationDTO; check: CreativeCheck | null; broke: BrokenRule[] }[] = [];
  let current = input.first;
  let stopped: GenerationQc['stopped'];

  for (let attempt = 1; ; attempt += 1) {
    input.onQc?.({ stage: 'made', attempt, generationId: current.id });
    input.onQc?.({ stage: 'checking', attempt });
    const check = await runCheck(scope, { generationId: current.id }).catch(() => null);
    const broke = check && check.status === 'ready' ? rulesBroken(check) : [];
    tried.push({ generation: current, check: check?.status === 'ready' ? check : null, broke });

    if (!check || check.status !== 'ready') { stopped = 'check_failed'; break; }
    if (broke.length === 0) { stopped = 'passed'; break; }
    if (attempt > maxFixes()) { stopped = 'out_of_tries'; break; }
    if (Date.now() - input.started > qcBudgetMs()) { stopped = 'out_of_time'; break; }

    input.onQc?.({ stage: 'fixing', attempt: attempt + 1, broke: broke.map((b) => b.rule) });
    const next = await input.remake(current, broke).catch(() => null);
    if (!next || next.status !== 'completed') { stopped = 'generation_failed'; break; }
    // Pointed at the brief as it is made, so the check reads the brand and
    // market the brief was written for.
    await linkBriefToGeneration(scope, input.briefId, next.id);
    current = next;
  }

  // The first that passed; otherwise the checked one breaking the fewest
  // rules, criticals counted heavier, the later one winning a tie. An
  // unchecked picture is only handed back when nothing was checked.
  const weight = (b: BrokenRule[]) => b.reduce((n, r) => n + (r.severity === 'critical' ? 10 : 1), 0);
  const checked = tried.filter((t) => t.check !== null);
  const best =
    checked.find((t) => t.broke.length === 0) ??
    checked.reduce<(typeof tried)[number] | null>((a, t) => (a === null || weight(t.broke) <= weight(a.broke) ? t : a), null) ??
    tried.at(-1)!;

  // The brief points at what was handed back, so a rating of it teaches.
  if (best.generation.id !== current.id) await linkBriefToGeneration(scope, input.briefId, best.generation.id);

  return {
    generation: best.generation,
    qc: {
      verdict: best.check === null ? 'unchecked' : best.broke.length === 0 ? 'passed' : 'failed',
      checkId: best.check?.id ?? null,
      broke: best.broke,
      attempts: tried.length,
      stopped: best.check !== null && best.broke.length === 0 ? 'passed' : stopped,
      earlier: tried
        .filter((t) => t.generation.id !== best.generation.id)
        .map((t) => ({ generationId: t.generation.id, broke: t.broke.map((b) => b.rule) })),
    },
  };
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
  asked: TargetShape | null,
  choice: ImageProviderChoice | null,
): ChosenShape {
  // A video resolution named through the API is one of the provider's own and
  // a video is not re-cut here, so it goes through as it always has.
  if (input.mediaType === 'video' && typeof input.resolution === 'string') {
    return { aspectRatio: null, exact: true, deliver: null };
  }

  const supported =
    input.mediaType === 'image'
      ? imageGenerationProvider(choice).aspectRatios
      : videoGenerationProvider().resolutions;

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

type ChosenGenerator = {
  /** Null for video, and for an image request that named no provider. */
  choice: ImageProviderChoice | null;
  /** Set when this is not the generator the caller named. */
  switched: { to: ImageProviderChoice; because: string } | null;
};

/**
 * Which generator makes it.
 *
 * Provider choice is the caller's, and nothing here second-guessed it — which
 * was right until sizes became a choice. OpenAI makes 1:1, 3:2 and 2:3 and
 * nothing else, so every 4:5 and every 9:16 was a 2:3 with its edges cut off,
 * losing a logo or a statutory warning on the way, while Gemini sat beside it
 * with a key and makes both exactly.
 *
 * So a generator that makes the requested shape itself beats one that would
 * have to cut it down. Only ever for a shape it cannot make: the named
 * provider still answers for every shape it does make, and the swap is
 * reported in the plan rather than done quietly.
 */
function generatorFor(input: BrainGenerateInput, asked: TargetShape | null): ChosenGenerator {
  const named = namedChoice(input.provider);
  if (input.mediaType !== 'image' || !asked) return { choice: named, switched: null };

  const current = imageGenerationProvider(named);
  if (makesShape(current, asked)) return { choice: named, switched: null };

  // Only a generator this deployment allows. Handing a shape to one that is
  // switched off is how a 4:5 request reached a Gemini account with no image
  // quota at all and came back as a rate limit that waiting could not clear.
  for (const choice of allowedImageChoices()) {
    const other = imageGenerationProvider(choice);
    // The same provider under another name is not an alternative, which is
    // what a deployment with one key configured has.
    if (other === current || !other.configured || !makesShape(other, asked)) continue;

    return {
      choice,
      switched: { to: choice, because: `${providerLabel(current.name)} does not make ${asked.label}` },
    };
  }

  // Nobody makes it directly. The nearest shape is generated and cut, which is
  // still the shape that was asked for.
  return { choice: named, switched: null };
}

/** Whether a generator makes this shape itself, rather than something near it. */
function makesShape(provider: ImageGenerationProvider, asked: TargetShape): boolean {
  return provider.aspectRatios.some((option) => {
    const ratio = ratioOf(option);
    return ratio !== null && sameShape(ratio, asked.ratio);
  });
}

function namedChoice(value: unknown): ImageProviderChoice | null {
  // A name this deployment does not allow is treated as no name at all, so an
  // older page still sending one gets the default rather than a refusal.
  return typeof value === 'string' &&
    (allowedImageChoices() as readonly string[]).includes(value)
    ? (value as ImageProviderChoice)
    : null;
}

/** What a person calls the generator. Never a model id in a sentence. */
function providerLabel(name: string): string {
  if (name === 'openai') return 'OpenAI';
  if (name === 'google') return 'Gemini';
  return 'That generator';
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

/**
 * Tells the generator how to fill the frame it is making.
 *
 * A picture that is cut afterwards has to be composed for the cut, or the crop
 * takes the logo. And a generator given a wide brief for a square canvas draws
 * a wide band inside the square. Neither is fixed by naming the final size —
 * naming a canvas the generator was not asked for is how you get a picture of
 * a banner — so this says which edges go, in words.
 */
function framingNote(shape: ChosenShape): string | null {
  const made = shape.aspectRatio ? ratioOf(shape.aspectRatio) : null;
  if (!shape.deliver || made === null) return null;

  const want = shape.deliver.ratio;
  const frame = sameShape(made, 1) ? 'square' : made > 1 ? 'horizontal' : 'vertical';
  let note = `Fill the whole ${frame} frame edge to edge, with no border, margin or letterboxing`;

  if (willCrop(shape)) {
    const kept = Math.round(100 * (made > want ? want / made : made / want));
    note +=
      made > want
        ? `. Keep the subject, logo and any text inside the middle ${kept}% of the width; the left and right edges are cropped away`
        : `. Keep the subject, logo and any text inside the middle ${kept}% of the height; the top and bottom edges are cropped away`;
  }

  return note;
}

/**
 * Says what the attached pictures are, and what to do with them.
 *
 * Reference images were attached and nothing ever told the model what they
 * were for. So the product in the result was drawn from the model's idea of a
 * whisky bottle: a different shape, a different cap, and a label carrying
 * words nobody has ever printed. The brief described the brand; no sentence in
 * it said "this is the bottle, copy it".
 *
 * A photograph of the product is treated differently from a past creative,
 * because they ask for opposite things: copy this one exactly, take only the
 * manner of that one.
 */
function referenceNote(attached: number, shots: number): string | null {
  if (attached === 0) return null;

  const notes: string[] = [];

  if (shots > 0) {
    notes.push(
      `The first ${shots === 1 ? 'attached image shows' : `${shots} attached images show`} ` +
        'the real product, as photographed or as its label artwork. Reproduce that product ' +
        'exactly: the same bottle shape and proportions, the same cap, the same label, the ' +
        'same logo, the same wording and the same colours. Do not redesign the label, do not ' +
        'invent or translate any text on it, and do not substitute a similar bottle.',
    );
  }

  const others = attached - shots;
  if (others > 0) {
    notes.push(
      `The other ${others === 1 ? 'attached image is past work' : `${others} attached images are past work`} ` +
        'from this brand: follow the way they look — lighting, palette, typography and ' +
        'composition — without copying their layout or their words.',
    );
  }

  return notes.join(' ');
}

/** Everything the generator is told beyond the brief, appended once. */
/**
 * Said to the generator every time. The brief already leaves statutory lines
 * out, but a model that has seen a thousand alcohol adverts adds a warning
 * strip of its own - misspelt, and wherever it likes. The team sets them at
 * layout in the approved wording.
 */
/**
 * The approved logo is placed on the picture afterwards (see logoStamp), so
 * the generator draws none of its own and keeps the corner it goes in clear.
 */
const LOGO_NOTE =
  "Do not draw any brand logo, emblem or wordmark anywhere except as printed on the product's own " +
  'label. Keep the top-right corner free of text and busy detail: the approved logo is placed there afterwards.';

/** Said first, because a generator weighs the start of a prompt most. */
const LOGO_LEAD =
  'Leave the top-right corner of the frame - about a fifth of its width - as plain background: ' +
  'no text, no logo, no objects.';

/**
 * The prompt without any ask to draw a logo.
 *
 * The brief faithfully repeats the brand's rule - "place the logo top-right" -
 * up to three times, and a generator told that and then told not to draw one
 * drew one anyway: the approved logo then landed on top of its imitation.
 * A clause about the product's own label stays: that logo is printed on the pack.
 */
export function withoutLogoAsks(prompt: string): string {
  const LOGO = /\b(logos?|wordmarks?|emblems?|logotypes?)\b/i;
  const LABEL = /\b(label|pack|bottle)\b/i;
  return prompt
    .split(/(?<=[.;])\s+/)
    .map((sentence) => {
      if (!LOGO.test(sentence) || LABEL.test(sentence)) return sentence;
      // Only the clauses about the logo go: "do NOT show people, do NOT alter the logo" keeps the first.
      const kept = sentence.split(/,\s+/).filter((clause) => !LOGO.test(clause));
      if (kept.length === 0) return '';
      const joined = kept.join(', ');
      return /[.;]$/.test(joined) ? joined : `${joined}.`;
    })
    .filter((sentence) => sentence.trim() && !/^[A-Za-z ]+:\s*[.;]?$/.test(sentence.trim()))
    .join(' ');
}

const LEGAL_LINES_NOTE =
  'Do not include any health warning, "Drink Responsibly" line, age mark such as 18+ or 25+, ' +
  'or other legal disclaimer text anywhere in the image.';

function withNotes(prompt: string, notes: (string | null)[]): string {
  const said = notes.filter((note): note is string => Boolean(note)).join(' ');
  if (said.length === 0) return prompt;
  return `${prompt.slice(0, MEDIA_LIMITS.maxPromptChars - said.length - 2)}. ${said}`;
}

/** Whether anything is actually trimmed, rather than delivered as generated. */
function willCrop(shape: ChosenShape): boolean {
  const made = shape.aspectRatio ? ratioOf(shape.aspectRatio) : null;
  if (!shape.deliver || made === null) return false;
  return !sameShape(made, shape.deliver.ratio);
}

function summarise(
  plan: PlannedGeneration,
  shape?: ChosenShape,
  switchedProvider: { to: ImageProviderChoice; because: string } | null = null,
): BrainPlanSummary {
  return {
    cropped: shape ? willCrop(shape) : false,
    switchedProvider,
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
    mustCarry: plan.mustCarry,
    productShots: plan.productShots.map((shot) => shot.fileName),
    pendingLessons: plan.pendingLessons,
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
