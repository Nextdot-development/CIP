import 'server-only';
import { withCompanyScope } from '../db';
import type { CompanyScope } from '../db';
import { embedder, toVectorLiteral } from '../drive/embedding';
import { BRAIN_LIMITS } from './providers/types';
import { similaritySupported } from './capabilities';

/**
 * Finding the memory that matters for one request.
 *
 * Everything here runs inside withCompanyScope and takes no company parameter,
 * so a request cannot reach another company's memory. Row-level security is the
 * filter even where a WHERE clause also names the company.
 *
 * Retrieval is bounded and index-backed. Similarity uses the same pgvector
 * setup and the same embedder as Phase 4 — there is no second vector system —
 * and every query is ordered by the HNSW index with a LIMIT, so the cost does
 * not grow with the size of the company.
 */

export type RetrievedAsset = {
  fileId: string;
  fileName: string;
  /** The extension, so a caller can tell an image apart from a document. */
  fileType: string;
  summary: string;
  extractedText: string | null;
  score: number;
};

export type RetrievedExample = {
  generationId: string;
  requestText: string;
  score: number;
  comment: string | null;
};

export type RetrievedLesson = {
  id: string;
  polarity: 'prefer' | 'avoid';
  statement: string;
  confidence: number;
  taskType: string | null;
  campaign: string | null;
  product: string | null;
  platform: string | null;
};

/** Below this two things are not meaningfully related. Matches Phase 4's floor. */
const MIN_SIMILARITY = 0.3;

/**
 * Assets whose understanding resembles the request.
 *
 * The request is embedded once and compared against asset summaries, which were
 * embedded by the same embedder when they were analysed — so this is a search
 * over what the assets *mean*, not over their filenames.
 */
export async function similarAssets(
  scope: CompanyScope,
  requestText: string,
  limit = BRAIN_LIMITS.maxReferences,
): Promise<RetrievedAsset[]> {
  // Similarity needs the vector column, which only exists where pgvector does.
  // Without it the Brain still plans — just without visual references.
  if (!(await similaritySupported(scope))) return [];

  const active = embedder();

  let literal: string;
  try {
    const [vector] = await active.embed([requestText]);
    if (!vector) return [];
    literal = toVectorLiteral(vector);
  } catch {
    // Without an embedding there is no similarity to compute. The brief is
    // still built, just without visual references.
    return [];
  }

  const maxDistance = 1 - MIN_SIMILARITY;

  const rows = await withCompanyScope(scope, async (tx) =>
    tx<
      {
        file_id: string; name: string; file_type: string; summary: string;
        extracted_text: string | null; score: string;
      }[]
    >`
      select u.file_id, f.name, f.file_type, u.summary, u.extracted_text,
             1 - (u.embedding <=> ${literal}::vector) as score
        from asset_understanding u
        join drive_files f on f.id = u.file_id
       where u.status = 'ready'
         and u.embedding is not null
         and u.embed_model = ${active.model}
         and f.archived_at is null
         and (u.embedding <=> ${literal}::vector) <= ${maxDistance}
       order by u.embedding <=> ${literal}::vector
       limit ${Math.min(Math.max(limit, 1), 20)}
    `,
  );

  return rows.map((row) => ({
    fileId: row.file_id,
    fileName: row.name,
    fileType: row.file_type,
    summary: row.summary,
    extractedText: row.extracted_text,
    score: Number(row.score),
  }));
}

/** One post read off a PDF page, retrieved by what it was about. */
export type RetrievedPost = {
  fileId: string;
  fileName: string;
  pageNumber: number;
  postIndex: number;
  country: string | null;
  caption: string | null;
  summary: string;
  score: number;
};

/**
 * Posts from this company's PDFs that resemble the request.
 *
 * Separate from similarAssets because the grain is different. A 30-page deck
 * of Instagram posts is one asset and eighty creative decisions; retrieving
 * "the India deck" says almost nothing, and retrieving the four Diwali posts
 * inside it says a great deal.
 *
 * `country` is returned so a caller can see which market a post came from.
 * These files arrive one per country and the difference matters — but it is
 * reported, never filtered on here, because the request decides what is
 * relevant, not this function.
 */
export async function similarPosts(
  scope: CompanyScope,
  requestText: string,
  limit = BRAIN_LIMITS.maxReferences,
): Promise<RetrievedPost[]> {
  if (!(await similaritySupported(scope))) return [];

  const active = embedder();

  let literal: string;
  try {
    const [vector] = await active.embed([requestText]);
    if (!vector) return [];
    literal = toVectorLiteral(vector);
  } catch {
    return [];
  }

  const maxDistance = 1 - MIN_SIMILARITY;

  // The posts table only exists once 0011 has run. A database that has not
  // migrated yet still plans; it simply has no posts to offer.
  try {
    const rows = await withCompanyScope(scope, async (tx) =>
      tx<
        {
          file_id: string; name: string; page_number: number; post_index: number;
          country: string | null; caption: string | null; summary: string; score: string;
        }[]
      >`
        select p.file_id, f.name, p.page_number, p.post_index, p.country,
               p.caption, p.summary,
               1 - (p.embedding <=> ${literal}::vector) as score
          from pdf_post p
          join drive_files f on f.id = p.file_id
         where p.embedding is not null
           and p.embed_model = ${active.model}
           and f.archived_at is null
           and (p.embedding <=> ${literal}::vector) <= ${maxDistance}
         order by p.embedding <=> ${literal}::vector
         limit ${Math.min(Math.max(limit, 1), 20)}
      `,
    );

    return rows.map((row) => ({
      fileId: row.file_id,
      fileName: row.name,
      pageNumber: row.page_number,
      postIndex: row.post_index,
      country: row.country,
      caption: row.caption,
      summary: row.summary,
      score: Number(row.score),
    }));
  } catch {
    return [];
  }
}

/**
 * Past generations this company rated well, and badly.
 *
 * Both matter. Positive examples say what to aim for; negative ones say what
 * not to repeat, which is the part a model will otherwise cheerfully do again.
 */
export async function ratedExamples(
  scope: CompanyScope,
  options: { mediaType: 'image' | 'video'; limit?: number },
): Promise<{ positive: RetrievedExample[]; negative: RetrievedExample[] }> {
  const limit = Math.min(Math.max(options.limit ?? 3, 1), 10);

  const rows = await withCompanyScope(scope, async (tx) =>
    tx<
      { generation_id: string; request_text: string; score: number; comment: string | null }[]
    >`
      select fb.generation_id,
             coalesce(b.request_text, g.prompt) as request_text,
             fb.score, fb.comment
        from generation_feedback fb
        join media_generations g on g.id = fb.generation_id
        left join generation_briefs b on b.generation_id = fb.generation_id
       where g.type = ${options.mediaType}
         and (fb.score >= 8 or fb.score <= 4)
       order by fb.created_at desc
       limit ${limit * 4}
    `,
  );

  const asExample = (row: (typeof rows)[number]): RetrievedExample => ({
    generationId: row.generation_id,
    requestText: row.request_text,
    score: row.score,
    comment: row.comment,
  });

  return {
    positive: rows.filter((r) => r.score >= 8).slice(0, limit).map(asExample),
    negative: rows.filter((r) => r.score <= 4).slice(0, limit).map(asExample),
  };
}

/**
 * Lessons that apply to this context.
 *
 * This is where context-aware learning is actually enforced. A lesson with a
 * campaign set only applies to that campaign; one with no scope at all applies
 * anywhere. Without this, "reduce the text" learned for one Diwali post would
 * quietly govern every asset the company ever generates.
 *
 * Confirmed lessons rank above candidates, and more evidence ranks above less.
 */
export async function applicableLessons(
  scope: CompanyScope,
  context: {
    taskType?: string | null;
    platform?: string | null;
    campaign?: string | null;
    product?: string | null;
  },
  limit = BRAIN_LIMITS.maxLessons,
): Promise<RetrievedLesson[]> {
  const rows = await withCompanyScope(scope, async (tx) =>
    tx<
      {
        id: string; polarity: 'prefer' | 'avoid'; statement: string; confidence: string;
        task_type: string | null; campaign: string | null; product: string | null; platform: string | null;
      }[]
    >`
      select id, polarity, statement, confidence, task_type, campaign, product, platform
        from brain_lessons
       where status in ('candidate', 'confirmed')
         -- A null scope column means "applies anywhere". A set one must match.
         and (task_type is null or task_type = ${context.taskType ?? null})
         and (platform  is null or platform  = ${context.platform ?? null})
         and (campaign  is null or campaign  = ${context.campaign ?? null})
         and (product   is null or product   = ${context.product ?? null})
       order by (status = 'confirmed') desc, confidence desc, evidence_count desc
       limit ${Math.min(Math.max(limit, 1), 30)}
    `,
  );

  return rows.map((row) => ({
    id: row.id,
    polarity: row.polarity,
    statement: row.statement,
    confidence: Number(row.confidence),
    taskType: row.task_type,
    campaign: row.campaign,
    product: row.product,
    platform: row.platform,
  }));
}

/**
 * Free-text search across a company's memory.
 *
 * Backs the Brain UI's memory view. Matches the readable summary and any text
 * found inside the asset, so searching for a word that appears on a poster
 * finds the poster.
 */
export async function searchMemory(
  scope: CompanyScope,
  term: string,
  limit = 40,
): Promise<RetrievedAsset[]> {
  const trimmed = term.trim();
  if (trimmed.length === 0) return [];

  const like = `%${trimmed.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;

  const rows = await withCompanyScope(scope, async (tx) =>
    tx<{ file_id: string; name: string; file_type: string; summary: string; extracted_text: string | null }[]>`
      select u.file_id, f.name, f.file_type, u.summary, u.extracted_text
        from asset_understanding u
        join drive_files f on f.id = u.file_id
       where u.status = 'ready'
         and f.archived_at is null
         and (u.summary ilike ${like} escape '\\'
              or u.extracted_text ilike ${like} escape '\\'
              or f.name ilike ${like} escape '\\')
       order by u.updated_at desc
       limit ${Math.min(Math.max(limit, 1), 100)}
    `,
  );

  return rows.map((row) => ({
    fileId: row.file_id,
    fileName: row.name,
    fileType: row.file_type,
    summary: row.summary,
    extractedText: row.extracted_text,
    score: 1,
  }));
}
