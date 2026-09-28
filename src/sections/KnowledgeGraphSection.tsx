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
  /** Where a point in the graph is on screen, for placing the hover card. */
  graph2ScreenCoords: (x: number, y: number) => { x: number; y: number };
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
  onZoom?: () => void;
  onNodeDragEnd?: (node: SimNode) => void;
  linkColor?: (link: SimLink) => string;
  linkWidth?: (link: SimLink) => number;
  linkDirectionalParticles?: (link: SimLink) => number;
  linkDirectionalParticleWidth?: number;
  linkDirectionalParticleSpeed?: number;
  linkDirectionalParticleColor?: (link: SimLink) => string;
  linkCurvature?: number;
  autoPauseRedraw?: boolean;
  linkDirectionalArrowLength?: number;
  linkDirectionalArrowRelPos?: number;
  linkDirectionalArrowColor?: (link: SimLink) => string;
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
  // Champagne gold, as the brands' rings are: a spirits portfolio reads as
  // premium in gold, and one colour for all of them keeps the family together.
  brand: '#d9bf86',
  // A hub is what brands have in common rather than a brand itself, so it is
  // the same warm family and a shade apart from it.
  trait: '#c7896a',
  source: '#a996b8',
  folder: '#7fa3b0',
  file: '#94ae8c',
  chunk: '#9d9384',
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
  country:  '#7fa3b0',
  category: '#c7896a',
  flavour:  '#94ae8c',
  tier:     '#a996b8',
};
const UNNAMED_HUB = '#6f685c';

/**
 * What kind of file a file is, in the four kinds a person sorts them into.
 * Every file was the same green, so a folder of films and a folder of decks
 * looked the same until each one was clicked.
 */
type FileKind = 'image' | 'video' | 'pdf' | 'doc';
const IMAGE_TYPES = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg']);
const VIDEO_TYPES = new Set(['mp4', 'mov', 'webm', 'mkv']);

function fileKindOf(fileType: string | undefined): FileKind {
  const type = (fileType ?? '').toLowerCase();
  if (IMAGE_TYPES.has(type)) return 'image';
  if (VIDEO_TYPES.has(type)) return 'video';
  if (type === 'pdf') return 'pdf';
  return 'doc';
}

/** Muted, as the rest of the graph is, and distinct from one another. */
const FILE_KIND_COLOR: Record<FileKind, string> = {
  image: '#8fb0a9',
  video: '#c9a07a',
  pdf: '#b88a8f',
  doc: '#c9c0a8',
};
const FILE_KIND_LABEL: Record<FileKind, string> = {
  image: 'Image', video: 'Video', pdf: 'PDF', doc: 'Document',
};

function colorFor(node: SimNode): string {
  if (node.type === 'file') return FILE_KIND_COLOR[fileKindOf(node.fileType)];
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

/**
 * Where somebody has put nodes by hand, kept in this browser.
 *
 * Dragging a node pins it, as Obsidian does, and an arrangement somebody took
 * the trouble to make should still be there tomorrow. Per view, since a place
 * in the portfolio means nothing in the file tree. Only this person's browser:
 * it is a preference about their screen, not a fact about the company. Reset
 * lets everything go back to finding its own place.
 *
 * Every read and write is guarded: storage can be refused outright - a private
 * window, a full disk, a blocked site - and the graph must draw regardless.
 */
type Pins = Record<string, [number, number]>;
const pinsKey = (view: string) => `cip.graph.pins.${view}`;

function readPins(view: string): Pins {
  try {
    return JSON.parse(window.localStorage.getItem(pinsKey(view)) ?? '{}') as Pins;
  } catch {
    return {};
  }
}

function rememberPin(view: string, node: SimNode): void {
  try {
    const pins = readPins(view);
    pins[node.id] = [node.x ?? 0, node.y ?? 0];
    window.localStorage.setItem(pinsKey(view), JSON.stringify(pins));
  } catch {
    // The pin still holds for this visit; it just will not outlive it.
  }
}

function forgetPins(view: string): void {
  try {
    window.localStorage.removeItem(pinsKey(view));
  } catch {
    // Nothing was kept, so there is nothing to forget.
  }
}

/** The same request always gives the same key, whatever order its parts came in. */
function graphKey(params: Record<string, string>): string {
  return new URLSearchParams(Object.entries(params).sort(([a], [b]) => a.localeCompare(b))).toString();
}

/**
 * A graph to draw, as copies.
 *
 * The simulation writes positions onto nodes and swaps each edge's ends for the
 * node objects themselves. A graph that is kept to be drawn again must not be
 * the one that was drawn, or its edges point at the last drawing's nodes.
 */
function copyOfGraph(graph: KnowledgeGraphDTO): { nodes: SimNode[]; edges: GraphEdgeDTO[] } {
  return {
    nodes: graph.nodes.map((n) => ({ ...n })) as SimNode[],
    edges: graph.edges.map((e) => ({
      ...e,
      source: endId(e.source as string | { id: string }),
      target: endId(e.target as string | { id: string }),
    })),
  };
}

/** Fresh nodes from the server, with anything pinned put back where it was left. */
function withPins(view: string, fresh: SimNode[]): SimNode[] {
  const pins = typeof window === 'undefined' ? {} : readPins(view);
  return fresh.map((node) => {
    const pin = pins[node.id];
    return pin ? { ...node, x: pin[0], y: pin[1], fx: pin[0], fy: pin[1] } : node;
  });
}

/**
 * Which filter chip a node belongs to: a brand, a trait by its kind, or the
 * shared tail that has no kind. Files and folders keep their own type.
 */
function groupOf(node: GraphNodeDTO): string {
  if (node.type === 'trait') return node.dimension ?? 'shared';
  if (node.type === 'file') return `file:${fileKindOf(node.fileType)}`;
  return node.type;
}

/** The ids within `depth` steps of a node, along the lines that are drawn. */
function neighbourhood(start: string, links: SimLink[], depth: number): Set<string> {
  const reached = new Set<string>([start]);
  let frontier = [start];
  for (let step = 0; step < depth && frontier.length > 0; step += 1) {
    const next: string[] = [];
    for (const link of links) {
      const a = endId(link.source);
      const b = endId(link.target);
      for (const [from, to] of [[a, b], [b, a]] as const) {
        if (frontier.includes(from) && !reached.has(to)) {
          reached.add(to);
          next.push(to);
        }
      }
    }
    frontier = next;
  }
  return reached;
}

/**
 * The brands most like one brand, closest first, with what they share.
 *
 * Read off the brand-to-brand edges already on the page, which carry both the
 * score and the reason, so showing them costs nothing.
 */
function mostAlike(
  brandId: string,
  edges: GraphEdgeDTO[],
  limit = 5,
): { other: string; score: number; shared: string[] }[] {
  return edges
    .filter((e) => e.kind === 'resembles')
    .filter((e) => endId(e.source as string) === brandId || endId(e.target as string) === brandId)
    .map((e) => ({
      other: (endId(e.source as string) === brandId ? endId(e.target as string) : endId(e.source as string))
        .replace(/^brand:/, ''),
      score: e.score ?? 0,
      shared: e.shared ?? [],
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** A file size a person reads, not a byte count. */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const FILE_ICON: Record<string, IconName> = {
  png: 'image', jpg: 'image', jpeg: 'image', webp: 'image', gif: 'image',
  mp4: 'video', mov: 'video', webm: 'video',
  xlsx: 'sheet', xls: 'sheet', csv: 'sheet',
  pptx: 'slides', ppt: 'slides', key: 'slides',
};

/**
 * How the graph is filtered, drawn and laid out - Obsidian's graph settings,
 * with Obsidian's names, so anyone who has used that panel knows this one.
 *
 * Kept in this browser like pinned nodes are: a preference about somebody's
 * screen, not a fact about the company.
 */
type GraphSettings = {
  /** How far the light, and an isolated cluster, reach from a node. */
  depth: 1 | 2 | 3;
  /** Whether nodes with no line to anything are drawn. */
  orphans: boolean;
  /** Below 0 names wait for a closer zoom; above 0 they appear from further out. */
  textFade: number;
  nodeSize: number;
  linkThickness: number;
  arrows: boolean;
  /** The pull to the middle. */
  centerForce: number;
  /** How hard nodes push each other away. */
  repelForce: number;
  /** How hard a line pulls its two ends together. 0 leaves it to the library, which weighs busy nodes less. */
  linkForce: number;
  linkDistance: number;
};

/** The layout the portfolio was tuned to, and what Restore puts back. */
const DEFAULT_SETTINGS: GraphSettings = {
  depth: 1,
  orphans: true,
  textFade: 0,
  nodeSize: 1,
  linkThickness: 1,
  arrows: false,
  centerForce: 0.07,
  repelForce: 520,
  linkForce: 0,
  linkDistance: 110,
};

const SETTINGS_KEY = 'cip.graph.settings.v1';

function readSettings(): GraphSettings {
  if (typeof window === 'undefined') return DEFAULT_SETTINGS;
  try {
    const saved = JSON.parse(window.localStorage.getItem(SETTINGS_KEY) ?? '{}') as Partial<GraphSettings>;
    return { ...DEFAULT_SETTINGS, ...saved };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/** One of the panel's sliders: a name, its value as a person reads it, the track. */
function SettingSlider({
  label, value, min, max, step, shown, onChange,
}: {
  label: string; value: number; min: number; max: number; step: number;
  shown: string; onChange: (value: number) => void;
}) {
  return (
    <label className="gs-row">
      <span className="gs-name">{label}<span className="gs-value">{shown}</span></span>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

/** One of the panel's switches. */
function SettingSwitch({
  label, on, onChange, hint,
}: { label: string; on: boolean; onChange: (on: boolean) => void; hint?: string }) {
  return (
    <button type="button" className="gs-switch-row" role="switch" aria-checked={on} title={hint}
      onClick={() => onChange(!on)}>
      <span>{label}</span>
      <i className={`gs-switch${on ? ' is-on' : ''}`} />
    </button>
  );
}

/** The chips along the top of the portfolio, in the order a reader wants them. */
const GROUPS: { key: string; label: string; color: string }[] = [
  { key: 'brand', label: 'Brands', color: TYPE_COLOR.brand },
  { key: 'category', label: 'Category', color: DIMENSION_COLOR.category! },
  { key: 'flavour', label: 'Flavour', color: DIMENSION_COLOR.flavour! },
  { key: 'tier', label: 'Tier', color: DIMENSION_COLOR.tier! },
  { key: 'country', label: 'Country', color: DIMENSION_COLOR.country! },
  { key: 'shared', label: 'Also shared', color: UNNAMED_HUB },
  { key: 'source', label: 'Sources', color: TYPE_COLOR.source },
  { key: 'folder', label: 'Folders', color: TYPE_COLOR.folder },
  { key: 'file:image', label: 'Images', color: FILE_KIND_COLOR.image },
  { key: 'file:video', label: 'Videos', color: FILE_KIND_COLOR.video },
  { key: 'file:pdf', label: 'PDFs', color: FILE_KIND_COLOR.pdf },
  { key: 'file:doc', label: 'Documents', color: FILE_KIND_COLOR.doc },
  { key: 'chunk', label: 'Passages', color: TYPE_COLOR.chunk },
];

export function KnowledgeGraphSection({
  initial,
  onOpenBrand,
}: {
  initial: KnowledgeGraphDTO;
  /** Opens one brand's own brain. Absent where there is nowhere to open it. */
  onOpenBrand?: (brand: string) => void;
}) {
  const { note } = useToast();
  const graphRef = useRef<GraphHandle | null>(null);
  /**
   * Whether the renderer has arrived.
   *
   * It is loaded after the page, so on the first pass graphRef is empty. The
   * layout forces used to be set in an effect that simply returned when it
   * found nothing there, and ran again only if the canvas changed size - so
   * most of the time they were never applied at all, and the graph was laid
   * out with the library's defaults: short links, weak repulsion, no room for
   * names. That is the knot that opened every time. Now the effect waits.
   */
  const [graphReady, setGraphReady] = useState(false);
  const attachGraph = useCallback((handle: GraphHandle | null) => {
    graphRef.current = handle;
    if (handle) setGraphReady(true);
  }, []);
  const shellRef = useRef<HTMLDivElement | null>(null);

  const [nodes, setNodes] = useState<SimNode[]>(() => withPins('brands', initial.nodes as SimNode[]));
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

  const savePin = useCallback((node: SimNode) => rememberPin(view, node), [view]);

  /** Obsidian's graph settings: filters, display and forces. */
  const [settings, setSettings] = useState<GraphSettings>(readSettings);
  const tune = useCallback(<K extends keyof GraphSettings>(key: K, value: GraphSettings[K]) => {
    setSettings((current) => ({ ...current, [key]: value }));
  }, []);
  const depth = settings.depth;
  useEffect(() => {
    try {
      window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      // Not kept past this visit; nothing else depends on it.
    }
  }, [settings]);
  /** Whether the settings panel is open, and which of its sections are. */
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [openSections, setOpenSections] = useState<Set<string>>(() => new Set(['filters', 'display', 'forces']));
  const toggleSection = (name: string) => setOpenSections((current) => {
    const next = new Set(current);
    if (next.has(name)) next.delete(name); else next.add(name);
    return next;
  });
  /**
   * Obsidian's Animate: the graph rebuilt one node at a time, so it can be
   * watched growing. Null when not animating; otherwise how many are shown.
   */
  const [revealed, setRevealed] = useState<number | null>(null);
  /** Chips switched off: kinds of node not drawn at all. */
  const [hiddenGroups, setHiddenGroups] = useState<Set<string>>(() => new Set());
  /** A node whose neighbourhood is all that is drawn, when somebody isolates one. */
  const [isolated, setIsolated] = useState<string | null>(null);
  /** The hover card, and where on screen the node it describes is. */
  const [tip, setTip] = useState<{ node: SimNode; x: number; y: number } | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  // Ctrl+K (or Cmd+K) goes to the search box, as it does everywhere else now.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const [busy, setBusy] = useState(false);
  const [size, setSize] = useState({ width: 800, height: 600 });

  /**
   * The screen's pixel ratio, watched for change.
   *
   * The renderer sizes its canvas for the ratio it started with and only
   * resizes when its width or height changes. Browser zoom, or dragging the
   * window to another screen, changes the ratio under it: the canvas stays
   * sized for the old one, each frame is wiped for the new one, and part of
   * it is never wiped at all - zooming then smeared every node into a trail
   * and left stale copies of the graph behind. A new ratio gets a new canvas.
   * The nodes keep their places, which live on the node objects.
   */
  const [pixelRatio, setPixelRatio] = useState(() =>
    typeof window === 'undefined' ? 1 : window.devicePixelRatio,
  );
  useEffect(() => {
    // Two ways of hearing about it, because not every browser sends both: a
    // media query on the current ratio, and the resize that browser zoom
    // also causes. Either way the ratio is read afresh, and an unchanged one
    // changes nothing.
    let media: MediaQueryList | null = null;
    const watch = () => {
      setPixelRatio(window.devicePixelRatio);
      media?.removeEventListener('change', watch);
      media = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      media.addEventListener('change', watch);
    };
    watch();
    window.addEventListener('resize', watch);
    return () => {
      media?.removeEventListener('change', watch);
      window.removeEventListener('resize', watch);
    };
  }, []);

  const hasFitted = useRef(false);

  /**
   * Frames the graph, and never closer than a comfortable zoom.
   *
   * Fitting eight nodes of an isolated cluster to the screen blew each one up
   * to the size of a saucer and pushed the bottom row under the banner. The
   * margin leaves room for the overlays along the top and bottom edges.
   */
  const fitView = useCallback((ms = 600) => {
    const handle = graphRef.current;
    if (!handle) return;
    handle.zoomToFit(ms, 110);
    window.setTimeout(() => {
      const zoom = handle.zoom();
      if (typeof zoom === 'number' && zoom > 1.6) handle.zoom(1.6, 300);
    }, ms + 40);
  }, []);

  /**
   * Pushes the nodes apart.
   *
   * The defaults are tuned for hundreds of nodes; a dozen of them collapse into
   * a knot in the middle of the canvas with every label on top of every other.
   * A stronger repulsion and a longer link give the graph room to breathe.
   */
  useEffect(() => {
    const handle = graphRef.current;
    if (!graphReady || !handle?.d3Force) return;

    // The portfolio is a few dozen nodes and every one of them carries a
    // label, so it needs far more room than a cloud of unlabelled dots. The
    // file tree is hundreds of nodes and the same spacing would fling them
    // off the canvas.
    // Everything holds the brands and their names as well as the files, and
    // at the file tree's tighter spacing the brands were squeezed into a knot
    // at the top with their names on one another. Only the file tree, which
    // is hundreds of unnamed dots, is laid out tight.
    const roomy = view !== 'files';
    handle.d3Force('charge')?.strength?.(-settings.repelForce * (roomy ? 1 : 0.5));
    handle.d3Force('link')?.distance?.(settings.linkDistance * (roomy ? 1 : 0.64));
    // Left to the library unless somebody set it: its default weighs a line to
    // a busy node less, which is what keeps a hub from swallowing its brands.
    if (settings.linkForce > 0) handle.d3Force('link')?.strength?.(settings.linkForce);
    // Repulsion alone let thirty labelled nodes settle in a knot with every
    // name on top of the next. Collision gives each one room for its name.
    handle.d3Force('collide', collide(settings.nodeSize));
    // And a gentle pull to the middle, so a brand that shares nothing with
    // the others stays on screen instead of dragging the whole view out.
    handle.d3Force('gravity', gravity(size.width / Math.max(1, size.height), settings.centerForce));
    // The layout changes shape under new forces, so it is fitted again once it
    // settles rather than left framed for the one it replaced.
    hasFitted.current = false;
    handle.d3ReheatSimulation();
  }, [
    graphReady, pixelRatio, nodes.length, view, size.width, size.height,
    settings.repelForce, settings.linkDistance, settings.linkForce, settings.centerForce, settings.nodeSize,
  ]);

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

  /**
   * Each view's graph, fetched once and kept for the visit.
   *
   * Opening Files or Everything waited on the server every time, and until
   * the answer came the old graph stayed on screen. The portfolio arrives with
   * the page; the other two are asked for quietly once it is drawn, so a tab
   * is usually ready before it is clicked. A request still on its way is
   * shared, never sent twice. Only whole views are kept - an opened folder or
   * a search is always asked for afresh - and Reset asks afresh too.
   */
  const graphRequests = useRef(
    new Map<string, Promise<KnowledgeGraphDTO | null>>([[graphKey({ view: 'brands' }), Promise.resolve(initial)]]),
  );
  const graphsHeld = useRef(new Map<string, KnowledgeGraphDTO>([[graphKey({ view: 'brands' }), initial]]));

  const fetchGraph = useCallback(
    async (
      params: Record<string, string>,
      options: { fresh?: boolean; quiet?: boolean } = {},
    ): Promise<KnowledgeGraphDTO | null> => {
      const key = graphKey(params);
      const keepable = !('nodeId' in params) && !('search' in params);
      if (keepable && !options.fresh) {
        const pending = graphRequests.current.get(key);
        if (pending) return pending;
      }

      const request = (async () => {
        const res = await fetch(`/api/knowledge-graph?${new URLSearchParams(params)}`, { cache: 'no-store' })
          .catch(() => null);
        if (!res?.ok) {
          // A quiet fetch is one nobody asked for yet; failing it says nothing.
          if (!options.quiet) note('The knowledge graph could not be loaded.');
          return null;
        }
        const graph = (await res.json()) as KnowledgeGraphDTO;
        if (keepable) graphsHeld.current.set(key, graph);
        return graph;
      })();

      if (keepable) {
        graphRequests.current.set(key, request);
        // A failure is not kept: the next click should try again.
        void request.then((graph) => {
          if (!graph && graphRequests.current.get(key) === request) graphRequests.current.delete(key);
        });
      }
      return request;
    },
    [note],
  );

  // Once the portfolio is on screen, fetch the other two views in the quiet.
  useEffect(() => {
    if (!graphReady) return;
    const later = window.setTimeout(() => {
      for (const other of ['files', 'all']) void fetchGraph({ view: other }, { quiet: true });
    }, 1500);
    return () => window.clearTimeout(later);
  }, [graphReady, fetchGraph]);

  /** Which view is being fetched with nothing yet to show for it. */
  const [loadingView, setLoadingView] = useState<string | null>(null);

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
    async (overrides: Record<string, string> = {}, options: { fresh?: boolean } = {}) => {
      const params = {
        view,
        ...(sourceFilter !== 'all' ? { source: sourceFilter } : {}),
        ...(typeFilter !== 'all' ? { type: typeFilter } : {}),
        ...overrides,
      };
      // Already here: drawn at once, with no round trip and no flash.
      const held = options.fresh ? undefined : graphsHeld.current.get(graphKey(params));
      // Not here yet, and a different view: the old graph goes now rather than
      // standing in for the new one until it arrives.
      if (!held && overrides.view && overrides.view !== view) {
        setNodes([]);
        setEdges([]);
        setSelected(null);
        setLoadingView(overrides.view);
      }
      setBusy(true);
      try {
        const graph = held ?? (await fetchGraph(params, { fresh: options.fresh }));
        if (!graph) return;
        // The view being loaded, which on a switch is the new one, not the
        // one still in state - pins are kept per view.
        const loading = (overrides.view as typeof view | undefined) ?? view;
        const copy = copyOfGraph(graph);
        setNodes(withPins(loading, copy.nodes));
        setEdges(copy.edges);
        setStats(graph.stats);
        setExpanded(new Set());
        setSelected(null);
        setMatches(new Set(graph.matches));
        hasFitted.current = false;
        // A large graph takes seconds to settle, and waiting for it left
        // Everything drawn too close, running off every edge. Framed once
        // it has a shape, and again when it settles.
        window.setTimeout(() => fitView(800), 1200);
      } finally {
        setBusy(false);
        setLoadingView(null);
      }
    },
    [fetchGraph, fitView, sourceFilter, typeFilter, view],
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

  /**
   * The brands the selected one is most like, closest first.
   *
   * Read off the edges already drawn rather than fetched: the reason is
   * carried on the edge precisely so that showing it costs nothing.
   */
  const resemblances = useMemo(
    () => (selected?.type === 'brand' ? mostAlike(selected.id, edges) : []),
    [edges, selected],
  );

  /** What the selected brand is, in the traits it shares, coloured by kind. */
  const brandTraits = useMemo(() => {
    if (!selected || selected.type !== 'brand') return [];
    const ids = new Set(
      edges
        .filter((e) => e.kind === 'shares' && endId(e.source as string) === selected.id)
        .map((e) => endId(e.target as string)),
    );
    return nodes
      .filter((n) => ids.has(n.id))
      .sort((a, b) => (a.dimension ? 0 : 1) - (b.dimension ? 0 : 1) || a.label.localeCompare(b.label));
  }, [edges, nodes, selected]);

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
  /**
   * The order Animate brings nodes in: the most connected brands first, then
   * what they share, widest first - the portfolio assembling around its
   * centre of gravity rather than in whatever order the rows came back.
   */
  const revealOrder = useMemo(() => {
    const degree = new Map<string, number>();
    for (const edge of visibleEdges) {
      for (const end of [endId(edge.source as string), endId(edge.target as string)]) {
        degree.set(end, (degree.get(end) ?? 0) + 1);
      }
    }
    const rank = (n: SimNode) => (n.type === 'brand' ? 0 : n.type === 'trait' && n.dimension ? 1 : 2);
    return [...nodes]
      .sort((a, b) => rank(a) - rank(b) || (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0))
      .map((n) => n.id);
  }, [nodes, visibleEdges]);

  const graphData = useMemo(() => {
    const allowed = revealed === null ? null : new Set(revealOrder.slice(0, revealed));
    let shown = nodes.filter((n) => !hiddenGroups.has(groupOf(n)) && (!allowed || allowed.has(n.id)));
    let present = new Set(shown.map((n) => n.id));
    let links = (visibleEdges as unknown as SimLink[]).filter(
      (edge) => present.has(endId(edge.source)) && present.has(endId(edge.target)),
    );
    // In Everything a branded file hangs off its brand alone. Tied to its
    // brand and to CIP Drive as well, every file dragged its brand towards
    // the one hub, and all eleven brands collapsed into a single knot. Hung
    // from the brand, each brand gathers its own files into a cluster, the way
    // Obsidian's notes gather round what links them. Where a file sits in the
    // folders is what the Files view is for.
    if (view === 'all') {
      const branded = new Set(
        links
          .filter((edge) => edge.kind === 'contains' && endId(edge.source).startsWith('brand:'))
          .map((edge) => endId(edge.target)),
      );
      links = links.filter(
        (edge) => !(edge.kind === 'contains' && branded.has(endId(edge.target)) && !endId(edge.source).startsWith('brand:')),
      );
    }
    // Orphans: nodes nothing on screen connects to. Obsidian's switch, and the
    // one that tidies away a brand that shares nothing with the rest.
    if (!settings.orphans) {
      const joined = new Set(links.flatMap((edge) => [endId(edge.source), endId(edge.target)]));
      shown = shown.filter((n) => joined.has(n.id));
      present = new Set(shown.map((n) => n.id));
    }
    // Isolating a node draws its neighbourhood and nothing else, to the depth
    // the light reaches - the same set a hover would light.
    if (isolated && present.has(isolated)) {
      present = neighbourhood(isolated, links, depth);
      shown = shown.filter((n) => present.has(n.id));
      links = links.filter((edge) => present.has(endId(edge.source)) && present.has(endId(edge.target)));
    }
    return { nodes: shown, links };
  }, [nodes, visibleEdges, hiddenGroups, isolated, depth, settings.orphans, revealed, revealOrder, view]);

  // Isolating a cluster or switching a kind off changes what is drawn, and the
  // view is fitted to the new shape once it settles - an isolated cluster left
  // framed for the whole portfolio is a small knot in one corner.
  // The nodes that remain already have their places, so the view moves to them
  // at once rather than after the layout has finished settling seconds later.
  useEffect(() => {
    hasFitted.current = false;
    const timer = window.setTimeout(() => fitView(), 120);
    return () => window.clearTimeout(timer);
  }, [isolated, hiddenGroups, settings.orphans, fitView]);

  /**
   * Plays Animate: every node hidden, then brought in a few at a time while
   * the layout settles around them, and fitted once they are all back.
   */
  const animate = useCallback(() => {
    if (revealed !== null) return;
    const total = revealOrder.length;
    const step = Math.max(1, Math.ceil(total / 45));
    let shown = 0;
    setRevealed(0);
    const timer = window.setInterval(() => {
      shown += step;
      if (shown >= total) {
        window.clearInterval(timer);
        setRevealed(null);
        window.setTimeout(() => fitView(800), 400);
      } else {
        setRevealed(shown);
      }
    }, 90);
  }, [fitView, revealOrder.length, revealed]);

  const lit = useMemo(
    () => (focusId ? neighbourhood(focusId, graphData.links, depth) : new Set<string>()),
    [focusId, graphData.links, depth],
  );
  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const focusColor = focusId && nodeById.get(focusId) ? colorFor(nodeById.get(focusId)!) : null;

  /** The colour a lit line takes: the node at its far end from what is lit. */
  const farColor = (edge: SimLink): string => {
    const a = endId(edge.source);
    const far = a === focusId ? edge.target : edge.source;
    const node = typeof far === 'string' ? nodeById.get(far) : far;
    return node ? colorFor(node) : focusColor ?? '#ffffff';
  };

  /** How many of each kind are on the page, for the chips. */
  const groupCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const node of nodes) counts.set(groupOf(node), (counts.get(groupOf(node)) ?? 0) + 1);
    return counts;
  }, [nodes]);

  /** Brands by how much they share, for the portfolio summary. */
  const mostConnected = useMemo(() => {
    const degree = new Map<string, number>();
    for (const edge of edges) {
      if (edge.kind !== 'shares') continue;
      const brand = endId(edge.source as string);
      degree.set(brand, (degree.get(brand) ?? 0) + 1);
    }
    return nodes
      .filter((n) => n.type === 'brand')
      .map((n) => ({ node: n, degree: degree.get(n.id) ?? 0 }))
      .sort((a, b) => b.degree - a.degree)
      .slice(0, 4);
  }, [edges, nodes]);

  const widestTraits = useMemo(
    () => nodes
      .filter((n) => n.type === 'trait' && n.dimension)
      .sort((a, b) => (b.brandCount ?? 0) - (a.brandCount ?? 0))
      .slice(0, 6),
    [nodes],
  );

  /** Selects a node and brings it to the middle of the screen. */
  const goTo = useCallback((node: SimNode | undefined) => {
    if (!node) return;
    setSelected(node);
    if (node.x !== undefined && node.y !== undefined) graphRef.current?.centerAt(node.x, node.y, 600);
  }, []);

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
            ref={searchRef}
            value={query}
            placeholder="Search brands, traits and files…"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void runSearch();
              if (e.key === 'Escape') { setQuery(''); setMatches(new Set()); }
            }}
          />
          {matches.size > 0 && <span className="graph-hits">{matches.size}</span>}
          <kbd className="graph-kbd">Ctrl K</kbd>
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
                // Everything draws every kind of line: with only the shared
                // traits drawn, its files floated loose across the canvas,
                // joined to nothing - their folders and brands were there,
                // but the lines to them were filtered out.
                setEdgeFilter(value === 'files' ? 'contains' : value === 'all' ? 'all' : 'shares');
                void reload({ view: value });
              }}
            >
              {label}
              {view === value && value === 'brands' && (
                <span className="graph-count">{groupCounts.get('brand') ?? 0}</span>
              )}
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
          <button type="button" onClick={() => fitView()}>Fit</button>
          <button
            type="button"
            title="Forget where nodes were moved to, and lay the graph out again"
            onClick={() => {
              forgetPins(view);
              void reload({}, { fresh: true });
            }}
          >
            Reset
          </button>
        </div>
      </div>

      <div className="graph-body">
        <div className={`graph-canvas${hovered ? ' is-pointing' : ''}`} ref={shellRef}>
          <ForceGraph2D
            key={pixelRatio}
            ref={attachGraph}
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
              fitView(700);
            }}
            d3VelocityDecay={0.32}
            // Slightly bowed, as a hand would draw them; straight lines
            // between thirty nodes read as a wiring diagram.
            linkCurvature={0.12}
            // The portfolio is a few dozen nodes, so it is cheap to keep
            // painting - which lets the logos appear as they load and the
            // light run along the lines of whatever is being pointed at.
            autoPauseRedraw={view !== 'brands'}
            nodeRelSize={5}
            onNodeClick={(node) => setSelected(node)}
            onNodeHover={(node) => {
              setHovered(node?.id ?? null);
              const handle = graphRef.current;
              if (!node || !handle?.graph2ScreenCoords) {
                setTip(null);
                return;
              }
              const at = handle.graph2ScreenCoords(node.x ?? 0, node.y ?? 0);
              setTip({ node, x: at.x, y: at.y });
            }}
            // A card left where a node used to be is worse than none.
            // Zoom events fire while the renderer is itself rendering, and a
            // state change there is an error; the card is cleared a frame on,
            // and only if there is one to clear.
            onZoom={() => window.requestAnimationFrame(() => setTip((t) => (t ? null : t)))}
            onBackgroundClick={() => setSelected(null)}
            onNodeDragEnd={(node) => {
              // Pin where it was dropped. Obsidian does the same, and a node
              // that springs back the moment you let go feels broken.
              node.fx = node.x;
              node.fy = node.y;
              savePin(node);
            }}
            linkColor={(edge) => {
              // Lit: the lines out of whatever is under the pointer take its
              // colour. Everything else sinks almost out of sight.
              // Each lit line takes the colour of what it leads to, so the kinds
              // of thing a brand is made of read at a glance.
              if (focusId !== null) {
                const a = endId(edge.source);
                const b = endId(edge.target);
                if (!lit.has(a) || !lit.has(b)) return 'rgba(211,200,182,0.04)';
                const direct = a === focusId || b === focusId;
                return hexWithAlpha(farColor(edge), direct ? 0.6 : 0.25);
              }
              if (edge.kind === 'resembles') {
                // Stronger resemblance draws stronger, so the shape of the
                // portfolio is readable without pointing at anything.
                const strength = Math.min(0.55, Math.max(0.12, (edge.score ?? 0.3) * 0.6));
                return `rgba(217,191,134,${strength})`;
              }
              if (edge.kind === 'related') return 'rgba(205,178,122,0.28)';
              return 'rgba(211,200,182,0.13)';
            }}
            linkWidth={(edge) => {
              const on = focusId !== null && (endId(edge.source) === focusId || endId(edge.target) === focusId);
              const base = on ? 1.3 : edge.kind === 'resembles' ? 0.6 + 1.4 * (edge.score ?? 0) : 0.7;
              return base * settings.linkThickness;
            }}
            // Obsidian's arrows: which way a line runs - from a brand to what
            // it shares, from a folder to what it holds.
            linkDirectionalArrowLength={settings.arrows ? 5 : 0}
            linkDirectionalArrowRelPos={0.72}
            linkDirectionalArrowColor={(edge) =>
              focusId !== null && lit.has(endId(edge.source)) && lit.has(endId(edge.target))
                ? hexWithAlpha(farColor(edge), 0.9)
                : 'rgba(211,200,182,0.3)'}
            nodeCanvasObject={(node, ctx, scale) => {
              drawNode(node, ctx, scale, {
                focusId,
                selectedId: selected?.id ?? null,
                lit,
                matches,
                expanded,
                nodeSize: settings.nodeSize,
                textFade: settings.textFade,
              });
            }}
            nodePointerAreaPaint={(node, color, ctx) => {
              ctx.fillStyle = color;
              ctx.beginPath();
              ctx.arc(node.x ?? 0, node.y ?? 0, radiusFor(node, settings.nodeSize) + 4, 0, 2 * Math.PI);
              ctx.fill();
            }}
          />

          {/* The overlays: chips that are both legend and filter, in every
              view, the controls for how the graph is laid out and lit, and a
              card for whatever is under the pointer. */}
          <div className="graph-chips" role="group" aria-label="Show or hide">
            {GROUPS.filter((g) => (groupCounts.get(g.key) ?? 0) > 0).map((g) => {
              const off = hiddenGroups.has(g.key);
              return (
                <button
                  key={g.key}
                  type="button"
                  className={`graph-chip${off ? ' is-off' : ''}`}
                  aria-pressed={!off}
                  title={off ? `Show ${g.label.toLowerCase()}` : `Hide ${g.label.toLowerCase()}`}
                  onClick={() => setHiddenGroups((current) => {
                    const next = new Set(current);
                    if (next.has(g.key)) next.delete(g.key); else next.add(g.key);
                    return next;
                  })}
                >
                  <i style={{ background: g.color, color: g.color }} />
                  {g.label}
                  <b>{groupCounts.get(g.key)}</b>
                </button>
              );
            })}
          </div>

          {/* Obsidian's graph settings, in the corner where Obsidian keeps
              them: closed to a single button until wanted. */}
          <div className={`graph-settings${settingsOpen ? ' is-open' : ''}`}>
            <button type="button" className="gs-toggle" title="Graph settings"
              aria-expanded={settingsOpen} onClick={() => setSettingsOpen((v) => !v)}>
              <Icon name={settingsOpen ? 'close' : 'sliders'} size={16} />
            </button>

            {settingsOpen && (
              <div className="gs-panel">
                <section>
                  <button type="button" className="gs-head" onClick={() => toggleSection('filters')}>
                    <Icon name={openSections.has('filters') ? 'chevron-down' : 'chevron-right'} size={13} />
                    Filters
                  </button>
                  {openSections.has('filters') && (
                    <div className="gs-body">
                      <SettingSlider label="Depth" value={settings.depth} min={1} max={3} step={1}
                        shown={`${settings.depth}`} onChange={(v) => tune('depth', v as 1 | 2 | 3)} />
                      <SettingSwitch label="Orphans" on={settings.orphans}
                        hint="Nodes nothing on screen connects to"
                        onChange={(v) => tune('orphans', v)} />
                      {(groupCounts.get('shared') ?? 0) > 0 && (
                        <SettingSwitch label="Untyped shared traits" on={!hiddenGroups.has('shared')}
                          hint="Things brands share that CIP cannot name a kind for"
                          onChange={(v) => setHiddenGroups((current) => {
                            const next = new Set(current);
                            if (v) next.delete('shared'); else next.add('shared');
                            return next;
                          })} />
                      )}
                    </div>
                  )}
                </section>

                <section>
                  <button type="button" className="gs-head" onClick={() => toggleSection('display')}>
                    <Icon name={openSections.has('display') ? 'chevron-down' : 'chevron-right'} size={13} />
                    Display
                  </button>
                  {openSections.has('display') && (
                    <div className="gs-body">
                      <SettingSwitch label="Arrows" on={settings.arrows} onChange={(v) => tune('arrows', v)} />
                      <SettingSlider label="Text fade threshold" value={settings.textFade} min={-1} max={1} step={0.1}
                        shown={settings.textFade === 0 ? 'default' : settings.textFade > 0 ? 'more names' : 'fewer names'}
                        onChange={(v) => tune('textFade', v)} />
                      <SettingSlider label="Node size" value={settings.nodeSize} min={0.6} max={1.6} step={0.05}
                        shown={`${Math.round(settings.nodeSize * 100)}%`} onChange={(v) => tune('nodeSize', v)} />
                      <SettingSlider label="Link thickness" value={settings.linkThickness} min={0.3} max={3} step={0.1}
                        shown={`${settings.linkThickness.toFixed(1)}×`} onChange={(v) => tune('linkThickness', v)} />
                      <button type="button" className="gs-animate" disabled={revealed !== null} onClick={animate}>
                        <Icon name="play" size={13} />
                        {revealed !== null ? 'Building…' : 'Animate'}
                      </button>
                    </div>
                  )}
                </section>

                <section>
                  <button type="button" className="gs-head" onClick={() => toggleSection('forces')}>
                    <Icon name={openSections.has('forces') ? 'chevron-down' : 'chevron-right'} size={13} />
                    Forces
                  </button>
                  {openSections.has('forces') && (
                    <div className="gs-body">
                      <SettingSlider label="Center force" value={settings.centerForce} min={0} max={0.25} step={0.01}
                        shown={settings.centerForce.toFixed(2)} onChange={(v) => tune('centerForce', v)} />
                      <SettingSlider label="Repel force" value={settings.repelForce} min={80} max={1400} step={20}
                        shown={`${settings.repelForce}`} onChange={(v) => tune('repelForce', v)} />
                      <SettingSlider label="Link force" value={settings.linkForce} min={0} max={1} step={0.05}
                        shown={settings.linkForce === 0 ? 'auto' : settings.linkForce.toFixed(2)}
                        onChange={(v) => tune('linkForce', v)} />
                      <SettingSlider label="Link distance" value={settings.linkDistance} min={40} max={280} step={5}
                        shown={`${settings.linkDistance}`} onChange={(v) => tune('linkDistance', v)} />
                    </div>
                  )}
                </section>

                <button type="button" className="gs-restore" onClick={() => setSettings(DEFAULT_SETTINGS)}>
                  Restore default settings
                </button>
              </div>
            )}
          </div>

          {isolated && nodeById.get(isolated) && (
            <div className="graph-isolated">
              Showing <b>{nodeById.get(isolated)!.label}</b> and what it connects to
              <button type="button" onClick={() => setIsolated(null)}>Show everything</button>
            </div>
          )}

          {tip && hovered === tip.node.id && (
            <div
              className="graph-tip"
              style={{ left: tip.x, top: tip.y, ['--tip' as string]: colorFor(tip.node) }}
            >
              <p className="graph-tip-title">
                <i />
                {tip.node.label}
                <span>{tip.node.type === 'trait' ? (tip.node.dimension ?? 'shared') : tip.node.type === 'file' ? FILE_KIND_LABEL[fileKindOf(tip.node.fileType)] : tip.node.type === 'chunk' ? 'passage' : tip.node.type}</span>
              </p>
              {tip.node.type === 'brand' ? (
                <p className="graph-tip-body">
                  {lit.size - 1} connected here
                  {tip.node.fileCount !== undefined && <> · {tip.node.fileCount} files</>}
                  {(() => {
                    const alike = mostAlike(tip.node.id, edges, 2);
                    return alike.length > 0 ? <> · most like {alike.map((a) => a.other).join(' & ')}</> : null;
                  })()}
                </p>
              ) : tip.node.type === 'trait' ? (
                <p className="graph-tip-body">
                  Shared by {tip.node.brandCount ?? lit.size - 1} brands
                </p>
              ) : tip.node.type === 'file' ? (
                <p className="graph-tip-body">
                  {(tip.node.fileType ?? '').toUpperCase()}
                  {tip.node.chunkCount ? ` · ${tip.node.chunkCount} passages read` : ' · not read into passages'}
                </p>
              ) : tip.node.type === 'folder' || tip.node.type === 'source' ? (
                <p className="graph-tip-body">
                  {tip.node.type === 'folder' ? Math.max(0, tip.node.weight - 3) : tip.node.weight} files
                </p>
              ) : null}
            </div>
          )}

          {loadingView ? (
            <div className="graph-loading">
              {loadingView === 'files' ? 'Loading the library…' : loadingView === 'all' ? 'Loading everything…' : 'Loading…'}
            </div>
          ) : busy && <div className="graph-busy">Working…</div>}
        </div>

        <aside className="graph-inspector">
          <div className="row-between">
            <span className="insp-eyebrow">Knowledge inspector</span>
            {selected && (
              <button type="button" className="insp-close" title="Back to the portfolio" onClick={() => setSelected(null)}>
                <Icon name="close" size={14} />
              </button>
            )}
          </div>

          {!selected && view !== 'brands' ? (
            /* Nothing chosen among the files: the library in numbers. */
            <>
              <h3 className="insp-title">The library</h3>
              <div className="insp-grid">
                <div><span>Files</span><b>{liveStats.files}</b></div>
                <div><span>Folders</span><b>{liveStats.folders}</b></div>
                <div><span>Passages read</span><b>{liveStats.chunks.toLocaleString('en-IN')}</b></div>
                <div><span>Drawn here</span><b>{loadingView ? '…' : nodes.filter((n) => n.type === 'file').length}</b></div>
              </div>
              {/* Said only once something is drawn: "the most recent 0 of
                  673" while the graph is still loading reads as a fault. */}
              {!loadingView && nodes.some((n) => n.type === 'file') &&
                nodes.filter((n) => n.type === 'file').length < liveStats.files && (
                <p className="insp-hint" style={{ margin: '-8px 0 16px' }}>
                  The most recent {nodes.filter((n) => n.type === 'file').length} of {liveStats.files} files
                  are drawn. Search, or open a folder, to reach the rest.
                </p>
              )}

              {nodes.some((n) => n.type === 'folder') && (
                <section className="insp-section">
                  <p className="insp-label">Largest folders</p>
                  <div className="insp-brandlist">
                    {nodes
                      .filter((n) => n.type === 'folder')
                      .sort((a, b) => b.weight - a.weight)
                      .slice(0, 5)
                      .map((folder) => (
                        <button key={folder.id} type="button" onClick={() => goTo(folder)}>
                          <Icon name="folder" size={15} />
                          <span className="grow truncate">{folder.label}</span>
                          <span className="muted">{Math.max(0, folder.weight - 3)} files</span>
                        </button>
                      ))}
                  </div>
                </section>
              )}

              {(['image', 'video', 'pdf', 'doc'] as const).some((kind) => (groupCounts.get(`file:${kind}`) ?? 0) > 0) && (
              <section className="insp-section">
                <p className="insp-label">By kind</p>
                <div className="insp-tags">
                  {(['image', 'video', 'pdf', 'doc'] as const)
                    .filter((kind) => (groupCounts.get(`file:${kind}`) ?? 0) > 0)
                    .map((kind) => (
                      <span key={kind} className="insp-tag" style={{ ['--tag' as string]: FILE_KIND_COLOR[kind] }}>
                        {FILE_KIND_LABEL[kind]}s<b>{groupCounts.get(`file:${kind}`)}</b>
                      </span>
                    ))}
                </div>
              </section>
              )}

              <p className="insp-hint">
                Point at a folder to see what it holds. Click a file to open it here.
              </p>
            </>
          ) : !selected ? (
            /* Nothing chosen: the portfolio in numbers, and where to start. */
            <>
              <h3 className="insp-title">The portfolio</h3>
              <div className="insp-grid">
                <div><span>Brands</span><b>{groupCounts.get('brand') ?? 0}</b></div>
                <div><span>Things in common</span><b>{nodes.filter((n) => n.type === 'trait').length}</b></div>
                <div><span>Connections</span><b>{liveStats.edges}</b></div>
                <div><span>Files read</span><b>{liveStats.files}</b></div>
              </div>

              {mostConnected.length > 0 && (
                <section className="insp-section">
                  <p className="insp-label">Most connected</p>
                  <div className="insp-brandlist">
                    {mostConnected.map(({ node, degree }) => (
                      <button key={node.id} type="button" onClick={() => goTo(node)}>
                        <BrandBadge size={12} />
                        <span className="grow truncate">{node.label}</span>
                        <span className="muted">{degree} shared</span>
                      </button>
                    ))}
                  </div>
                </section>
              )}

              {widestTraits.length > 0 && (
                <section className="insp-section">
                  <p className="insp-label">Shared most widely</p>
                  <div className="insp-tags">
                    {widestTraits.map((t) => (
                      <button key={t.id} type="button" className="insp-tag"
                        style={{ ['--tag' as string]: colorFor(t) }} onClick={() => goTo(t)}>
                        {t.label}<b>{t.brandCount}</b>
                      </button>
                    ))}
                  </div>
                </section>
              )}

              <p className="insp-hint">
                Point at anything to light what it connects to. Click a brand to open it here.
              </p>
            </>
          ) : selected.type === 'brand' ? (
            /* A brand: what it is made of, what it holds, and who it is like. */
            <>
              <div className="insp-hero">
                <BrandBadge size={34} />
                <div className="stack">
                  <h3 className="insp-title">{selected.label}</h3>
                  <span className="insp-pill" style={{ ['--tag' as string]: colorFor(selected) }}>
                    Brand{isolated === selected.id ? ' · isolated' : ''}
                  </span>
                </div>
              </div>

              <div className="insp-grid">
                <div><span>Files</span><b>{selected.fileCount ?? 0}</b></div>
                <div><span>Things in common</span><b>{brandTraits.length}</b></div>
                {/* "Described as", not "is": this is what CIP read in the
                    brand's files, and files can be wrong - Magic Moments
                    came out as whisky. */}
                <div className="span-2">
                  <span>Described as</span>
                  <b className="truncate">
                    {brandTraits.filter((t) => t.dimension === 'category').map((t) => t.label).join(', ') || '—'}
                  </b>
                </div>
              </div>

              {brandTraits.length > 0 && (
                <section className="insp-section">
                  <p className="insp-label">Connected knowledge ({brandTraits.length})</p>
                  <div className="insp-tags">
                    {brandTraits.map((t) => (
                      <button key={t.id} type="button" className="insp-tag"
                        style={{ ['--tag' as string]: colorFor(t) }} onClick={() => goTo(t)}>
                        {t.label}
                      </button>
                    ))}
                  </div>
                </section>
              )}

              {(selected.files?.length ?? 0) > 0 && (
                <section className="insp-section">
                  <p className="insp-label row-between">
                    Latest files <span className="muted">{selected.fileCount} in all</span>
                  </p>
                  <ul className="insp-files">
                    {selected.files!.map((f) => (
                      <li key={f.id}>
                        <Icon name={FILE_ICON[f.fileType.toLowerCase()] ?? 'doc'} size={15} />
                        <span className="grow stack">
                          <span className="truncate">{f.name}</span>
                          <span className="muted">
                            {f.fileType.toUpperCase()}{formatBytes(f.bytes) ? ` · ${formatBytes(f.bytes)}` : ''}
                          </span>
                        </span>
                        <a href={`/api/drive/files/${f.id}/content?disposition=inline`} target="_blank"
                          rel="noreferrer" title="Open this file">
                          <Icon name="arrow-right" size={14} />
                        </a>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {/* A line drawn between two brands is a claim, and a claim
                  nobody can check is worse than no claim - so what both were
                  described as is listed under every score. */}
              {resemblances.length > 0 && (
                <section className="insp-section">
                  <p className="insp-label">Most alike in the portfolio</p>
                  {resemblances.slice(0, 3).map((r) => (
                    <div key={r.other} className="insp-alike">
                      <div className="row-between">
                        <button type="button" onClick={() => goTo(nodeById.get(`brand:${r.other}`))}>
                          {r.other}
                        </button>
                        <b>{Math.round(r.score * 100)}% alike</b>
                      </div>
                      <i><span style={{ width: `${Math.max(4, Math.round(r.score * 100))}%` }} /></i>
                      {r.shared.length > 0 && <p>Both: {r.shared.join(', ')}</p>}
                    </div>
                  ))}
                </section>
              )}

              <div className="insp-actions">
                {onOpenBrand && (
                  <button type="button" className="btn btn-primary btn-sm insp-cta"
                    onClick={() => onOpenBrand(selected.label)}>
                    Open {selected.label}&apos;s full brain <Icon name="arrow-right" size={14} />
                  </button>
                )}
                <button type="button" className="btn btn-sm"
                  onClick={() => setIsolated(isolated === selected.id ? null : selected.id)}>
                  {isolated === selected.id ? 'Show everything' : 'Isolate its cluster'}
                </button>
                {selected.expandable && !expanded.has(selected.id) && (
                  <button type="button" className="btn btn-sm" disabled={busy}
                    onClick={() => void expand(selected)}>
                    Show its files on the graph
                  </button>
                )}
                {expanded.has(selected.id) && (
                  <button type="button" className="btn btn-sm" onClick={() => collapse(selected)}>
                    Hide its files
                  </button>
                )}
              </div>
            </>
          ) : selected.type === 'trait' ? (
            /* A trait: which brands share it. */
            <>
              <div className="insp-hero">
                <span className="insp-planet" style={{ ['--tag' as string]: colorFor(selected) }} />
                <div className="stack">
                  <h3 className="insp-title">{selected.label}</h3>
                  <span className="insp-pill" style={{ ['--tag' as string]: colorFor(selected) }}>
                    {selected.dimension ?? 'shared trait'}
                  </span>
                </div>
              </div>

              <section className="insp-section">
                <p className="insp-label">Shared by {onThisHub.length} brands</p>
                <div className="insp-brandlist">
                  {onThisHub.map((name) => {
                    const node = nodeById.get(`brand:${name}`);
                    return (
                      <button key={name} type="button" onClick={() => goTo(node)}>
                        {node && <BrandBadge size={12} />}
                        <span className="grow truncate">{name}</span>
                      </button>
                    );
                  })}
                </div>
              </section>

              <div className="insp-actions">
                <button type="button" className="btn btn-sm"
                  onClick={() => setIsolated(isolated === selected.id ? null : selected.id)}>
                  {isolated === selected.id ? 'Show everything' : 'Isolate its brands'}
                </button>
              </div>
            </>
          ) : (
            /* Files, folders, sources and passages: what they are, and where to go. */
            <>
              <div className="insp-hero">
                <span className="insp-kindbadge" style={{ ['--tag' as string]: colorFor(selected) }}>
                  <Icon
                    name={selected.type === 'file' ? (FILE_ICON[(selected.fileType ?? '').toLowerCase()] ?? 'doc') : TYPE_ICON[selected.type]}
                    size={18}
                  />
                </span>
                <div className="stack">
                  <h3 className="insp-title insp-title-long">{selected.label}</h3>
                  <span className="insp-pill" style={{ ['--tag' as string]: colorFor(selected) }}>
                    {selected.type === 'file'
                      ? FILE_KIND_LABEL[fileKindOf(selected.fileType)]
                      : selected.type === 'chunk' ? 'passage' : selected.type}
                  </span>
                </div>
              </div>

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
                      if (file) goTo(file);
                      else note('That passage came from a file that is not on the canvas yet.');
                    }}>
                    Open source
                  </button>
                )}
                {selected.type === 'folder' && (
                  <a className="btn btn-sm" href={`/drive?folder=${selected.id}`}>Open in Drive</a>
                )}
              </div>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}

/** A brand in the inspector: the same gold orb its node is on the canvas. */
function BrandBadge({ size }: { size: number }) {
  return <span className="insp-orb" style={{ width: size, height: size }} aria-hidden />;
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

/**
 * How big a node draws. Weight comes from the server, from real counts.
 *
 * A brand is a badge with its logo in it, so it is drawn a good deal larger
 * than a dot has to be: a logo at the size of a dot is not a logo.
 */
function radiusFor(node: SimNode, size = 1): number {
  if (node.type === 'brand') return Math.min(7 + Math.sqrt(node.weight) * 1.6, 14) * size;
  if (node.type === 'trait' && !node.dimension) return Math.min(2.5 + Math.sqrt(node.weight) * 1.1, 6) * size;
  return Math.min(3 + Math.sqrt(node.weight) * 1.9, 13) * size;
}

/**
 * Room a node needs around it: its dot, and its name for the kinds that are
 * always named. Without this the layout only pushed dots apart, and thirty
 * labels settled on top of one another in a knot in the middle of the canvas.
 *
 * A name is wider than it is tall, and a circle of room has to cover its
 * width: "Royal Ranthambore" needs far more than "rum". Measured roughly, at
 * the size names are drawn when the graph is fitted to the screen.
 */
function roomFor(node: SimNode, size = 1): number {
  const radius = radiusFor(node, size);
  const name = (node.label ?? '').length;
  if (node.type === 'brand') return Math.max(radius + 22, name * 3.6 + 8);
  if (node.type === 'trait' && node.dimension) return Math.max(radius + 16, name * 3.2 + 6);
  return radius + 6;
}

/**
 * Keeps nodes from overlapping.
 *
 * A d3 force in the shape react-force-graph expects: called every tick with
 * the simulation's heat, handed the nodes once. Pairwise, which is fine at the
 * size these graphs are - a few dozen brands, a few hundred files - and saves
 * pulling in d3-force for the one function.
 */
function collide(size = 1, strength = 0.7) {
  let nodes: SimNode[] = [];
  // Worked out once, not per pair per tick: a node's room depends on its kind
  // and its name, neither of which moves. Recomputing it inside the pair loop
  // was most of what made Files and Everything take a second to appear.
  let rooms: number[] = [];
  let widest = 0;
  const force = (alpha: number) => {
    // Swept left to right: once the next node is further away across than any
    // two rooms can reach, so is every node after it.
    const order = nodes.map((_, i) => i).sort((p, q) => (nodes[p]!.x ?? 0) - (nodes[q]!.x ?? 0));
    for (let oi = 0; oi < order.length; oi += 1) {
      const i = order[oi]!;
      const a = nodes[i]!;
      const ax = a.x ?? 0;
      const ay = a.y ?? 0;
      const reach = rooms[i]! + widest;
      for (let oj = oi + 1; oj < order.length; oj += 1) {
        const j = order[oj]!;
        const b = nodes[j]!;
        let dx = (b.x ?? 0) - ax;
        if (dx > reach) break;
        let dy = (b.y ?? 0) - ay;
        const min = rooms[i]! + rooms[j]!;
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
    rooms = given.map((node) => roomFor(node, size));
    widest = rooms.reduce((most, room) => Math.max(most, room), 0);
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

/**
 * A brand, drawn as Obsidian draws a note - a plain round node, sized by how
 * much it connects to - and dressed in the portfolio's gold: lit from the top
 * left like a pearl, with a fine dark rim and a soft shadow. Logos were tried
 * and read as clutter at this size; the name beneath says whose it is.
 */
function drawBrand(
  node: SimNode,
  ctx: CanvasRenderingContext2D,
  scale: number,
  radius: number,
  focus: boolean,
): void {
  const x = node.x ?? 0;
  const y = node.y ?? 0;

  ctx.save();
  ctx.shadowColor = focus ? 'rgba(232, 204, 140, 0.45)' : 'rgba(0, 0, 0, 0.5)';
  ctx.shadowBlur = focus ? 14 : 8;
  ctx.shadowOffsetY = focus ? 0 : 2;
  const orb = ctx.createRadialGradient(x - radius * 0.35, y - radius * 0.4, radius * 0.08, x, y, radius);
  orb.addColorStop(0, '#f5e8c6');
  orb.addColorStop(0.55, '#d5b87d');
  orb.addColorStop(1, '#a3834c');
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, 2 * Math.PI);
  ctx.fillStyle = orb;
  ctx.fill();
  ctx.restore();

  ctx.beginPath();
  ctx.arc(x, y, radius, 0, 2 * Math.PI);
  ctx.lineWidth = Math.max(1 / scale, radius * 0.08);
  ctx.strokeStyle = 'rgba(16, 14, 11, 0.55)';
  ctx.stroke();

  // Pointed at: a fine gold ring a little way out, as Obsidian rings a
  // hovered node.
  if (focus) {
    ctx.beginPath();
    ctx.arc(x, y, radius + 4 / scale, 0, 2 * Math.PI);
    ctx.lineWidth = 1.2 / scale;
    ctx.strokeStyle = 'rgba(232, 204, 140, 0.6)';
    ctx.stroke();
  }
}

/**
 * A trait: a plain dot of its kind's colour with a fine dark rim, a size down
 * from the brands. Kinds are told apart by colour alone, as Obsidian's groups
 * are.
 */
function drawTrait(
  node: SimNode,
  ctx: CanvasRenderingContext2D,
  scale: number,
  radius: number,
  color: string,
): void {
  const x = node.x ?? 0;
  const y = node.y ?? 0;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, 2 * Math.PI);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = Math.max(1 / scale, radius * 0.12);
  ctx.strokeStyle = 'rgba(16, 14, 11, 0.7)';
  ctx.stroke();
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
    nodeSize: number;
    textFade: number;
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
  const radius = radiusFor(node, state.nodeSize) * (isFocus ? 1.25 : 1);

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

  if (node.type === 'brand') {
    drawBrand(node, ctx, scale, radius, isFocus);
  } else if (node.type === 'trait' && node.dimension) {
    drawTrait(node, ctx, scale, radius, color);
  } else {
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, 2 * Math.PI);
    ctx.fillStyle = color;
    ctx.fill();
  }

  // The one that is open in the inspector wears a slowly turning orbit in its
  // own colour, so it can be found again after looking away.
  if (isSelected) {
    const turn = typeof performance === 'undefined' ? 0 : performance.now() / 45;
    ctx.save();
    ctx.setLineDash([5 / scale, 4 / scale]);
    ctx.lineDashOffset = -turn / scale;
    ctx.beginPath();
    ctx.arc(x, y, radius + 7 / scale + 3, 0, 2 * Math.PI);
    ctx.lineWidth = 1.5 / scale;
    ctx.strokeStyle = hexWithAlpha(color, 0.95);
    ctx.stroke();
    ctx.restore();
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
  // The text fade threshold moves every kind's fade-in nearer or further, as
  // if the graph were zoomed that much more or less.
  const fadeScale = scale * Math.pow(2, state.textFade * 1.5);
  // A folder of a hundred and fifty files, lit, named all hundred and fifty
  // at once in a pile nobody could read. Past a couple of dozen neighbours,
  // files and passages keep to the zoom's rule and only the rest are named.
  const crowded = focused && state.lit.size > 24 && !isFocus && (node.type === 'file' || node.type === 'chunk');
  const opacity = focused
    ? (inLight ? (crowded ? labelOpacity(node, fadeScale) : 1) : 0)
    : Math.max(labelOpacity(node, fadeScale), isSelected ? 1 : 0);
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
    ctx.strokeStyle = 'rgba(16, 14, 11, 0.9)';
    ctx.lineJoin = 'round';
    ctx.strokeText(label, x, top);
    ctx.fillStyle = isFocus || isSelected
      ? '#ffffff'
      : node.type === 'brand'
        ? 'rgba(243, 237, 226, 0.95)'
        : 'rgba(211, 200, 182, 0.8)';
    ctx.fillText(label, x, top);
  }

  ctx.globalAlpha = 1;
}

/** A #rrggbb colour at a given opacity, for lines that take a node's colour. */
function hexWithAlpha(hex: string, alpha: number): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(value >> 16) & 255},${(value >> 8) & 255},${value & 255},${alpha})`;
}
