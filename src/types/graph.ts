/**
 * What the knowledge-graph endpoint sends the browser.
 *
 * A deliberate mirror of the server types rather than an import: those live
 * behind `server-only`. Neither shape has a company id, a storage path or an
 * external Google id, so none can reach a component by accident.
 */

export type GraphNodeType = 'source' | 'folder' | 'file' | 'chunk';
export type GraphSource = 'cip_drive' | 'google_drive';
export type GraphEdgeKind = 'contains' | 'related';

export type GraphNodeDTO = {
  id: string;
  type: GraphNodeType;
  label: string;
  source: GraphSource | null;
  weight: number;
  fileType?: string;
  processingStatus?: string;
  chunkCount?: number;
  heading?: string | null;
  ordinal?: number;
  snippet?: string;
  fileId?: string;
  expandable: boolean;
};

export type GraphEdgeDTO = {
  source: string;
  target: string;
  kind: GraphEdgeKind;
  score?: number;
};

export type GraphStatsDTO = {
  nodes: number;
  edges: number;
  files: number;
  folders: number;
  chunks: number;
  sources: number;
};

export type KnowledgeGraphDTO = {
  nodes: GraphNodeDTO[];
  edges: GraphEdgeDTO[];
  stats: GraphStatsDTO;
  matches: string[];
  empty: boolean;
  truncated: boolean;
};
