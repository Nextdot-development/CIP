import { requireSession } from '@/server/auth/guards';
import { knowledgeGraph } from '@/server/knowledge/graph';
import { KnowledgeGraphSection } from '@/sections/KnowledgeGraphSection';

export const metadata = { title: 'Knowledge Graph — CIP' };
export const dynamic = 'force-dynamic';

/**
 * The first view is rendered on the server so the graph is already there when
 * the page paints. Loaded for the session's own company: there is no company
 * parameter to pass and none to forget.
 */
export default async function KnowledgeGraphPage() {
  const session = await requireSession();
  const graph = await knowledgeGraph(session.scope);

  return <KnowledgeGraphSection initial={graph} />;
}
