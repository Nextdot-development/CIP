import 'server-only';
import { search } from './service';
import { semanticSearch } from './semanticSearch';
import { searchAssets } from './assetSearch';
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
  };
  score: number;
};

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
  const [byName, inText, inPictures] = await Promise.all([
    search(scope, text).catch(() => null),
    semanticSearch(scope, { query: text, limit }).catch(() => null),
    searchAssets(scope, text, limit).catch(() => []),
  ]);

  const found = new Map<string, FoundFile>();

  const take = (
    id: string,
    base: { name: string; kind: string; fileType: string; market: string | null; folderName: string | null; createdAt: string },
  ): FoundFile => {
    const existing = found.get(id);
    if (existing) return existing;
    const fresh: FoundFile = {
      id,
      ...base,
      why: { byName: false, inText: null, inPicture: null },
      score: 0,
    };
    found.set(id, fresh);
    return fresh;
  };

  for (const file of byName?.files ?? []) {
    const row = take(file.id, {
      name: file.name,
      kind: file.kind,
      fileType: file.fileType,
      market: file.market ?? null,
      folderName: file.folderName,
      createdAt: file.createdAt,
    });
    row.why.byName = true;
    row.score += NAME_WEIGHT;
  }

  for (const hit of inText?.hits ?? []) {
    const row = take(hit.fileId, {
      name: hit.fileName,
      kind: kindOf('', hit.fileType),
      fileType: hit.fileType,
      market: null,
      folderName: hit.folderName,
      createdAt: new Date().toISOString(),
    });
    // The best passage, not the sum of them: a long document mentioning
    // something five times is not five times the answer.
    if (!row.why.inText) {
      row.why.inText = hit.snippet.slice(0, 220);
      row.score += hit.score * MEANING_WEIGHT;
    }
  }

  for (const hit of inPictures) {
    const row = take(hit.fileId, {
      name: hit.fileName,
      kind: kindOf(hit.mimeType, hit.fileType),
      fileType: hit.fileType,
      market: hit.market,
      folderName: null,
      createdAt: new Date().toISOString(),
    });
    if (!row.why.inPicture) {
      row.why.inPicture = hit.snippet.slice(0, 220);
      row.score += hit.score * MEANING_WEIGHT;
    }
  }

  return [...found.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}
