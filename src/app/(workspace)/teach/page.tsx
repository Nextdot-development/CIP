import { requireSession } from '@/server/auth/guards';
import { getConnection, listSyncedFiles } from '@/server/integrations/googleDrive/connection';
import { listFolder } from '@/server/drive/service';
import { TeachSection } from '@/sections/TeachSection';

export const metadata = { title: 'Add data — CIP' };
export const dynamic = 'force-dynamic';

/**
 * Both ways of teaching CIP, loaded together because they are one page now.
 *
 * `google` is the outcome of an OAuth round trip, which lands back here rather
 * than on a page of its own. Everything is loaded for the session's own
 * company: there is no company parameter to pass and none to forget.
 */
export default async function TeachPage({
  searchParams,
}: {
  searchParams: Promise<{ google?: string; folder?: string }>;
}) {
  const session = await requireSession();
  const { google, folder } = await searchParams;

  const [connection, syncedFiles, listing] = await Promise.all([
    getConnection(session.scope),
    listSyncedFiles(session.scope, {}),
    listFolder(session.scope, folder ?? null),
  ]);

  return (
    <TeachSection
      connection={connection}
      syncedFiles={syncedFiles}
      listing={listing}
      googleOutcome={google}
    />
  );
}
