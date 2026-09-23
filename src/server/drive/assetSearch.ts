import 'server-only';
import { withCompanyScope } from '../db';
import { adminSql } from '../db-admin';
import type { CompanyScope } from '../db';
import { embedder, toVectorLiteral } from './embedding';

/**
 * Making pictures findable by what is in them.
 *
 * Creative Search could not find one. Search by meaning runs on document
 * chunks, a chunk belongs to an extraction, and a photograph has no text to
 * extract — so 431 images had no vector between them while 58 PDFs had 13,976.
 *
 * What CIP wrote down after looking at each picture is a perfectly good
 * description: what it is, what it says, which product, what it looks like.
 * That is what gets embedded here, one vector per asset.
 */

/** The longest description embedded. Beyond this a reading is repeating itself. */
const MAX_CHARS = 4_000;

export type AssetHit = {
  fileId: string;
  fileName: string;
  fileType: string;
  mimeType: string;
  brand: string | null;
  market: string | null;
  /** The reading that matched, trimmed for display. */
  snippet: string;
  /** 1 - cosine distance, so higher is a better match. */
  score: number;
};

/**
 * One picture, in words, ready to be embedded.
 *
 * Everything CIP noticed, in one paragraph: what it is, any text on it, which
 * products, how it was shot. The file's own name goes in too — a creative
 * called "8PM-Diwali-golden-hour.png" says something the reading may not.
 */
export function describeAsset(input: {
  fileName: string;
  brand: string | null;
  market: string | null;
  summary: string | null;
  extractedText: string | null;
  structured: Record<string, unknown> | null;
}): string {
  const parts: string[] = [input.fileName];
  if (input.brand) parts.push(input.brand);
  if (input.market) parts.push(input.market);
  if (input.summary) parts.push(input.summary);

  const s = input.structured ?? {};
  const list = (key: string): string[] => {
    const value = s[key];
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  };
  const word = (key: string): string | null => {
    const value = s[key];
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  };

  for (const key of ['products', 'objects', 'brandElements', 'colours', 'typography']) {
    const values = list(key);
    if (values.length > 0) parts.push(`${key}: ${values.join(', ')}`);
  }
  for (const key of ['contentType', 'composition', 'background', 'lighting', 'style', 'mood']) {
    const value = word(key);
    if (value) parts.push(`${key}: ${value}`);
  }

  // Last, because it is the longest and the least distinctive: a headline read
  // off a poster is worth having, a wall of small print is not worth the room.
  if (input.extractedText) parts.push(input.extractedText);

  return parts.join('. ').replace(/\s+/g, ' ').trim().slice(0, MAX_CHARS);
}

/**
 * Assets whose reading matches what was asked, by meaning.
 *
 * Returns nothing rather than the least unrelated thing: a nearest-neighbour
 * index always has a nearest neighbour, and a search the Drive does not cover
 * has to be able to come back empty.
 */
export async function searchAssets(
  scope: CompanyScope,
  query: string,
  limit = 24,
): Promise<AssetHit[]> {
  const text = query.trim();
  if (text.length < 2) return [];

  const active = embedder();
  const [vector] = await active.embed([text]);
  if (!vector) return [];

  const literal = toVectorLiteral(vector);
  const maxDistance = 1 - Math.min(Math.max(active.minRelevanceScore, 0), 1);

  const rows = await withCompanyScope(scope, async (tx) => {
    // pgvector's iterative scan, for the same reason the chunk search sets it:
    // with the filter applied after the index scan, a filtered search can come
    // back with far fewer rows than it asked for.
    await tx`set local hnsw.iterative_scan = 'relaxed_order'`;

    return tx<
      {
        file_id: string; file_name: string; file_type: string; mime_type: string;
        brand: string | null; market: string | null; content: string; score: string;
      }[]
    >`
      select a.file_id, f.name as file_name, f.file_type, f.mime_type,
             f.brand, f.market, a.content,
             (1 - (a.embedding <=> ${literal}::extensions.vector))::text as score
        from asset_embeddings a
        join drive_files f on f.id = a.file_id and f.company_id = a.company_id
       where a.company_id = ${scope.companyId}
         and f.archived_at is null
         and a.model = ${active.model}
         and (a.embedding <=> ${literal}::extensions.vector) <= ${maxDistance}
       order by a.embedding <=> ${literal}::extensions.vector
       limit ${Math.min(Math.max(limit, 1), 50)}
    `;
  });

  return rows.map((row) => ({
    fileId: row.file_id,
    fileName: row.file_name,
    fileType: row.file_type,
    mimeType: row.mime_type,
    brand: row.brand,
    market: row.market,
    snippet: row.content.slice(0, 260),
    score: Number(row.score),
  }));
}

/**
 * Embeds the readings that have none, newest first.
 *
 * Returns how many it wrote. Safe to run again: an asset already embedded under
 * this model is skipped, and a re-read replaces its vector rather than leaving
 * the old description findable for ever.
 */
export async function embedAssets(
  scope: CompanyScope,
  options: { limit?: number; onProgress?: (done: number, total: number) => void } = {},
): Promise<{ embedded: number; skipped: number }> {
  const active = embedder();
  const limit = Math.min(Math.max(options.limit ?? 500, 1), 2_000);

  const pending = await withCompanyScope(scope, (tx) =>
    tx<
      {
        understanding_id: string; file_id: string; name: string;
        brand: string | null; market: string | null;
        summary: string | null; extracted_text: string | null;
        structured: Record<string, unknown> | null;
      }[]
    >`
      select u.id as understanding_id, u.file_id, f.name, f.brand, f.market,
             u.summary, u.extracted_text, u.structured
        from asset_understanding u
        join drive_files f on f.id = u.file_id and f.company_id = u.company_id
       where u.company_id = ${scope.companyId}
         and u.status = 'ready'
         and f.archived_at is null
         and not exists (
           select 1 from asset_embeddings a
            where a.company_id = u.company_id
              and a.file_id = u.file_id
              and a.model = ${active.model}
              and a.understanding_id = u.id
         )
       order by u.updated_at desc
       limit ${limit}
    `,
  );

  let embedded = 0;
  let skipped = 0;

  // In tens: one call per asset is slow and wasteful, and one call for five
  // hundred is a single failure that loses all of them.
  for (let at = 0; at < pending.length; at += 10) {
    const batch = pending.slice(at, at + 10);
    const described = batch.map((row) => ({
      row,
      text: describeAsset({
        fileName: row.name,
        brand: row.brand,
        market: row.market,
        summary: row.summary,
        extractedText: row.extracted_text,
        structured: row.structured,
      }),
    }));

    const usable = described.filter((d) => d.text.length >= 20);
    skipped += described.length - usable.length;
    if (usable.length === 0) continue;

    const vectors = await active.embed(usable.map((d) => d.text));

    await withCompanyScope(scope, async (tx) => {
      for (const [index, { row, text }] of usable.entries()) {
        const vector = vectors[index];
        if (!vector) continue;
        await tx`
          insert into asset_embeddings
            (company_id, file_id, understanding_id, content, model, dimensions, embedding, input_chars)
          values
            (${scope.companyId}, ${row.file_id}, ${row.understanding_id}, ${text},
             ${active.model}, ${active.dimensions}, ${toVectorLiteral(vector)}::extensions.vector,
             ${text.length})
          on conflict (company_id, file_id, model) do update set
            understanding_id = excluded.understanding_id,
            content = excluded.content,
            embedding = excluded.embedding,
            input_chars = excluded.input_chars,
            created_at = now()
        `;
        embedded += 1;
      }
    });

    options.onProgress?.(Math.min(at + batch.length, pending.length), pending.length);
  }

  return { embedded, skipped };
}

/**
 * Posts CIP read off the pages of a deck.
 *
 * Three hundred and seventy-five of them, each already embedded when the page
 * was read, and none of them reachable from the search box. They are the most
 * specific thing CIP holds about past work - a caption, a headline, the country
 * it ran in, the product it was for - and "a raspberry post from Nigeria" could
 * not find one.
 *
 * A post is not a file, so what comes back is the deck it is on and which page.
 */
export type PostHit = {
  fileId: string;
  fileName: string;
  pageNumber: number;
  snippet: string;
  country: string | null;
  score: number;
};

export async function searchPosts(
  scope: CompanyScope,
  query: string,
  limit = 12,
): Promise<PostHit[]> {
  const text = query.trim();
  if (text.length < 2) return [];

  const active = embedder();
  const [vector] = await active.embed([text]);
  if (!vector) return [];

  const literal = toVectorLiteral(vector);
  const maxDistance = 1 - Math.min(Math.max(active.minRelevanceScore, 0), 1);

  const rows = await withCompanyScope(scope, async (tx) => {
    await tx`set local hnsw.iterative_scan = 'relaxed_order'`;
    return tx<
      {
        file_id: string; file_name: string; page_number: number; country: string | null;
        caption: string | null; headline: string | null; summary: string; score: string;
      }[]
    >`
      select p.file_id, f.name as file_name, p.page_number, p.country,
             p.caption, p.headline, p.summary,
             (1 - (p.embedding <=> ${literal}::extensions.vector))::text as score
        from pdf_post p
        join drive_files f on f.id = p.file_id and f.company_id = p.company_id
       where p.company_id = ${scope.companyId}
         and p.embedding is not null
         and f.archived_at is null
         and (p.embedding <=> ${literal}::extensions.vector) <= ${maxDistance}
       order by p.embedding <=> ${literal}::extensions.vector
       limit ${Math.min(Math.max(limit, 1), 40)}
    `;
  });

  return rows.map((row) => ({
    fileId: row.file_id,
    fileName: row.file_name,
    pageNumber: row.page_number,
    country: row.country,
    snippet: [row.headline, row.caption, row.summary].filter(Boolean).join(' — ').slice(0, 260),
    score: Number(row.score),
  }));
}

/**
 * Embeds the new readings for every company, a few at a time.
 *
 * Run from the pass that does the reading, so a picture becomes findable in the
 * same sweep that CIP first looks at it. Before this it became findable when
 * somebody remembered to run a script, which is to say: sometimes.
 *
 * Bounded, because this shares a pass with extraction, understanding and the
 * checker, and a hundred new pictures must not starve the rest of it.
 */
export async function embedUnderstandingsEverywhere(
  perCompany = 40,
): Promise<{ embedded: number }> {
  const sql = adminSql();
  let companies: { id: string }[];
  try {
    companies = await sql<{ id: string }[]>`select id from companies`;
  } finally {
    await sql.end();
  }

  let embedded = 0;
  for (const company of companies) {
    const outcome = await embedAssets(
      {
        companyId: company.id,
        userId: '00000000-0000-0000-0000-000000000000',
        role: 'owner',
      },
      { limit: perCompany },
    ).catch(() => ({ embedded: 0, skipped: 0 }));
    embedded += outcome.embedded;
  }
  return { embedded };
}
