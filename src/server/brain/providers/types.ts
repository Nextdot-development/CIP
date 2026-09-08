import 'server-only';

/**
 * What a Brain provider has to be able to do.
 *
 * The interface exists so the Brain's reasoning — what an asset is, what the
 * brand looks like, what a feedback comment means — never names a vendor. Two
 * implementations: OpenAI, and a deterministic fake that lets the whole
 * pipeline be tested offline with no key and no bill.
 *
 * PRIVACY: implementations send asset content — image bytes, sampled video
 * frames, extracted text — and the user's own request to a third party. They
 * send nothing else. No company id, no file id, no storage path, no database
 * id, no credentials. Callers pass content and nothing more; see each method.
 */

export type BrainProviderName = 'openai' | 'fake';

/**
 * The task types a brief may claim.
 *
 * A fixed list rather than free text, because task type is a *scope* for
 * learning: a lesson recorded against one is only retrieved for another with
 * the same name. Left open, the model returned "promotional_image" one run and
 * "production_brief" the next, and the lesson learned from the first was never
 * seen again. A closed vocabulary is what makes the scoping actually work.
 */
export const TASK_TYPES = [
  'social_image',
  'promotional_image',
  'product_image',
  'brand_image',
  'other_image',
  'social_video',
  'promotional_video',
  'product_video',
  'brand_video',
  'other_video',
] as const;

export type TaskType = (typeof TASK_TYPES)[number];

/** The fallback for a media type, when nothing more specific fits. */
export function defaultTaskType(mediaType: 'image' | 'video'): TaskType {
  return mediaType === 'video' ? 'other_video' : 'other_image';
}

/** Coerces whatever a provider returned onto the vocabulary. */
export function normaliseTaskType(value: unknown, mediaType: 'image' | 'video'): TaskType {
  if (typeof value === 'string') {
    const candidate = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
    if ((TASK_TYPES as readonly string[]).includes(candidate)) return candidate as TaskType;
  }
  return defaultTaskType(mediaType);
}

/** Why a Brain call failed, and what the queue should do about it. */
export type BrainFailureKind = 'rate_limited' | 'transient' | 'permanent';

export type BrainErrorCode =
  | 'NOT_CONFIGURED'
  | 'RATE_LIMITED'
  | 'TIMEOUT'
  | 'PROVIDER_ERROR'
  | 'INVALID_RESPONSE'
  | 'UNSUPPORTED_ASSET'
  | 'ASSET_TOO_SMALL';

export class BrainFailed extends Error {
  readonly code: BrainErrorCode;
  readonly kind: BrainFailureKind;
  readonly retryAfterSeconds: number | null;

  constructor(
    code: BrainErrorCode,
    kind: BrainFailureKind,
    message: string,
    retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = 'BrainFailed';
    this.code = code;
    this.kind = kind;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Safe metadata about a call. Never content. */
export type BrainUsage = {
  inputTokens?: number | null;
  outputTokens?: number | null;
  durationMs?: number | null;
};

/**
 * What looking at one asset produced.
 *
 * `summary` is a sentence a person could read, and the thing that gets
 * embedded. `structured` carries the parts whose shape depends on the asset
 * kind. `facts` are the individual claims that feed Brand DNA — each one small
 * enough that evidence can be counted for it across many assets.
 */
export type AssetFact = {
  section: 'visual' | 'video' | 'content';
  attribute: string;
  value: string;
};

export type AssetAnalysis = {
  summary: string;
  extractedText: string | null;
  structured: Record<string, unknown>;
  facts: AssetFact[];
  usage: BrainUsage;
};

export type ImageInput = {
  bytes: Buffer;
  mimeType: string;
  /** The display name only. Never a path, never an id. */
  filename: string;
};

export type FramesInput = {
  /** Sampled key frames, in order. Never the whole video. */
  frames: { bytes: Buffer; mimeType: string; atSeconds: number }[];
  durationSeconds: number;
  width: number | null;
  height: number | null;
  /** Spoken content, when it could be transcribed. */
  transcript: string | null;
  filename: string;
};

export type DocumentInput = {
  /** Already-extracted text, truncated by the caller. */
  text: string;
  filename: string;
};

/** What a feedback comment means, turned into something actionable. */
export type FeedbackAnalysis = {
  /** The lessons this feedback supports. Empty when it taught us nothing. */
  lessons: {
    polarity: 'prefer' | 'avoid';
    statement: string;
    /**
     * How specific this is. A comment about one campaign must not become a
     * company-wide rule, so the provider says what it actually applies to and
     * the caller narrows the scope accordingly.
     */
    appliesTo: 'company' | 'task_type' | 'campaign' | 'product' | 'platform';
    confidence: number;
  }[];
  usage: BrainUsage;
};

export type FeedbackInput = {
  score: number;
  comment: string | null;
  /** What was asked for, so the comment can be read in context. */
  requestText: string;
  taskType: string;
  platform: string | null;
  campaign: string | null;
  product: string | null;
};

/** What the Brain decided to ask the generator for. */
export type GenerationBrief = {
  taskType: string;
  platform: string | null;
  campaign: string | null;
  product: string | null;
  visualDirection: string | null;
  videoDirection: string | null;
  contentDirection: string | null;
  brandRules: string[];
  successfulPatterns: string[];
  negativePatterns: string[];
  learnedPreferences: string[];
  constraints: string[];
  avoid: string[];
  /** The prompt actually handed to the image or video model. */
  generationPrompt: string;
  confidence: number;
  /**
   * Set when the Brain could not safely decide something it needs. The caller
   * stops and asks rather than guessing.
   */
  clarificationQuestion: string | null;
};

export type BriefInput = {
  requestText: string;
  mediaType: 'image' | 'video';
  /** Everything retrieved from this company's memory, already scoped. */
  brandFacts: { section: string; attribute: string; value: string; confidence: number }[];
  relevantAssets: { summary: string; extractedText: string | null }[];
  successfulExamples: { requestText: string; score: number; comment: string | null }[];
  negativeExamples: { requestText: string; score: number; comment: string | null }[];
  lessons: { polarity: 'prefer' | 'avoid'; statement: string; confidence: number }[];
  /** Distinct campaigns and products the company has, for disambiguation. */
  knownCampaigns: string[];
  knownProducts: string[];
};

export interface BrainProvider {
  readonly name: BrainProviderName;
  readonly model: string;
  /** False when no credentials are configured; callers refuse early. */
  readonly configured: boolean;

  /**
   * Looks at an image.
   *
   * Implementations must send the image bytes, its display name and the
   * instruction — nothing else.
   */
  analyzeImage(input: ImageInput): Promise<AssetAnalysis>;

  /** Looks at sampled frames and any transcript. Never the whole video. */
  analyzeFrames(input: FramesInput): Promise<AssetAnalysis>;

  /** Reads already-extracted document text. */
  analyzeDocument(input: DocumentInput): Promise<AssetAnalysis>;

  /** Turns a score and a comment into scoped, actionable lessons. */
  analyzeFeedback(input: FeedbackInput): Promise<FeedbackAnalysis>;

  /** Turns a request plus retrieved memory into a generation brief. */
  buildGenerationBrief(input: BriefInput): Promise<GenerationBrief & { usage: BrainUsage }>;
}

/**
 * Bounds, so one enormous asset cannot cost a fortune or hang a worker.
 *
 * Every one is configurable: the right numbers depend on what somebody is
 * paying for, and hard-coding them would mean a deploy to change them.
 */
function fromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export const BRAIN_LIMITS = {
  /** Images below this on either side are refused: see the note. */
  get minImagePixels(): number {
    return fromEnv('CIP_BRAIN_MIN_IMAGE_PIXELS', 64);
  },
  get maxImageBytes(): number {
    return fromEnv('CIP_BRAIN_MAX_IMAGE_BYTES', 20 * 1024 * 1024);
  },
  /** Frames sampled from a video. More costs more and says little extra. */
  get maxVideoFrames(): number {
    return fromEnv('CIP_BRAIN_MAX_VIDEO_FRAMES', 6);
  },
  get maxVideoSeconds(): number {
    return fromEnv('CIP_BRAIN_MAX_VIDEO_SECONDS', 600);
  },
  get maxVideoBytes(): number {
    return fromEnv('CIP_BRAIN_MAX_VIDEO_BYTES', 500 * 1024 * 1024);
  },
  /** Document text sent for analysis. The rest is already chunked and embedded. */
  get maxDocumentChars(): number {
    return fromEnv('CIP_BRAIN_MAX_DOCUMENT_CHARS', 12_000);
  },
  get requestTimeoutMs(): number {
    return fromEnv('CIP_BRAIN_TIMEOUT_MS', 120_000);
  },
  /** Attempts before an asset is left failed. */
  get maxAttempts(): number {
    return fromEnv('CIP_BRAIN_MAX_ATTEMPTS', 3);
  },
  /** How many retrieved items of each kind go into a brief. */
  get maxReferences(): number {
    return fromEnv('CIP_BRAIN_MAX_REFERENCES', 4);
  },
  get maxBrandFacts(): number {
    return fromEnv('CIP_BRAIN_MAX_BRAND_FACTS', 24);
  },
  get maxLessons(): number {
    return fromEnv('CIP_BRAIN_MAX_LESSONS', 8);
  },
  /** Evidence before a candidate lesson becomes confirmed. */
  get lessonConfirmAt(): number {
    return fromEnv('CIP_BRAIN_LESSON_CONFIRM_AT', 2);
  },
  /** Evidence before an observation becomes a Brand DNA fact worth stating. */
  get factMinEvidence(): number {
    return fromEnv('CIP_BRAIN_FACT_MIN_EVIDENCE', 2);
  },
  /** Below this the Brain asks rather than guessing. */
  get minBriefConfidence(): number {
    const value = Number(process.env.CIP_BRAIN_MIN_CONFIDENCE);
    return Number.isFinite(value) && value >= 0 && value <= 1 ? value : 0.35;
  },
} as const;

/**
 * Image types the Brain will look at.
 *
 * Narrower than what the Drive stores: these are the ones a vision model
 * reliably accepts.
 */
export const ANALYSABLE_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;

export const ANALYSABLE_VIDEO_TYPES = [
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'video/x-matroska',
] as const;
