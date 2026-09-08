import { requireSession } from '@/server/auth/guards';
import { knowledgeOverview } from '@/server/brain/overview';
import { HomeDashboard } from '@/sections/HomeDashboard';

export const dynamic = 'force-dynamic';

/**
 * Counted on the server so the page arrives with real figures. Loaded for the
 * session's own company: there is no company parameter to pass and none to
 * forget.
 */
export default async function HomePage() {
  const session = await requireSession();
  return <HomeDashboard overview={await knowledgeOverview(session.scope)} />;
}
