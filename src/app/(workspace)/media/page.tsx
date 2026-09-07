import { requireSession } from '@/server/auth/guards';
import { listGenerations } from '@/server/media/generation';
import { providerStatus } from '@/server/media/providers';
import { search } from '@/server/drive/service';
import { MediaSection } from '@/sections/MediaSection';

export const metadata = { title: 'Media — CIP' };
export const dynamic = 'force-dynamic';

/**
 * Everything on this page is loaded for the session's own company. There is no
 * company parameter to pass and none to forget.
 */
export default async function MediaPage() {
  const session = await requireSession();

  const [{ generations }, reference] = await Promise.all([
    listGenerations(session.scope, { limit: 50 }),
    // Images already in the Drive, offered as a starting point. Scoped, so the
    // list can only ever contain this company's own files.
    search(session.scope, ''),
  ]);

  const referenceOptions = reference.files
    .filter((file) => ['png', 'jpg', 'jpeg', 'webp'].includes(file.fileType.toLowerCase()))
    .slice(0, 50);

  return (
    <MediaSection
      initial={generations}
      providers={providerStatus()}
      referenceOptions={referenceOptions}
    />
  );
}
