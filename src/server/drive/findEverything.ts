import 'server-only';
import { withCompanyScope } from '../db';
import { embedder, toVectorLiteral } from './embedding';
import { brandForText } from '../brain/brands';
import { marketInRequest, marketsCovering } from '../brain/markets';
import type { CompanyScope } from '../db';

/**
 * One search box, every way of looking.
 *
 * Creative Search used to make the person choose: a "words" button that matched
 * file names, and a "meaning" button that searched inside documents. Nobody
 * knows which of those will find the thing they are looking for - that is the
 * whole reason they are searching - and picking wrong returns nothing and looks
 * like an empty Drive.
 *
 * So everything is looked at, and what comes back is merged:
 *
 *   the name           "8PM-Diwali-banner.png" for "diwali"
 *   inside documents   a market report that discusses it
 *   inside pictures    what CIP saw when it looked at them
 *   posts on a deck    a caption read off page 7
 *
 * A creative found more than one way ranks above one found one way, because
 * agreement between different kinds of evidence is worth more than a strong
 * score from either alone.
 *
 * Nothing here invents a match. Each way can come back with nothing, and all of
 * them nothing is an honest empty result rather than the least unrelated file.
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
  /** Other live files with exactly these bytes. Shown once, with the count. */
  copies: number;
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
    /** Labelled with the brand or market the question named, and nothing else was asked. */
    byLabel: boolean;
  };
  score: number;
};

/** What the search took the question to be about, said back to the person. */
export type SearchReading = { brand: string | null; market: string | null };

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
 * A name match is certain and cheap, so it leads. The by-meaning scores are
 * cosine similarities, which for this embedder sit around 0.3 to 0.6 for a good
 * hit - worth less than a name on their own and decisive together.
 */
const NAME_WEIGHT = 0.6;

/**
 * How far one vector search may look before it settles for what it has.
 *
 * With a relevance floor, an index scan for a question nothing answers keeps
 * going until it has looked at everything: "woman at a party" took 37 seconds
 * in Radico's documents and came back with the same seven passages it found in
 * the first thousand. Measured: a thousand returns the same answers in a tenth
 * of the time.
 */
const MAX_SCAN = 1000;

/**
 * The search is for creatives. A creative found by what is in it outranks a
 * book that mentions the same words; a deck's posts sit between.
 */
function kindWeight(kind: string, onlyText: boolean): number {
  if (kind === 'image' || kind === 'video') return 1.1;
  if (onlyText) return 0.75;
  return 1;
}

/** Words that say nothing about which file is meant. */
const NOT_A_WORD = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'in', 'on', 'at', 'for', 'with', 'to', 'by', 'from',
  'show', 'me', 'find', 'any', 'all', 'some', 'post', 'posts', 'creative', 'creatives', 'image',
  'images', 'picture', 'pictures', 'photo', 'video', 'videos', 'file', 'files',
]);

/** The words of a question worth matching against file names. */
export function nameWords(query: string): string[] {
  return [...new Set(
    query
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length >= 2 && !NOT_A_WORD.has(w)),
  )];
}

type Evidence = {
  byLabel: boolean;
  byName: boolean;
  inText: string | null;
  inPicture: string | null;
  inPost: { page: number; text: string } | null;
  score: number;
};

type FileFacts = {
  id: string; name: string; file_type: string; mime_type: string; brand: string | null;
  market: string | null; created_at: Date; folder_name: string | null; checksum: string | null;
  archived: boolean;
};

export async function findEverything(
  scope: CompanyScope,
  query: string,
  limit = 24,
  context: { activeBrand?: string | null } = {},
): Promise<{ files: FoundFile[]; reading: SearchReading }> {
  const text = query.trim();
  const empty = { files: [], reading: { brand: null, market: null } };
  if (text.length < 2) return empty;

  // The question as a vector, once, started before anything else so it is
  // ready by the time the database is. It was made three times - once per
  // kind of looking - each a round trip to the embedder.
  const active = embedder();
  const embedding = active.embed([text]).then(([v]) => v ?? null).catch(() => null);
  const maxDistance = 1 - Math.min(Math.max(active.minRelevanceScore, 0), 1);
  const words = nameWords(text);
  const perKind = Math.min(Math.max(limit, 1), 40);

  // Everything in one transaction. On the platform there is one connection per
  // function, so the four searches that looked parallel queued behind each
  // other, each paying for its own transaction.
  const found = await withCompanyScope(scope, async (tx) => {
    // Which brand and market the question is about, read the way the
    // generator reads a request. Only the names are needed here - not the
    // counts the brand and market pages show, which cost seconds.
    const roster = await tx<{ name: string; aliases: string[] | null }[]>`
      select name, aliases from company_brands where company_id = ${scope.companyId}
    `;
    const marketRows = await tx<{ market: string }[]>`
      select distinct market from drive_files
       where company_id = ${scope.companyId} and archived_at is null and market is not null
    `;
    const brand = brandForText(text, roster.map((r) => ({ name: r.name, aliases: r.aliases ?? [], note: null, facts: 0 })));
    const market = marketInRequest(text, marketRows.map((r) => r.market));
    const covering = market ? marketsCovering(market).map((m) => m.toLowerCase()) : [];

    // What is left of the question once the brand and market are taken out.
    // "Nigeria post" leaves nothing: it asks for Nigeria's work, not for a
    // file with "post" in its name, and is answered by the label.
    const labelWords = new Set(
      nameWords([brand, ...(brand ? roster.find((r) => r.name === brand)?.aliases ?? [] : []), market].filter(Boolean).join(' ')),
    );
    const rest = words.filter((w) => !labelWords.has(w));
    const browsing = rest.length === 0 && (brand !== null || market !== null);

    // The name is matched on what is left: "Afri Bull golden pour" wants a
    // golden pour, and a brand's work is told by its label - or its name,
    // below - not by every word of the brand being in the file name.
    const nameMatch = rest.length > 0 ? rest : words;
    const named = nameMatch.length === 0 || browsing
      ? []
      : await tx<{ id: string }[]>`
          select f.id
            from drive_files f
           where f.company_id = ${scope.companyId}
             and f.archived_at is null
             and lower(regexp_replace(f.name, '[-_.]+', ' ', 'g')) like all(${nameMatch.map((w) => `%${w.replace(/[\\%_]/g, (c) => `\\${c}`)}%`)})
           order by f.created_at desc
           limit 60
        `;

    // Asked only for a brand or a market: its newest creatives.
    const labelled = !browsing
      ? []
      : await tx<{ id: string }[]>`
          select f.id
            from drive_files f
           where f.company_id = ${scope.companyId}
             and f.archived_at is null
             and (f.mime_type like 'image/%' or f.mime_type like 'video/%')
             and (${brand}::text is null or f.brand = ${brand}::text)
             and (${covering.length === 0} or lower(f.market) = any(${covering}::text[]))
           -- The market named before the region it sits in: "Nigeria" is
           -- Nigeria's own work first, then West Africa's.
           order by (lower(f.market) = lower(${market ?? ''})) desc, f.created_at desc
           limit ${perKind}
        `;

    const vector = await embedding;
    const literal = vector && !browsing ? toVectorLiteral(vector) : null;
    let meaning: { source: 'text' | 'picture' | 'post'; file_id: string; snippet: string; page: number | null; score: string }[] = [];
    if (literal) {
      // In a savepoint, so a by-meaning search that cannot run - no vectors
      // in this database, an index being rebuilt - costs only its own answers
      // and not the names, the labels and the transaction they share.
      meaning = await tx.savepoint(async (sp) => {
      await sp`set local hnsw.iterative_scan = 'relaxed_order'`;
      await sp.unsafe(`set local hnsw.max_scan_tuples = ${MAX_SCAN}`);

      // The three by-meaning searches as one statement: one round trip, one
      // vector, each part bounded by its own index.
      return sp<typeof meaning>`
        (select 'text' as source, e.file_id, k.content as snippet, null::int as page,
                (1 - (e.embedding <=> ${literal}::extensions.vector))::text as score
           from drive_file_embeddings e
           join drive_file_chunks k on k.id = e.chunk_id
          where e.company_id = ${scope.companyId}
            and e.model = ${active.model}
            and (e.embedding <=> ${literal}::extensions.vector) <= ${maxDistance}
          order by e.embedding <=> ${literal}::extensions.vector
          limit ${perKind})
        union all
        (select 'picture', a.file_id, a.content, null::int,
                (1 - (a.embedding <=> ${literal}::extensions.vector))::text
           from asset_embeddings a
          where a.company_id = ${scope.companyId}
            and a.model = ${active.model}
            and (a.embedding <=> ${literal}::extensions.vector) <= ${maxDistance}
          order by a.embedding <=> ${literal}::extensions.vector
          limit ${perKind})
        union all
        (select 'post', p.file_id, concat_ws(' — ', p.headline, p.caption, p.summary), p.page_number,
                (1 - (p.embedding <=> ${literal}::extensions.vector))::text
           from pdf_post p
          where p.company_id = ${scope.companyId}
            and p.embedding is not null
            and (p.embedding <=> ${literal}::extensions.vector) <= ${maxDistance}
          order by p.embedding <=> ${literal}::extensions.vector
          limit ${perKind})
      `;
      }).catch(() => [] as typeof meaning);
    }

    // What each file is, including its bytes' fingerprint - and every live
    // file with the same fingerprint. A picture CIP read under one name is the
    // same picture under another, and when the name it was read under has
    // since been archived, the copy still here is the one to show. 76 of
    // Radico's creatives were findable only through files nobody could open.
    const hitIds = [...new Set([...named.map((r) => r.id), ...labelled.map((r) => r.id), ...meaning.map((r) => r.file_id)])];
    const own = hitIds.length === 0 ? [] : await tx<FileFacts[]>`
      select f.id, f.name, f.file_type, f.mime_type, f.brand, f.market, f.created_at,
             d.name as folder_name, f.checksum_sha256 as checksum, f.archived_at is not null as archived
        from drive_files f
        left join drive_folders d on d.id = f.folder_id
       where f.company_id = ${scope.companyId} and f.id = any(${hitIds}::uuid[])
    `;
    const sums = [...new Set(own.map((f) => f.checksum).filter((c): c is string => c !== null))];
    const copies = sums.length === 0 ? [] : await tx<FileFacts[]>`
      select f.id, f.name, f.file_type, f.mime_type, f.brand, f.market, f.created_at,
             d.name as folder_name, f.checksum_sha256 as checksum, false as archived
        from drive_files f
        left join drive_folders d on d.id = f.folder_id
       where f.company_id = ${scope.companyId} and f.archived_at is null
         and f.checksum_sha256 = any(${sums})
    `;
    const brandNames = brand
      ? [brand, ...(roster.find((r) => r.name === brand)?.aliases ?? [])].map((n) => n.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ''))
      : [];
    return { brand, brandNames, market, covering, named, labelled, meaning, facts: { own, copies } };
  });

  const { brand, brandNames, market, covering, facts } = found;
  /** Whether a file is the named brand's: its label, or, unlabelled, its name. */
  const isBrands = (file: FileFacts): boolean =>
    file.brand === brand ||
    (file.brand === null && brandNames.some((n) => n && file.name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '').includes(n)));
  const byName = found.named;
  const byMeaning = found.meaning;

  const byId = new Map(facts.own.map((f) => [f.id, f]));
  const liveCopies = new Map<string, FileFacts[]>();
  for (const copy of facts.copies) {
    const list = liveCopies.get(copy.checksum!) ?? [];
    list.push(copy);
    liveCopies.set(copy.checksum!, list);
  }

  /** The creative a hit is about, and the live file to show for it. */
  const resolve = (fileId: string): { key: string; shown: FileFacts; copies: number } | null => {
    const file = byId.get(fileId);
    if (!file) return null;
    const live = file.checksum ? (liveCopies.get(file.checksum) ?? []) : [];
    if (!file.archived) return { key: file.checksum ?? file.id, shown: file, copies: Math.max(live.length, 1) };
    // Read under a name since archived: the newest copy still here, or nothing.
    const newest = [...live].sort((a, b) => b.created_at.getTime() - a.created_at.getTime())[0];
    return newest ? { key: file.checksum!, shown: newest, copies: live.length } : null;
  };

  const groups = new Map<string, { shown: FileFacts; copies: number; why: Evidence }>();
  const take = (fileId: string) => {
    const found = resolve(fileId);
    if (!found) return null;
    const existing = groups.get(found.key);
    if (existing) {
      // The copy with a brand label is the better one to show.
      if (!existing.shown.brand && found.shown.brand) existing.shown = found.shown;
      return existing;
    }
    const fresh = {
      shown: found.shown,
      copies: found.copies,
      why: { byLabel: false, byName: false, inText: null, inPicture: null, inPost: null, score: 0 } as Evidence,
    };
    groups.set(found.key, fresh);
    return fresh;
  };

  for (const row of byName) {
    const group = take(row.id);
    if (group && !group.why.byName) {
      group.why.byName = true;
      group.why.score += NAME_WEIGHT;
    }
  }
  // Newest first, gently: a browse is an answer, but not a strong match.
  found.labelled.forEach((row, index) => {
    const group = take(row.id);
    if (group && !group.why.byLabel) {
      group.why.byLabel = true;
      group.why.score += 0.8 - index * 0.005;
    }
  });

  for (const hit of byMeaning) {
    const group = take(hit.file_id);
    if (!group) continue;
    const score = Number(hit.score);
    // The best passage of each kind, not the sum of them: a long document
    // mentioning something five times is not five times the answer.
    if (hit.source === 'text' && !group.why.inText) {
      group.why.inText = hit.snippet.slice(0, 220);
      group.why.score += score;
    } else if (hit.source === 'picture' && !group.why.inPicture) {
      group.why.inPicture = hit.snippet.slice(0, 220);
      group.why.score += score;
    } else if (hit.source === 'post' && !group.why.inPost) {
      group.why.inPost = { page: hit.page ?? 1, text: hit.snippet.slice(0, 260) };
      group.why.score += score;
    }
  }

  const files = [...groups.values()].map(({ shown, copies, why }) => {
    const kind = kindOf(shown.mime_type, shown.file_type);
    let score = why.score * kindWeight(kind, !why.inPicture && !why.inPost);
    // The brand the question named leads; another brand's work falls back,
    // and work nobody has attributed sits between.
    const forBrand = brand ?? context.activeBrand ?? null;
    if (forBrand) {
      if (shown.brand === forBrand || (brand && isBrands(shown))) score *= brand ? 1.25 : 1.1;
      else if (shown.brand) score *= brand ? 0.6 : 0.9;
      else score *= 0.9;
    }
    // The market likewise, counting a region as the countries in it.
    if (market) {
      if (shown.market && covering.includes(shown.market.toLowerCase())) score *= 1.2;
      else if (shown.market) score *= 0.75;
    }
    return {
      id: shown.id,
      name: shown.name,
      kind,
      fileType: shown.file_type,
      brand: shown.brand,
      market: shown.market,
      folderName: shown.folder_name,
      createdAt: shown.created_at.toISOString(),
      copies,
      why: { byName: why.byName, inText: why.inText, inPicture: why.inPicture, inPost: why.inPost, byLabel: why.byLabel },
      score: Math.round(score * 1000) / 1000,
    } satisfies FoundFile;
  });

  return {
    files: files.sort((a, b) => b.score - a.score).slice(0, limit),
    reading: { brand, market },
  };
}
