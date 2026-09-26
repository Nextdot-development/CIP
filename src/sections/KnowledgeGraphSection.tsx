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
type SimNode = GraphNodeDTO & {
  x?: number; y?: number; vx?: number; vy?: number; fx?: number; fy?: number;
};
type SimLink = { source: string | SimNode; target: string | SimNode; kind: string; score?: number };

/** What the canvas can be told to do from here. */
type GraphHandle = {
  zoomToFit: (ms?: number, padding?: number) => void;
  zoom: (level?: number, ms?: number) => number | void;
  centerAt: (x?: number, y?: number, ms?: number) => void;
  d3ReheatSimulation: () => void;
  /**
   * The underlying d3 forces, so the layout can be spread out to taste. Given
   * a force as well, it sets one - which is how collision is added.
   */
  d3Force: (
    name: string,
    force?: ((alpha: number) => void) & { initialize?: (nodes: SimNode[]) => void },
  ) => { strength?: (v: number) => unknown; distance?: (v: number) => unknown } | undefined;
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
  warmupTicks?: number;
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
  linkDirectionalParticleSpeed?: number;
  linkDirectionalParticleColor?: (link: SimLink) => string;
  linkCurvature?: number;
  autoPauseRedraw?: boolean;
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
  brand: '#f5a3cf',
  // A hub is what brands have in common rather than a brand itself, so it is
  // the same warm family and a shade apart from it.
  trait: '#f7b77a',
  source: '#b9a6f7',
  folder: '#7fc8ee',
  file: '#86dfa8',
  chunk: '#f1d27a',
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
  country:  '#7fc8ee',
  category: '#f7b77a',
  flavour:  '#86dfa8',
  tier:     '#b9a6f7',
};
const UNNAMED_HUB = '#6b6e7b';

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
  /**
   * Each brand's logo or bottle, once it has loaded.
   *
   * Loaded by the page rather than drawn from a URL, because a canvas can only
   * draw a picture it already has. A thumbnail, not the original: a badge is a
   * few dozen pixels across and a logo file can be several megabytes.
   */
  const [images, setImages] = useState<Map<string, NodeImage>>(() => new Map());
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
    handle.d3Force('charge')?.strength?.(roomy ? -520 : -260);
    handle.d3Force('link')?.distance?.(roomy ? 110 : 70);
    // Repulsion alone let thirty labelled nodes settle in a knot with every
    // name on top of the next. Collision gives each one room for its name.
    handle.d3Force('collide', collide());
    // And a gentle pull to the middle, so a brand that shares nothing with
    // the others stays on screen instead of dragging the whole view out.
    handle.d3Force('gravity', gravity(size.width / Math.max(1, size.height)));
    handle.d3ReheatSimulation();
  }, [nodes.length, view, size.width, size.height]);

  useEffect(() => {
    const wanted = nodes
      .map((n) => n.imageFileId)
      .filter((id): id is string => Boolean(id) && !images.has(id!));
    if (wanted.length === 0) return;
    let cancelled = false;
    for (const id of new Set(wanted)) {
      const image = new Image();
      image.decoding = 'async';
      image.onload = () => {
        if (cancelled) return;
        setImages((current) => new Map(current).set(id, image));
      };
      // A brand whose picture will not load keeps its initials; nothing to say.
      image.src = `/api/drive/files/${id}/content?disposition=inline&size=320`;
    }
    return () => {
      cancelled = true;
    };
  }, [nodes, images]);

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
   * What is lit: the node under the pointer, or the selection when the
   * pointer is elsewhere. Obsidian lights on hover, and a graph that only
   * answers a click makes you click every node to learn anything.
   */
  const focusId = hovered ?? selected?.id ?? null;
  const lit = useMemo(() => {
    if (!focusId) return new Set<string>();
    const near = new Set<string>([focusId]);
    for (const edge of edges as unknown as SimLink[]) {
      const source = endId(edge.source);
      const target = endId(edge.target);
      if (source === focusId) near.add(target);
      if (target === focusId) near.add(source);
    }
    return near;
  }, [edges, focusId]);
  const focusColor = useMemo(() => {
    const node = focusId ? nodes.find((n) => n.id === focusId) : undefined;
    return node ? colorFor(node) : null;
  }, [focusId, nodes]);

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

  /**
   * What is drawn, with every edge proved to have both its ends on screen.
   *
   * Nodes come back under a limit and edges come back under their own, so a
   * graph can arrive holding an edge to a node the limit cut off. Handed one,
   * the renderer invents the missing end as a bare `{ id }` - no label, no
   * type - and the first thing that reads `node.label.length` throws, which
   * took the whole page down with "Cannot read properties of undefined".
   *
   * An edge with nothing at one end is not drawable anyway, so it is dropped
   * here rather than guessed at further in.
   */
  const graphData = useMemo(() => {
    const present = new Set(nodes.map((n) => n.id));
    const links = (visibleEdges as unknown as SimLink[]).filter(
      (edge) => present.has(endId(edge.source)) && present.has(endId(edge.target)),
    );
    return { nodes, links };
  }, [nodes, visibleEdges]);

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
        <div className={`graph-canvas${hovered ? ' is-pointing' : ''}`} ref={shellRef}>
          <ForceGraph2D
            ref={graphRef}
            graphData={graphData}
            width={size.width}
            height={size.height}
            // Transparent: the backdrop is drawn by CSS, a soft vignette the
            // canvas cannot paint without redrawing it every frame.
            backgroundColor="rgba(0,0,0,0)"
            // Laid out before the first frame, so the graph opens as a shape
            // rather than as an explosion from a single point, then left to
            // settle gently the way Obsidian's does.
            warmupTicks={80}
            cooldownTicks={220}
            onEngineStop={() => {
              if (hasFitted.current) return;
              hasFitted.current = true;
              graphRef.current?.zoomToFit(700, 90);
            }}
            d3VelocityDecay={0.32}
            // Slightly bowed, as a hand would draw them; straight lines
            // between thirty nodes read as a wiring diagram.
            linkCurvature={0.12}
            // The portfolio is a few dozen nodes, so it is cheap to keep
            // painting - which lets the logos appear as they load and the
            // light run along the lines of whatever is being pointed at.
            autoPauseRedraw={view !== 'brands'}
            linkDirectionalParticles={(edge) =>
              focusId !== null && (endId(edge.source) === focusId || endId(edge.target) === focusId) ? 2 : 0
            }
            linkDirectionalParticleWidth={2.4}
            linkDirectionalParticleSpeed={0.006}
            linkDirectionalParticleColor={() => focusColor ?? '#ffffff'}
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
              // Lit: the lines out of whatever is under the pointer take its
              // colour. Everything else sinks almost out of sight.
              if (focusId !== null) {
                const on = endId(edge.source) === focusId || endId(edge.target) === focusId;
                return on && focusColor ? hexWithAlpha(focusColor, 0.85) : 'rgba(200,200,215,0.035)';
              }
              if (edge.kind === 'resembles') {
                // Stronger resemblance draws stronger, so the shape of the
                // portfolio is readable without pointing at anything.
                const strength = Math.min(0.55, Math.max(0.12, (edge.score ?? 0.3) * 0.6));
                return `rgba(245,163,207,${strength})`;
              }
              if (edge.kind === 'related') return 'rgba(241,210,122,0.3)';
              return 'rgba(200,200,215,0.16)';
            }}
            linkWidth={(edge) => {
              const on = focusId !== null && (endId(edge.source) === focusId || endId(edge.target) === focusId);
              if (on) return 1.8;
              return edge.kind === 'resembles' ? 0.6 + 1.4 * (edge.score ?? 0) : 0.7;
            }}
            nodeCanvasObject={(node, ctx, scale) => {
              drawNode(node, ctx, scale, {
                focusId,
                selectedId: selected?.id ?? null,
                lit,
                matches,
                expanded,
                images,
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
                  <span><i style={{ background: TYPE_COLOR.brand, color: TYPE_COLOR.brand }} />brand</span>
                  {(['category', 'flavour', 'tier', 'country'] as const)
                    .filter((d) => nodes.some((n) => n.type === 'trait' && n.dimension === d))
                    .map((d) => (
                      <span key={d}><i style={{ background: DIMENSION_COLOR[d], color: DIMENSION_COLOR[d] }} />{d}</span>
                    ))}
                  {nodes.some((n) => n.type === 'trait' && !n.dimension) && (
                    <span><i style={{ background: UNNAMED_HUB, color: UNNAMED_HUB }} />also shared</span>
                  )}
                </>
              )
              : (['source', 'folder', 'file', 'chunk'] as GraphNodeType[]).map((type) => (
                <span key={type}>
                  <i style={{ background: TYPE_COLOR[type], color: TYPE_COLOR[type] }} />
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

/** A picture that has finished loading, ready to be drawn into a node. */
type NodeImage = CanvasImageSource & { width: number; height: number };

/**
 * How big a node draws. Weight comes from the server, from real counts.
 *
 * A brand is a badge with its logo in it, so it is drawn a good deal larger
 * than a dot has to be: a logo at the size of a dot is not a logo.
 */
function radiusFor(node: SimNode): number {
  if (node.type === 'brand') return Math.min(18 + Math.sqrt(node.weight) * 2.5, 28);
  if (node.type === 'trait' && !node.dimension) return Math.min(2.5 + Math.sqrt(node.weight) * 1.1, 6);
  return Math.min(3 + Math.sqrt(node.weight) * 1.9, 13);
}

/**
 * Room a node needs around it: its dot, and its name for the kinds that are
 * always named. Without this the layout only pushed dots apart, and thirty
 * labels settled on top of one another in a knot in the middle of the canvas.
 */
function roomFor(node: SimNode): number {
  if (node.type === 'brand') return radiusFor(node) + 20;
  const named = node.type === 'trait' && node.dimension;
  return radiusFor(node) + (named ? 16 : 6);
}

/**
 * Keeps nodes from overlapping.
 *
 * A d3 force in the shape react-force-graph expects: called every tick with
 * the simulation's heat, handed the nodes once. Pairwise, which is fine at the
 * size these graphs are - a few dozen brands, a few hundred files - and saves
 * pulling in d3-force for the one function.
 */
function collide(strength = 0.7) {
  let nodes: SimNode[] = [];
  const force = (alpha: number) => {
    for (let i = 0; i < nodes.length; i += 1) {
      const a = nodes[i]!;
      for (let j = i + 1; j < nodes.length; j += 1) {
        const b = nodes[j]!;
        let dx = (b.x ?? 0) - (a.x ?? 0);
        let dy = (b.y ?? 0) - (a.y ?? 0);
        const min = roomFor(a) + roomFor(b);
        let d2 = dx * dx + dy * dy;
        if (d2 >= min * min) continue;
        if (d2 === 0) {
          // Two nodes on the same spot have no direction to part in.
          dx = (Math.random() - 0.5) * 1e-3;
          dy = (Math.random() - 0.5) * 1e-3;
          d2 = dx * dx + dy * dy;
        }
        const d = Math.sqrt(d2);
        const push = ((min - d) / d) * strength * Math.min(1, alpha * 4) * 0.5;
        a.vx = (a.vx ?? 0) - dx * push;
        a.vy = (a.vy ?? 0) - dy * push;
        b.vx = (b.vx ?? 0) + dx * push;
        b.vy = (b.vy ?? 0) + dy * push;
      }
    }
  };
  force.initialize = (given: SimNode[]) => {
    nodes = given;
  };
  return force;
}

/**
 * A gentle pull towards the middle, on every node.
 *
 * Without it a node with no lines - Jaisalmer, which shares no trait with any
 * other brand - is pushed away by every other node and nothing pulls it back.
 * It drifted hundreds of units out, and fitting the view to include it shrank
 * the rest of the portfolio to a knot in one corner. Obsidian has the same
 * force, and calls it exactly that.
 *
 * Pulled harder up and down than side to side, by the shape of the canvas: the
 * graph then settles as wide as the screen it is on rather than as a round
 * clump in the middle of a wide one, and fitting it draws everything larger.
 */
function gravity(aspect = 2, strength = 0.07) {
  let nodes: SimNode[] = [];
  const along = strength / Math.sqrt(Math.max(1, aspect));
  const across = strength * Math.sqrt(Math.max(1, aspect));
  const force = (alpha: number) => {
    for (const node of nodes) {
      node.vx = (node.vx ?? 0) - (node.x ?? 0) * along * alpha;
      node.vy = (node.vy ?? 0) - (node.y ?? 0) * across * alpha;
    }
  };
  force.initialize = (given: SimNode[]) => {
    nodes = given;
  };
  return force;
}

/** 0 below `from`, 1 above `to`, and a straight line between. */
function ramp(value: number, from: number, to: number): number {
  return Math.min(1, Math.max(0, (value - from) / (to - from)));
}

/**
 * How visible a node's name is at this zoom, before any hover.
 *
 * Obsidian's rule, more or less: from far away you see the landmarks, and the
 * rest of the names rise into view as you move in. Brands are the landmarks -
 * reading your own portfolio the moment the page opens is the point - and the
 * numerous kinds wait until there is room for them.
 */
function labelOpacity(node: SimNode, scale: number): number {
  switch (node.type) {
    case 'brand':
      return 1;
    case 'trait':
      // What the brands share is the point of this view, so a named trait is
      // readable from the first frame; the grey tail waits for a closer look.
      return node.dimension ? 0.35 + 0.65 * ramp(scale, 0.5, 1) : ramp(scale, 1.2, 2);
    case 'source':
    case 'folder':
      return ramp(scale, 0.6, 1.1);
    case 'file':
      return ramp(scale, 1.3, 2.1);
    case 'chunk':
      return ramp(scale, 2.2, 3.2);
  }
}

/** Up to two letters for a brand with no picture: "Blue Finest" is "BF". */
function initialsOf(name: string): string {
  const words = name.split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? words[0]![0]! + words[1]![0]! : name.slice(0, 2);
  return letters.toUpperCase();
}

/**
 * A brand, drawn as a badge: its logo or its bottle on a dark plate inside a
 * ring of its colour, glowing. The picture is fitted inside the circle rather
 * than cropped to fill it - a wordmark cropped to a circle loses its ends, and
 * a bottle cropped loses its neck.
 */
function drawBrand(
  node: SimNode,
  ctx: CanvasRenderingContext2D,
  scale: number,
  radius: number,
  color: string,
  glow: number,
  image: NodeImage | undefined,
): void {
  const x = node.x ?? 0;
  const y = node.y ?? 0;

  ctx.shadowColor = color;
  ctx.shadowBlur = glow;
  const plate = ctx.createRadialGradient(x, y - radius * 0.4, radius * 0.1, x, y, radius);
  plate.addColorStop(0, image ? '#2a2733' : hexWithAlpha(color, 0.55));
  plate.addColorStop(1, image ? '#141219' : hexWithAlpha(color, 0.22));
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, 2 * Math.PI);
  ctx.fillStyle = plate;
  ctx.fill();
  ctx.shadowBlur = 0;

  if (image && image.width > 0 && image.height > 0) {
    const inner = radius * 0.78;
    const fit = Math.min((inner * 2) / image.width, (inner * 2) / image.height);
    const w = image.width * fit;
    const h = image.height * fit;
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, radius - 1.2, 0, 2 * Math.PI);
    ctx.clip();
    ctx.drawImage(image, x - w / 2, y - h / 2, w, h);
    ctx.restore();
  } else {
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.font = `700 ${(radius * 0.8).toFixed(2)}px Inter, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(initialsOf(node.label ?? node.id), x, y + radius * 0.04);
  }

  // The ring, in the brand's colour, a fixed width on screen at any zoom.
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, 2 * Math.PI);
  ctx.lineWidth = Math.max(1.6 / scale, radius * 0.1);
  ctx.strokeStyle = color;
  ctx.stroke();
}

/**
 * A trait drawn as a small planet: a soft disc of its colour, a ring, and a
 * bright core. It reads as a different kind of thing from a brand at a glance,
 * which a second size of plain dot never did.
 */
function drawTrait(
  node: SimNode,
  ctx: CanvasRenderingContext2D,
  scale: number,
  radius: number,
  color: string,
  glow: number,
): void {
  const x = node.x ?? 0;
  const y = node.y ?? 0;

  ctx.shadowColor = color;
  ctx.shadowBlur = glow;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, 2 * Math.PI);
  ctx.fillStyle = hexWithAlpha(color, 0.2);
  ctx.fill();
  ctx.shadowBlur = 0;

  ctx.lineWidth = Math.max(1 / scale, radius * 0.14);
  ctx.strokeStyle = hexWithAlpha(color, 0.9);
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(x, y, radius * 0.38, 0, 2 * Math.PI);
  ctx.fillStyle = color;
  ctx.fill();
}

/**
 * Draws one node.
 *
 * Hovering (or, with nothing hovered, the selection) lights a node and its
 * neighbours and sinks everything else, which is what makes a dense graph
 * readable: the alternative is a wall of equally bright dots where the thing
 * you are pointing at is indistinguishable from the rest.
 */
function drawNode(
  node: SimNode,
  ctx: CanvasRenderingContext2D,
  scale: number,
  state: {
    focusId: string | null;
    selectedId: string | null;
    lit: Set<string>;
    matches: Set<string>;
    expanded: Set<string>;
    images: Map<string, NodeImage>;
  },
): void {
  const x = node.x ?? 0;
  const y = node.y ?? 0;
  const color = colorFor(node);

  const focused = state.focusId !== null;
  const isFocus = state.focusId === node.id;
  const isSelected = state.selectedId === node.id;
  const isMatch = state.matches.has(node.id);
  const inLight = !focused || state.lit.has(node.id);
  const radius = radiusFor(node) * (isFocus ? 1.25 : 1);

  ctx.globalAlpha = inLight || isMatch ? 1 : 0.1;

  // A search hit gets a halo so it can be found without reading every label.
  if (isMatch) {
    ctx.beginPath();
    ctx.arc(x, y, radius + 7, 0, 2 * Math.PI);
    ctx.fillStyle = 'rgba(250, 204, 21, 0.16)';
    ctx.fill();
  }

  // Brands always carry a little glow, so the portfolio reads as the lit
  // points it is; whatever is under the pointer carries more.
  const glow = isFocus ? 30 : focused && inLight ? 16 : node.type === 'brand' ? 14 : node.type === 'trait' && node.dimension ? 6 : 0;

  if (node.type === 'brand') {
    drawBrand(node, ctx, scale, radius, color, glow, node.imageFileId ? state.images.get(node.imageFileId) : undefined);
  } else if (node.type === 'trait' && node.dimension) {
    drawTrait(node, ctx, scale, radius, color, glow);
  } else {
    if (glow > 0) {
      ctx.shadowColor = color;
      ctx.shadowBlur = glow;
    }
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, 2 * Math.PI);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  if (isSelected) {
    ctx.beginPath();
    ctx.arc(x, y, radius + 3, 0, 2 * Math.PI);
    ctx.lineWidth = 1.5 / scale;
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.stroke();
  }

  // A ring marks something with more inside it that has not been opened.
  if (node.expandable && node.type !== 'brand' && !state.expanded.has(node.id)) {
    ctx.beginPath();
    ctx.arc(x, y, radius + 2.5, 0, 2 * Math.PI);
    ctx.lineWidth = 1 / scale;
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.stroke();
  }

  // With something lit, exactly its neighbourhood is named and nothing else.
  // Otherwise the zoom decides.
  const opacity = focused ? (inLight ? 1 : 0) : Math.max(labelOpacity(node, scale), isSelected ? 1 : 0);
  if (opacity > 0.02) {
    const emphasis = node.type === 'brand' || isFocus;
    // Text grows as you zoom in, and more slowly than the graph does, so it
    // is never microscopic from afar nor enormous up close.
    const onScreen = Math.min(Math.max((emphasis ? 12.5 : 11) * Math.sqrt(scale), 9.5), 17);
    const size = onScreen / scale;
    // Whole hundreds only: a weight of 450 is read by some canvases as the
    // font size, and every trait was drawn four hundred pixels tall.
    ctx.font = `${emphasis ? 600 : 500} ${size.toFixed(2)}px Inter, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    // Its own name where it has one, and its id where it does not. A label is
    // a thing to draw, and one missing must never take down a page.
    const name = node.label ?? node.id;
    const label = name.length > 30 ? `${name.slice(0, 29)}…` : name;
    const top = y + radius + 4 / scale;

    ctx.globalAlpha = (inLight || isMatch ? 1 : 0.1) * opacity;
    // A dark halo behind the text, so a label crossing a line stays readable.
    ctx.lineWidth = 3.5 / scale;
    ctx.strokeStyle = 'rgba(14, 13, 18, 0.9)';
    ctx.lineJoin = 'round';
    ctx.strokeText(label, x, top);
    ctx.fillStyle = isFocus || isSelected
      ? '#ffffff'
      : node.type === 'brand'
        ? 'rgba(236, 234, 244, 0.95)'
        : 'rgba(196, 194, 208, 0.85)';
    ctx.fillText(label, x, top);
  }

  ctx.globalAlpha = 1;
}

/** A #rrggbb colour at a given opacity, for lines that take a node's colour. */
function hexWithAlpha(hex: string, alpha: number): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(value >> 16) & 255},${(value >> 8) & 255},${value & 255},${alpha})`;
}
