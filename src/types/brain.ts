/**
 * What the Brain endpoints send the browser.
 *
 * A deliberate mirror of the server types rather than an import: those live
 * behind `server-only`. None of these shapes has a company id, a storage path
 * or a provider credential, so none can reach a component by accident.
 */

export type BrandSection = 'visual' | 'video' | 'content' | 'rules';

export type BrandFactDTO = {
  id: string;
  section: BrandSection;
  attribute: string;
  value: string;
  kind: 'observed' | 'derived' | 'preference' | 'inference' | 'hypothesis';
  confidence: number;
  evidenceCount: number;
  updatedAt: string;
  /**
   * The markets whose files produced this fact.
   *
   * Empty when none of them has been placed. Two or more means the pattern
   * holds across countries — it is the brand, not one country's version of it.
   */
  markets: string[];
};

export type BrandEvidenceDTO = {
  fileId: string | null;
  fileName: string | null;
  note: string | null;
};

export type LessonDTO = {
  id: string;
  polarity: 'prefer' | 'avoid';
  statement: string;
  status: 'candidate' | 'confirmed' | 'rejected' | 'superseded';
  evidenceCount: number;
  confidence: number;
  taskType: string | null;
  platform: string | null;
  campaign: string | null;
  product: string | null;
  createdAt: string;
};

export type FeedbackDTO = {
  id: string;
  generationId: string;
  score: number;
  comment: string | null;
  createdAt: string;
  analysed: boolean;
};

export type MemoryDTO = {
  fileId: string;
  fileName: string;
  fileType: string;
  summary: string;
  kind?: string;
};

export type BrainOverviewDTO = {
  provider: { provider: string; model: string; configured: boolean };
  video: { ffmpeg: boolean };
  counts: {
    understood: number; pending: number; failed: number; unsupported: number;
    facts: number; derived: number; lessons: number; confirmed: number;
    feedback: number; briefs: number; assets: number;
  };
  topFacts: BrandFactDTO[];
  recentLessons: LessonDTO[];
  recentFeedback: FeedbackDTO[];
  empty: boolean;
};

/** How a fact came to be known, in words a person can act on. */
export const FACT_KIND_LABEL: Record<BrandFactDTO['kind'], string> = {
  observed: 'Seen in an asset',
  derived: 'Pattern across assets',
  preference: 'Your stated preference',
  inference: 'Inferred',
  hypothesis: 'Low confidence',
};

/**
 * A PDF read visually, and what came out of it.
 *
 * Kept separate from MemoryDTO because the question is different: memory asks
 * what CIP knows, this asks how the reading of one file actually went — which
 * pages were looked at, which failed, and how many posts were found.
 */
export type PdfSummaryDTO = {
  fileId: string;
  name: string;
  fileSize: number;
  uploadedAt: string;
  status: string;
  kind: string | null;
  error: string | null;
  pageCount: number;
  pagesProcessed: number;
  pagesUnderstood: number;
  pagesFailed: number;
  pagesWithText: number;
  postsDetected: number;
  processingMs: number | null;
};

export type PdfPageDTO = {
  id: string;
  pageNumber: number;
  status: string;
  summary: string;
  hasTextLayer: boolean;
  postsDetected: number;
  width: number | null;
  height: number | null;
  errorMessage: string | null;
  durationMs: number | null;
  structured: Record<string, unknown>;
  /** Scoped route, never a storage path. */
  imageUrl: string;
};

export type PdfPostDTO = {
  id: string;
  pageNumber: number;
  postIndex: number;
  country: string | null;
  caption: string | null;
  headline: string | null;
  summary: string;
  visibleText: string | null;
  confidence: number;
  structured: Record<string, unknown>;
};
