/**
 * What the media endpoints send the browser.
 *
 * A deliberate mirror of the server's MediaGenerationDTO rather than an import
 * of it: the server type lives behind `server-only`, and copying the shape
 * here keeps the browser from ever pulling that module in. Company ids and
 * storage paths are absent from both, so neither can be rendered by accident.
 */

export type MediaType = 'image' | 'video';

export type MediaStatus = 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';

export type MediaErrorCode =
  | 'PROVIDER_NOT_CONFIGURED'
  | 'INVALID_REQUEST'
  | 'RATE_LIMITED'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_ERROR'
  | 'STORAGE_ERROR'
  | 'GENERATION_FAILED'
  | 'CANCELLED';

export type MediaGenerationDTO = {
  id: string;
  type: MediaType;
  provider: string;
  model: string;
  prompt: string;
  status: MediaStatus;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  errorCode: MediaErrorCode | null;
  errorMessage: string | null;
  aspectRatio: string | null;
  hasAsset: boolean;
  assetCount: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

export type MediaAssetDTO = {
  id: string;
  mimeType: string;
  fileSize: number;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  ordinal: number;
};

export type ImageProviderChoice = 'openai' | 'gemini';

export type ImageProviderStatusDTO = {
  choice: ImageProviderChoice;
  provider: string;
  model: string;
  configured: boolean;
  /** The shapes this generator makes itself. Anything else is cut from one of these. */
  aspectRatios: string[];
};

export type ProviderStatusDTO = {
  /** Whichever image provider would answer a request that names none. */
  image: { provider: string; model: string; configured: boolean };
  /** Every image provider, so the UI can offer a choice and show what is set up. */
  images: ImageProviderStatusDTO[];
  defaultImageProvider: ImageProviderChoice;
  video: { provider: string; model: string; configured: boolean; supportsCancel: boolean };
};

/** What the picker calls each provider. */
export const IMAGE_PROVIDER_LABELS: Record<ImageProviderChoice, string> = {
  openai: 'OpenAI',
  gemini: 'Gemini / Nano Banana 2',
};

/** The asset route proves the session before it serves a byte. */
export function assetUrl(generationId: string, assetId?: string): string {
  const query = assetId ? `?assetId=${encodeURIComponent(assetId)}` : '';
  return `/api/media/generations/${generationId}/asset${query}`;
}

/**
 * The same bytes, asked for as a file to keep.
 *
 * A separate URL rather than a flag on the element: the page shows the inline
 * one and offers this, so the browser saves what is on screen without
 * re-deciding what it is.
 */
export function assetDownloadUrl(generationId: string, assetId?: string): string {
  const query = assetId ? `?assetId=${encodeURIComponent(assetId)}&download=1` : '?download=1';
  return `/api/media/generations/${generationId}/asset${query}`;
}

/** A generation still moving is one the UI should keep polling. */
export function isInFlight(status: MediaStatus): boolean {
  return status === 'queued' || status === 'processing';
}
