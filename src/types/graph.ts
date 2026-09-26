/**
 * What the knowledge-graph endpoint sends the browser.
 *
 * A deliberate mirror of the server types rather than an import: those live
 * behind `server-only`. Neither shape has a company id, a storage path or an
 * external Google id, so none can reach a component by accident.
 */

export type GraphNodeType = 'source' | 'folder' | 'file' | 'chunk' | 'brand' | 'trait';
export type GraphSource = 'cip_drive' | 'google_drive';
export type GraphEdgeKind = 'contains' | 'related' | 'resembles' | 'shares';

/** Which heading a trait hub belongs under, when it belongs under one. */
export type GraphTraitDimension = 'country' | 'category' | 'tier' | 'flavour' | null;

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
  /** Trait-only: the heading this hub sits under, if it has one. */
  dimension?: GraphTraitDimension;
  /** Trait-only: how many brands hang off it. */
  brandCount?: number;
  /**
   * Brand-only: a picture of it to draw in its node - its logo, or failing
   * that a photograph of the pack. Absent when CIP holds neither, and the node
   * then carries the brand's initials instead.
   */
  imageFileId?: string;
  /** Brand-only: how many files are about it. */
  fileCount?: number;
  /**
   * Brand-only: its most recent files, so the inspector can show what the
   * brand is made of without a second trip. A handful, newest first.
   */
  files?: { id: string; name: string; fileType: string; bytes: number }[];
  expandable: boolean;
};

export type GraphEdgeDTO = {
  source: string;
  target: string;
  kind: GraphEdgeKind;
  score?: number;
  /**
   * Why two brands resemble each other, in their own words.
   *
   * Carried on the edge so that "why are these joined?" is answered with
   * things both brands were described as, rather than a number nobody can
   * check. Absent on every other kind of edge.
   */
  shared?: string[];
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
