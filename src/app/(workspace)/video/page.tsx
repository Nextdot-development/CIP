import { requireSession } from '@/server/auth/guards';
import { VideoStudioSection } from '@/sections/VideoStudioSection';

export const metadata = { title: 'Video Studio — CIP' };
export const dynamic = 'force-dynamic';

/**
 * Video Studio: a doctor's recording into a finished film in the house
 * template. Everything is loaded on the page; it only has to know who is here.
 */
export default async function VideoPage() {
  await requireSession();
  return <VideoStudioSection />;
}
