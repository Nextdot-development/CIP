import 'server-only';
import { withCompanyScope } from '../db';
import type { CompanyScope } from '../db';
import { embedder } from '../drive/embedding';

/**
 * The knowledge graph.
 *
 * Everything here is derived from what the company already has — folders,
 * files, extracted chunks and the vectors Phase 4 produced. Nothing is
 * invented, and there is no sample data: a company with no documents gets an
 * empty graph, which is the honest answer.
 *
 * Two kinds of edge:
 *
 *   contains  folder -> folder -> file -> chunk, from the rows themselves
 *   related   chunk <-> chunk, from vector similarity
 *
 * The related edges are the reason this is a graph rather than a tree, and
 * they are deliberately sparse. Connecting every chunk to every other chunk
 * would be O(N^2) work to produce a hairball nobody can read, so each chunk
 * keeps only its few nearest neighbours above a similarity floor.
 *
 * Every query runs inside withCompanyScope. There is no company parameter,
 * so no request can reach another company's knowledge, and row-level security
 * is the filter even where a WHERE clause also names the company.
 */

export type GraphNodeType = 'source' | 'folder' | 'file' | 'chunk';

export type GraphSource = 'cip_drive' | 'google_drive';

/**
 * What a caller may see of a node.
 *
 * No company id, no storage path, no external Google id. The node id is our
 * own row id, which is already how every other endpoint addresses things.
 */
export type GraphNode = {
  id: string;
  type: GraphNodeType;
  label: string;
  /** Which knowledge source it came from. Absent for source nodes themselves. */
  source: GraphSource | null;
  /** Rough size for the renderer: a folder with more in it draws larger. */
  weight: number;
  /** File-only, and safe: the extension, never the path. */
  fileType?: string;
  processingStatus?: string;
  chunkCount?: number;
  /** Chunk-only. */
  heading?: string | null;
  ordinal?: number;
  /** Chunk-only: the text the inspector shows, capped rather than the whole passage. */
  snippet?: string;
  /** Chunk-only: which file it came from, so the inspector can link back. */
  fileId?: string;
  /** Whether this node has neighbours that are not loaded yet. */
  expandable: boolean;
};

export type GraphEdgeKind = 'contains' | 'related';

export type GraphEdge = {
  source: string;
  target: string;
  kind: GraphEdgeKind;
  /** Similarity, for related edges only. Drives edge opacity. */
  score?: number;
};

export type GraphStats = {
  nodes: number;
  edges: number;
  files: number;
  folders: number;
  chunks: number;
  sources: number;
};

export type KnowledgeGraphDTO = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: GraphStats;
  /** Ids the search matched, so the UI can highlight and centre on them. */
  matches: string[];
  /** True when the company genuinely has nothing, not merely nothing shown. */
  empty: boolean;
  truncated: boolean;
};

export type GraphOptions = {
  /** Expand this node's neighbours instead of returning the overview. */
  nodeId?: string | null;
  /** How far to walk from nodeId. 1 is direct neighbours. */
  depth?: number;
  search?: string | null;
  source?: GraphSource | 'all' | null;
  type?: GraphNodeType | 'all' | null;
  limit?: number;
};

/** Bounds, so a large company cannot produce a browser-melting payload. */
const LIMITS = {
  defaultNodes: 150,
  maxNodes: 400,
  /** Nearest neighbours kept per chunk. */
  neighboursPerChunk: 3,
  /** Below this cosine similarity two chunks are not meaningfully related. */
  minSimilarity: 0.3,
  maxRelatedEdges: 300,
  snippetChars: 240,
} as const;

const SOURCE_LABEL: Record<GraphSource, string> = {
  cip_drive: 'CIP Drive',
  google_drive: 'Google Drive',
};

type FolderRow = { id: string; name: string; parent_id: string | null; file_count: number };
type FileRow = {
  id: string;
  name: string;
  folder_id: string | null;
  file_type: string;
  source_type: GraphSource;
  processing_status: string;
  chunk_count: number;
};
type ChunkRow = {
  id: string;
  file_id: string;
  ordinal: number;
  heading: string | null;
  content: string;
};

/**
 * Builds the graph a caller should see.
 *
 * The overview is folders and files only. Chunks are not included by default:
 * a few hundred documents is tens of thousands of chunks, and a graph that
 * opens as an unreadable cloud is worse than one that starts legible and
 * expands on request.
 */
export async function knowledgeGraph(
  scope: CompanyScope,
  options: GraphOptions = {},
): Promise<KnowledgeGraphDTO> {
  const limit = Math.min(Math.max(options.limit ?? LIMITS.defaultNodes, 1), LIMITS.maxNodes);
  const sourceFilter = options.source && options.source !== 'all' ? options.source : null;
  const typeFilter = options.type && options.type !== 'all' ? options.type : null;
  const search = typeof options.search === 'string' ? options.search.trim() : '';

  if (options.nodeId) {
    return expandNode(scope, options.nodeId, { limit, sourceFilter, typeFilter });
  }

  return overview(scope, { limit, sourceFilter, typeFilter, search });
}

// --- the default view -------------------------------------------------------

async function overview(
  scope: CompanyScope,
  options: {
    limit: number;
    sourceFilter: GraphSource | null;
    typeFilter: GraphNodeType | null;
    search: string;
  },
): Promise<KnowledgeGraphDTO> {
  const { folders, files, totals } = await withCompanyScope(scope, async (tx) => {
    const folderRows = await tx<FolderRow[]>`
      select f.id, f.name, f.parent_id,
             (select count(*)::int from drive_files df
               where df.folder_id = f.id and df.archived_at is null) as file_count
        from drive_folders f
       where f.archived_at is null
       order by f.name
       limit ${options.limit}
    `;

    const fileRows = await tx<FileRow[]>`
      select f.id, f.name, f.folder_id, f.file_type, f.source_type, f.processing_status,
             (select count(*)::int from drive_file_chunks c
               where c.file_id = f.id) as chunk_count
        from drive_files f
       where f.archived_at is null
         and (${options.sourceFilter}::text is null or f.source_type = ${options.sourceFilter})
       order by f.created_at desc
       limit ${options.limit}
    `;

    // Real counts for the whole company, not just what is drawn.
    const counts = await tx<{ folders: number; files: number; chunks: number }[]>`
      select
        (select count(*)::int from drive_folders where archived_at is null) as folders,
        (select count(*)::int from drive_files   where archived_at is null) as files,
        (select count(*)::int from drive_file_chunks)                       as chunks
    `;

    return { folders: folderRows, files: fileRows, totals: counts[0]! };
  });

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  // One node per source that actually has files. Never a source nobody uses.
  const usedSources = [...new Set(files.map((f) => f.source_type))];
  for (const source of usedSources) {
    nodes.push({
      id: sourceNodeId(source),
      type: 'source',
      label: SOURCE_LABEL[source],
      source: null,
      weight: files.filter((f) => f.source_type === source).length,
      expandable: false,
    });
  }

  const folderIds = new Set(folders.map((f) => f.id));

  for (const folder of folders) {
    nodes.push({
      id: folder.id,
      type: 'folder',
      label: folder.name,
      source: 'cip_drive',
      weight: 3 + folder.file_count,
      expandable: folder.file_count > 0,
    });

    // A folder whose parent is outside the page hangs off its source instead,
    // so nothing is left floating with no way to reach it.
    if (folder.parent_id && folderIds.has(folder.parent_id)) {
      edges.push({ source: folder.parent_id, target: folder.id, kind: 'contains' });
    }
  }

  for (const file of files) {
    nodes.push({
      id: file.id,
      type: 'file',
      label: file.name,
      source: file.source_type,
      weight: 2 + Math.min(file.chunk_count, 8),
      fileType: file.file_type,
      processingStatus: file.processing_status,
      chunkCount: file.chunk_count,
      expandable: file.chunk_count > 0,
    });

    const parent =
      file.folder_id && folderIds.has(file.folder_id) ? file.folder_id : sourceNodeId(file.source_type);
    edges.push({ source: parent, target: file.id, kind: 'contains' });
  }

  // Folders with no parent in view attach to the Drive they belong to, but
  // only if that source node exists — otherwise the edge would dangle.
  const hasCipSource = nodes.some((n) => n.id === sourceNodeId('cip_drive'));
  if (hasCipSource) {
    for (const folder of folders) {
      const parentInView = folder.parent_id && folderIds.has(folder.parent_id);
      if (!parentInView) {
        edges.push({ source: sourceNodeId('cip_drive'), target: folder.id, kind: 'contains' });
      }
    }
  }

  const filtered = applyTypeFilter(nodes, edges, options.typeFilter);
  const matches = options.search ? await searchNodes(scope, options.search) : [];

  return {
    nodes: filtered.nodes,
    edges: filtered.edges,
    stats: statsFor(filtered.nodes, filtered.edges, totals),
    matches,
    empty: totals.files === 0 && totals.folders === 0,
    truncated: totals.files > files.length || totals.folders > folders.length,
  };
}

// --- expansion --------------------------------------------------------------

/**
 * The neighbours of one node.
 *
 * Lazy on purpose: the browser asks for what somebody actually opened rather
 * than being handed the whole company up front.
 */
async function expandNode(
  scope: CompanyScope,
  nodeId: string,
  options: { limit: number; sourceFilter: GraphSource | null; typeFilter: GraphNodeType | null },
): Promise<KnowledgeGraphDTO> {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  // A source node expands to the files that came from it.
  const asSource = sourceFromNodeId(nodeId);
  if (asSource) {
    const files = await withCompanyScope(scope, async (tx) =>
      tx<FileRow[]>`
        select f.id, f.name, f.folder_id, f.file_type, f.source_type, f.processing_status,
               (select count(*)::int from drive_file_chunks c where c.file_id = f.id) as chunk_count
          from drive_files f
         where f.archived_at is null and f.source_type = ${asSource}
         order by f.created_at desc
         limit ${options.limit}
      `,
    );
    for (const file of files) {
      nodes.push(fileNode(file));
      edges.push({ source: nodeId, target: file.id, kind: 'contains' });
    }
    return assemble(nodes, edges, options.typeFilter);
  }

  if (!isUuid(nodeId)) return assemble([], [], options.typeFilter);

  const { folders, files, chunks } = await withCompanyScope(scope, async (tx) => {
    // Folder -> child folders and files.
    const childFolders = await tx<FolderRow[]>`
      select f.id, f.name, f.parent_id,
             (select count(*)::int from drive_files df
               where df.folder_id = f.id and df.archived_at is null) as file_count
        from drive_folders f
       where f.parent_id = ${nodeId} and f.archived_at is null
       limit ${options.limit}
    `;

    const childFiles = await tx<FileRow[]>`
      select f.id, f.name, f.folder_id, f.file_type, f.source_type, f.processing_status,
             (select count(*)::int from drive_file_chunks c where c.file_id = f.id) as chunk_count
        from drive_files f
       where f.folder_id = ${nodeId} and f.archived_at is null
       limit ${options.limit}
    `;

    // File -> its chunks.
    const fileChunks = await tx<ChunkRow[]>`
      select c.id, c.file_id, c.ordinal, c.heading, c.content
        from drive_file_chunks c
       where c.file_id = ${nodeId}
       order by c.ordinal
       limit ${options.limit}
    `;

    return { folders: childFolders, files: childFiles, chunks: fileChunks };
  });

  for (const folder of folders) {
    nodes.push(folderNode(folder));
    edges.push({ source: nodeId, target: folder.id, kind: 'contains' });
  }
  for (const file of files) {
    nodes.push(fileNode(file));
    edges.push({ source: nodeId, target: file.id, kind: 'contains' });
  }
  for (const chunk of chunks) {
    nodes.push(chunkNode(chunk));
    edges.push({ source: nodeId, target: chunk.id, kind: 'contains' });
  }

  // The interesting part: what else in this company resembles these chunks.
  const chunkIds = chunks.length > 0 ? chunks.map((c) => c.id) : [nodeId];
  const related = await relatedChunks(scope, chunkIds);

  for (const edge of related.edges) edges.push(edge);
  for (const node of related.nodes) {
    if (!nodes.some((n) => n.id === node.id)) nodes.push(node);
  }

  return assemble(nodes, edges, options.typeFilter);
}

/**
 * Nearest neighbours for a set of chunks, by vector similarity.
 *
 * One statement, with a lateral join so PostgreSQL uses the HNSW index once
 * per chunk instead of comparing every pair. Self-matches are excluded in the
 * join, and the pair is normalised afterwards so A-B and B-A collapse into one
 * edge rather than drawing twice.
 */
async function relatedChunks(
  scope: CompanyScope,
  chunkIds: string[],
): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
  // Semantic edges need Phase 4's tables, and a database without pgvector does
  // not have them. The graph is still worth drawing without them — folders,
  // files and passages are all real — so this degrades to structural edges
  // rather than failing the whole expansion.
  if (!(await embeddingsAvailable(scope))) return { nodes: [], edges: [] };

  const model = embedder().model;

  const rows = await withCompanyScope(scope, async (tx) => {
    // The floor is expressed as a distance because that is what the index
    // orders by: cosine distance is 1 - similarity.
    const maxDistance = 1 - LIMITS.minSimilarity;

    return tx<
      {
        source_chunk: string;
        target_chunk: string;
        score: number;
        file_id: string;
        file_name: string;
        ordinal: number;
        heading: string | null;
        content: string;
      }[]
    >`
      with seed as (
        select e.chunk_id, e.embedding
          from drive_file_embeddings e
         where e.chunk_id = any(${chunkIds}::uuid[]) and e.model = ${model}
      )
      select s.chunk_id as source_chunk,
             n.chunk_id as target_chunk,
             n.score,
             n.file_id, n.file_name, n.ordinal, n.heading, n.content
        from seed s
        cross join lateral (
          select e2.chunk_id,
                 e2.file_id,
                 df.name as file_name,
                 c.ordinal, c.heading, c.content,
                 1 - (e2.embedding <=> s.embedding) as score
            from drive_file_embeddings e2
            join drive_file_chunks c on c.id = e2.chunk_id
            join drive_files df on df.id = e2.file_id
           where e2.model = ${model}
             and e2.chunk_id <> s.chunk_id
             and df.archived_at is null
             and (e2.embedding <=> s.embedding) <= ${maxDistance}
           order by e2.embedding <=> s.embedding
           limit ${LIMITS.neighboursPerChunk}
        ) n
       limit ${LIMITS.maxRelatedEdges}
    `;
  });

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const seenNode = new Set<string>();
  const seenEdge = new Set<string>();

  for (const row of rows) {
    // A-B and B-A are the same relationship drawn twice.
    const pair = [row.source_chunk, row.target_chunk].sort().join('|');
    if (seenEdge.has(pair)) continue;
    seenEdge.add(pair);

    edges.push({
      source: row.source_chunk,
      target: row.target_chunk,
      kind: 'related',
      score: Number(row.score),
    });

    if (!seenNode.has(row.target_chunk)) {
      seenNode.add(row.target_chunk);
      nodes.push(
        chunkNode({
          id: row.target_chunk,
          file_id: row.file_id,
          ordinal: row.ordinal,
          heading: row.heading,
          content: row.content,
        }),
      );
    }
  }

  return { nodes, edges };
}

/**
 * Whether this database has the embedding tables at all.
 *
 * Asked once per process: it is a schema fact, not a per-request one, and it
 * cannot change while the server is running.
 */
let embeddingsPresent: boolean | null = null;

async function embeddingsAvailable(scope: CompanyScope): Promise<boolean> {
  if (embeddingsPresent !== null) return embeddingsPresent;

  embeddingsPresent = await withCompanyScope(scope, async (tx) => {
    const rows = await tx<{ present: boolean }[]>`
      select to_regclass('public.drive_file_embeddings') is not null as present
    `;
    return rows[0]?.present ?? false;
  });
  return embeddingsPresent;
}

/** Tests reset it after migrating a fresh database. */
export function __resetGraphCapabilities(): void {
  embeddingsPresent = null;
}

// --- search -----------------------------------------------------------------

/**
 * Which nodes a search matches.
 *
 * Names and headings are matched directly, and chunk text is matched on its
 * content, so searching "diabetes" finds the passage that discusses it even
 * when no file is called that. Company-scoped throughout.
 */
async function searchNodes(scope: CompanyScope, term: string): Promise<string[]> {
  const like = `%${term.replace(/[%_\\]/g, (m) => '\\' + m)}%`;

  const rows = await withCompanyScope(scope, async (tx) => {
    const folders = await tx<{ id: string }[]>`
      select id from drive_folders
       where archived_at is null and name ilike ${like} escape '\\'
       limit 50
    `;
    const files = await tx<{ id: string }[]>`
      select id from drive_files
       where archived_at is null and (name ilike ${like} escape '\\'
          or original_filename ilike ${like} escape '\\')
       limit 50
    `;
    const chunks = await tx<{ id: string; file_id: string }[]>`
      select id, file_id from drive_file_chunks
       where content ilike ${like} escape '\\' or heading ilike ${like} escape '\\'
       limit 50
    `;
    return [...folders, ...files, ...chunks.map((c) => ({ id: c.id })), ...chunks.map((c) => ({ id: c.file_id }))];
  });

  return [...new Set(rows.map((r) => r.id))];
}

// --- helpers ----------------------------------------------------------------

function assemble(
  nodes: GraphNode[],
  edges: GraphEdge[],
  typeFilter: GraphNodeType | null,
): KnowledgeGraphDTO {
  const filtered = applyTypeFilter(nodes, edges, typeFilter);
  return {
    nodes: filtered.nodes,
    edges: filtered.edges,
    stats: statsFor(filtered.nodes, filtered.edges, null),
    matches: [],
    empty: filtered.nodes.length === 0,
    truncated: false,
  };
}

/**
 * Drops nodes of unwanted types, and any edge left without both ends.
 *
 * An edge whose endpoint has been filtered away would render as a line into
 * nothing, so it goes too.
 */
function applyTypeFilter(
  nodes: GraphNode[],
  edges: GraphEdge[],
  typeFilter: GraphNodeType | null,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  if (!typeFilter) return { nodes, edges };

  // Source nodes are kept whatever the filter: they are the anchors everything
  // else hangs from, and removing them scatters the graph.
  const kept = nodes.filter((n) => n.type === typeFilter || n.type === 'source');
  const ids = new Set(kept.map((n) => n.id));
  return { nodes: kept, edges: edges.filter((e) => ids.has(e.source) && ids.has(e.target)) };
}

/** Counted from the graph itself. Nothing here is a stored or guessed number. */
function statsFor(
  nodes: GraphNode[],
  edges: GraphEdge[],
  totals: { folders: number; files: number; chunks: number } | null,
): GraphStats {
  const byType = (type: GraphNodeType) => nodes.filter((n) => n.type === type).length;
  return {
    nodes: nodes.length,
    edges: edges.length,
    // The overview reports the company's real totals; an expansion reports
    // what it returned, because it never claimed to be the whole picture.
    files: totals?.files ?? byType('file'),
    folders: totals?.folders ?? byType('folder'),
    chunks: totals?.chunks ?? byType('chunk'),
    sources: byType('source'),
  };
}

function folderNode(row: FolderRow): GraphNode {
  return {
    id: row.id,
    type: 'folder',
    label: row.name,
    source: 'cip_drive',
    weight: 3 + row.file_count,
    expandable: row.file_count > 0,
  };
}

function fileNode(row: FileRow): GraphNode {
  return {
    id: row.id,
    type: 'file',
    label: row.name,
    source: row.source_type,
    weight: 2 + Math.min(row.chunk_count, 8),
    fileType: row.file_type,
    processingStatus: row.processing_status,
    chunkCount: row.chunk_count,
    expandable: row.chunk_count > 0,
  };
}

function chunkNode(row: ChunkRow): GraphNode {
  const text = row.content.replace(/\s+/g, ' ').trim();
  return {
    id: row.id,
    type: 'chunk',
    label: row.heading?.trim() || text.slice(0, 60) || `Passage ${row.ordinal + 1}`,
    source: null,
    weight: 1,
    heading: row.heading,
    ordinal: row.ordinal,
    fileId: row.file_id,
    // Capped, so a long passage cannot bloat the payload for every node drawn.
    snippet: text.slice(0, LIMITS.snippetChars),
    expandable: true,
  };
}

function sourceNodeId(source: GraphSource): string {
  return `source:${source}`;
}

function sourceFromNodeId(nodeId: string): GraphSource | null {
  if (nodeId === 'source:cip_drive') return 'cip_drive';
  if (nodeId === 'source:google_drive') return 'google_drive';
  return null;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export const GRAPH_LIMITS = LIMITS;
