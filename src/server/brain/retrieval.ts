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
  /**
   * Whether enough separate ratings have said this for CIP to act on it.
   *
   * Returned because the caller has to tell them apart. A candidate is one
   * person's opinion about one picture, and it used to reach the generator as
   * though the brand had decided it.
   */
  status: 'candidate' | 'confirmed';
  evidenceCount: number;
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
  /**
   * The brand this is for, when one was named.
   *
   * Similarity does not respect a roster: a request mentioning honey pulled
   * four Whytehall Honey files into an 8PM brief and handed them to the
   * generator as what 8PM looks like. A sibling's packshot is the single most
   * misleading thing a generator can be shown, because it does not argue —
   * it copies.
   *
   * Files belonging to no brand still come through. A company photograph or
   * an unnamed background is the house's, and withholding it would leave a
   * brand with less than it has.
   */
  brand: string | null = null,
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
         -- This brand's own material, plus anything belonging to no brand.
         and (${brand}::text is null or f.brand is null or f.brand = ${brand})
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

/**
 * Words that say a picture is of the product itself.
 *
 * Read off what the Brain called each asset while it looked at it, which is
 * the company's own vocabulary rather than a list anybody maintains: "packshot",
 * "product photograph", "photorealistic product render".
 */
const IS_PRODUCT_SHOT =
  /pack\s?shot|packaging|product\s*(shot|photo|photograph|image|render)|bottle/i;

/** And words that say it is a piece of advertising, which is a different thing. */
const IS_ADVERTISING = /advert|poster|ooh|out-of-home|billboard|creative|social|banner|campaign/i;

/** Artwork of the label or logo: not the bottle, but the truth about what is printed on it. */
const IS_ARTWORK = /logo|label|lockup|wordmark|artwork/i;

export type ProductShot = RetrievedAsset & {
  /** What the Brain called it when it looked at it. */
  contentType: string;
};

/**
 * Photographs of the product itself, for the brand and product being made.
 *
 * This is the reason a generated bottle looks like the real one. Similarity
 * retrieval answers "what resembles this request", and for "a Diwali banner"
 * that is every Diwali poster the brand has ever run — so the generator was
 * shown four campaign creatives, no photograph of the bottle, and drew a
 * whisky bottle from its own imagination with invented words on the label.
 *
 * Ranked rather than filtered, because every company's vocabulary differs:
 * a picture the Brain called a packshot beats one it called a poster, a file
 * whose name or summary carries the product asked for beats a sibling
 * product's, and label artwork counts because what is printed on a bottle is
 * exactly what a generator invents when nothing shows it.
 *
 * Needs no pgvector: a company without embeddings still gets its own bottle.
 */
export async function productShots(
  scope: CompanyScope,
  options: { brand: string | null; requestText: string; limit?: number },
): Promise<ProductShot[]> {
  const limit = Math.min(Math.max(options.limit ?? 2, 1), 5);
  const brand = options.brand?.trim() || null;

  const rows = await withCompanyScope(scope, async (tx) =>
    tx<
      {
        file_id: string; name: string; file_type: string; summary: string;
        extracted_text: string | null; content_type: string; products: string[] | null;
      }[]
    >`
      select u.file_id, f.name, f.file_type, u.summary, u.extracted_text,
             coalesce(u.structured->>'contentType', '') as content_type,
             case when jsonb_typeof(u.structured->'products') = 'array'
                  then array(select jsonb_array_elements_text(u.structured->'products'))
                  else null end as products
        from asset_understanding u
        join drive_files f on f.id = u.file_id
       where u.status = 'ready'
         and f.archived_at is null
         and lower(f.file_type) in ('png', 'jpg', 'jpeg', 'webp')
         -- This brand's own. A bottle is the one thing that must never come
         -- from a sibling, and an unattributed photograph of "a bottle" is
         -- some brand's bottle - just not knowably this one.
         and (${brand}::text is null or f.brand = ${brand})
       limit 400
    `,
  );

  const wanted = words(options.requestText);

  const scored = rows
    .map((row) => {
      const said = `${row.name} ${row.content_type} ${row.summary}`;
      const named = [row.name, row.summary, ...(row.products ?? [])].join(' ');

      let score = 0;
      if (IS_PRODUCT_SHOT.test(row.content_type)) score += 4;
      if (IS_PRODUCT_SHOT.test(row.name)) score += 3;
      if (IS_ARTWORK.test(said)) score += 2;
      // A poster of the product is not a photograph of it: it is the product
      // already dressed in a layout, and copied it brings the layout with it.
      if (IS_ADVERTISING.test(row.content_type)) score -= 5;

      // The product actually asked for, and weighted above everything else.
      // "Whytehall Honey" and "Whytehall Chocolate" are one brand and two
      // different bottles, and the label is the whole difference between them:
      // asked for Honey, CIP sent the Chocolate pack because that file had the
      // better-sounding description. Which bottle it is beats how well it was
      // photographed, every time.
      const overlap = [...words(named)].filter((word) => wanted.has(word)).length;
      score += Math.min(overlap, 3) * 4;

      return { row, score, overlap };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || b.overlap - a.overlap || a.row.name.localeCompare(b.row.name));

  // A photograph of the pack leads, with label artwork behind it. Both are
  // worth sending — the artwork is the only thing that says exactly what is
  // printed — but the generator should see the object first.
  const isPhoto = (row: { content_type: string; name: string }): boolean => {
    const said = `${row.content_type} ${row.name}`;
    // "label/packaging artwork" carries the word packaging and is a drawing of
    // a label, not a picture of the pack. Both are useful; only one is the
    // object.
    return (IS_PRODUCT_SHOT.test(row.content_type) || IS_PRODUCT_SHOT.test(row.name))
      && !IS_ARTWORK.test(said);
  };

  return scored
    .slice(0, limit)
    .sort((a, b) => Number(isPhoto(b.row)) - Number(isPhoto(a.row)))
    .map(({ row, score }) => ({
    fileId: row.file_id,
    fileName: row.name,
    fileType: row.file_type,
    summary: row.summary,
    extractedText: row.extracted_text,
    contentType: row.content_type,
    score,
  }));
}

/** The words worth matching on: long enough to mean something, lower case. */
function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length >= 3 && !STOPWORDS.has(word)),
  );
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'make', 'create', 'image',
  'photo', 'picture', 'post', 'banner', 'poster', 'new', 'png', 'jpg', 'jpeg', 'webp',
  'copy', 'final', 'revised', 'radico', 'bottles',
]);

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
  /** The brand this is for. A sibling's post is not this brand's example. */
  brand: string | null = null,
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
           and (${brand}::text is null or f.brand is null or f.brand = ${brand})
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
  options: { mediaType: 'image' | 'video'; limit?: number; brand?: string | null },
): Promise<{ positive: RetrievedExample[]; negative: RetrievedExample[] }> {
  const limit = Math.min(Math.max(options.limit ?? 3, 1), 10);
  const brand = options.brand ?? null;

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
         -- Work rated for another brand is not an example for this one. The
         -- brief that produced it recorded which brand it was for; work from
         -- before that was recorded has no brand and still counts.
         and (
           ${brand}::text is null
           or b.brief->>'brand' is null
           or b.brief->>'brand' = ${brand}
         )
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
    /**
     * The brand this is for.
     *
     * A lesson had a task type, a platform, a campaign and a product, and no
     * brand — so "keep the Magic Moments product prominent", learned from
     * Magic Moments feedback, arrived in an 8PM brief and told it what to do.
     */
    brand?: string | null;
  },
  limit = BRAIN_LIMITS.maxLessons,
): Promise<RetrievedLesson[]> {
  const rows = await withCompanyScope(scope, async (tx) =>
    tx<
      {
        id: string; polarity: 'prefer' | 'avoid'; statement: string; confidence: string;
        task_type: string | null; campaign: string | null; product: string | null; platform: string | null;
        status: 'candidate' | 'confirmed'; evidence_count: number;
      }[]
    >`
      select id, polarity, statement, confidence, task_type, campaign, product, platform,
             status, evidence_count
        from brain_lessons
       where status in ('candidate', 'confirmed')
         -- A null scope column means "applies anywhere". A set one must match.
         and (task_type is null or task_type = ${context.taskType ?? null})
         and (platform  is null or platform  = ${context.platform ?? null})
         and (campaign  is null or campaign  = ${context.campaign ?? null})
         and (product   is null or product   = ${context.product ?? null})
         and (brand     is null or brand     = ${context.brand ?? null})
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
    status: row.status,
    evidenceCount: row.evidence_count,
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
