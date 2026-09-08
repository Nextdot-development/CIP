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
