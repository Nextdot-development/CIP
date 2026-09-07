import { requireSession } from '@/server/auth/guards';
import { getConnection, listSyncedFiles } from '@/server/integrations/googleDrive/connection';
import { KnowledgeSection } from '@/sections/KnowledgeSection';

export const metadata = { title: 'Knowledge — CIP' };
export const dynamic = 'force-dynamic';

/**
 * Knowledge settings, loaded for the session's own company. There is no company
 * parameter to pass and none to forget.
 */
export default async function KnowledgePage({
  searchParams,
}: {
  searchParams: Promise<{ google?: string }>;
}) {
  const session = await requireSession();
  const { google } = await searchParams;

  const [connection, files] = await Promise.all([
    getConnection(session.scope),
    listSyncedFiles(session.scope, { limit: 100 }),
  ]);

  return <KnowledgeSection initial={connection} initialFiles={files} outcome={google ?? null} />;
}
