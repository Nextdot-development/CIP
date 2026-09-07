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

export type ProviderStatusDTO = {
  image: { provider: string; model: string; configured: boolean };
  video: { provider: string; model: string; configured: boolean; supportsCancel: boolean };
};

/** The asset route proves the session before it serves a byte. */
export function assetUrl(generationId: string, assetId?: string): string {
  const query = assetId ? `?assetId=${encodeURIComponent(assetId)}` : '';
  return `/api/media/generations/${generationId}/asset${query}`;
}

/** A generation still moving is one the UI should keep polling. */
export function isInFlight(status: MediaStatus): boolean {
  return status === 'queued' || status === 'processing';
}
