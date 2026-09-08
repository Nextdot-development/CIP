import 'server-only';
import { withCompanyScope } from '../db';
import type { CompanyScope } from '../db';
import { adminSql } from '../db-admin';
import { embedder, toVectorLiteral } from '../drive/embedding';
import { brain } from './providers';
import { similaritySupported } from './capabilities';
import { BRAIN_LIMITS } from './providers/types';

/**
 * Learning from what people thought of the results.
 *
 * A score and a comment do not change the Brand DNA. They produce a *candidate*
 * lesson, which becomes confirmed only once enough separate pieces of feedback
 * say the same thing. One person disliking one image is an opinion; three
 * saying it is a pattern.
 *
 * Every lesson carries the context it was learned in. "Reduce the text" said
 * about one campaign is stored against that campaign, not the company — because
 * the same brand may want dense text elsewhere, and a rule that ignores context
 * makes the system worse the more it is used.
 */

export type FeedbackDTO = {
  id: string;
  generationId: string;
  score: number;
  comment: string | null;
  createdAt: string;
  analysed: boolean;
};

export type LessonDTO = {
  id: string;
  polarity: 'prefer' | 'avoid';
  statement: string;
  status: 'candidate' | 'confirmed' | 'rejected' | 'superseded';
  evidenceCount: number;
  confidence: number;
  taskType: string | null;
  platform: string | null;
  campaign: string | null;
  product: string | null;
  createdAt: string;
};

export class FeedbackRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FeedbackRejected';
  }
}

/**
 * Records what somebody thought of a generation.
 *
 * One score per person per generation: changing your mind updates the row
 * rather than stacking opinions, and re-submitting the same view cannot inflate
 * the evidence behind a lesson.
 */
export async function submitFeedback(
  scope: CompanyScope,
  input: { generationId: string; score: unknown; comment: unknown },
): Promise<FeedbackDTO> {
  const score = Number(input.score);
  if (!Number.isInteger(score) || score < 0 || score > 10) {
    throw new FeedbackRejected('A score must be a whole number from 0 to 10.');
  }
  if (!isUuid(input.generationId)) {
    throw new FeedbackRejected('That generation could not be found.');
  }

  const comment =
    typeof input.comment === 'string' && input.comment.trim().length > 0
      ? input.comment.trim().slice(0, 2_000)
      : null;

  const rows = await withCompanyScope(scope, async (tx) => {
    // Confirms the generation belongs to this company before anything is
    // written. A generation id from elsewhere simply is not found.
    const owned = await tx<{ id: string }[]>`
      select id from media_generations where id = ${input.generationId}
    `;
    if (owned.length === 0) throw new FeedbackRejected('That generation could not be found.');

    return tx<
      { id: string; generation_id: string; score: number; comment: string | null; created_at: Date; analysed_at: Date | null }[]
    >`
      insert into generation_feedback (company_id, generation_id, given_by, score, comment)
      values (${scope.companyId}, ${input.generationId}, ${scope.userId}, ${score}, ${comment})
      on conflict (generation_id, given_by) do update
         set score = excluded.score,
             comment = excluded.comment,
             -- Changed feedback deserves fresh analysis.
             analysed_at = null
      returning id, generation_id, score, comment, created_at, analysed_at
    `;
  });

  const row = rows[0]!;
  return {
    id: row.id,
    generationId: row.generation_id,
    score: row.score,
    comment: row.comment,
    createdAt: row.created_at.toISOString(),
    analysed: row.analysed_at !== null,
  };
}

export type LearningOutcome =
  | { status: 'learned'; lessons: number; confirmed: number }
  | { status: 'nothing_to_learn' }
  | { status: 'failed'; message: string };

/**
 * Turns one piece of unanalysed feedback into lessons.
 *
 * Claimed with a lease so two workers cannot count the same feedback twice
 * towards the same lesson — the evidence count is what promotes a candidate,
 * so double-counting would confirm rules nobody actually asked for.
 */
export async function analyseNextFeedback(): Promise<LearningOutcome | null> {
  const claim = await claimFeedback();
  if (!claim) return null;

  const scope: CompanyScope = {
    companyId: claim.companyId,
    userId: '00000000-0000-0000-0000-000000000000',
    role: 'owner',
  };

  try {
    const provider = brain();
    if (!provider.configured) {
      return { status: 'failed', message: 'The Brain is not configured.' };
    }

    const analysis = await provider.analyzeFeedback({
      score: claim.score,
      comment: claim.comment,
      requestText: claim.requestText,
      taskType: claim.taskType,
      platform: claim.platform,
      campaign: claim.campaign,
      product: claim.product,
    });

    if (analysis.lessons.length === 0) {
      await markAnalysed(scope, claim.feedbackId);
      return { status: 'nothing_to_learn' };
    }

    let confirmed = 0;
    for (const lesson of analysis.lessons) {
      // The scope the provider judged the lesson to apply to, narrowed to what
      // this generation actually was. A lesson can never be recorded against a
      // campaign the generation did not belong to.
      const scoped = {
        taskType: lesson.appliesTo === 'company' ? null : claim.taskType,
        platform: lesson.appliesTo === 'platform' ? claim.platform : null,
        campaign: lesson.appliesTo === 'campaign' ? claim.campaign : null,
        product: lesson.appliesTo === 'product' ? claim.product : null,
      };

      const promoted = await upsertLesson(scope, {
        ...scoped,
        polarity: lesson.polarity,
        statement: lesson.statement.trim().slice(0, 400),
        feedbackId: claim.feedbackId,
      });
      if (promoted) confirmed += 1;
    }

    await markAnalysed(scope, claim.feedbackId);
    return { status: 'learned', lessons: analysis.lessons.length, confirmed };
  } catch (error) {
    // Leave it unanalysed so it is picked up again; the lease expires on its
    // own. Never log the error: it can carry the comment.
    void error;
    await releaseFeedback(claim.feedbackId);
    return { status: 'failed', message: 'That feedback could not be analysed.' };
  }
}

type ClaimedFeedback = {
  feedbackId: string;
  companyId: string;
  score: number;
  comment: string | null;
  requestText: string;
  taskType: string;
  platform: string | null;
  campaign: string | null;
  product: string | null;
};

/**
 * Takes the next unanalysed feedback.
 *
 * Marked with a far-future analysed_at as a lease rather than a separate
 * column: the row is invisible to other workers while it is held, and
 * markAnalysed replaces it with the real timestamp when the work is done.
 */
async function claimFeedback(): Promise<ClaimedFeedback | null> {
  const sql = adminSql();
  try {
    const rows = await sql<
      {
        id: string; company_id: string; score: number; comment: string | null;
        request_text: string | null; task_type: string | null; platform: string | null;
        campaign: string | null; product: string | null; prompt: string;
      }[]
    >`
      update generation_feedback fb
         set analysed_at = 'infinity'
       where fb.id = (
         select f2.id from generation_feedback f2
          where f2.analysed_at is null
          order by f2.created_at
            for update skip locked
          limit 1
       )
      returning fb.id, fb.company_id, fb.score, fb.comment,
                (select b.request_text from generation_briefs b
                  where b.generation_id = fb.generation_id limit 1) as request_text,
                (select b.task_type from generation_briefs b
                  where b.generation_id = fb.generation_id limit 1) as task_type,
                (select b.platform from generation_briefs b
                  where b.generation_id = fb.generation_id limit 1) as platform,
                (select b.campaign from generation_briefs b
                  where b.generation_id = fb.generation_id limit 1) as campaign,
                (select b.product from generation_briefs b
                  where b.generation_id = fb.generation_id limit 1) as product,
                (select g.prompt from media_generations g where g.id = fb.generation_id) as prompt
    `;

    const row = rows[0];
    if (!row) return null;

    return {
      feedbackId: row.id,
      companyId: row.company_id,
      score: row.score,
      comment: row.comment,
      // A generation made without the Brain has no brief; its own prompt is
      // the best record of what was asked for.
      requestText: row.request_text ?? row.prompt,
      taskType: row.task_type ?? 'unknown',
      platform: row.platform,
      campaign: row.campaign,
      product: row.product,
    };
  } finally {
    await sql.end();
  }
}

async function releaseFeedback(feedbackId: string): Promise<void> {
  const sql = adminSql();
  try {
    await sql`update generation_feedback set analysed_at = null where id = ${feedbackId}`;
  } finally {
    await sql.end();
  }
}

async function markAnalysed(scope: CompanyScope, feedbackId: string): Promise<void> {
  await withCompanyScope(scope, async (tx) => {
    await tx`update generation_feedback set analysed_at = now() where id = ${feedbackId}`;
  });
}

/**
 * Records a lesson, or adds evidence to one already known.
 *
 * Returns true when this piece of evidence was the one that confirmed it.
 * Evidence is counted from the linking rows rather than incremented, so the
 * same feedback can never support a lesson twice however often it is replayed.
 */
async function upsertLesson(
  scope: CompanyScope,
  input: {
    polarity: 'prefer' | 'avoid';
    statement: string;
    taskType: string | null;
    platform: string | null;
    campaign: string | null;
    product: string | null;
    feedbackId: string;
  },
): Promise<boolean> {
  const active = embedder();
  const canEmbed = await similaritySupported(scope);

  let literal: string | null = null;
  if (canEmbed) {
    try {
      const [vector] = await active.embed([input.statement]);
      literal = vector ? toVectorLiteral(vector) : null;
    } catch {
      literal = null;
    }
  }

  return withCompanyScope(scope, async (tx) => {
    const rows = await tx<{ id: string }[]>`
      insert into brain_lessons
        (company_id, polarity, statement, task_type, platform, campaign, product,
         status, evidence_count, confidence, embed_model)
      values
        (${scope.companyId}, ${input.polarity}, ${input.statement},
         ${input.taskType}, ${input.platform}, ${input.campaign}, ${input.product},
         'candidate', 0, 0, ${literal ? active.model : null})
      on conflict (company_id, polarity, statement,
                   coalesce(task_type, ''), coalesce(platform, ''),
                   coalesce(campaign, ''), coalesce(product, ''))
        do update set updated_at = now()
      returning id
    `;

    const lessonId = rows[0]!.id;

    if (literal) {
      await tx`update brain_lessons set embedding = ${literal}::vector where id = ${lessonId}`;
    }

    await tx`
      insert into brain_lesson_evidence (company_id, lesson_id, feedback_id)
      values (${scope.companyId}, ${lessonId}, ${input.feedbackId})
      on conflict (lesson_id, feedback_id) do nothing
    `;

    // Counted from the evidence rows. This is what makes replay safe.
    const counted = await tx<{ n: number }[]>`
      select count(*)::int n from brain_lesson_evidence where lesson_id = ${lessonId}
    `;
    const evidence = counted[0]?.n ?? 1;

    const updated = await tx<{ status: string }[]>`
      update brain_lessons
         set evidence_count = ${evidence},
             confidence = least(0.95, round((${evidence}::numeric / (${evidence} + 2)), 3)),
             status = case
               when status in ('rejected', 'superseded') then status
               when ${evidence} >= ${BRAIN_LIMITS.lessonConfirmAt} then 'confirmed'
               else 'candidate'
             end,
             updated_at = now()
       where id = ${lessonId}
      returning status
    `;

    return updated[0]?.status === 'confirmed' && evidence === BRAIN_LIMITS.lessonConfirmAt;
  });
}

/** What the Brain has learned, for the UI. */
export async function readLessons(
  scope: CompanyScope,
  options: { status?: LessonDTO['status'] | null; limit?: number } = {},
): Promise<LessonDTO[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const status = options.status ?? null;

  const rows = await withCompanyScope(scope, async (tx) =>
    tx<
      {
        id: string; polarity: 'prefer' | 'avoid'; statement: string; status: LessonDTO['status'];
        evidence_count: number; confidence: string; task_type: string | null;
        platform: string | null; campaign: string | null; product: string | null; created_at: Date;
      }[]
    >`
      select id, polarity, statement, status, evidence_count, confidence,
             task_type, platform, campaign, product, created_at
        from brain_lessons
       where (${status}::text is null or status = ${status})
       order by (status = 'confirmed') desc, evidence_count desc, created_at desc
       limit ${limit}
    `,
  );

  return rows.map((row) => ({
    id: row.id,
    polarity: row.polarity,
    statement: row.statement,
    status: row.status,
    evidenceCount: row.evidence_count,
    confidence: Number(row.confidence),
    taskType: row.task_type,
    platform: row.platform,
    campaign: row.campaign,
    product: row.product,
    createdAt: row.created_at.toISOString(),
  }));
}

/** Recent feedback, for the UI. */
export async function readFeedback(scope: CompanyScope, limit = 50): Promise<FeedbackDTO[]> {
  const rows = await withCompanyScope(scope, async (tx) =>
    tx<
      { id: string; generation_id: string; score: number; comment: string | null; created_at: Date; analysed_at: Date | null }[]
    >`
      select id, generation_id, score, comment, created_at, analysed_at
        from generation_feedback
       order by created_at desc
       limit ${Math.min(Math.max(limit, 1), 200)}
    `,
  );

  return rows.map((row) => ({
    id: row.id,
    generationId: row.generation_id,
    score: row.score,
    comment: row.comment,
    createdAt: row.created_at.toISOString(),
    // 'infinity' means a worker is holding it, which is not the same as done.
    analysed: row.analysed_at !== null && Number.isFinite(row.analysed_at.getTime()),
  }));
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
