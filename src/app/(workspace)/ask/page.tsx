import { requireSession } from '@/server/auth/guards';
import { listGenerations } from '@/server/media/generation';
import { providerStatus } from '@/server/media/providers';
import { AskSection } from '@/sections/AskSection';

export const metadata = { title: 'Ask — CIP' };
export const dynamic = 'force-dynamic';

/**
 * Loaded for the session's own company: there is no company parameter to pass
 * and none to forget. What has already been made arrives with the page so the
 * history is there before the first render rather than after a fetch.
 */
export default async function AskPage() {
  const session = await requireSession();

  return (
    <AskSection
      initial={(await listGenerations(session.scope, { limit: 30 })).generations}
      providers={providerStatus()}
    />
  );
}
