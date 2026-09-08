import 'server-only';
import { withCompanyScope } from '../db';
import type { CompanyScope } from '../db';
import { driveStorage, pdfPageKeyFor } from '../drive/storage';
import { embedder, toVectorLiteral } from '../drive/embedding';
import { profilePdf, renderPdfPages, RENDER_LIMITS } from '../drive/extraction/pdfRender';
import type { PdfProfile, RenderedBand } from '../drive/extraction/pdfRender';
import { brain } from './providers';
import { BrainFailed, BRAIN_LIMITS } from './providers/types';
import type { AssetAnalysis, PdfPageAnalysis, PdfPost } from './providers/types';
import { similaritySupported } from './capabilities';

/**
 * Reading a PDF by looking at it.
 *
 * The text extractor reads a PDF's text layer, and a screenshot has none. An
 * Instagram page exported to PDF is a picture of a post: pdf.js finds nothing,
 * so the document contributes nothing, and a company's most brand-defining
 * assets sit in the Drive making no difference to anything.
 *
 * This renders each page and asks the existing vision model what is on it. The
 * two halves are deliberately kept apart: rendering is deterministic and lives
 * with the other extractors, and only the interpretation happens here.
 *
 * Cost is the reason for the shape of it. A vision call per page is expensive
 * enough that pages are chosen rather than swept: a page with a real text
 * layer and no pictures has already been read, and rendering it would buy
 * nothing. Everything else is bounded by RENDER_LIMITS.
 *
 * PRIVACY: the provider is sent a rendered page, its position in the document
 * and the display filename. Never the company, the file id or the storage path.
 */

export type PdfVisualOutcome = {
  analysis: AssetAnalysis;
  pageCount: number;
  pagesRendered: number;
  pagesUnderstood: number;
  pagesFailed: number;
  pagesSkipped: number;
  postsDetected: number;
  hasTextLayer: boolean;
};

/** Whether this PDF needs looking at, rather than merely reading. */
export function needsVisualPass(profile: PdfProfile): boolean {
  // No text worth the name: the only way to read it is to look at it.
  if (!profile.hasTextLayer) return true;
  // Text *and* pictures: the text has been read, but the pictures carry the
  // brand — layout, palette, product presentation — and are worth the pass.
  return profile.hasImages;
}

/** The pages worth rendering, in order. */
export function pagesToRender(profile: PdfProfile): number[] {
  // When there is no text layer at all, every page is a candidate: a page that
  // draws no bitmap may still be vector artwork, which renders perfectly well.
  if (!profile.hasTextLayer) {
    return profile.pages.map((page) => page.pageNumber);
  }

  // Otherwise only the pages that actually show something. A page of body text
  // in a document that has already been read has nothing left to give.
  return profile.pages.filter((page) => page.hasImage).map((page) => page.pageNumber);
}

/**
 * Runs the visual pass over one PDF and records everything it found.
 *
 * Page failures are survivable by design. One page that will not render, or
 * one the model refuses, must not cost the other thirty-nine — the page is
 * recorded as failed with its reason, and the document still yields what it
 * could. Only a document where nothing at all could be read is an error.
 */
export async function understandPdfVisually(
  scope: CompanyScope,
  input: {
    fileId: string;
    understandingId: string;
    filename: string;
    bytes: Buffer;
  },
): Promise<PdfVisualOutcome> {
  const provider = brain();
  const profile = await profilePdf(input.bytes);
  const wanted = pagesToRender(profile);

  const rendered = await renderPdfPages(input.bytes, wanted);

  // Rendered but never analysed: the budget ran out part-way through.
  const skipped = new Set(rendered.skipped);

  if (rendered.pages.length === 0) {
    throw new BrainFailed(
      'UNSUPPORTED_ASSET',
      'permanent',
      'No page of this PDF could be rendered, so there was nothing to look at.',
    );
  }

  const canEmbed = await similaritySupported(scope);
  const active = embedder();

  let pagesUnderstood = 0;
  let pagesFailed = 0;
  let postsDetected = 0;

  const summaries: string[] = [];
  const allColours: string[] = [];
  const allTypography: string[] = [];
  const allPatterns: string[] = [];
  const countries = new Set<string>();
  const pageTextParts: string[] = [];

  for (const page of rendered.pages) {
    const profiled = profile.pages.find((p) => p.pageNumber === page.pageNumber);
    // Whatever the deterministic pass already read off this page. Null when
    // there was nothing, which is the normal case for a screenshot.
    const pageText = profiled?.text?.trim() ? profiled.text : null;

    // The row comes first, because its id is what the object is named after —
    // the storage layer only accepts keys built from ids we generated, and a
    // page number is not one.
    const pageId = await upsertPage(scope, {
      fileId: input.fileId,
      understandingId: input.understandingId,
      pageNumber: page.pageNumber,
      width: page.width,
      height: page.height,
      bytes: page.bands.reduce((total, band) => total + band.bytes.length, 0),
      hasTextLayer: (profiled?.textLength ?? 0) >= RENDER_LIMITS.minTextChars,
      pageText,
    });

    // The rendered page is kept, because the inspection view has to be able to
    // show what the model was looking at when it made a claim. The first band
    // is the whole page for anything of ordinary proportions; for a strip it is
    // the top of it, which is enough to recognise the page by.
    const first = page.bands[0];
    if (!first) continue;

    const imagePath = pdfPageKeyFor(scope.companyId, input.fileId, pageId);
    await driveStorage().put(imagePath, first.bytes, 'image/jpeg');

    await withCompanyScope(scope, async (tx) => {
      await tx`update pdf_page_understanding set image_path = ${imagePath} where id = ${pageId}`;
    });

    try {
      // A tall page is looked at in strips, because a 1:8 image resolves almost
      // nothing across its narrow axis. Each strip is a separate question about
      // the same page, and the answers are combined below — the page number
      // stays the provenance, which is what a reader can actually check.
      const analysis = await analyseBands(provider, {
        page,
        pageCount: profile.pageCount,
        pageText,
        filename: input.filename,
      });

      await storePage(scope, {
        pageId,
        fileId: input.fileId,
        pageNumber: page.pageNumber,
        analysis,
        canEmbed,
        embedModel: active.model,
      });

      pagesUnderstood += 1;
      postsDetected += analysis.posts.length;
      if (analysis.summary) summaries.push(`p${page.pageNumber}: ${analysis.summary}`);
      if (analysis.extractedText) pageTextParts.push(analysis.extractedText);

      const structured = analysis.structured as {
        colours?: string[]; typography?: string[]; recurringPatterns?: string[]; country?: string | null;
      };
      allColours.push(...(structured.colours ?? []));
      allTypography.push(...(structured.typography ?? []));
      allPatterns.push(...(structured.recurringPatterns ?? []));
      if (structured.country) countries.add(structured.country);
      for (const post of analysis.posts) if (post.country) countries.add(post.country);
    } catch (error) {
      pagesFailed += 1;
      const failure =
        error instanceof BrainFailed
          ? error
          : new BrainFailed('PROVIDER_ERROR', 'transient', 'This page could not be understood.');

      await withCompanyScope(scope, async (tx) => {
        await tx`
          update pdf_page_understanding
             set status = 'failed',
                 error_code = ${failure.code},
                 error_message = ${failure.message.slice(0, 500)},
                 updated_at = now()
           where id = ${pageId}
        `;
      });

      // A page the provider refuses outright will be refused again on the next
      // page too, and paying forty times to learn that is not worth it.
      if (failure.code === 'NOT_CONFIGURED' || failure.kind === 'rate_limited') throw failure;
    }
  }

  if (pagesUnderstood === 0) {
    throw new BrainFailed(
      'PROVIDER_ERROR',
      'transient',
      'Every page of this PDF failed to be understood.',
    );
  }

  return {
    analysis: {
      summary:
        `${profile.pageCount}-page PDF "${input.filename}" read visually: ` +
        `${postsDetected} post(s) across ${pagesUnderstood} page(s)` +
        (countries.size > 0 ? ` from ${[...countries].join(', ')}` : '') +
        '. ' +
        summaries.slice(0, 6).join(' '),
      extractedText: pageTextParts.join('\n\n').slice(0, 200_000) || null,
      structured: {
        pageCount: profile.pageCount,
        pagesRendered: rendered.pages.length,
        pagesUnderstood,
        pagesFailed,
        pagesSkipped: skipped.size,
        postsDetected,
        hasTextLayer: profile.hasTextLayer,
        countries: [...countries],
        colours: mostCommon(allColours, 8),
        typography: mostCommon(allTypography, 6),
        recurringPatterns: mostCommon(allPatterns, 8),
      },
      // Deliberately empty. Every fact this PDF produced has already been
      // written against the page it was seen on, which is provenance a
      // file-level write cannot express: "page 7 of the India deck" is
      // checkable, "somewhere in the India deck" is not.
      facts: [],
      usage: { inputTokens: null, outputTokens: null, durationMs: null },
    },
    pageCount: profile.pageCount,
    pagesRendered: rendered.pages.length,
    pagesUnderstood,
    pagesFailed,
    pagesSkipped: skipped.size,
    postsDetected,
    hasTextLayer: profile.hasTextLayer,
  };
}

/**
 * Looks at every strip of one page and combines what came back.
 *
 * Bands overlap on purpose, so a post cut in half by one boundary appears
 * whole on the next — which means the same post can be reported twice. They
 * are matched on what the model read off them rather than on position: two
 * descriptions of the same tile agree on its caption and its text long before
 * they agree on where it sits.
 *
 * Post indices are renumbered across the whole page, so `page 2, post 7` means
 * the seventh post on page 2 regardless of which strip found it.
 */
async function analyseBands(
  provider: ReturnType<typeof brain>,
  input: {
    page: { pageNumber: number; bands: readonly RenderedBand[] };
    pageCount: number;
    pageText: string | null;
    filename: string;
  },
): Promise<PdfPageAnalysis> {
  const results: PdfPageAnalysis[] = [];

  for (const band of input.page.bands) {
    results.push(
      await provider.analyzePdfPage({
        bytes: band.bytes,
        mimeType: band.mimeType,
        pageNumber: input.page.pageNumber,
        pageCount: input.pageCount,
        // The text belongs to the whole page, so every strip gets it. It is a
        // hint for reading a picture, not a claim about this strip.
        pageText: input.pageText,
        filename: input.filename,
      }),
    );
  }

  const first = results[0];
  if (!first) {
    throw new BrainFailed('UNSUPPORTED_ASSET', 'permanent', 'This page produced no bands to look at.');
  }
  if (results.length === 1) return first;

  const posts: PdfPost[] = [];
  const seen = new Set<string>();

  for (const result of results) {
    for (const post of result.posts) {
      const key = identityOf(post);
      // A post with nothing readable on it cannot be matched to its twin, so
      // it is kept: losing a real tile is worse than keeping a duplicate.
      if (key !== null) {
        if (seen.has(key)) continue;
        seen.add(key);
      }
      posts.push({ ...post, postIndex: posts.length });
    }
  }

  return {
    summary: results.map((r) => r.summary).filter(Boolean).join(' '),
    extractedText: results.map((r) => r.extractedText).filter(Boolean).join('\n') || null,
    structured: {
      ...first.structured,
      bandsAnalysed: results.length,
      postCount: posts.length,
    },
    facts: dedupeFacts(results.flatMap((r) => r.facts)),
    posts: posts.slice(0, BRAIN_LIMITS.maxPostsPerPage * results.length),
    usage: {
      inputTokens: sum(results.map((r) => r.usage.inputTokens)),
      outputTokens: sum(results.map((r) => r.usage.outputTokens)),
      durationMs: sum(results.map((r) => r.usage.durationMs)),
    },
  };
}

/** What makes two sightings of a post the same post, or null if nothing does. */
function identityOf(post: PdfPost): string | null {
  const parts = [post.caption, post.headline, post.visibleText]
    .map((value) => value?.trim().toLowerCase())
    .filter((value): value is string => Boolean(value && value.length > 8));

  return parts.length > 0 ? parts.join('|').slice(0, 300) : null;
}

function dedupeFacts(facts: PdfPageAnalysis['facts']): PdfPageAnalysis['facts'] {
  const seen = new Set<string>();
  return facts.filter((fact) => {
    const key = `${fact.section}|${fact.attribute}|${fact.value}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sum(values: (number | null | undefined)[]): number | null {
  const present = values.filter((value): value is number => typeof value === 'number');
  return present.length > 0 ? present.reduce((a, b) => a + b, 0) : null;
}

/**
 * Creates or reclaims the row for one page.
 *
 * Reprocessing the same document has to land on the same rows rather than
 * accumulating a second set, so the page number is the identity and a rerun
 * resets the row to pending.
 */
async function upsertPage(
  scope: CompanyScope,
  page: {
    fileId: string;
    understandingId: string;
    pageNumber: number;
    width: number;
    height: number;
    bytes: number;
    hasTextLayer: boolean;
    pageText: string | null;
  },
): Promise<string> {
  return withCompanyScope(scope, async (tx) => {
    const rows = await tx<{ id: string }[]>`
      insert into pdf_page_understanding
        (company_id, file_id, understanding_id, page_number,
         image_width, image_height, image_bytes, has_text_layer, page_text, status)
      values
        (${scope.companyId}, ${page.fileId}, ${page.understandingId}, ${page.pageNumber},
         ${page.width}, ${page.height}, ${page.bytes},
         ${page.hasTextLayer}, ${page.pageText}, 'pending')
      on conflict (company_id, file_id, page_number) do update
         set understanding_id = excluded.understanding_id,
             image_width      = excluded.image_width,
             image_height     = excluded.image_height,
             image_bytes      = excluded.image_bytes,
             has_text_layer   = excluded.has_text_layer,
             page_text        = excluded.page_text,
             status           = 'pending',
             error_code       = null,
             error_message    = null,
             updated_at       = now()
      returning id
    `;

    const id = rows[0]?.id;
    if (!id) throw new Error('the page row could not be written');
    return id;
  });
}

/** Writes what one page turned out to hold: the page, its posts, its facts. */
async function storePage(
  scope: CompanyScope,
  input: {
    pageId: string;
    fileId: string;
    pageNumber: number;
    analysis: PdfPageAnalysis;
    canEmbed: boolean;
    embedModel: string;
  },
): Promise<void> {
  const { analysis } = input;

  // Embedded before the transaction: a network call inside one would hold a
  // row lock open for as long as the embedder takes.
  let vectors: (number[] | null)[] = analysis.posts.map(() => null);
  if (input.canEmbed && analysis.posts.length > 0) {
    try {
      const embedded = await embedder().embed(analysis.posts.map((post) => postText(post)));
      vectors = analysis.posts.map((_, index) => embedded[index] ?? null);
    } catch {
      // A post without a vector is still stored, still readable and still
      // evidence. Only "find me a post like this" misses it.
      vectors = analysis.posts.map(() => null);
    }
  }

  await withCompanyScope(scope, async (tx) => {
    await tx`
      update pdf_page_understanding
         set status = 'ready',
             provider = ${brain().name},
             model = ${brain().model},
             summary = ${analysis.summary},
             structured = ${tx.json(analysis.structured as never)},
             page_text = coalesce(${analysis.extractedText}, page_text),
             posts_detected = ${analysis.posts.length},
             duration_ms = ${analysis.usage.durationMs ?? null},
             input_tokens = ${analysis.usage.inputTokens ?? null},
             output_tokens = ${analysis.usage.outputTokens ?? null},
             error_code = null,
             error_message = null,
             updated_at = now()
       where id = ${input.pageId}
    `;

    // A rerun that finds fewer posts must not leave the extra ones behind
    // claiming to still be on the page.
    await tx`
      delete from pdf_post
       where company_id = ${scope.companyId}
         and file_id = ${input.fileId}
         and page_number = ${input.pageNumber}
         and post_index >= ${analysis.posts.length}
    `;

    for (const [index, post] of analysis.posts.entries()) {
      const rows = await tx<{ id: string }[]>`
        insert into pdf_post
          (company_id, file_id, page_id, page_number, post_index, country, account,
           posted_on, caption, headline, visible_text, summary, structured, confidence,
           embed_model)
        values
          (${scope.companyId}, ${input.fileId}, ${input.pageId}, ${input.pageNumber},
           ${post.postIndex}, ${post.country}, ${post.account}, ${post.postedOn},
           ${post.caption}, ${post.headline}, ${post.visibleText}, ${post.summary},
           ${tx.json(structuredOf(post) as never)}, ${post.confidence},
           ${vectors[index] ? input.embedModel : null})
        on conflict (company_id, file_id, page_number, post_index) do update
           set page_id      = excluded.page_id,
               country      = excluded.country,
               account      = excluded.account,
               posted_on    = excluded.posted_on,
               caption      = excluded.caption,
               headline     = excluded.headline,
               visible_text = excluded.visible_text,
               summary      = excluded.summary,
               structured   = excluded.structured,
               confidence   = excluded.confidence,
               embed_model  = excluded.embed_model,
               updated_at   = now()
        returning id
      `;

      const postId = rows[0]?.id;
      const vector = vectors[index];
      if (postId && vector) {
        // Written separately so the column can be absent altogether on a
        // database without pgvector, rather than failing the whole insert.
        await tx`
          update pdf_post set embedding = ${toVectorLiteral(vector)}::vector
           where id = ${postId}
        `;
      }
    }

    // Facts, with the page they were seen on. Two pages showing the same
    // pattern are two pieces of evidence, which is exactly right: a colour
    // that recurs across a deck is better evidenced than one seen once.
    for (const fact of analysis.facts) {
      const factRows = await tx<{ id: string }[]>`
        insert into brand_dna_facts
          (company_id, section, attribute, value, kind, confidence, evidence_count)
        values
          (${scope.companyId}, ${fact.section}, ${fact.attribute}, ${fact.value},
           'observed', 0.2, 1)
        on conflict (company_id, section, attribute, value) do update
           set evidence_count = brand_dna_facts.evidence_count + 1,
               updated_at = now()
        returning id
      `;

      const factId = factRows[0]?.id;
      if (!factId) continue;

      await tx`
        insert into brand_dna_evidence
          (company_id, fact_id, file_id, page_number, source_type)
        select ${scope.companyId}, ${factId}, ${input.fileId}, ${input.pageNumber}, 'pdf_visual'
         where not exists (
           select 1 from brand_dna_evidence
            where fact_id = ${factId}
              and file_id = ${input.fileId}
              and page_number = ${input.pageNumber}
         )
      `;
    }
  });
}

/** What a post is embedded as: everything a later request might match on. */
function postText(post: PdfPost): string {
  return [
    post.summary,
    post.caption,
    post.headline,
    post.eventContext,
    post.product,
    post.cta,
    post.creativeFormat,
    post.designStyle,
    post.photographyStyle,
    post.hashtags.join(' '),
  ]
    .filter(Boolean)
    .join('. ');
}

/** The parts of a post whose shape varies, kept out of columns. */
function structuredOf(post: PdfPost): Record<string, unknown> {
  return {
    product: post.product,
    location: post.location,
    eventContext: post.eventContext,
    cta: post.cta,
    hashtags: post.hashtags,
    offer: post.offer,
    creativeFormat: post.creativeFormat,
    photographyStyle: post.photographyStyle,
    designStyle: post.designStyle,
    composition: post.composition,
    colours: post.colours,
    typography: post.typography,
    logoVisible: post.logoVisible,
    people: post.people,
  };
}

/** The values that recur most, which is what makes them brand rather than noise. */
function mostCommon(values: string[], limit: number): string[] {
  const counts = new Map<string, number>();
  for (const value of values) {
    const key = value.trim();
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([value]) => value);
}

/** Everything recorded for one PDF, for the inspection view. */
export async function readPdfPages(
  scope: CompanyScope,
  fileId: string,
): Promise<{
  pages: {
    id: string; pageNumber: number; status: string; summary: string;
    hasTextLayer: boolean; postsDetected: number; width: number | null; height: number | null;
    errorMessage: string | null; durationMs: number | null; structured: Record<string, unknown>;
  }[];
  posts: {
    id: string; pageNumber: number; postIndex: number; country: string | null;
    caption: string | null; headline: string | null; summary: string;
    visibleText: string | null; confidence: number; structured: Record<string, unknown>;
  }[];
}> {
  return withCompanyScope(scope, async (tx) => {
    const pages = await tx<
      {
        id: string; page_number: number; status: string; summary: string;
        has_text_layer: boolean; posts_detected: number;
        image_width: number | null; image_height: number | null;
        error_message: string | null; duration_ms: number | null;
        structured: Record<string, unknown>;
      }[]
    >`
      select id, page_number, status, summary, has_text_layer, posts_detected,
             image_width, image_height, error_message, duration_ms, structured
        from pdf_page_understanding
       where company_id = ${scope.companyId} and file_id = ${fileId}
       order by page_number
    `;

    const posts = await tx<
      {
        id: string; page_number: number; post_index: number; country: string | null;
        caption: string | null; headline: string | null; summary: string;
        visible_text: string | null; confidence: string; structured: Record<string, unknown>;
      }[]
    >`
      select id, page_number, post_index, country, caption, headline, summary,
             visible_text, confidence, structured
        from pdf_post
       where company_id = ${scope.companyId} and file_id = ${fileId}
       order by page_number, post_index
    `;

    return {
      // Storage paths never leave the server: the page image is served by id
      // through the company-scoped route, exactly like a Drive file.
      pages: pages.map((row) => ({
        id: row.id,
        pageNumber: row.page_number,
        status: row.status,
        summary: row.summary,
        hasTextLayer: row.has_text_layer,
        postsDetected: row.posts_detected,
        width: row.image_width,
        height: row.image_height,
        errorMessage: row.error_message,
        durationMs: row.duration_ms,
        structured: row.structured ?? {},
      })),
      posts: posts.map((row) => ({
        id: row.id,
        pageNumber: row.page_number,
        postIndex: row.post_index,
        country: row.country,
        caption: row.caption,
        headline: row.headline,
        summary: row.summary,
        visibleText: row.visible_text,
        confidence: Number(row.confidence),
        structured: row.structured ?? {},
      })),
    };
  });
}

/** The bytes of one rendered page, for the inspection view. */
export async function readPageImage(
  scope: CompanyScope,
  pageId: string,
): Promise<{ bytes: Buffer; mimeType: string } | null> {
  const rows = await withCompanyScope(scope, async (tx) =>
    tx<{ image_path: string | null }[]>`
      select image_path from pdf_page_understanding
       where id = ${pageId} and company_id = ${scope.companyId}
    `,
  );

  const path = rows[0]?.image_path;
  if (!path) return null;

  return { bytes: await driveStorage().get(path), mimeType: 'image/jpeg' };
}

export { BRAIN_LIMITS };
