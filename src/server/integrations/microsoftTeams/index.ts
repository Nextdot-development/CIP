import 'server-only';
import { MicrosoftGraphClient, microsoftGraphFromEnv } from './client';
import type { MicrosoftGraphApi } from './client';

/**
 * Which Microsoft Graph the application talks to.
 *
 * The real client when an Entra application is configured. When it is not, the
 * real client is still returned — and it refuses every call with "not
 * configured". There is deliberately no fallback to the fake here, for the
 * same reason the Google registry has none: a deployment with no credentials
 * must fail honestly rather than appear to sync an empty workspace.
 *
 * Tests inject the in-memory Graph explicitly through __setMicrosoftGraph.
 */

let cached: MicrosoftGraphApi | null = null;

export function microsoftGraph(): MicrosoftGraphApi {
  if (cached) return cached;
  cached = microsoftGraphFromEnv();
  return cached;
}

/** Tests swap in their own. */
export function __setMicrosoftGraph(api: MicrosoftGraphApi | null): void {
  cached = api;
}

export { MicrosoftGraphClient };
export * from './client';
