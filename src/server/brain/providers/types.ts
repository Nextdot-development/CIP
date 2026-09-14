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

/**
 * The shape a piece has to be, named rather than assumed.
 *
 * A banner is not a square and a story is not a poster, and asking for one and
 * getting a 1024x1024 is the difference between a usable asset and a picture of
 * one. The brief said "recommended canvas 1200 x 400 px" while the generator
 * produced a square, because nothing carried the shape from the words to the
 * request.
 *
 * A closed list for the same reason task types are closed: free text drifts —
 * "banner", "web banner" and "hero banner" would be three formats by Thursday —
 * and every entry here has to map onto something a generator will accept.
 */
export const CREATIVE_FORMATS = [
  'feed_post',
  'story',
  'carousel_card',
  'banner',
  'billboard',
  'poster',
  'thumbnail',
  'other',
] as const;

export type CreativeFormat = (typeof CREATIVE_FORMATS)[number];

/**
 * What each format wants to be, as width:height.
 *
 * These are the real shapes of the things, not what any provider offers. What
 * a provider can actually make is decided separately, against this.
 */
export const FORMAT_ASPECT: Record<CreativeFormat, { ratio: number; canvas: string }> = {
  feed_post:     { ratio: 1,        canvas: '1080 x 1080' },
  carousel_card: { ratio: 1,        canvas: '1080 x 1080' },
  story:         { ratio: 9 / 16,   canvas: '1080 x 1920' },
  poster:        { ratio: 2 / 3,    canvas: '1080 x 1620' },
  banner:        { ratio: 3,        canvas: '1200 x 400' },
  billboard:     { ratio: 4,        canvas: '1920 x 480' },
  thumbnail:     { ratio: 16 / 9,   canvas: '1280 x 720' },
  other:         { ratio: 1,        canvas: '1080 x 1080' },
};

/** What a person calls it. */
export const FORMAT_LABELS: Record<CreativeFormat, string> = {
  feed_post: 'Feed post',
  story: 'Story',
  carousel_card: 'Carousel card',
  banner: 'Banner',
  billboard: 'Billboard',
  poster: 'Poster',
  thumbnail: 'Thumbnail',
  other: 'Other',
};

/** Coerces whatever a provider returned onto the vocabulary. */
export function normaliseFormat(value: unknown): CreativeFormat {
  if (typeof value === 'string') {
    const candidate = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
    if ((CREATIVE_FORMATS as readonly string[]).includes(candidate)) {
      return candidate as CreativeFormat;
    }
  }
  return 'other';
}

/**
 * The closest shape a generator can actually make, and whether it is the shape
 * that was wanted.
 *
 * `exact` is false when the format's own proportions are not on offer — a
 * 3:1 banner against a generator whose widest is 3:2. The caller says so
 * rather than quietly returning something a third as wide as it asked for.
 */
export function closestAspectRatio(
  format: CreativeFormat,
  supported: readonly string[],
): { aspectRatio: string | null; exact: boolean } {
  const want = FORMAT_ASPECT[format].ratio;

  let best: { value: string; ratio: number } | null = null;
  for (const option of supported) {
    const [w, h] = option.split(':').map(Number);
    if (!w || !h) continue;
    const ratio = w / h;
    if (best === null || Math.abs(Math.log(ratio / want)) < Math.abs(Math.log(best.ratio / want))) {
      best = { value: option, ratio };
    }
  }

  if (!best) return { aspectRatio: null, exact: false };

  // Within 2% is the same shape as far as anyone looking at it is concerned.
  return { aspectRatio: best.value, exact: Math.abs(Math.log(best.ratio / want)) < 0.02 };
}


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
  /**
   * Which of the company's brands this is about, when it is about one.
   *
   * Null is the common case and the right one for anything belonging to the
   * house — a rule about never targeting minors is every brand's. Only ever a
   * name from the company's own roster; a company without a roster gets null
   * throughout and behaves exactly as it did before.
   */
  brand?: string | null;
};

export type AssetAnalysis = {
  summary: string;
  extractedText: string | null;
  structured: Record<string, unknown>;
  facts: AssetFact[];
  usage: BrainUsage;
};

export type ImageInput = {
  /** Brands to attribute facts to. Empty when the company has no roster. */
  brands?: BrandRoster;
  bytes: Buffer;
  mimeType: string;
  /** The display name only. Never a path, never an id. */
  filename: string;
};

export type FramesInput = {
  /** Brands to attribute facts to. Empty when the company has no roster. */
  brands?: BrandRoster;
  /** Sampled key frames, in order. Never the whole video. */
  frames: { bytes: Buffer; mimeType: string; atSeconds: number }[];
  durationSeconds: number;
  width: number | null;
  height: number | null;
  /** Spoken content, when it could be transcribed. */
  transcript: string | null;
  filename: string;
};

/** The brands a company works on, handed to the model as a closed list. */
export type BrandRoster = readonly { name: string; note: string | null }[];

export type DocumentInput = {
  /** Brands to attribute facts to. Empty when the company has no roster. */
  brands?: BrandRoster;
  /** Already-extracted text, truncated by the caller. */
  text: string;
  filename: string;
};

/**
 * One post found on a rendered PDF page.
 *
 * These files are pages of social posts, and a page can carry several. Each is
 * a separate creative decision — its own caption, format and call to action —
 * so they are returned separately rather than flattened into one description
 * of the page.
 *
 * Every field is optional in substance: a post that shows no date has no date,
 * and the model is told to leave it null rather than produce a plausible one.
 */
export type PdfPost = {
  /** Where on the page, reading order. */
  postIndex: number;
  country: string | null;
  account: string | null;
  postedOn: string | null;
  caption: string | null;
  headline: string | null;
  /** Everything legible, verbatim. */
  visibleText: string | null;
  summary: string;
  product: string | null;
  location: string | null;
  eventContext: string | null;
  cta: string | null;
  hashtags: string[];
  offer: string | null;
  creativeFormat: string | null;
  photographyStyle: string | null;
  designStyle: string | null;
  composition: string | null;
  colours: string[];
  typography: string[];
  logoVisible: boolean;
  people: string | null;
  /** How sure the model is that this is one distinct post. */
  confidence: number;
};

/** What one rendered PDF page turned out to hold. */
export type PdfPageAnalysis = AssetAnalysis & {
  posts: PdfPost[];
};

export type PdfPageInput = {
  /** Brands to attribute facts to. Empty when the company has no roster. */
  brands?: BrandRoster;
  /** The rendered page image. Never the PDF itself. */
  bytes: Buffer;
  mimeType: string;
  pageNumber: number;
  pageCount: number;
  /** Text the deterministic pass already read off this page, when there was any. */
  pageText: string | null;
  /** The display name only. Never a path, never an id. */
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
  /** The shape the piece has to be. Decides the aspect ratio actually asked for. */
  format: CreativeFormat;
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
  /**
   * Which brand and market this was built for.
   *
   * Decided by the planner rather than by the model — they come from the
   * roster and from what the request implied, and a model asked to restate
   * them can get them wrong. Recorded because a brief that cannot say which
   * country it drew on cannot be checked, and "why does this look Nigerian?"
   * is the first question anybody asks of a piece they did not expect.
   *
   * Null means there was only one to choose from, or none at all.
   */
  brand: string | null;
  market: string | null;
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

  /**
   * Looks at one rendered page of a PDF and reports the posts on it.
   *
   * Separate from analyzeImage because the question is different: not "what is
   * this picture" but "which posts are on this page, and what does each one
   * say". Implementations must send the page image, its position in the
   * document, any text already read from it and the instruction — nothing else.
   */
  analyzePdfPage(input: PdfPageInput): Promise<PdfPageAnalysis>;

  /** Turns a score and a comment into scoped, actionable lessons. */
  analyzeFeedback(input: FeedbackInput): Promise<FeedbackAnalysis>;

  /** Turns a request plus retrieved memory into a generation brief. */
  buildGenerationBrief(input: BriefInput): Promise<GenerationBrief & { usage: BrainUsage }>;

  /**
   * Looks at a creative and says where it breaks the brand's rules.
   *
   * Implementations send the image, its display name, the brand and market,
   * and the rules - nothing else. They report findings; they never report a
   * score. The score is worked out from the findings by the caller, because a
   * number a model chooses about its own judgement is not a measurement.
   */
  checkCreative(input: CheckInput): Promise<CheckAnalysis>;
}

/** The three things a creative is judged on. */
export type CheckDimension = 'visual' | 'verbal' | 'compliance';

/**
 * One thing a creative is checked against, as a provider sees it.
 *
 * The ref is opaque and short - "F12", "R3" - rather than a database id. A
 * finding has to cite one, and the caller discards any finding that cites a
 * ref it did not send: that is a rule the model made up, and a flag grounded
 * in nothing is exactly the ungrounded output this whole product exists to
 * prevent.
 */
export type CheckRule = {
  ref: string;
  dimension: CheckDimension;
  /**
   * required / forbidden for a stated compliance rule; observed for a Brand
   * DNA fact, which is what the brand has consistently done rather than what
   * it must do.
   */
  requirement: 'required' | 'forbidden' | 'observed';
  statement: string;
};

export type CheckInput = {
  bytes: Buffer;
  mimeType: string;
  /** The display name only. Never a path, never an id. */
  filename: string;
  brand: string | null;
  market: string | null;
  rules: CheckRule[];
};

export type CheckFinding = {
  /** Which rule this is about. Must be one of the refs that was sent. */
  ref: string;
  dimension: CheckDimension;
  severity: 'critical' | 'warning' | 'note';
  /** Plain language a reviewer can act on. */
  message: string;
};

export type CheckAnalysis = {
  /** One or two sentences on the creative as a whole. */
  summary: string;
  findings: CheckFinding[];
  usage: BrainUsage;
};

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
  /**
   * The longest edge an image is sent at.
   *
   * Vision models downsample to roughly this before they look at anything, so
   * a 9000-pixel packshot costs bandwidth and a rejection and buys no extra
   * detail. Anything larger is scaled down to fit rather than refused — a
   * 90 MB bottle shot is still a bottle shot, and "too large to analyse" is a
   * fact about the request, not about the asset.
   */
  get visionEdgePixels(): number {
    return fromEnv('CIP_BRAIN_VISION_EDGE_PIXELS', 2000);
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
  /**
   * Posts read from a single page. A contact sheet of thumbnails can show
   * dozens; past a point they are too small to read anything from reliably.
   */
  get maxPostsPerPage(): number {
    return fromEnv('CIP_BRAIN_MAX_POSTS_PER_PAGE', 12);
  },
  /**
   * Page text passed alongside the image. It is a hint for reading the
   * picture, not the content itself, so it does not need the document budget.
   */
  get maxPageTextChars(): number {
    return fromEnv('CIP_BRAIN_MAX_PAGE_TEXT_CHARS', 4_000);
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
