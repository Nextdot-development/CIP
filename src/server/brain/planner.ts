import 'server-only';
import { withCompanyScope } from '../db';
import type { CompanyScope } from '../db';
import { brain } from './providers';
import { BRAIN_LIMITS, BrainFailed, defaultTaskType } from './providers/types';
import type { GenerationBrief } from './providers/types';
import { knownSubjects, readBrandDna } from './brandDna';
import { applicableLessons, ratedExamples, similarAssets, similarPosts } from './retrieval';
import { companyMarkets, marketInRequest } from './markets';
import { brandInRequest, brandNames } from './brands';

/**
 * Deciding what to generate, before anything is generated.
 *
 * The user's words are the request, not the prompt. What reaches the image or
 * video model is a brief built from this company's own evidence: what its
 * assets look like, which of them resemble the request, what it has rated well
 * and badly, and what its feedback has taught. Forwarding the raw request
 * straight through would make the Brain decorative.
 *
 * Everything runs inside the caller's CompanyScope. There is no company
 * parameter, so no request can plan against another company's memory.
 */

export type PlannedGeneration = {
  briefId: string;
  brief: GenerationBrief;
  /** Assets whose understanding informed the brief, for provenance and references. */
  references: { fileId: string; fileName: string; fileType: string; score: number }[];
  lessonIds: string[];
  /** Set when the Brain needs an answer before it can safely proceed. */
  clarificationQuestion: string | null;
  confidence: number;
};

export type PlanInput = {
  requestText: string;
  mediaType: 'image' | 'video';
  /** Narrows retrieval when the caller already knows. Usually absent. */
  campaign?: string | null;
  product?: string | null;
  platform?: string | null;
  /** A prior clarification answer, folded into the request. */
  clarification?: string | null;
  /** Which brand this is for. Asked about the same way as a market. */
  brand?: string | null;
  /**
   * Which market this is for.
   *
   * When absent and the company has knowledge about more than one, the Brain
   * asks rather than averaging them: three country decks blended together
   * produce a look none of the three uses.
   */
  market?: string | null;
};

/**
 * Spells a list the way a person would say it.
 */
function listOptions(options: readonly string[]): string {
  if (options.length <= 1) return options[0] ?? '';
  if (options.length === 2) return options.join(' or ');
  return `${options.slice(0, -1).join(', ')} or ${options[options.length - 1]}`;
}

/**
 * Stops and asks which brand, or which market, this is for.
 *
 * Built here rather than by the model: the question is the same every time and
 * the options are a fact about this company, so there is nothing to reason
 * about and no way to invent a tenth brand or a fourth country.
 *
 * The brief is still written and stored — the caller answers and comes back
 * through the same path with the answer filled in.
 */
async function askWhich(
  scope: CompanyScope,
  input: PlanInput,
  requestText: string,
  asking: { kind: 'brand' | 'market'; options: readonly string[]; question: string },
): Promise<PlannedGeneration> {
  const brief: GenerationBrief = {
    taskType: defaultTaskType(input.mediaType),
    format: 'other',
    platform: input.platform ?? null,
    campaign: input.campaign ?? null,
    product: input.product ?? null,
    visualDirection: null,
    videoDirection: null,
    contentDirection: null,
    brandRules: [],
    successfulPatterns: [],
    negativePatterns: [],
    learnedPreferences: [],
    constraints: [],
    avoid: [],
    generationPrompt: '',
    confidence: 0,
    clarificationQuestion: asking.question,
  };

  const briefId = await storeBrief(scope, {
    requestText,
    brief,
    referenceFileIds: [],
    lessonIds: [],
  });

  return {
    briefId,
    brief,
    references: [],
    lessonIds: [],
    confidence: 0,
    clarificationQuestion: asking.question,
  };
}

/**
 * Plans one generation.
 *
 * Retrieval first, then the provider turns retrieved memory into a brief. The
 * brief is stored before anything is generated, so a decision can be audited
 * whether or not the generation that followed succeeded.
 */
export async function planGeneration(
  scope: CompanyScope,
  input: PlanInput,
): Promise<PlannedGeneration> {
  const provider = brain();
  if (!provider.configured) {
    throw new BrainFailed('NOT_CONFIGURED', 'permanent', 'The Brain is not configured.');
  }

  const requestText = [input.requestText.trim(), input.clarification?.trim()]
    .filter(Boolean)
    .join('. ');

  if (requestText.length === 0) {
    throw new BrainFailed('PROVIDER_ERROR', 'permanent', 'A request is required.');
  }

  // Which brand this is for, before anything else. It matters more than the
  // market: Whytehall in Nigeria is still Whytehall, but Magic Moments' voice
  // in a Whytehall brief is simply the wrong brand.
  const brands = await brandNames(scope);
  const brand = input.brand?.trim() || brandInRequest(requestText, brands) || null;

  if (!brand && brands.length > 1) {
    return askWhich(scope, input, requestText, {
      kind: 'brand',
      options: brands,
      question:
        `Which brand is this for — ${listOptions(brands)}? They do not share a ` +
        'voice, so CIP would rather ask than blend them.',
    });
  }

  // Which market this is for. It decides which of that brand's knowledge is
  // even relevant.
  const markets = await companyMarkets(scope);
  const marketNames = markets.map((m) => m.market);
  const market =
    input.market?.trim() ||
    marketInRequest(requestText, marketNames) ||
    null;

  // More than one market and nobody has said which: stop and ask. Averaging
  // them is the one answer that is wrong for everybody, and the clarification
  // path already exists for exactly this.
  if (!market && marketNames.length > 1) {
    return askWhich(scope, input, requestText, {
      kind: 'market',
      options: marketNames,
      question:
        `Which market is this for — ${listOptions(marketNames)}? They look ` +
        'different from each other, so CIP would rather ask than average them.',
    });
  }

  // Everything the Brain gets to reason with, all of it this company's own.
  const [facts, assets, posts, subjects] = await Promise.all([
    readBrandDna(scope, { limit: BRAIN_LIMITS.maxBrandFacts, minEvidence: 1, market, brand }),
    similarAssets(scope, requestText),
    // Individual posts read off this company's PDFs. A whole deck retrieved as
    // one asset says "there is a deck"; the four posts inside it that match
    // the request are the part worth putting in front of the model.
    similarPosts(scope, requestText),
    knownSubjects(scope),
  ]);

  const examples = await ratedExamples(scope, { mediaType: input.mediaType });

  // Lessons are fetched for the context the caller already knows. The brief may
  // identify a narrower one; that is applied on the second pass below.
  const lessons = await applicableLessons(scope, {
    taskType: null,
    platform: input.platform ?? null,
    campaign: input.campaign ?? null,
    product: input.product ?? null,
  });

  const brief = await provider.buildGenerationBrief({
    requestText,
    mediaType: input.mediaType,
    brandFacts: facts.map((f) => ({
      section: f.section,
      attribute: f.attribute,
      // Where a fact belongs to one market and this is for that market, say
      // so. A pattern seen only in Nigeria is how Nigeria does it, not how the
      // brand does it, and the difference changes how firmly to follow it.
      value:
        market && f.markets.length === 1 && f.markets[0] === market
          ? `${f.value} (seen in ${market})`
          : f.markets.length > 1
            ? `${f.value} (holds across ${f.markets.join(', ')})`
            : f.value,
      confidence: f.confidence,
    })),
    relevantAssets: [
      ...assets.map((a) => ({ summary: a.summary, extractedText: a.extractedText })),
      // Named by where they came from, so the model can tell a real past post
      // from a description of a file and weigh it accordingly.
      ...posts.map((p) => ({
        summary:
          `Past post (${p.fileName}, page ${p.pageNumber}` +
          (p.country ? `, ${p.country}` : '') +
          `): ${p.summary}`,
        extractedText: p.caption,
      })),
    ],
    successfulExamples: examples.positive.map((e) => ({
      requestText: e.requestText,
      score: e.score,
      comment: e.comment,
    })),
    negativeExamples: examples.negative.map((e) => ({
      requestText: e.requestText,
      score: e.score,
      comment: e.comment,
    })),
    lessons: lessons.map((l) => ({
      polarity: l.polarity,
      statement: l.statement,
      confidence: l.confidence,
    })),
    knownCampaigns: subjects.campaigns,
    knownProducts: subjects.products,
  });

  // Now that the brief has identified the campaign, product and task type, the
  // lessons that actually apply can be fetched. This is the pass that makes
  // learning context-aware: a lesson scoped to one campaign only reaches a
  // brief for that campaign.
  const scopedLessons = await applicableLessons(scope, {
    taskType: brief.taskType,
    platform: brief.platform,
    campaign: brief.campaign,
    product: brief.product,
  });

  // Confidence is the Brain's, but it cannot claim more than its evidence
  // supports: with nothing known about the brand, a high number would be a
  // fiction regardless of how sure the model sounds.
  const evidenceCeiling = facts.length === 0 ? 0.4 : 1;
  const confidence = Math.min(brief.confidence, evidenceCeiling);

  const clarification =
    brief.clarificationQuestion ??
    (confidence < BRAIN_LIMITS.minBriefConfidence && subjects.campaigns.length > 1
      ? `Which campaign is this for: ${subjects.campaigns.slice(0, 5).join(', ')}?`
      : null);

  const finalBrief: GenerationBrief = {
    ...brief,
    confidence,
    clarificationQuestion: clarification,
    learnedPreferences: [
      ...new Set([
        ...brief.learnedPreferences,
        ...scopedLessons.filter((l) => l.polarity === 'prefer').map((l) => l.statement),
      ]),
    ],
    avoid: [
      ...new Set([
        ...brief.avoid,
        ...scopedLessons.filter((l) => l.polarity === 'avoid').map((l) => l.statement),
      ]),
    ],
  };

  const briefId = await storeBrief(scope, {
    requestText,
    brief: finalBrief,
    referenceFileIds: assets.map((a) => a.fileId),
    lessonIds: scopedLessons.map((l) => l.id),
  });

  return {
    briefId,
    brief: finalBrief,
    references: assets.map((a) => ({
      fileId: a.fileId,
      fileName: a.fileName,
      fileType: a.fileType,
      score: a.score,
    })),
    lessonIds: scopedLessons.map((l) => l.id),
    clarificationQuestion: clarification,
    confidence,
  };
}

/**
 * The prompt actually sent to the generator.
 *
 * Assembled from the brief rather than taken from one field, so brand rules and
 * learned preferences reach the model even when the provider's own prompt is
 * terse. Bounded, because a prompt is not a place to put a company's whole
 * memory.
 */
export function promptFromBrief(brief: GenerationBrief): string {
  const parts: string[] = [brief.generationPrompt.trim()];

  const direction = brief.visualDirection ?? brief.videoDirection;
  if (direction) parts.push(direction);

  if (brief.brandRules.length > 0) {
    parts.push(`Brand: ${brief.brandRules.slice(0, 8).join('; ')}`);
  }
  if (brief.learnedPreferences.length > 0) {
    parts.push(`Preferred: ${brief.learnedPreferences.slice(0, 5).join('; ')}`);
  }
  if (brief.avoid.length > 0) {
    parts.push(`Avoid: ${brief.avoid.slice(0, 5).join('; ')}`);
  }
  if (brief.constraints.length > 0) {
    parts.push(`Constraints: ${brief.constraints.slice(0, 5).join('; ')}`);
  }

  return parts.filter((part) => part.trim().length > 0).join('. ').slice(0, 3_800);
}

async function storeBrief(
  scope: CompanyScope,
  input: {
    requestText: string;
    brief: GenerationBrief;
    referenceFileIds: string[];
    lessonIds: string[];
  },
): Promise<string> {
  return withCompanyScope(scope, async (tx) => {
    const rows = await tx<{ id: string }[]>`
      insert into generation_briefs
        (company_id, requested_by, request_text, task_type, platform, campaign, product,
         brief, generation_prompt, reference_file_ids, lesson_ids, confidence,
         clarification_question)
      values
        (${scope.companyId}, ${scope.userId}, ${input.requestText},
         ${input.brief.taskType}, ${input.brief.platform}, ${input.brief.campaign},
         ${input.brief.product},
         ${tx.json(input.brief as never)}, ${promptFromBrief(input.brief)},
         ${input.referenceFileIds}::uuid[], ${input.lessonIds}::uuid[],
         ${input.brief.confidence}, ${input.brief.clarificationQuestion})
      returning id
    `;
    return rows[0]!.id;
  });
}

/** Attaches a brief to the generation it produced, once that exists. */
export async function linkBriefToGeneration(
  scope: CompanyScope,
  briefId: string,
  generationId: string,
): Promise<void> {
  await withCompanyScope(scope, async (tx) => {
    await tx`
      update generation_briefs
         set generation_id = ${generationId}
       where id = ${briefId}
    `;
  });
}
