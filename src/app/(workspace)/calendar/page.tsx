import { requireSession } from '@/server/auth/guards';
import { allOccasions } from '@/server/brain/calendar';
import { activeBrand } from '@/server/brain/activeBrand';
import { CalendarSection } from '@/sections/CalendarSection';

export const metadata = { title: 'Social Calendar — CIP' };
export const dynamic = 'force-dynamic';

/**
 * The Social Calendar: what is coming in each market, and the days to publish
 * nothing at all.
 *
 * Loaded from the company's own calendar - the markets it imported and the
 * occasions it added - for the brand chosen in the sidebar. An occasion with
 * no brand belongs to every brand, exactly as a fact with no brand does.
 */
/**
 * The dates the page covers. Looks back far enough to catch a season that
 * started a while ago and is still running, because allOccasions filters on
 * the start date.
 */
function calendarWindow(): { today: string; from: string; to: string } {
  const now = Date.now();
  const day = (offset: number) => new Date(now + offset * 86_400_000).toISOString().slice(0, 10);
  return { today: day(0), from: day(-120), to: day(400) };
}

export default async function CalendarPage() {
  const session = await requireSession();
  const scope = session.scope;
  const { today, from, to } = calendarWindow();

  const [{ active }, occasions] = await Promise.all([
    activeBrand(scope),
    allOccasions(scope, { from, to }),
  ]);

  const relevant = occasions.filter(
    (occasion) => occasion.endsOn >= today && (!active || !occasion.brand || occasion.brand === active),
  );

  return <CalendarSection occasions={relevant} brand={active} today={today} />;
}
