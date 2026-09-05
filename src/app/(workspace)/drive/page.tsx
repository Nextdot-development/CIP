import { requireSession } from '@/server/auth/guards';
import { DriveNotFound, listFolder } from '@/server/drive/service';
import { DriveSection } from '@/sections/DriveSection';
import { EmptyState } from '@/components/ui/Bits';

export const metadata = { title: 'Drive — CIP' };
export const dynamic = 'force-dynamic';

/**
 * The folder id arrives in the query string, so a person can paste one in. It
 * is checked against the session's company before anything loads: another
 * company's id renders "not found", exactly like an id that never existed.
 */
export default async function DrivePage({
  searchParams,
}: {
  searchParams: Promise<{ folder?: string }>;
}) {
  const session = await requireSession();
  const { folder } = await searchParams;

  let listing;
  try {
    listing = await listFolder(session.scope, folder ?? null);
  } catch (error) {
    if (!(error instanceof DriveNotFound)) throw error;
    listing = null;
  }

  if (listing) return <DriveSection listing={listing} />;

  return (
    <EmptyState
          icon="folder"
      title="That folder could not be found"
      copy="It may have been archived, or the link may point somewhere you cannot open."
      action={
        <a className="btn btn-primary btn-sm" href="/drive">
          Back to your Drive
        </a>
      }
    />
  );
}
