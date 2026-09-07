import 'server-only';
import { GoogleDriveClient, googleDriveClientFromEnv } from './client';
import type { GoogleDriveApi } from './client';

/**
 * Which Google Drive the application talks to.
 *
 * The real client when an OAuth client is configured. When it is not, the real
 * client is still returned — and it refuses every call with "not configured".
 * There is deliberately no fallback to the fake here: a deployment with no
 * credentials must fail honestly rather than appear to sync an empty Drive.
 *
 * Tests inject the in-memory Drive explicitly through __setGoogleDrive.
 */

let cached: GoogleDriveApi | null = null;

export function googleDrive(): GoogleDriveApi {
  if (cached) return cached;
  cached = googleDriveClientFromEnv();
  return cached;
}

/** Tests swap in their own. */
export function __setGoogleDrive(api: GoogleDriveApi | null): void {
  cached = api;
}

export { GoogleDriveClient };
export * from './client';
