import { requireSessionOr401 } from '@/server/auth/guards';
import { noStore } from '@/server/drive/http';
import { knowledgeGraph } from '@/server/knowledge/graph';
import type { GraphNodeType, GraphSource } from '@/server/knowledge/graph';

/**
 * GET /api/knowledge-graph
 *
 * The company's own knowledge as nodes and edges. There is no company
 * parameter — the scope comes from the session, and row-level security turns
 * it into the filter, so a company id in a query string has nowhere to go.
 *
 * Bounded by default and expanded a node at a time, so opening the page never
 * ships the whole company to the browser.
 */
export const dynamic = 'force-dynamic';

const NODE_TYPES = ['source', 'folder', 'file', 'chunk'] as const;
const SOURCES = ['cip_drive', 'google_drive'] as const;

export async function GET(request: Request) {
  const auth = await requireSessionOr401();
  if (!auth.ok) return auth.response;

  const params = new URL(request.url).searchParams;

  // Only these six are read. Anything else in the query string is ignored.
  const typeParam = params.get('type');
  const sourceParam = params.get('source');
  const limitParam = Number(params.get('limit'));
  const depthParam = Number(params.get('depth'));

  try {
    const graph = await knowledgeGraph(auth.session.scope, {
      nodeId: params.get('nodeId'),
      depth: Number.isFinite(depthParam) && depthParam > 0 ? depthParam : 1,
      search: params.get('search'),
      source: (SOURCES as readonly string[]).includes(sourceParam ?? '')
        ? (sourceParam as GraphSource)
        : 'all',
      type: (NODE_TYPES as readonly string[]).includes(typeParam ?? '')
        ? (typeParam as GraphNodeType)
        : 'all',
      limit: Number.isFinite(limitParam) && limitParam > 0 ? limitParam : undefined,
    });

    return Response.json(graph, { headers: noStore });
  } catch (error) {
    // Never echo the error: it can carry document text.
    console.error('[knowledge-graph] a request failed');
    void error;
    return Response.json(
      { error: 'graph_error', message: 'The knowledge graph is unavailable right now.' },
      { status: 500, headers: noStore },
    );
  }
}
