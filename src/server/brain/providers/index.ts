import 'server-only';
import { FakeBrainProvider } from './fake';
import { openAIBrainFromEnv } from './openai';
import type { BrainProvider } from './types';

/**
 * Which Brain answers.
 *
 * OpenAI when a key is configured. When it is not, the real provider is still
 * returned — and it refuses every call with "not configured". There is
 * deliberately no silent fallback to the fake: a deployment with no key must
 * fail honestly rather than appear to have learned things about a brand.
 *
 * CIP_FORCE_FAKE_BRAIN pins the deterministic one, which is what the offline
 * test suite runs against.
 */

let cached: BrainProvider | null = null;

export function brain(): BrainProvider {
  if (cached) return cached;
  cached = process.env.CIP_FORCE_FAKE_BRAIN === 'true'
    ? new FakeBrainProvider()
    : openAIBrainFromEnv();
  return cached;
}

/** What /api/brain and the UI report. Credentials, never a credential. */
export function brainStatus(): { provider: string; model: string; configured: boolean } {
  const provider = brain();
  return {
    provider: provider.name,
    model: provider.model,
    // A fake standing in reports the real provider as unconfigured, so nobody
    // reads a green light and concludes the Brain is wired up.
    configured: provider.name !== 'fake' && provider.configured,
  };
}

/** Tests swap in their own. */
export function __setBrain(provider: BrainProvider | null): void {
  cached = provider;
}

export { FakeBrainProvider };
export * from './types';
