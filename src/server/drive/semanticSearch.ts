import 'server-only';
import { withCompanyScope } from '../db';
import type { CompanyScope } from '../db';
import { DriveNotFound, DriveRejected } from './service';
import { embedder, toVectorLiteral } from './embedding';
import { EXTRACTABLE_FILE_TYPES } from '@/lib/fileTypes';
import type { SemanticSearchDTO } from '@/types/drive';

/**
 * Search by meaning, within one company.
 *
 * There is no company parameter, and that is the point: the scope comes from a
 * verified session, and the row-level security policy turns it into the filter.
 * A similarity query has no natural WHERE clause — it asks for nearest
 * neighbours across the table — so the policy is doing real work here rather
 * than backing up an explicit filter.
 */

const MAX_QUERY_CHARS = 1_000;
const MAX_LIMIT = 50;
const SNIPPET_CHARS = 320;

export type SemanticSearchInput = {
  query: string;
  limit?: number;
  folderId?: string | null;
  fileTypes?: string[] | null;
};

/**
 * Internal only. The HTTP route reads a fixed set of fields from the request
 * body and this is not one of them, so a caller on the network cannot set it.
 *
 * It exists so isolation tests can lower the relevance floor and confirm the
 * company boundary holds on its own — a test that only ever sees an empty
 * result cannot tell isolation apart from a search that returns nothing.
 */
export type SemanticSearchOptions = {
  /** Overrides the embedder's floor. 0 returns the nearest rows regardless. */
  minScore?: number;
};

export async function semanticSearch(
  scope: CompanyScope,
  input: SemanticSearchInput,
  options: SemanticSearchOptions = {},
): Promise<SemanticSearchDTO> {
  const query = input.query.trim();
  if (query.length < 2) throw new DriveRejected('Search for at least two characters.');
  if (query.length > MAX_QUERY_CHARS) throw new DriveRejected('That search is too long.');

  const limit = Math.min(Math.max(input.limit ?? 10, 1), MAX_LIMIT);

  const fileTypes = (input.fileTypes ?? [])
    .map((t) => t.toLowerCase())
    .filter((t) => (EXTRACTABLE_FILE_TYPES as readonly string[]).includes(t));

  const active = embedder();
  // The provider sees the query text and nothing else.
  const [vector] = await active.embed([query]);
  if (!vector) throw new DriveRejected('We could not read that search.');
  const literal = toVectorLiteral(vector);
  const floor = options.minScore ?? active.minRelevanceScore;
  const maxDistance = 1 - Math.min(Math.max(floor, 0), 1);

  const hits = await withCompanyScope(scope, async (tx) => {
    // Confirms the folder belongs to this company before it is used as a
    // filter, so a pasted id from elsewhere is "not found" rather than an
    // empty result that looks like a working search.
    let folderIds: string[] | null = null;
    if (input.folderId) {
      const found = await tx<{ id: string }[]>`
        with recursive down as (
          select id from drive_folders
           where id = ${input.folderId} and company_id = ${scope.companyId} and archived_at is null
          union all
          select f.id from drive_folders f
            join down on f.parent_id = down.id
           where f.company_id = ${scope.companyId} and f.archived_at is null
        )
        select id from down
      `;
      if (found.length === 0) throw new DriveNotFound('That folder');
      folderIds = found.map((r) => r.id);
    }

    // pgvector 0.8 defaults hnsw.iterative_scan to off, and with the filter
    // applied after the index scan a filtered search can return far fewer rows
    // than asked for — verified on this database: forced onto the index with
    // the default, a 0.5%-selective filter returned nothing at all.
    await tx`set local hnsw.iterative_scan = 'relaxed_order'`;

    return tx<
      {
        chunk_id: string; file_id: string; file_name: string; file_type: string;
        folder_id: string | null; folder_name: string | null; heading: string | null;
        ordinal: number; char_start: number; char_end: number; content: string; score: string;
        source_type: string;
      }[]
    >`
      select k.id            as chunk_id,
             k.file_id,
             f.name          as file_name,
             f.file_type,
             f.source_type,
             f.folder_id,
             d.name          as folder_name,
             k.heading,
             k.ordinal,
             k.char_start,
             k.char_end,
             k.content,
             1 - (e.embedding <=> ${literal}::vector) as score
        from drive_file_embeddings e
        join drive_file_chunks k on k.id = e.chunk_id
        join drive_files f       on f.id = e.file_id
        left join drive_folders d on d.id = f.folder_id
       where e.model = ${active.model}
         and f.archived_at is null
         -- The relevance floor, as a distance so it reads the same way the
         -- index does: cosine distance is 1 - similarity, so "at least this
         -- similar" is "no further away than this". Applied here rather than
         -- after the fact so passages that are not answers never leave the
         -- database at all.
         and (e.embedding <=> ${literal}::vector) <= ${maxDistance}
         and (${folderIds}::uuid[] is null or f.folder_id = any(${folderIds}::uuid[]))
         and (${fileTypes.length === 0} or f.file_type = any(${fileTypes}))
       order by e.embedding <=> ${literal}::vector
       limit ${limit}
    `;
  });

  return {
    query,
    model: active.model,
    hits: hits.map((h) => ({
      chunkId: h.chunk_id,
      fileId: h.file_id,
      fileName: h.file_name,
      fileType: h.file_type,
      folderId: h.folder_id,
      folderName: h.folder_name,
      heading: h.heading,
      ordinal: h.ordinal,
      charStart: h.char_start,
      charEnd: h.char_end,
      snippet: h.content.slice(0, SNIPPET_CHARS),
      score: Number(h.score),
      // Which source the passage came from, so a result set spanning the
      // Company Drive and a connected Google Drive is legible.
      sourceType: (h.source_type ?? 'cip_drive') as 'cip_drive' | 'google_drive',
    })),
  };
}
