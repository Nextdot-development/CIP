import 'server-only';

/**
 * What a media provider has to be able to do.
 *
 * The interfaces exist so nothing above this directory ever names Google or
 * fal. The service layer asks for an image or a video and receives normalised
 * bytes and metadata; which vendor produced them is a configuration detail.
 *
 * PRIVACY: implementations of these interfaces send prompt text, and for an
 * edit the reference image bytes, to a third party. They send nothing else —
 * no company id, no storage path, no database id, no credentials. Callers are
 * responsible for passing only what the user asked to generate. See the
 * contract on each method.
 */

export type ProviderName = 'google' | 'seedance' | 'fake-image' | 'fake-video';

/** Normalised failure codes. A provider's own wording never reaches a caller. */
export type MediaErrorCode =
  | 'PROVIDER_NOT_CONFIGURED'
  | 'INVALID_REQUEST'
  | 'RATE_LIMITED'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_ERROR'
  | 'STORAGE_ERROR'
  | 'GENERATION_FAILED'
  | 'CANCELLED';

/** Whether the queue should try again, and when. */
export type FailureKind =
  /** The provider asked us to slow down. Back off without spending an attempt. */
  | 'rate_limited'
  /** Network, timeout, 5xx. Spend an attempt and back off. */
  | 'transient'
  /** The request will be refused identically every time. Stop now. */
  | 'permanent';

export class ProviderFailed extends Error {
  readonly code: MediaErrorCode;
  readonly kind: FailureKind;
  readonly retryAfterSeconds: number | null;

  constructor(
    code: MediaErrorCode,
    kind: FailureKind,
    message: string,
    retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = 'ProviderFailed';
    this.code = code;
    this.kind = kind;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** What a provider reports about what a call consumed. All optional. */
export type ProviderUsage = {
  providerRequestId?: string | null;
  inputUnits?: number | null;
  outputUnits?: number | null;
  /**
   * Only ever set when the provider itself returns a cost. Neither adapter
   * currently does, so this stays null rather than carrying a number somebody
   * guessed from a pricing page that will move.
   */
  estimatedCost?: number | null;
  costCurrency?: string | null;
};

/** One produced file, already in memory and not yet stored. */
export type GeneratedAsset = {
  bytes: Buffer;
  mimeType: string;
  width?: number | null;
  height?: number | null;
  durationSeconds?: number | null;
};

/** An image the caller already owns, passed in for editing or as a reference. */
export type ReferenceImage = {
  bytes: Buffer;
  mimeType: string;
};

export type ImageRequest = {
  prompt: string;
  /**
   * Resolved server-side from records this company owns. A provider receives
   * bytes, never an id and never a path — it has no use for either, and
   * sending them would widen what leaves our infrastructure for no gain.
   */
  references: ReferenceImage[];
  aspectRatio?: string | null;
  imageSize?: string | null;
};

export type ImageResult = {
  assets: GeneratedAsset[];
  model: string;
  usage: ProviderUsage;
};

export interface ImageGenerationProvider {
  readonly name: ProviderName;
  readonly model: string;
  /** False when no credentials are configured; the service refuses early. */
  readonly configured: boolean;
  /** Aspect ratios this provider accepts, for server-side validation. */
  readonly aspectRatios: readonly string[];
  readonly imageSizes: readonly string[];

  /**
   * Produces one or more images.
   *
   * Implementations must send the prompt, the reference bytes and the
   * generation options — nothing else.
   */
  generate(request: ImageRequest): Promise<ImageResult>;
}

export type VideoRequest = {
  prompt: string;
  /** Present for image-to-video; absent for text-to-video. */
  reference?: ReferenceImage | null;
  durationSeconds?: number | null;
  resolution?: string | null;
  aspectRatio?: string | null;
};

/** Submitting a video returns a handle, not a file. Nothing is ready yet. */
export type VideoJob = {
  providerJobId: string;
  model: string;
  usage: ProviderUsage;
};

export type VideoStatus =
  | { state: 'pending' }
  | { state: 'completed'; assets: GeneratedAsset[]; usage: ProviderUsage }
  | { state: 'failed'; code: MediaErrorCode; message: string };

export interface VideoGenerationProvider {
  readonly name: ProviderName;
  readonly model: string;
  readonly configured: boolean;
  readonly resolutions: readonly string[];
  /** Whether cancel() means anything. Only claimed when the API really has it. */
  readonly supportsCancel: boolean;

  /** Submits the job and returns immediately. Never waits for the video. */
  submit(request: VideoRequest): Promise<VideoJob>;
  /** Asks where the job has got to. Called by the worker, never by a request. */
  poll(providerJobId: string): Promise<VideoStatus>;
  /** Best effort. Implementations that cannot cancel must say so above. */
  cancel(providerJobId: string): Promise<void>;
}

/** Shared limits, so one place decides what is too big or too long. */
export const MEDIA_LIMITS = {
  maxPromptChars: 4_000,
  maxReferenceImages: 3,
  maxReferenceBytes: 8 * 1024 * 1024,
  maxAssetBytes: 200 * 1024 * 1024,
  requestTimeoutMs: 120_000,
  /** Attempts before a generation is left failed. */
  maxAttempts: 3,
  /** How long a video may sit in the queue before the worker gives up on it. */
  videoTimeoutMs: 30 * 60 * 1000,
} as const;

/** Image types we are willing to accept as a reference and to store. */
export const SUPPORTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
