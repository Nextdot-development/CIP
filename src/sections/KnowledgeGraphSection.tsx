'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ComponentType } from 'react';
import dynamic from 'next/dynamic';
import { Icon } from '@/components/ui/Icon';
import type { IconName } from '@/components/ui/Icon';
import { useToast } from '@/context/toast';
import type {
  GraphEdgeDTO,
  GraphNodeDTO,
  GraphNodeType,
  GraphSource,
  KnowledgeGraphDTO,
} from '@/types/graph';

/**
 * The knowledge graph.
 *
 * A force-directed view of what this company actually knows: its folders, its
 * files from every source, and — once a file is opened — the passages inside
 * it and whatever else in the company resembles them.
 *
 * The graph starts deliberately small. Folders and files only, because a few
 * hundred documents is tens of thousands of passages and a view that opens as
 * a cloud is worse than one that opens legible. Everything past that is
 * fetched when somebody asks for it.
 *
 * Nothing here filters by company: the endpoint only ever answers for the
 * session's own, so there is no company for this component to get wrong.
 */

/** react-force-graph mutates these in place with x/y/vx/vy as it simulates. */
type SimNode = GraphNodeDTO & { x?: number; y?: number; fx?: number; fy?: number };
type SimLink = { source: string | SimNode; target: string | SimNode; kind: string; score?: number };

/** What the canvas can be told to do from here. */
type GraphHandle = {
  zoomToFit: (ms?: number, padding?: number) => void;
  zoom: (level?: number, ms?: number) => number | void;
  centerAt: (x?: number, y?: number, ms?: number) => void;
  d3ReheatSimulation: () => void;
  /** The underlying d3 forces, so the layout can be spread out to taste. */
  d3Force: (name: string) => { strength?: (v: number) => unknown; distance?: (v: number) => unknown } | undefined;
};

/**
 * The slice of the renderer's surface this view actually uses.
 *
 * Spelled out rather than borrowed from the library, whose props are generic
 * over the node type and lose that generic through next/dynamic. Declaring it
 * here keeps the callbacks typed as our own nodes instead of `any`, and makes
 * the dependency on someone else's component an explicit, small one.
 */
type ForceGraphProps = {
  ref?: React.Ref<GraphHandle>;
  graphData: { nodes: SimNode[]; links: SimLink[] };
  width?: number;
  height?: number;
  backgroundColor?: string;
  cooldownTicks?: number;
  d3VelocityDecay?: number;
  nodeRelSize?: number;
  onNodeClick?: (node: SimNode) => void;
  onNodeHover?: (node: SimNode | null) => void;
  onBackgroundClick?: () => void;
  onNodeDragEnd?: (node: SimNode) => void;
  linkColor?: (link: SimLink) => string;
  linkWidth?: (link: SimLink) => number;
  linkDirectionalParticles?: (link: SimLink) => number;
  linkDirectionalParticleWidth?: number;
  onEngineStop?: () => void;
  nodeCanvasObject?: (node: SimNode, ctx: CanvasRenderingContext2D, scale: number) => void;
  nodePointerAreaPaint?: (node: SimNode, color: string, ctx: CanvasRenderingContext2D) => void;
};

// The renderer touches window on import, so it cannot be server-rendered.
const ForceGraph2D = dynamic(() => import('react-force-graph-2d'), {
  ssr: false,
  loading: () => <div className="graph-loading">Laying out your knowledge…</div>,
}) as unknown as ComponentType<ForceGraphProps>;

const TYPE_COLOR: Record<GraphNodeType, string> = {
  // A brand is the only kind of node that is not a place a file lives, so it
  // is the only warm one. Everything structural stays on the cool side.
  brand: '#f9a8d4',
  // A hub is what brands have in common rather than a brand itself, so it is
  // the same warm family and a shade apart from it.
  trait: '#fdba74',
  source: '#c4b5fd',
  folder: '#7dd3fc',
  file: '#86efac',
  chunk: '#fcd34d',
};

/**
 * A hub's colour is the kind of thing it is.
 *
 * This is what makes the portfolio readable at a glance rather than after
 * clicking twelve nodes: every spirit is one colour, every flavour another.
 * The tail - words two brands happened to share that CIP cannot name a kind
 * for - is deliberately grey, so the taxonomy reads first and the incidental
 * stuff recedes instead of competing with it.
 */
const DIMENSION_COLOR: Record<string, string> = {
  country:  '#7dd3fc',
  category: '#fdba74',
  flavour:  '#86efac',
  tier:     '#c4b5fd',
};
const UNNAMED_HUB = '#8a94a6';

function colorFor(node: SimNode): string {
  if (node.type !== 'trait') return TYPE_COLOR[node.type];
  return DIMENSION_COLOR[node.dimension ?? ''] ?? UNNAMED_HUB;
}

const TYPE_ICON: Record<GraphNodeType, IconName> = {
  brand: 'sparkle',
  trait: 'link',
  source: 'box',
  folder: 'folder',
  file: 'doc',
  chunk: 'book',
};

export function KnowledgeGraphSection({ initial }: { initial: KnowledgeGraphDTO }) {
  const { note } = useToast();
  const graphRef = useRef<GraphHandle | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);

  const [nodes, setNodes] = useState<SimNode[]>(() => initial.nodes as SimNode[]);
  const [edges, setEdges] = useState<GraphEdgeDTO[]>(initial.edges);
  const [stats, setStats] = useState(initial.stats);
  const [empty] = useState(initial.empty);

  const [selected, setSelected] = useState<SimNode | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [matches, setMatches] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const [query, setQuery] = useState('');
  const [sourceFilter, setSourceFilter] = useState<GraphSource | 'all'>('all');
  const [typeFilter, setTypeFilter] = useState<GraphNodeType | 'all'>('all');
  /**
   * Which links are drawn.
   *
   * Starts on the hubs rather than on everything. The hubs and the
   * brand-to-brand lines say the same thing twice - one as groups, one as
   * pairs - and showing both at once doubles the edges for no extra meaning.
   * Either is a click away.
   */
  const [edgeFilter, setEdgeFilter] =
    useState<'all' | 'contains' | 'related' | 'resembles' | 'shares'>('shares');
  /**
   * Which of the two graphs is on screen.
   *
   * There are two, and drawing them at once was the problem. "Where does this
   * file live" is a tree of sources, folders and documents; "what does CIP
   * know about" is brands and what they have in common. Together they came to
   * nearly two hundred nodes and three hundred and fifty edges, which is not
   * a graph anybody can read.
   */
  const [view, setView] = useState<'brands' | 'files' | 'all'>('brands');
  const [busy, setBusy] = useState(false);
  const [size, setSize] = useState({ width: 800, height: 600 });

  const hasFitted = useRef(false);

  /**
   * Pushes the nodes apart.
   *
   * The defaults are tuned for hundreds of nodes; a dozen of them collapse into
   * a knot in the middle of the canvas with every label on top of every other.
   * A stronger repulsion and a longer link give the graph room to breathe.
   */
  useEffect(() => {
    const handle = graphRef.current;
    if (!handle?.d3Force) return;

    // The portfolio is a few dozen nodes and every one of them carries a
    // label, so it needs far more room than a cloud of unlabelled dots. The
    // file tree is hundreds of nodes and the same spacing would fling them
    // off the canvas.
    const roomy = view === 'brands';
    handle.d3Force('charge')?.strength?.(roomy ? -900 : -420);
    handle.d3Force('link')?.distance?.(roomy ? 150 : 90);
    handle.d3ReheatSimulation();
  }, [nodes.length, view]);

  // The canvas is sized from its container rather than the viewport, so the
  // sidebar and any future chrome are accounted for automatically.
  useEffect(() => {
    const element = shellRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const fetchGraph = useCallback(
    async (params: Record<string, string>) => {
      const search = new URLSearchParams(params);
      const res = await fetch(`/api/knowledge-graph?${search}`, { cache: 'no-store' });
      if (!res.ok) {
        note('The knowledge graph could not be loaded.');
        return null;
      }
      return (await res.json()) as KnowledgeGraphDTO;
    },
    [note],
  );

  /**
   * Merges a fetched fragment into what is already drawn.
   *
   * Existing node objects are kept rather than replaced, because the simulation
   * stores each node's position on the object itself — swapping them would
   * throw the whole layout back to the middle on every expansion.
   */
  const merge = useCallback((incoming: KnowledgeGraphDTO) => {
    setNodes((current) => {
      const byId = new Map(current.map((n) => [n.id, n]));
      for (const node of incoming.nodes) {
        const existing = byId.get(node.id);
        if (existing) Object.assign(existing, node);
        else byId.set(node.id, node as SimNode);
      }
      return [...byId.values()];
    });

    setEdges((current) => {
      const seen = new Set(current.map(edgeKey));
      const added = incoming.edges.filter((e) => !seen.has(edgeKey(e)));
      return added.length > 0 ? [...current, ...added] : current;
    });
  }, []);

  const reload = useCallback(
    async (overrides: Record<string, string> = {}) => {
      setBusy(true);
      try {
        const graph = await fetchGraph({
          view,
          ...(sourceFilter !== 'all' ? { source: sourceFilter } : {}),
          ...(typeFilter !== 'all' ? { type: typeFilter } : {}),
          ...overrides,
        });
        if (!graph) return;
        setNodes(graph.nodes as SimNode[]);
        setEdges(graph.edges);
        setStats(graph.stats);
        setExpanded(new Set());
        setSelected(null);
        setMatches(new Set(graph.matches));
        hasFitted.current = false;
      } finally {
        setBusy(false);
      }
    },
    [fetchGraph, sourceFilter, typeFilter, view],
  );

  const expand = useCallback(
    async (node: SimNode) => {
      if (expanded.has(node.id)) return;
      setBusy(true);
      try {
        const graph = await fetchGraph({ nodeId: node.id });
        if (!graph) return;
        if (graph.nodes.length === 0) {
          note('Nothing more to show for that one.');
          setExpanded((s) => new Set(s).add(node.id));
          return;
        }
        // New nodes start where their parent is, so they fly outwards from it
        // instead of appearing from the corner of the canvas.
        for (const incoming of graph.nodes as SimNode[]) {
          if (incoming.x === undefined && node.x !== undefined) {
            incoming.x = node.x + (Math.random() - 0.5) * 40;
            incoming.y = (node.y ?? 0) + (Math.random() - 0.5) * 40;
          }
        }
        merge(graph);
        setExpanded((s) => new Set(s).add(node.id));
        // Let the view frame itself again once the new nodes have settled.
        // Without this the graph can spread straight past the edge of the
        // canvas and leave somebody looking at empty space.
        hasFitted.current = false;
        graphRef.current?.d3ReheatSimulation();
      } finally {
        setBusy(false);
      }
    },
    [expanded, fetchGraph, merge, note],
  );

  /** Removes everything this node brought in, but never the node itself. */
  const collapse = useCallback(
    (node: SimNode) => {
      const children = new Set(
        (edges as unknown as SimLink[])
          .filter((e) => endId(e.source) === node.id && e.kind === 'contains')
          .map((e) => endId(e.target)),
      );
      if (children.size === 0) return;

      setNodes((current) => current.filter((n) => !children.has(n.id)));
      setEdges((current) =>
        (current as unknown as SimLink[]).filter(
          (e) => !children.has(endId(e.source)) && !children.has(endId(e.target)),
        ) as unknown as GraphEdgeDTO[],
      );
      setExpanded((s) => {
        const next = new Set(s);
        next.delete(node.id);
        return next;
      });
    },
    [edges],
  );

  const runSearch = useCallback(async () => {
    const term = query.trim();
    if (term.length === 0) {
      setMatches(new Set());
      return;
    }
    setBusy(true);
    try {
      const graph = await fetchGraph({ search: term });
      if (!graph) return;
      const found = new Set(graph.matches);
      setMatches(found);

      if (found.size === 0) {
        note(`Nothing in your knowledge mentions “${term}”.`);
        return;
      }
      // Centre on the first match that is actually on screen; anything else is
      // inside a file nobody has opened yet.
      const target = nodes.find((n) => found.has(n.id));
      if (target?.x !== undefined) {
        graphRef.current?.centerAt(target.x, target.y, 700);
        setSelected(target);
      } else {
        note(`${found.size} match(es) — expand a file to see them.`);
      }
    } finally {
      setBusy(false);
    }
  }, [fetchGraph, nodes, note, query]);

  // Which nodes sit next to the selected one, for highlighting.
  const neighbours = useMemo(() => {
    if (!selected) return new Set<string>();
    const near = new Set<string>([selected.id]);
    for (const edge of edges as unknown as SimLink[]) {
      const source = endId(edge.source);
      const target = endId(edge.target);
      if (source === selected.id) near.add(target);
      if (target === selected.id) near.add(source);
    }
    return near;
  }, [edges, selected]);

  /**
   * The brands the selected one is most like, closest first.
   *
   * Read off the edges already drawn rather than fetched: the reason is
   * carried on the edge precisely so that showing it costs nothing.
   */
  const resemblances = useMemo(() => {
    if (!selected || selected.type !== 'brand') return [];
    const endId = (end: string | { id: string }): string =>
      typeof end === 'string' ? end : end.id;

    return edges
      .filter((e) => e.kind === 'resembles')
      .filter((e) => endId(e.source) === selected.id || endId(e.target) === selected.id)
      .map((e) => ({
        other: (endId(e.source) === selected.id ? endId(e.target) : endId(e.source)).replace(/^brand:/, ''),
        score: e.score ?? 0,
        shared: e.shared ?? [],
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
  }, [edges, selected]);

  /**
   * The brands hanging off the selected hub.
   *
   * Read from the edges rather than fetched, for the same reason the
   * resemblances are: they are already on the page.
   */
  const onThisHub = useMemo(() => {
    if (!selected || selected.type !== 'trait') return [];
    const endId = (end: string | { id: string }): string =>
      typeof end === 'string' ? end : end.id;

    return edges
      .filter((e) => e.kind === 'shares' && endId(e.target) === selected.id)
      .map((e) => endId(e.source).replace(/^brand:/, ''))
      .sort();
  }, [edges, selected]);

  const visibleEdges = useMemo(
    () => (edgeFilter === 'all' ? edges : edges.filter((e) => e.kind === edgeFilter)),
    [edgeFilter, edges],
  );

  const graphData = useMemo(
    () => ({ nodes, links: visibleEdges as unknown as SimLink[] }),
    [nodes, visibleEdges],
  );

  const liveStats = useMemo(
    () => ({ ...stats, nodes: nodes.length, edges: visibleEdges.length }),
    [nodes.length, stats, visibleEdges.length],
  );

  if (empty) {
    return (
      <div className="graph-empty">
        <Icon name="grid" size={30} />
        <h2>Your knowledge graph is empty.</h2>
        <p>
          Upload documents to CIP Drive or connect Google Drive to start building your knowledge
          graph.
        </p>
        <div className="row-gap">
          <a className="btn btn-primary" href="/teach">Teach CIP</a>
          <a className="btn" href="/teach">Connect Google Drive</a>
        </div>
      </div>
    );
  }

  return (
    <div className="graph-page">
      <div className="graph-toolbar">
        <div className="graph-search">
          <Icon name="search" size={15} />
          <input
            value={query}
            placeholder="Search your knowledge…"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void runSearch();
              if (e.key === 'Escape') { setQuery(''); setMatches(new Set()); }
            }}
          />
          {matches.size > 0 && <span className="graph-hits">{matches.size}</span>}
        </div>

        {/* Which graph. First control on the bar, because it decides what
            every other control here even applies to. */}
        <div className="graph-views" role="group" aria-label="What to show">
          {([
            ['brands', 'Brands'],
            ['files', 'Files'],
            ['all', 'Everything'],
          ] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={view === value ? 'is-on' : ''}
              aria-pressed={view === value}
              disabled={busy}
              onClick={() => {
                if (view === value) return;
                setView(value);
                // The filters below belong to the other graph and mean nothing
                // here, so they go back to showing everything rather than
                // silently hiding half of what was just asked for.
                setSourceFilter('all');
                setTypeFilter('all');
                // Each view has a sensible thing to lead with: groups in the
                // portfolio, structure in the files.
                setEdgeFilter(value === 'files' ? 'contains' : 'shares');
                void reload({ view: value });
              }}
            >
              {label}
            </button>
          ))}
        </div>

        {view !== 'brands' && (
          <select value={sourceFilter} onChange={(e) => {
            const value = e.target.value as GraphSource | 'all';
            setSourceFilter(value);
            void reload({ ...(value !== 'all' ? { source: value } : {}) });
          }}>
            <option value="all">All sources</option>
            <option value="cip_drive">CIP Drive</option>
            <option value="google_drive">Google Drive</option>
          </select>
        )}

        {view !== 'brands' && (
          <select value={typeFilter} onChange={(e) => {
            const value = e.target.value as GraphNodeType | 'all';
            setTypeFilter(value);
            void reload({ ...(value !== 'all' ? { type: value } : {}) });
          }}>
            <option value="all">All types</option>
            <option value="brand">Brands</option>
            <option value="trait">What they share</option>
            <option value="folder">Folders</option>
            <option value="file">Files</option>
            <option value="chunk">Passages</option>
          </select>
        )}

        <select value={edgeFilter} onChange={(e) => setEdgeFilter(e.target.value as typeof edgeFilter)}>
          <option value="all">All links</option>
          {view !== 'files' && <option value="shares">Grouped by what they are</option>}
          {view !== 'files' && <option value="resembles">Brand to brand</option>}
          {view !== 'brands' && <option value="contains">Contains</option>}
          {view !== 'brands' && <option value="related">Related passages</option>}
        </select>

        <div className="graph-zoom">
          <button type="button" title="Zoom in" onClick={() => graphRef.current?.zoom((graphRef.current.zoom() as number) * 1.4, 250)}>+</button>
          <button type="button" title="Zoom out" onClick={() => graphRef.current?.zoom((graphRef.current.zoom() as number) / 1.4, 250)}>−</button>
          <button type="button" onClick={() => graphRef.current?.zoomToFit(600, 60)}>Fit</button>
          <button type="button" onClick={() => void reload()}>Reset</button>
        </div>
      </div>

      <div className="graph-body">
        <div className="graph-canvas" ref={shellRef}>
          <ForceGraph2D
            ref={graphRef}
            graphData={graphData}
            width={size.width}
            height={size.height}
            backgroundColor="#0d1017"
            cooldownTicks={120}
            onEngineStop={() => {
              if (hasFitted.current) return;
              hasFitted.current = true;
              graphRef.current?.zoomToFit(500, 70);
            }}
            d3VelocityDecay={0.28}
            nodeRelSize={5}
            onNodeClick={(node) => setSelected(node)}
            onNodeHover={(node) => setHovered(node?.id ?? null)}
            onBackgroundClick={() => setSelected(null)}
            onNodeDragEnd={(node) => {
              // Pin where it was dropped. Obsidian does the same, and a node
              // that springs back the moment you let go feels broken.
              node.fx = node.x;
              node.fy = node.y;
            }}
            linkColor={(edge) => {
              const dim = selected !== null && !touches(edge, neighbours);
              if (edge.kind === 'shares') {
                return dim ? 'rgba(253,186,116,0.06)' : 'rgba(253,186,116,0.38)';
              }
              if (edge.kind === 'resembles') {
                // Stronger resemblance draws stronger, so the shape of the
                // portfolio is readable without clicking anything.
                const strength = Math.min(1, Math.max(0.25, edge.score ?? 0.3));
                return dim ? 'rgba(249,168,212,0.08)' : `rgba(249,168,212,${strength})`;
              }
              if (edge.kind === 'related') return dim ? 'rgba(252,211,77,0.07)' : 'rgba(252,211,77,0.45)';
              return dim ? 'rgba(148,163,184,0.07)' : 'rgba(148,163,184,0.35)';
            }}
            linkWidth={(edge) =>
              edge.kind === 'resembles' ? 1.2 + 2.4 * (edge.score ?? 0) : edge.kind === 'related' ? 1.6 : 1
            }
            linkDirectionalParticles={(edge) =>
              selected !== null && touches(edge, neighbours) ? 2 : 0
            }
            linkDirectionalParticleWidth={2}
            nodeCanvasObject={(node, ctx, scale) => {
              drawNode(node, ctx, scale, {
                selectedId: selected?.id ?? null,
                hoveredId: hovered,
                neighbours,
                matches,
                expanded,
              });
            }}
            nodePointerAreaPaint={(node, color, ctx) => {
              ctx.fillStyle = color;
              ctx.beginPath();
              ctx.arc(node.x ?? 0, node.y ?? 0, radiusFor(node) + 4, 0, 2 * Math.PI);
              ctx.fill();
            }}
          />

          {/* What is on screen, counted in the words of whichever graph this
              is. Folder and passage counts under the portfolio told somebody
              about a picture they were not looking at. */}
          <div className="graph-stats">
            {view === 'brands' ? (
              <>
                <b>{nodes.filter((n) => n.type === 'brand').length}</b> Brands
                <b>{nodes.filter((n) => n.type === 'trait').length}</b> Things in common
                <b>{liveStats.edges}</b> Connections
                <b>{liveStats.files}</b> Files read
              </>
            ) : (
              <>
                <b>{liveStats.nodes}</b> Nodes
                <b>{liveStats.edges}</b> Connections
                <b>{liveStats.files}</b> Files
                <b>{liveStats.folders}</b> Folders
                <b>{liveStats.chunks}</b> Passages
              </>
            )}
          </div>

          {/* The legend names what is on screen, not the full vocabulary.
              Listing folders and passages under the portfolio was a legend
              for a different picture. */}
          <div className="graph-legend">
            {view === 'brands'
              ? (
                <>
                  <span><i style={{ background: TYPE_COLOR.brand }} />brand</span>
                  {(['category', 'flavour', 'tier', 'country'] as const)
                    .filter((d) => nodes.some((n) => n.type === 'trait' && n.dimension === d))
                    .map((d) => (
                      <span key={d}><i style={{ background: DIMENSION_COLOR[d] }} />{d}</span>
                    ))}
                  {nodes.some((n) => n.type === 'trait' && !n.dimension) && (
                    <span><i style={{ background: UNNAMED_HUB }} />also shared</span>
                  )}
                </>
              )
              : (['source', 'folder', 'file', 'chunk'] as GraphNodeType[]).map((type) => (
                <span key={type}>
                  <i style={{ background: TYPE_COLOR[type] }} />
                  {type === 'chunk' ? 'passage' : type}
                </span>
              ))}
          </div>

          {busy && <div className="graph-busy">Working…</div>}
        </div>

        {selected && (
          <aside className="graph-inspector">
            <div className="row-between">
              <span className="insp-kind">
                <Icon name={TYPE_ICON[selected.type]} size={14} />
                {selected.type === 'chunk' ? 'Passage' : selected.type === 'trait' ? (selected.dimension ?? 'Shared') : selected.type}
              </span>
              <button type="button" className="insp-close" onClick={() => setSelected(null)}>
                <Icon name="close" size={14} />
              </button>
            </div>

            <h3>{selected.label}</h3>

            <dl className="insp-facts">
              {selected.fileType && (
                <div><dt>Type</dt><dd>{selected.fileType.toUpperCase()}</dd></div>
              )}
              {selected.source && (
                <div>
                  <dt>Source</dt>
                  <dd>{selected.source === 'google_drive' ? 'Google Drive' : 'CIP Drive'}</dd>
                </div>
              )}
              {selected.processingStatus && (
                <div><dt>Processing</dt><dd>{selected.processingStatus}</dd></div>
              )}
              {selected.chunkCount !== undefined && (
                <div><dt>Passages</dt><dd>{selected.chunkCount}</dd></div>
              )}
              {selected.ordinal !== undefined && (
                <div><dt>Position</dt><dd>#{selected.ordinal + 1}</dd></div>
              )}
              <div>
                <dt>Connections</dt>
                <dd>{neighbours.size > 0 ? neighbours.size - 1 : 0}</dd>
              </div>
            </dl>

            {selected.snippet && <p className="insp-snippet">{selected.snippet}…</p>}

            {/* Why this brand is joined to the others. A line drawn between
                two brands is a claim, and a claim nobody can check is worse
                than no claim — so the words both were described with are
                listed rather than the number behind them. */}
            {selected.type === 'trait' && onThisHub.length > 0 && (
              <div className="insp-resemblance">
                <p className="insp-label">
                  {selected.dimension
                    ? `${selected.dimension} · ${onThisHub.length} brands`
                    : `${onThisHub.length} brands share this`}
                </p>
                <div className="insp-hub-brands">
                  {onThisHub.map((name) => (
                    <span key={name} className="insp-chip">{name}</span>
                  ))}
                </div>
              </div>
            )}

            {selected.type === 'brand' && resemblances.length > 0 && (
              <div className="insp-resemblance">
                <p className="insp-label">Most like</p>
                {resemblances.map((r) => (
                  <div key={r.other} className="insp-resembles">
                    <span className="strong">{r.other}</span>
                    <span className="muted"> · both: {r.shared.join(', ')}</span>
                  </div>
                ))}
              </div>
            )}

            <div className="insp-actions">
              {selected.expandable && !expanded.has(selected.id) && (
                <button type="button" className="btn btn-primary btn-sm" disabled={busy}
                  onClick={() => void expand(selected)}>
                  Expand knowledge
                </button>
              )}
              {expanded.has(selected.id) && (
                <button type="button" className="btn btn-sm" onClick={() => collapse(selected)}>
                  Collapse
                </button>
              )}
              {selected.type === 'file' && (
                <>
                  <a className="btn btn-sm" href={`/api/drive/files/${selected.id}/content`} download>
                    Open file
                  </a>
                  <a className="btn btn-sm" href={`/api/drive/files/${selected.id}/extraction`}>
                    View extraction
                  </a>
                </>
              )}
              {selected.type === 'chunk' && selected.fileId && (
                <button type="button" className="btn btn-sm"
                  onClick={() => {
                    const file = nodes.find((n) => n.id === selected.fileId);
                    if (file) { setSelected(file); if (file.x !== undefined) graphRef.current?.centerAt(file.x, file.y, 500); }
                    else note('That passage came from a file that is not on the canvas yet.');
                  }}>
                  Open source
                </button>
              )}
              {selected.type === 'folder' && (
                <a className="btn btn-sm" href={`/drive?folder=${selected.id}`}>Open in Drive</a>
              )}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}

/** How big a node draws. Weight comes from the server, from real counts. */
function radiusFor(node: SimNode): number {
  return Math.min(3 + Math.sqrt(node.weight) * 1.9, 13);
}

function edgeKey(edge: GraphEdgeDTO): string {
  const ends = [endId(edge.source as string | { id: string }), endId(edge.target as string | { id: string })];
  return `${edge.kind}:${ends.sort().join('|')}`;
}

/**
 * The id at one end of an edge.
 *
 * The simulation rewrites `source` and `target` in place, replacing the id it
 * was given with the node object itself. Anything comparing them to an id has
 * to cope with both, or it works until the first tick and then silently stops
 * matching anything — which is what made the inspector report every node as
 * having no connections.
 */
function endId(end: string | { id: string }): string {
  return typeof end === 'string' ? end : end.id;
}

function touches(link: SimLink, ids: Set<string>): boolean {
  return ids.has(endId(link.source)) && ids.has(endId(link.target));
}

/**
 * Draws one node.
 *
 * Selection dims everything that is not adjacent, which is what makes a dense
 * graph readable: the alternative is a wall of equally-bright dots where the
 * thing you clicked is indistinguishable from the rest.
 */
function drawNode(
  node: SimNode,
  ctx: CanvasRenderingContext2D,
  scale: number,
  state: {
    selectedId: string | null;
    hoveredId: string | null;
    neighbours: Set<string>;
    matches: Set<string>;
    expanded: Set<string>;
  },
): void {
  const x = node.x ?? 0;
  const y = node.y ?? 0;
  const radius = radiusFor(node);

  const isSelected = state.selectedId === node.id;
  const isNear = state.selectedId === null || state.neighbours.has(node.id);
  const isMatch = state.matches.has(node.id);
  const dimmed = !isNear && !isMatch;

  ctx.globalAlpha = dimmed ? 0.18 : 1;

  // A search hit gets a halo so it can be found without reading every label.
  if (isMatch) {
    ctx.beginPath();
    ctx.arc(x, y, radius + 6, 0, 2 * Math.PI);
    ctx.fillStyle = 'rgba(250, 204, 21, 0.18)';
    ctx.fill();
  }

  if (isSelected || state.hoveredId === node.id) {
    ctx.beginPath();
    ctx.arc(x, y, radius + 4, 0, 2 * Math.PI);
    ctx.fillStyle = 'rgba(255,255,255,0.14)';
    ctx.fill();
  }

  ctx.beginPath();
  ctx.arc(x, y, radius, 0, 2 * Math.PI);
  ctx.fillStyle = colorFor(node);
  ctx.fill();

  if (isSelected) {
    ctx.lineWidth = 2 / scale;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
  }

  // A ring marks something with more inside it that has not been opened.
  if (node.expandable && !state.expanded.has(node.id)) {
    ctx.beginPath();
    ctx.arc(x, y, radius + 2.5, 0, 2 * Math.PI);
    ctx.lineWidth = 1 / scale;
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.stroke();
  }

  // Labels only once there is room for them, and always for what is selected.
  // Labels are drawn when there is room for them. Passages are the numerous
  // kind, so they stay quiet until somebody zooms in or picks one.
  // A brand and a hub are always named. There are a few dozen of them and
  // reading your own brands the moment the page opens is the entire point -
  // a constellation of unlabelled dots proves nothing about what CIP knows.
  // Files and passages are the numerous kind and stay quiet until zoomed to.
  const showLabel =
    isSelected ||
    node.type === 'brand' ||
    node.type === 'trait' ||
    node.type === 'source' ||
    node.type === 'folder' ||
    (node.type === 'file' && scale > 0.9) ||
    scale > 2;

  if (showLabel && !dimmed) {
    const emphasis = node.type === 'brand' || (node.type === 'trait' && node.dimension);
    const size = Math.max((emphasis ? 11 : 10) / scale, 2.2);
    ctx.font = `${emphasis ? 600 : 400} ${size}px Inter, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    const label = node.label.length > 30 ? `${node.label.slice(0, 29)}…` : node.label;

    // A dark halo behind the text, so a label crossing an edge or another
    // node stays readable instead of dissolving into it.
    ctx.lineWidth = 3 / scale;
    ctx.strokeStyle = 'rgba(8, 11, 16, 0.85)';
    ctx.lineJoin = 'round';
    ctx.strokeText(label, x, y + radius + 3);

    ctx.fillStyle = isSelected
      ? '#ffffff'
      : emphasis
        ? 'rgba(241,245,249,0.95)'
        : 'rgba(203,213,225,0.72)';
    ctx.fillText(label, x, y + radius + 3);
  }

  ctx.globalAlpha = 1;
}
