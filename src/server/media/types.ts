import 'server-only';
import { MEDIA_LIMITS, SUPPORTED_IMAGE_TYPES } from './providers/types';
import type { MediaErrorCode } from './providers/types';

/**
 * The media domain: what a generation is, and what a caller is allowed to see
 * of one.
 *
 * The DTO is the security boundary for reads. company_id and storage_path are
 * not optional fields that happen to be omitted — they are absent from the
 * type, so a handler cannot return them by forgetting to strip them.
 */

export type MediaType = 'image' | 'video';

export type MediaStatus = 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';

/** What a caller may see. No company id, no storage path, no credentials. */
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
  /** Normalised, never the provider's own wording. */
  errorCode: MediaErrorCode | null;
  errorMessage: string | null;
  aspectRatio: string | null;
  /** True once there are bytes to fetch through the asset route. */
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

export class MediaNotFound extends Error {
  constructor(what = 'That generation') {
    super(`${what} could not be found.`);
    this.name = 'MediaNotFound';
  }
}

export class MediaRejected extends Error {
  readonly code: MediaErrorCode;
  constructor(message: string, code: MediaErrorCode = 'INVALID_REQUEST') {
    super(message);
    this.name = 'MediaRejected';
    this.code = code;
  }
}

export class MediaConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MediaConflict';
  }
}

/** Provider not configured is its own outcome: not an error the user caused. */
export class MediaProviderUnavailable extends Error {
  readonly code: MediaErrorCode = 'PROVIDER_NOT_CONFIGURED';
  constructor(message = 'That provider is not configured.') {
    super(message);
    this.name = 'MediaProviderUnavailable';
  }
}

/**
 * Validates a prompt.
 *
 * Length only. There is deliberately no content filtering here: the provider
 * does that, and a second opinion implemented from guesswork would reject
 * legitimate briefs while giving no real protection.
 */
export function validatePrompt(value: unknown): string {
  if (typeof value !== 'string') throw new MediaRejected('A prompt is required.');
  const prompt = value.trim();
  if (prompt.length === 0) throw new MediaRejected('A prompt is required.');
  if (prompt.length > MEDIA_LIMITS.maxPromptChars) {
    throw new MediaRejected(`Keep the prompt under ${MEDIA_LIMITS.maxPromptChars} characters.`);
  }
  return prompt;
}

/** Only ratios the selected provider actually accepts. */
export function validateChoice(
  value: unknown,
  allowed: readonly string[],
  label: string,
): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new MediaRejected(`${label} must be one of: ${allowed.join(', ')}.`);
  }
  return value;
}

export function validateReferenceIds(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new MediaRejected('Reference images must be a list of file ids.');
  const ids = value.filter((v): v is string => typeof v === 'string' && v.length > 0);
  if (ids.length > MEDIA_LIMITS.maxReferenceImages) {
    throw new MediaRejected(`Use at most ${MEDIA_LIMITS.maxReferenceImages} reference images.`);
  }
  return ids;
}

export function validateDuration(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 60) {
    throw new MediaRejected('Duration must be between 1 and 60 seconds.');
  }
  return Math.round(seconds);
}

export function validateIdempotencyKey(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length < 8 || value.length > 200) {
    throw new MediaRejected('An idempotency key must be between 8 and 200 characters.');
  }
  return value;
}

export function isSupportedImageType(mimeType: string): boolean {
  return (SUPPORTED_IMAGE_TYPES as readonly string[]).includes(mimeType);
}
