import 'server-only';
import { withCompanyScope } from '../db';
import { search } from './service';
import { semanticSearch } from './semanticSearch';
import { searchAssets, searchPosts } from './assetSearch';
import type { CompanyScope } from '../db';

/**
 * One search box, three ways of looking.
 *
 * Creative Search used to make the person choose: a "words" button that matched
 * file names, and a "meaning" button that searched inside documents. Nobody
 * knows which of those will find the thing they are looking for - that is the
 * whole reason they are searching - and picking wrong returns nothing and looks
 * like an empty Drive.
 *
 * So all three run, and what comes back is merged:
 *
 *   the name           "8PM-Diwali-banner.png" for "diwali"
 *   inside documents   a market report that discusses it
 *   inside pictures    what CIP saw when it looked at them
 *
 * A file found more than one way ranks above a file found one way, because
 * agreement between two different kinds of evidence is worth more than a strong
 * score from either alone.
 *
 * Nothing here invents a match. Each way can come back with nothing, and three
 * nothings is an honest empty result rather than the least unrelated file in
 * the Drive.
 */

export type FoundFile = {
  id: string;
  name: string;
  kind: string;
  fileType: string;
  brand: string | null;
  market: string | null;
  folderName: string | null;
  createdAt: string;
  /** Why this is here, so a result nobody expected can be understood. */
  why: {
    /** The name contains what was typed. */
    byName: boolean;
    /** A passage from inside the document. */
    inText: string | null;
    /** What CIP saw when it looked at the picture. */
    inPicture: string | null;
    /** A post CIP read off one of this deck's pages, and which page. */
    inPost: { page: number; text: string } | null;
  };
  score: number;
};

/**
 * Everything on a card, read from the file's own row.
 *
 * The three searches each know a little about a file and none of them knows all
 * of it: a chunk hit carries no market, an asset hit carries no folder, and
 * neither carries the date. Filling the gaps with plausible values put today's
 * date on every result that was not found by name - which is to say, on most of
 * them - and a date that is simply wrong is worse than no date.
 *
 * So the merge decides which files and why, and one query says what they are.
 */
async function hydrate(
  scope: CompanyScope,
  ids: string[],
): Promise<Map<string, Omit<FoundFile, 'why' | 'score'>>> {
  if (ids.length === 0) return new Map();

  const rows = await withCompanyScope(scope, (tx) =>
    tx<{
      id: string; name: string; file_type: string; mime_type: string;
      brand: string | null; market: string | null; created_at: Date; folder_name: string | null;
    }[]>`
      select f.id, f.name, f.file_type, f.mime_type, f.brand, f.market, f.created_at,
             d.name as folder_name
        from drive_files f
        left join drive_folders d on d.id = f.folder_id
       where f.company_id = ${scope.companyId}
         and f.archived_at is null
         and f.id = any(${ids}::uuid[])
    `,
  );

  return new Map(
    rows.map((row) => [
      row.id,
      {
        id: row.id,
        name: row.name,
        kind: kindOf(row.mime_type, row.file_type),
        fileType: row.file_type,
        brand: row.brand,
        market: row.market,
        folderName: row.folder_name,
        createdAt: row.created_at.toISOString(),
      },
    ]),
  );
}

const PRESENTATION = new Set(['ppt', 'pptx', 'key', 'odp']);
const SPREADSHEET = new Set(['xls', 'xlsx', 'csv', 'ods']);

function kindOf(mimeType: string, fileType: string): string {
  const mime = mimeType.toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (PRESENTATION.has(fileType.toLowerCase())) return 'presentation';
  if (SPREADSHEET.has(fileType.toLowerCase())) return 'spreadsheet';
  return 'document';
}

/**
 * What a match is worth.
 *
 * A name match is certain and cheap, so it leads. The two by-meaning scores are
 * cosine similarities, which for this embedder sit around 0.3 to 0.6 for a good
 * hit - so they are worth less than a name on their own and decisive together.
 */
const NAME_WEIGHT = 0.6;
const MEANING_WEIGHT = 1;

/** What each way of looking found about one file, before it is dressed up. */
type Evidence = {
  byName: boolean;
  inText: string | null;
  inPicture: string | null;
  inPost: { page: number; text: string } | null;
  score: number;
};

export async function findEverything(
  scope: CompanyScope,
  query: string,
  limit = 24,
): Promise<FoundFile[]> {
  const text = query.trim();
  if (text.length < 2) return [];

  // Independently, and none of them fatal: a Drive with no embeddings should
  // still find things by name, and an embedder that is down should not make the
  // search page useless.
  const [byName, inText, inPictures, inPosts] = await Promise.all([
    search(scope, text).catch(() => null),
    semanticSearch(scope, { query: text, limit }).catch(() => null),
    searchAssets(scope, text, limit).catch(() => []),
    // Posts CIP read off the pages of a deck. Already embedded when the page
    // was read, and never once reachable from the search box.
    searchPosts(scope, text, limit).catch(() => []),
  ]);

  const evidence = new Map<string, Evidence>();
  const take = (id: string): Evidence => {
    const existing = evidence.get(id);
    if (existing) return existing;
    const fresh: Evidence = {
      byName: false, inText: null, inPicture: null, inPost: null, score: 0,
    };
    evidence.set(id, fresh);
    return fresh;
  };

  for (const file of byName?.files ?? []) {
    const row = take(file.id);
    row.byName = true;
    row.score += NAME_WEIGHT;
  }

  for (const hit of inText?.hits ?? []) {
    const row = take(hit.fileId);
    // The best passage, not the sum of them: a long document mentioning
    // something five times is not five times the answer.
    if (!row.inText) {
      row.inText = hit.snippet.slice(0, 220);
      row.score += hit.score * MEANING_WEIGHT;
    }
  }

  for (const hit of inPictures) {
    const row = take(hit.fileId);
    if (!row.inPicture) {
      row.inPicture = hit.snippet.slice(0, 220);
      row.score += hit.score * MEANING_WEIGHT;
    }
  }

  for (const hit of inPosts) {
    const row = take(hit.fileId);
    // The best post on the deck, not every one of them: a deck with forty
    // Nigerian posts is not forty times the answer to "Nigeria".
    if (!row.inPost) {
      row.inPost = { page: hit.pageNumber, text: hit.snippet };
      row.score += hit.score * MEANING_WEIGHT;
    }
  }

  // One query for what these files actually are. A file that has been archived
  // since it was indexed simply does not come back, which is the right answer.
  const facts = await hydrate(scope, [...evidence.keys()]);

  return [...evidence.entries()]
    .map(([id, why]) => {
      const fact = facts.get(id);
      if (!fact) return null;
      return {
        ...fact,
        why: {
          byName: why.byName,
          inText: why.inText,
          inPicture: why.inPicture,
          inPost: why.inPost,
        },
        score: why.score,
      } satisfies FoundFile;
    })
    .filter((file): file is FoundFile => file !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
