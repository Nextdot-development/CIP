'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { useWorkspace } from '@/context/workspace';
import { useAskSeed } from '@/context/NavContext';
import { useToast } from '@/context/toast';
import { Card, EmptyState, Pill } from '../components/ui/Bits';
import { Icon } from '../components/ui/Icon';
import { relativeDay } from '@/lib/format';
import { IMAGE_PROVIDER_LABELS, assetDownloadUrl, assetUrl, exportUrl, isInFlight } from '@/types/media';
import type {
  ImageProviderChoice,
  ImageProviderStatusDTO,
  MediaGenerationDTO,
  MediaType,
  ProviderStatusDTO,
} from '@/types/media';

/**
 * Ask — describe what you want, and CIP makes it out of what it knows.
 *
 * This is the real thing now. The version before it ran a keyword matcher over
 * the typed words, waited 900ms to look like it was thinking, and showed a
 * made-up plan; nothing left the browser. What happens here instead is
 * /api/brain/generate: the request is planned against this company's own
 * memory, the brief that comes out of that is what reaches the generator, and
 * the plan is shown because a person should be able to see what was decided on
 * their behalf before they judge the result.
 *
 * Media is not a separate place any more. Asking for an image and asking for a
 * video are the same act with a different answer, and both are asked for here.
 */

/**
 * Where the request has actually got to.
 *
 * `planning` and `making` are two real stages inside one call — retrieving what
 * the company knows and writing a brief, then asking the generator for the
 * picture — and the server reports the boundary between them rather than the
 * page guessing at it on a timer.
 */
/** How many past results stand open before the rest are folded away. */
const HISTORY_PREVIEW = 3;

/**
 * The sizes on offer.
 *
 * Named for what they are used for, because that is how people ask for them. A
 * size the chosen generator does not make itself stays on the list: CIP makes
 * it on whichever generator does, and cuts it from the nearest when neither
 * does. What it will not do any more is refuse — naming a ratio OpenAI has not
 * got used to be an error instead of a picture.
 *
 * "Auto" is a real choice and the default: CIP reads the size out of the
 * request, and decides from the format when the request does not say.
 */
/** What a shape is called where people work. */
const SHAPE_LABELS: Record<string, string> = {
  '1:1': 'Square 1:1',
  '3:2': 'Landscape 3:2',
  '2:3': 'Portrait 2:3',
  '3:4': 'Portrait 3:4',
  '4:3': 'Landscape 4:3',
  '4:5': 'Portrait 4:5',
  '5:4': 'Landscape 5:4',
  '9:16': 'Story 9:16',
  '16:9': 'Wide 16:9',
  '21:9': 'Ultrawide 21:9',
};

/**
 * The sizes to offer, which is whatever the generator that will run makes.
 *
 * This list used to be written down here, and it offered 4:5, 9:16 and 16:9 —
 * none of which OpenAI makes. Each of those was quietly handed to Gemini, whose
 * account has no image quota at all, so pressing them produced "the image
 * provider is rate limiting us" and nothing else, forever. A picker should only
 * offer work that can be done.
 */
function shapesFor(
  chosen: ImageProviderStatusDTO | null,
): { value: string | null; label: string }[] {
  const own = chosen?.aspectRatios ?? [];
  return [
    { value: null, label: 'Auto' },
    ...own.map((ratio) => ({
      value: ratio,
      label: SHAPE_LABELS[ratio] ?? ratio,
    })),
    // The feed's own shape, whether or not the generator makes it: made at the nearest and cut to it.
    ...(own.includes('4:5') ? [] : [{ value: '4:5', label: SHAPE_LABELS['4:5']! }]),
  ];
}

type Phase = 'idle' | 'planning' | 'making' | 'checking' | 'done';

/** Where the check-and-fix loop is, as the stream reports it. */
type QcStep = { attempt: number; fixing: string[] | null };

/** What the checker said about a picture CIP just made. See generate.ts. */
type GenerationQc = {
  verdict: 'passed' | 'failed' | 'unchecked';
  checkId: string | null;
  broke: { rule: string; message: string; severity: 'critical' | 'warning' }[];
  attempts: number;
  stopped: 'passed' | 'out_of_tries' | 'out_of_time' | 'generation_failed' | 'check_failed' | 'left_to_you';
  earlier: { generationId: string; broke: string[] }[];
};

type PlanSummary = {
  taskType: string | null;
  formatLabel: string;
  aspectRatio: string | null;
  exactShape: boolean;
  deliveredShape: string | null;
  /** Whether anything was actually trimmed off what the generator made. */
  cropped: boolean;
  switchedProvider: { to: ImageProviderChoice; because: string } | null;
  platform: string | null;
  campaign: string | null;
  product: string | null;
  brandRules: string[];
  learnedPreferences: string[];
  avoid: string[];
  mustCarry: string[];
  productShots: string[];
  pendingLessons: { statement: string; evidenceCount: number }[];
  references: { fileId: string; fileName: string }[];
  confidence: number;
};

type StreamEvent =
  | { stage: 'planning' }
  | { stage: 'planned'; plan: PlanSummary; briefId: string }
  | { stage: 'made'; attempt: number; generationId: string }
  | { stage: 'checking'; attempt: number }
  | { stage: 'fixing'; attempt: number; broke: string[] }
  | { stage: 'done'; result: BrainResult }
  | { stage: 'failed'; message: string };

type BrainResult =
  | { status: 'generated'; generation: MediaGenerationDTO; briefId: string; plan: PlanSummary; qc: GenerationQc | null }
  | { status: 'needs_clarification'; briefId: string; question: string; plan: PlanSummary };

export function AskSection({
  initial,
  providers,
  markets,
  brands = [],
  packs = {},
  brandMarkets = {},
  activeBrand = null,
  ideation,
}: {
  /** Concept cards, shown under the heading and above the composer. */
  ideation?: ReactNode;
  initial: MediaGenerationDTO[];
  providers: ProviderStatusDTO;
  /** Markets this company has knowledge about. Empty when nothing is placed. */
  markets: string[];
  /** The company's brands, and the one chosen at the top of the page. */
  brands?: string[];
  /** Each brand's packs from its library: Whytehall → Standard, Chocolate, Fire, Honey, Royal, Collection. */
  packs?: Record<string, string[]>;
  /** Each brand's markets: Magic Moments → Nigeria, Europe. A brand not listed is offered every market. */
  brandMarkets?: Record<string, string[]>;
  activeBrand?: string | null;
}) {
  const workspace = useWorkspace();
  const { seed } = useAskSeed();
  const { note } = useToast();

  const [draft, setDraft] = useState(seed?.text ?? '');
  // A concept chosen above arrives as a new seed while this page is open, and
  // belongs in the box. Adjusted during render rather than in an effect, so
  // the box never shows the old text for a frame first.
  const [seenSeed, setSeenSeed] = useState(seed);
  if (seed !== seenSeed) {
    setSeenSeed(seed);
    if (seed?.text) setDraft(seed.text);
  }
  // CIP makes pictures; video is not offered here.
  const [mediaType] = useState<MediaType>('image');
  // Named explicitly rather than left to the default. Sending no provider is
  // how a request quietly went to a key Google had revoked while a working one
  // sat next to it.
  const [provider, setProvider] = useState<ImageProviderChoice>(providers.defaultImageProvider);
  const [phase, setPhase] = useState<Phase>('idle');
  const [qcStep, setQcStep] = useState<QcStep | null>(null);
  // The latest version made, shown while it is checked.
  const [madeId, setMadeId] = useState<string | null>(null);
  const [result, setResult] = useState<BrainResult | null>(null);
  // Held separately from `result` so the brief can be shown while the picture
  // is still being made.
  const [planned, setPlanned] = useState<PlanSummary | null>(null);
  /** Why the last request produced nothing, kept where the answer would be. */
  const [failure, setFailure] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState(0);
  const [answer, setAnswer] = useState('');
  const [showAll, setShowAll] = useState(false);
  // Left unset on purpose when there is a choice: the Brain asks rather than
  // picking one, because guessing the market is the one mistake that makes
  // everything else in the brief wrong.
  const [market, setMarket] = useState<string | null>(markets.length === 1 ? markets[0]! : null);
  // Null is "let CIP decide", which is what it did before there was a picker.
  const [shape, setShape] = useState<string | null>(null);
  // The brand chosen at the top of the page to start with; unset, the request names it or CIP asks.
  const [brand, setBrand] = useState<string | null>(activeBrand ?? (brands.length === 1 ? brands[0]! : null));
  // Sangam is one of Rampur's: chosen under Rampur, made as Sangam.
  const shownBrands = brands.includes('Rampur') ? brands.filter((b) => b !== 'Sangam') : brands;
  const brandRow = brand === 'Sangam' && brands.includes('Rampur') ? 'Rampur' : brand;
  /** The brand's packs to choose from, Sangam among Rampur's. */
  const packChoices = brandRow
    ? [
        ...(packs[brandRow] ?? []),
        ...(brandRow === 'Rampur' && brands.includes('Sangam') ? ['Sangam'] : []),
        // Magic Moments: several flavours on one background - the background is made, the bottles are set on it in the studio.
        ...(brandRow === 'Magic Moments' && !(packs[brandRow] ?? []).includes('Collection') ? ['Collection'] : []),
      ]
    : [];
  const [pack, setPack] = useState<string | null>(null);
  /** The markets offered: only those the chosen brand is sold in. */
  const marketChoices = brand && brandMarkets[brand]?.length ? brandMarkets[brand]! : markets;
  // A market the newly chosen brand is not sold in is let go, not carried over.
  if (market && !marketChoices.includes(market)) setMarket(null);
  const choosePack = (name: string) => {
    if (brandRow === 'Rampur' && name === 'Sangam') { setBrand(pack === 'Sangam' ? 'Rampur' : 'Sangam'); setPack(pack === 'Sangam' ? null : 'Sangam'); return; }
    if (brandRow === 'Rampur') setBrand('Rampur');
    setPack(pack === name ? null : name);
  };
  // A picture of the person's own to set the post on, instead of one painted for it: free.
  const [ownPicture, setOwnPicture] = useState<File | null>(null);
  const [placing, setPlacing] = useState(false);
  // A picture already made, to carry into the next one. "The same thing at
  // 9:16" used to start again from nothing and come back a different picture.
  const [basedOn, setBasedOn] = useState<{ id: string; prompt: string } | null>(null);
  const [history, setHistory] = useState(initial);

  const chosen = providers.images.find((p) => p.choice === provider) ?? null;
  const videoReady = providers.video.configured;
  const ready = mediaType === 'image' ? Boolean(chosen?.configured) : videoReady;
  // Every size offered is one the post comes back in: the generator's own, or
  // 4:5 made at the nearest of its sizes and cut - so nothing to warn about first.
  const shapes = shapesFor(chosen);
  // A brief's piece arrives with its shape and market: chosen here too, when this page offers them.
  // A shape it cannot make is left to Auto - the request says the size, and the studio exports to it.
  const [lookSeed, setLookSeed] = useState(seed);
  if (seed !== lookSeed) {
    setLookSeed(seed);
    if (seed?.market && markets.includes(seed.market)) setMarket(seed.market);
    if (seed?.brand && brands.includes(seed.brand)) setBrand(seed.brand);
    if (seed && seed.shape !== undefined) setShape(shapes.some((o) => o.value === seed.shape) ? seed.shape ?? null : null);
  }

  const refresh = useCallback(async () => {
    const res = await fetch('/api/media/generations', { cache: 'no-store' });
    if (!res.ok) return;
    const body = (await res.json()) as { generations: MediaGenerationDTO[] };
    setHistory(body.generations);
  }, []);

  // A video is queued rather than returned, so the page has to come back for
  // it. Polling stops as soon as nothing is in flight.
  const waiting = history.some((g) => isInFlight(g.status));
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(refresh, 4000);
    return () => clearInterval(timer);
  }, [waiting, refresh]);

  const send = async (clarification?: string) => {
    const text = draft.trim();
    if (!text) return;

    setResult(null);
    setPlanned(null);
    setFailure(null);
    setQcStep(null);
    setMadeId(null);
    setPhase('planning');
    setStartedAt(Date.now());

    try {
      const res = await fetch('/api/brain/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' },
        body: JSON.stringify({
          request: text,
          mediaType,
          ...(mediaType === 'image' ? { provider } : {}),
          ...(mediaType === 'image' && shape ? { aspectRatio: shape } : {}),
          ...(mediaType === 'image' && basedOn ? { basedOn: basedOn.id } : {}),
          ...(market ? { market } : {}),
          ...(brand ? { brand } : {}),
          ...(pack && pack !== 'Sangam' ? { pack } : {}),
          ...(clarification ? { clarification } : {}),
        }),
      });

      if (!res.ok || !res.body) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        note(body.message ?? 'That could not be made.');
        setPhase('idle');
        return;
      }

      // One JSON object per line. The last one carries the outcome; a stream
      // that ends without it is a failure, not a success.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffered = '';
      let settled = false;

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });

        const lines = buffered.split('\n');
        buffered = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line) as StreamEvent;

          if (event.stage === 'planned') {
            // The brief exists. Show it now rather than holding it back until
            // the picture is ready — it is the half of the answer that
            // explains the other half.
            setPlanned(event.plan);
            setPhase('making');
          } else if (event.stage === 'made') {
            setMadeId(event.generationId);
          } else if (event.stage === 'checking') {
            setQcStep({ attempt: event.attempt, fixing: null });
            setPhase('checking');
          } else if (event.stage === 'fixing') {
            // Back to making: the picture broke a rule and is being made
            // again, and the page says which rule rather than just waiting.
            setQcStep({ attempt: event.attempt, fixing: event.broke });
            setPhase('making');
          } else if (event.stage === 'done') {
            settled = true;
            setResult(event.result);
            setPhase('done');
            setAnswer('');
            if (event.result.status === 'generated') {
              note(mediaType === 'video' ? 'Queued — this takes a few minutes' : 'Made');
              void refresh();
            }
          } else if (event.stage === 'failed') {
            settled = true;
            // Kept on the page as well as announced. A toast disappears, and
            // a request that produced a brief and no picture then looks like
            // nothing happened at all — which is exactly how this was
            // reported: "it is not creating images".
            setFailure(event.message);
            note(event.message);
            setPhase('idle');
          }
        }
      }

      if (!settled) {
        note('That stopped before it finished.');
        setPhase('idle');
      }
    } catch {
      note('That could not be sent.');
      setPhase('idle');
    }
  };

  /**
   * The post set on the person's own picture: the bottle, logo and headline
   * placed on it, layer by layer. Nothing is painted and no model is asked.
   */
  const placeOnOwn = async () => {
    if (!ownPicture) return;
    setPlacing(true);
    setFailure(null);
    const form = new FormData();
    form.append('file', ownPicture);
    form.append('request', draft.trim());
    if (brand) form.append('brand', brand);
    // Left on Auto, the post takes the picture's own shape: a 4:5 photo makes a 4:5 post, not a square.
    form.append('ratio', shape ?? 'auto');
    const res = await fetch('/api/media/own-picture', { method: 'POST', body: form }).catch(() => null);
    setPlacing(false);
    if (!res?.ok) {
      const message = (await res?.json().catch(() => null) as { message?: string } | null)?.message;
      setFailure(message ?? 'The post could not be set on your picture.');
      return;
    }
    note('Made on your picture - free. Arrange it below.');
    setOwnPicture(null);
    void refresh();
  };

  const busy = phase === 'planning' || phase === 'making' || phase === 'checking' || placing;
  // Chosen before anything starts, wherever there is a choice - so CIP never stops to ask.
  const missing = [
    ...(brands.length > 1 && !brand ? ['brand'] : []),
    ...(packChoices.length > 1 && !pack ? ['pack'] : []),
    ...(marketChoices.length > 1 && !market ? ['market'] : []),
  ];

  return (
    <div className="rise">
      <header className="page-head">
        <p className="eyebrow">Campaign Ideation</p>
        <h1>Make something grounded in the brand</h1>
        <p className="lede">
          Describe it the way you would to a colleague. CIP writes the brief from what it has
          learned about {workspace.name}, then makes it.
        </p>
      </header>

      {ideation}

      <Card className="pad">
        <div className="row" style={{ gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>

          {/* Which generator, named rather than assumed. One with no working
              key is shown as unavailable instead of being quietly chosen. */}
          {mediaType === 'image' && providers.images.length > 1 && (
            <span className="row" style={{ gap: 6, marginLeft: 'auto' }}>
              {providers.images.map((p) => (
                <button
                  key={p.choice}
                  type="button"
                  className={`chip ${provider === p.choice ? 'on' : ''}`}
                  onClick={() => setProvider(p.choice)}
                  disabled={!p.configured}
                  title={
                    p.configured
                      ? `${p.provider}/${p.model}`
                      : `${IMAGE_PROVIDER_LABELS[p.choice]} has no key configured`
                  }
                >
                  {IMAGE_PROVIDER_LABELS[p.choice]}
                </button>
              ))}
            </span>
          )}
        </div>

        {/* Which market, when this company has more than one. Unset is a real
            choice: the Brain then asks, instead of averaging three countries
            that do not look alike. */}
        {/* Which brand, when this company has more than one: the one chosen at
            the top of the page to start with. Unset, the request names it or CIP asks. */}
        {brands.length > 1 && (
          <div className="pick-row">
            <span className="pick-step"><b>1</b> Brand</span>
            {shownBrands.map((name) => (
              <button
                key={name}
                type="button"
                className={`chip pick ${brandRow === name ? 'on' : ''}`}
                aria-pressed={brandRow === name}
                onClick={() => { setBrand(brandRow === name ? null : name); setPack(null); }}
              >
                {brandRow === name && <Icon name="check" size={13} />}{name}
              </button>
            ))}
          </div>
        )}

        {packChoices.length > 1 && (
          <div className="pick-row">
            <span className="pick-step"><b>2</b> {brandRow === 'Rampur' ? 'Expression' : 'Flavour / pack'}</span>
            {packChoices.map((name) => (
              <button
                key={name}
                type="button"
                className={`chip pick ${pack === name ? 'on' : ''}`}
                aria-pressed={pack === name}
                onClick={() => choosePack(name)}
                title={name === 'Collection' ? 'Several of its packs together' : undefined}
              >
                {pack === name && <Icon name="check" size={13} />}{name}
              </button>
            ))}
            {!pack && <span className="tiny muted">— its look, its bottle and its lines follow this</span>}
          </div>
        )}

        {marketChoices.length > 1 && (
          <div className="pick-row">
            <span className="pick-step"><b>{packChoices.length > 1 ? 3 : 2}</b> Market</span>
            {marketChoices.map((name) => (
              <button
                key={name}
                type="button"
                className={`chip pick ${market === name ? 'on' : ''}`}
                aria-pressed={market === name}
                onClick={() => setMarket(market === name ? null : name)}
              >
                {market === name && <Icon name="check" size={13} />}{name}
              </button>
            ))}
          </div>
        )}

        {/* The picture being carried forward, and a way out of it. Shown above
            the box because it changes what the words mean: "less text on it"
            is about that picture, not about the brand in general. */}
        {mediaType === 'image' && basedOn && (
          <div className="row" style={{ gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
            <span className="tiny muted">Building on:</span>
            <span className="chip on" title={basedOn.prompt}>
              {basedOn.prompt.slice(0, 60)}
              {basedOn.prompt.length > 60 ? '…' : ''}
            </span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setBasedOn(null)}>
              Start fresh
            </button>
          </div>
        )}

        {/* What shape it has to be. A placement decides this, not the model:
            a story is 9:16 wherever it runs, and asking for one in words and
            hoping was how a banner came back square. */}
        {mediaType === 'image' && (
          <div className="pick-row">
            <span className="pick-step"><b>{(packChoices.length > 1 ? 3 : 2) + (markets.length > 1 ? 1 : 0)}</b> Size</span>
            {shapes.map((option) => (
              <button
                key={option.value ?? '__auto'}
                type="button"
                className={`chip pick ${shape === option.value ? 'on' : ''}`}
                aria-pressed={shape === option.value}
                onClick={() => setShape(option.value)}
                disabled={busy}
                title={
                  option.value === null
                    ? 'CIP reads the size from your request, or decides from the format'
                    : chosen?.aspectRatios.includes(option.value)
                      ? `${IMAGE_PROVIDER_LABELS[chosen.choice]} makes this size directly`
                      : 'Made at the nearest size the generator has, then cut to this one'
                }
              >
                {shape === option.value && <Icon name="check" size={13} />}{option.label}
              </button>
            ))}
          </div>
        )}

        {/* The person's own picture, to set the post on instead of one painted for it: free. */}
        {mediaType === 'image' && (
          <div className="row" style={{ gap: 6, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
            <label className={`chip ${ownPicture ? 'on' : ''} ${busy ? 'is-off' : ''}`} style={{ cursor: 'pointer' }} title="The bottle, logo and headline are set on your picture. Free.">
              <Icon name="upload" size={14} /> {ownPicture ? `Your background: ${ownPicture.name.slice(0, 28)}` : 'Add your own background'}
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                hidden
                disabled={busy}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (!file) return;
                  if (file.size > 15 * 1024 * 1024) { note('That picture is over 15 MB. Bring a smaller one.'); return; }
                  setOwnPicture(file);
                }}
              />
            </label>
            {ownPicture && (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOwnPicture(null)} disabled={busy} aria-label="Remove your background">
                <Icon name="x" size={13} />
              </button>
            )}
            {ownPicture && (
              <span className="tiny muted">
                Say the brand, and put the headline in quotes to use your own words - else one of the brand&apos;s own is used.
              </span>
            )}
          </div>
        )}

        <textarea
          className="field-input"
          rows={4}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={workspace.composerPlaceholder}
          disabled={busy}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send();
          }}
        />

        <div className="row" style={{ justifyContent: 'space-between', marginTop: 12 }}>
          <span className="tiny muted">
            {mediaType === 'image' && ownPicture
              ? 'Set on your picture - nothing is painted, nothing is spent.'
              : ready
              ? mediaType === 'video'
                ? `${providers.video.provider}/${providers.video.model} · queued, takes a few minutes.`
                : `${chosen?.provider}/${chosen?.model} · usually about a minute.`
              : mediaType === 'image'
                ? `${IMAGE_PROVIDER_LABELS[provider]} has no key configured.`
                : 'No video provider is configured.'}
          </span>
          {missing.length > 0 && (
            <span className="tiny" style={{ color: 'var(--warn-700, #b7791f)' }}>Choose the {missing.join(' and the ')} first</span>
          )}
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void (mediaType === 'image' && ownPicture ? placeOnOwn() : send())}
            disabled={busy || missing.length > 0 || (mediaType === 'image' && ownPicture ? false : !draft.trim() || !ready)}
            title={missing.length ? `Choose the ${missing.join(' and the ')} above first - so CIP never has to stop and ask` : undefined}
          >
            {placing ? 'Setting it on your picture…' : busy ? 'Working…' : 'Make it'} <Icon name="arrow-right" size={14} />
          </button>
        </div>
      </Card>

      {busy && <Working phase={phase} mediaType={mediaType} startedAt={startedAt} qcStep={qcStep} draft={madeId} />}

      {failure && (
        <Card className="pad">
          <p className="strong" style={{ marginBottom: 4 }}>
            <Icon name="alert" size={15} /> That did not get made
          </p>
          <p className="small">{failure}</p>
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
            <button type="button" className="btn btn-sm" onClick={() => void send()} disabled={busy}>
              Try again
            </button>
          </div>
        </Card>
      )}

      {result?.status === 'needs_clarification' && (
        <Card className="pad">
          <p className="strong" style={{ marginBottom: 4 }}>
            <Icon name="sparkle" size={15} /> CIP needs to know one thing first
          </p>
          <p className="small" style={{ marginBottom: 12 }}>{result.question}</p>
          <textarea
            className="field-input"
            rows={2}
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            placeholder="Answer in a line or two…"
          />
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => void send(answer.trim())}
              disabled={busy || !answer.trim()}
            >
              Carry on
            </button>
          </div>
        </Card>
      )}

      {result?.status === 'generated' && (
        <Result
          generation={result.generation}
          onRated={() => void refresh()}
          onBuildOn={(g) => setBasedOn({ id: g.id, prompt: g.prompt })}
        />
      )}

      {/* How CIP made it, under the picture and folded away: the picture is
          what a person came for, and the reasoning is there when they want it. */}
      {(result?.plan ?? planned) && <Plan plan={(result?.plan ?? planned)!} />}

      <div className="sec-head">
        <div>
          <h2>Everything you have made</h2>
          <p className="hint">Rate anything here and CIP takes it into the next brief.</p>
        </div>
      </div>

      {history.length === 0 ? (
        <EmptyState
          icon="sparkle"
          title="Nothing made yet"
          copy="Ask for something above. If CIP has not read much of your brand yet, teach it first and the results get sharper."
          action={
            <Link className="btn btn-ghost btn-sm" href="/teach">
              Teach CIP <Icon name="arrow-right" size={14} />
            </Link>
          }
        />
      ) : (
        <>
          <div className="gen-list">
            {history.slice(0, showAll ? history.length : HISTORY_PREVIEW).map((g) => (
              <Result
                key={g.id}
                generation={g}
                compact
                onRated={() => void refresh()}
                onBuildOn={(chosen) => {
                  setBasedOn({ id: chosen.id, prompt: chosen.prompt });
                  window.scrollTo({ top: 0, behavior: 'smooth' });
                }}
              />
            ))}
          </div>

          {history.length > HISTORY_PREVIEW && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              style={{ marginTop: 12 }}
              onClick={() => setShowAll((open) => !open)}
            >
              {showAll
                ? 'Show less'
                : `Show ${history.length - HISTORY_PREVIEW} more`}
              <Icon
                name="chevron-down"
                size={14}
                className={showAll ? 'flip' : undefined}
              />
            </button>
          )}
        </>
      )}
    </div>
  );
}

/**
 * The wait, with the two stages the server actually reports.
 *
 * Both are real: the first ends when the brief is written, which the stream
 * says out loud. Nothing here advances on a timer, so a slow generator shows a
 * step still running rather than a bar that has quietly finished without it.
 *
 * The elapsed seconds are the honest part of a wait nobody can predict — a
 * picture is about a minute, a video several, and neither provider will say.
 */
function Working({
  phase, mediaType, startedAt, qcStep, draft,
}: {
  phase: Phase;
  mediaType: MediaType;
  startedAt: number;
  qcStep: QcStep | null;
  /** The version made so far, if any. */
  draft: string | null;
}) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const tick = () => setElapsed(Math.max(0, Math.round((Date.now() - startedAt) / 1000)));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [startedAt]);

  const steps: { id: Phase; label: string; done: string }[] = [
    { id: 'planning', label: 'Reading what it knows about you', done: 'Read your brand' },
    {
      id: 'making',
      label: mediaType === 'video'
        ? 'Sending it to the video generator'
        : qcStep?.fixing
          ? `Making it again, fixing what broke the rules (try ${qcStep.attempt})`
          : 'Making the picture',
      done: mediaType === 'video' ? 'Sent to the generator' : 'Made the picture',
    },
    // A video is checked by the worker once it exists, minutes from now.
    ...(mediaType === 'image'
      ? [{ id: 'checking' as Phase, label: 'Checking it against every QC rule', done: 'Checked' }]
      : []),
  ];

  return (
    <Card className="pad working">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
        <p className="strong">CIP is working on it</p>
        <span className="tiny muted">{elapsed}s</span>
      </div>

      <ol className="work-steps">
        {steps.map((step) => {
          const index = steps.findIndex((x) => x.id === phase);
          const own = steps.findIndex((x) => x.id === step.id);
          const state = own < index ? 'done' : own === index ? 'now' : 'next';

          return (
            <li key={step.id} className={`work-step ${state}`}>
              <span className="ws-mark" aria-hidden>
                {state === 'done' ? <Icon name="check" size={13} /> : <span className="ws-dot" />}
              </span>
              <span className="ws-label">{state === 'done' ? step.done : step.label}</span>
            </li>
          );
        })}
      </ol>

      {qcStep?.fixing && (
        <p className="tiny" style={{ marginTop: 8 }}>
          <Icon name="alert" size={13} /> The last version broke: {qcStep.fixing.join('; ')}
        </p>
      )}

      {/* The version made so far, while it is checked or made again - or a
          placeholder in the shape of what is coming, so the page does not
          jump when it arrives. */}
      {draft ? (
        <figure className="work-draft">
          <img src={assetUrl(draft)} alt="The version made so far" />
          <figcaption className="tiny muted">
            {qcStep?.fixing
              ? 'The last version. A fixed one is being made; the final one replaces it.'
              : 'Made. CIP is checking it against the rules before handing it over.'}
          </figcaption>
        </figure>
      ) : (
        <div className="work-skeleton" aria-hidden />
      )}

      <p className="tiny muted">
        {mediaType === 'video'
          ? 'Video takes a few minutes. You can leave this page — it keeps going.'
          : 'Usually about a minute, and more when a version has to be made again to pass QC.'}
      </p>
    </Card>
  );
}

/** What CIP decided to make, and what it leaned on to decide it. */
function Plan({ plan }: { plan: PlanSummary }) {
  const context = [plan.campaign, plan.product, plan.platform].filter(Boolean);
  const shape = plan.deliveredShape ?? plan.aspectRatio;
  const noPhoto = !(plan.productShots?.length > 0);

  // At most three of each, short: the full brief is not what a person reads.
  const few = (items: string[]) => {
    const unique = [...new Set(items)];
    return { shown: unique.slice(0, 3), more: Math.max(0, unique.length - 3) };
  };
  const sections: { title: string; items: string[] }[] = [
    { title: 'Add at layout, not in the picture', items: plan.mustCarry ?? [] },
    { title: 'Brand rules followed', items: plan.brandRules },
    { title: 'From your feedback', items: plan.learnedPreferences },
    { title: 'Avoided', items: plan.avoid },
  ];

  return (
    <details className="card pad plan-fold">
      <summary className="row" style={{ justifyContent: 'space-between', gap: 8, cursor: 'pointer' }}>
        <span className="small">
          <strong>How CIP made this</strong>
          <span className="muted"> · {[plan.formatLabel, ...context, shape].filter(Boolean).join(' · ')}</span>
          {noPhoto && <span style={{ color: 'var(--warn-700)' }}> · ⚠ no product photo</span>}
        </span>
        <span className="row" style={{ gap: 8 }}>
          <Pill tone={plan.confidence >= 0.6 ? 'ok' : 'warn'}>{Math.round(plan.confidence * 100)}% sure</Pill>
          <Icon name="chevron-down" size={14} className="plan-chevron" />
        </span>
      </summary>

      <div style={{ marginTop: 10 }}>
        {noPhoto ? (
          <p className="small" style={{ color: 'var(--warn-700)' }}>
            <Icon name="alert" size={13} /> No photo of this product, so the bottle is made up. Add one under
            {' '}&ldquo;Add data to brain&rdquo;.
          </p>
        ) : (
          <p className="small muted">
            <Icon name="image" size={13} /> Used your product photo: {plan.productShots[0]!.replace(/\.[a-z0-9]+$/i, '')}
          </p>
        )}

        {plan.switchedProvider && (
          <p className="small muted">Made with {IMAGE_PROVIDER_LABELS[plan.switchedProvider.to]}: {plan.switchedProvider.because}.</p>
        )}
        {!plan.exactShape && !plan.deliveredShape && (
          <p className="small" style={{ color: 'var(--warn-700)' }}>
            <Icon name="alert" size={13} /> Closest shape the generator makes{plan.aspectRatio ? ` (${plan.aspectRatio})` : ''}.
          </p>
        )}

        {sections.filter((x) => x.items.length > 0).map((section) => {
          const { shown, more } = few(section.items);
          return (
            <div className="plan-block" key={section.title}>
              <p className="tiny muted">{section.title}</p>
              {shown.map((item) => <p className="small" key={item}>· {item}</p>)}
              {more > 0 && <p className="tiny muted">+{more} more</p>}
            </div>
          );
        })}

        {plan.references.length > 0 && (
          <p className="tiny muted" style={{ marginTop: 8 }}>
            Based on {plan.references.length} of your file{plan.references.length === 1 ? '' : 's'}
          </p>
        )}
      </div>
    </details>
  );
}

/**
 * What a size that this generator does not make will actually produce.
 *
 * Both outcomes are honest and neither is an error: another configured
 * generator makes it exactly, or the nearest shape is made and cut down.
 */

type HeadlineLine = NonNullable<MediaGenerationDTO['headline']>[number];

const LINE_PARTS: { role: HeadlineLine['role']; label: string }[] = [
  { role: 'lead', label: 'Main' },
  { role: 'key', label: 'Highlight' },
  { role: 'tail', label: 'Closing' },
];

/**
 * The headline of a composed post, line by line, to set again on the same
 * scene. Saved as a new version beside this one, in a second or two.
 */
function TextEditor({ generation, lines: initial, onDone, onSave, saveLabel = 'Save as new version', hint, fonts, inks }: {
  generation: MediaGenerationDTO;
  lines: HeadlineLine[];
  onDone: () => void;
  /** Saves the lines another way - on the post itself, for one arranged layer by layer. */
  onSave?: (lines: HeadlineLine[]) => Promise<boolean>;
  saveLabel?: string;
  hint?: string;
  /** Faces a line may be set in on its own; none offered when not given. */
  fonts?: { id: string; label: string; own: boolean }[];
  /** Colours a line may take on its own - the brand's; none offered when not given. */
  inks?: string[];
}) {
  const { note } = useToast();
  const [lines, setLines] = useState<HeadlineLine[]>(initial);
  const [saving, setSaving] = useState(false);
  const set = (i: number, change: Partial<HeadlineLine>) =>
    setLines((all) => all.map((l, n) => (n === i ? { ...l, ...change } : l)));
  /**
   * A line's part or face, changed and set on the post at once where the post
   * is arranged here - choosing "Highlight" did nothing until the button was
   * pressed, and looked broken. Words still wait for the button: half a word is not a headline.
   */
  const setNow = (i: number, change: Partial<HeadlineLine>) => {
    const next = lines.map((l, n) => (n === i ? { ...l, ...change } : l));
    setLines(next);
    const filled = next.filter((l) => l.text.trim());
    if (onSave && filled.length) void onSave(filled);
  };
  const filled = lines.filter((l) => l.text.trim());

  const save = async () => {
    setSaving(true);
    if (onSave) {
      const ok = await onSave(filled);
      setSaving(false);
      if (ok) onDone();
      return;
    }
    const res = await fetch(`/api/media/generations/${generation.id}/text`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lines: filled }),
    });
    setSaving(false);
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { message?: string } | null;
      note(body?.message ?? 'The text could not be changed.');
      return;
    }
    note('New version made with your text');
    onDone();
  };

  return (
    <div className="stack" style={{ marginTop: 12, gap: 8 }}>
      <span className="tiny muted">
        {hint ?? 'Same picture, bottle and logo - only the words change. Capitals are set for you.'}
      </span>
      {lines.map((line, i) => (
        <div key={i} className="headline-line">
          <div className="row" style={{ gap: 8 }}>
            <input
              className="field-input grow"
              value={line.text}
              maxLength={80}
              onChange={(e) => set(i, { text: e.target.value })}
              aria-label={`Line ${i + 1}`}
            />
            {lines.length > 1 && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setLines((all) => all.filter((_, n) => n !== i))}
                aria-label={`Remove line ${i + 1}`}
              >
                <Icon name="x" size={14} />
              </button>
            )}
          </div>
          <div className="row headline-line-look" style={{ gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <select
            className="field-input"
            style={{ width: 118, padding: '6px 8px' }}
            value={line.role}
            onChange={(e) => setNow(i, { role: e.target.value as HeadlineLine['role'] })}
            aria-label={`Line ${i + 1} style`}
          >
            {LINE_PARTS.map((p) => <option key={p.role} value={p.role}>{p.label}</option>)}
          </select>
          {fonts && fonts.length > 0 && (
            <select
              className="field-input"
              style={{ width: 160, padding: '6px 8px' }}
              value={line.font ?? ''}
              onChange={(e) => {
                const font = e.target.value;
                setNow(i, font ? { font } : { font: undefined });
              }}
              aria-label={`Line ${i + 1} font`}
              title="This line's own font - or the headline's"
            >
              <option value="">Headline&apos;s font</option>
              {fonts.map((f) => <option key={f.id} value={f.id}>{f.label}{f.own ? '' : ' ≈'}</option>)}
            </select>
          )}
          {inks && inks.length > 0 && (
            <span className="row headline-line-inks" role="group" aria-label={`Line ${i + 1} colour`}>
              <button
                type="button"
                className={`headline-ink is-auto ${!line.ink ? 'is-on' : ''}`}
                onClick={() => line.ink && setNow(i, { ink: undefined })}
                title="The headline's colour"
                aria-pressed={!line.ink}
              >
                Aa
              </button>
              {inks.map((ink) => (
                <button
                  key={ink}
                  type="button"
                  className={`headline-ink ${line.ink === ink ? 'is-on' : ''}`}
                  style={{ background: ink }}
                  onClick={() => line.ink !== ink && setNow(i, { ink })}
                  title={`This line in ${ink}`}
                  aria-label={`Line ${i + 1} in ${ink}`}
                  aria-pressed={line.ink === ink}
                />
              ))}
            </span>
          )}
          </div>
        </div>
      ))}
      <div className="row" style={{ gap: 8 }}>
        {lines.length < 4 && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setLines((all) => [...all, { text: '', role: 'lead' }])}
          >
            Add a line
          </button>
        )}
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={() => void save()}
          disabled={saving || filled.length === 0}
        >
          {saving ? 'Setting the text…' : saveLabel}
        </button>
      </div>
    </div>
  );
}

type Layers = NonNullable<MediaGenerationDTO['layers']>;
type LayerName = 'background' | 'shadow' | 'reflection' | 'bottle' | 'pictures' | 'headline' | 'texts' | 'logo';
/**
 * A piece's box in fractions of the post, how far it is turned (degrees,
 * clockwise) for one that turns, and the point it turns and sizes about when
 * that is not its middle - the shadow's is the bottle's foot.
 */
type Frac = { x: number; y: number; w: number; h: number; r?: number; px?: number; py?: number };
type BasePiece = 'bottle' | 'shadow' | 'reflection' | 'logo' | 'text';
/** A piece on the post: one of its own, a block of text a person added - "t:" and its id - or a picture they added, "p:". */
type Piece = BasePiece | `t:${string}` | `p:${string}`;
const isBlock = (piece: Piece): piece is `t:${string}` => piece.startsWith('t:');
const isPic = (piece: Piece): piece is `p:${string}` => piece.startsWith('p:');
/** A picture a person laid on the post - a glass, ice - from Drive: its place, width, shape and look. */
type PictureC = {
  id: string; file?: string; shape?: ShapeC; aspect: number; x: number; y: number; w: number;
  rotate?: number; flip?: boolean; opacity?: number; bright?: number; shadow?: number;
  crop?: { l: number; t: number; r: number; b: number }; feather?: number; tint?: string; tintAmount?: number;
  /** A shadow on the surface at its foot: 0 to 1. */
  ground?: number;
  /** Its reflection on a glossy surface: 0 to 1. */
  mirror?: number;
  groundSoft?: number;
  mirrorSoft?: number;
};
/** A shape laid on the post: a box, a band, a badge, a button - with words, for the last two. */
type ShapeC = { kind: 'rect' | 'round' | 'circle' | 'line' | 'badge' | 'button'; fill: string; stroke?: string; strokeW?: number; text?: string; ink?: string; font?: string };
/** Letter and line spacing, an outline and a second colour, for any words. */
type TextLookC = { spacing?: number; lineHeight?: number; stroke?: number; strokeInk?: string; ink2?: string };
/** A shape drawn by the server exactly as the post will have it, at the size it is shown. */
const shapeSrc = (shape: ShapeC, w: number, h: number) =>
  `/api/media/shape?s=${encodeURIComponent(JSON.stringify(shape))}&w=${Math.max(4, Math.round(w / 20) * 20)}&h=${Math.max(4, Math.round(h / 20) * 20)}`;
const pictureSrc = (pic: PictureC, size?: number) => (pic.shape
  ? shapeSrc(pic.shape, 240, 240 * pic.aspect)
  : `/api/drive/files/${pic.file}/content${size ? `?size=${size}` : '?disposition=inline'}`);
/** Text a person added besides the headline: its lines, place and look. */
type TextBlockC = {
  id: string; lines: HeadlineLine[]; x: number; y: number; width: number; size: number;
  align: 'left' | 'center' | 'right'; weight: 'regular' | 'bold' | 'black'; italic: boolean; upper: boolean; shadow: boolean;
  font?: string; ink?: string;
} & TextLookC;
/** The pieces that hang from the bottle's foot: each moves, sizes and turns about it, on its own. */
type FromFoot = 'shadow' | 'reflection';
const FROM_FOOT = new Set<Piece>(['shadow', 'reflection']);
type Placement = {
  bottle?: { cx: number; base: number; height: number; rotate?: number };
  shadow?: { dx: number; dy: number; scale: number; rotate: number };
  reflection?: { dx: number; dy: number; scale: number; rotate: number };
  logo?: { x: number; y: number; w: number; rotate?: number };
  text?: { x: number; y: number; scale: number };
};
type Manifest = {
  width: number;
  height: number;
  version: string;
  /** `v` is what the layer holds: it changes only when that layer does. */
  layers: { name: LayerName; present: boolean; v?: string }[];
  boxes: {
    bottle: Frac | null; shadow?: Frac | null; shadowPivot?: { x: number; y: number } | null;
    reflection?: Frac | null; reflectionPivot?: { x: number; y: number } | null;
    logo: Frac | null; text: Frac | null; textAnchor: { x: number } | null;
    texts?: { id: string; x: number; y: number; w: number; h: number }[];
  };
  choices: { bottle: Layers['bottle']; size: Layers['size']; logo: Layers['logo']; headline?: 'shown' | 'none'; place?: Placement; style?: PostStyle; texts?: TextBlockC[]; pictures?: PictureC[]; order?: StackGroupC[]; locked?: string[]; bottleFile?: string; logoFile?: string };
  /** What measuring the post found to look at, each with the change that puts it right when there is one. */
  checks?: (string | { text: string; fix?: { choices: Record<string, unknown> } })[];
};

/** How the headline and the bottle look, as a person set them. */
type PostStyle = {
  ink?: string; align?: 'left' | 'center' | 'right'; textSize?: number; font?: string;
  backing?: 'none' | 'box'; backingInk?: string;
  shadow?: number; bright?: number; shadowSoft?: number; shadowAngle?: number; shadowLength?: number;
  reflection?: number; reflectionSoft?: number;
  logoBright?: number; logoShadow?: number; logoOpacity?: number; bgBright?: number; bgBlur?: number;
  logoTone?: 'light' | 'dark' | 'colour';
  bottleCrop?: { l: number; t: number; r: number; b: number };
  logoCrop?: { l: number; t: number; r: number; b: number };
  bgZoom?: number; bgX?: number; bgY?: number; bgFlip?: boolean; bgOverlay?: string; bgOverlayAmount?: number; bgVignette?: number;
  warmth?: number; contrast?: number; saturation?: number;
  textSpacing?: number; textLeading?: number; textStroke?: number; textStrokeInk?: string; ink2?: string;
};
type SlideKey = 'textSize' | 'shadow' | 'bright' | 'shadowSoft' | 'shadowAngle' | 'shadowLength' | 'reflection' | 'reflectionSoft'
  | 'logoBright' | 'logoShadow' | 'logoOpacity' | 'bgBright' | 'bgBlur'
  | 'bgZoom' | 'bgX' | 'bgY' | 'bgOverlayAmount' | 'bgVignette' | 'warmth' | 'contrast' | 'saturation';
/** Ready-made looks for the whole post: one click, and each slider still free to change after. */
const POST_LOOKS: { label: string; style: Partial<Record<'warmth' | 'contrast' | 'saturation', number | null>> }[] = [
  { label: 'Natural', style: { warmth: null, contrast: null, saturation: null } },
  { label: 'Warm', style: { warmth: 0.45, contrast: 0.06, saturation: 0.1 } },
  { label: 'Cool', style: { warmth: -0.45, contrast: 0.06, saturation: null } },
  { label: 'Punchy', style: { warmth: null, contrast: 0.25, saturation: 0.35 } },
  { label: 'Muted', style: { warmth: 0.1, contrast: -0.1, saturation: -0.4 } },
  { label: 'Classic', style: { warmth: null, contrast: 0.15, saturation: -1 } },
];
/** The pieces that can lie over or under one another, from the bottom up as CIP lays them. */
const STACK_C = ['bottle', 'pictures', 'headline', 'texts', 'logo'] as const;
type StackGroupC = (typeof STACK_C)[number];
const STACK_LAYERS: Record<StackGroupC, LayerName[]> = { bottle: ['shadow', 'reflection', 'bottle'], pictures: ['pictures'], headline: ['headline'], texts: ['texts'], logo: ['logo'] };
/** An order made whole, as the server makes it: a piece it does not name goes where it usually lies. */
function stackOfC(order?: readonly StackGroupC[] | null): StackGroupC[] {
  if (!order?.length) return [...STACK_C];
  const out = order.filter((g, i) => STACK_C.includes(g) && order.indexOf(g) === i);
  STACK_C.forEach((g, i) => {
    if (out.includes(g)) return;
    out.splice(i > 0 ? out.indexOf(STACK_C[i - 1]!) + 1 : 0, 0, g);
  });
  return out;
}

/** A look set by sliding, as an editor has it: its range, where "as designed" is, and how it reads. */
const SLIDES: Record<SlideKey, { label: string; min: number; max: number; step: number; plain: number | null; shows: (v: number) => string }> = {
  shadow: { label: 'Strength', min: 0, max: 3, step: 0.05, plain: 1, shows: (v) => `${Math.round(v * 100)}%` },
  shadowSoft: { label: 'Softness', min: 0.2, max: 3, step: 0.05, plain: 1, shows: (v) => `${Math.round(v * 100)}%` },
  shadowAngle: { label: 'Direction', min: -1.6, max: 1.6, step: 0.05, plain: null, shows: (v) => (Math.abs(v) < 0.05 ? 'Straight back' : v < 0 ? `Left ${Math.round(-v * 100 / 1.6)}%` : `Right ${Math.round(v * 100 / 1.6)}%`) },
  logoBright: { label: 'Light on the logo', min: -0.4, max: 0.4, step: 0.01, plain: 0, shows: (v) => (v === 0 ? 'As it is' : `${v > 0 ? '+' : ''}${Math.round(v * 100)}%`) },
  logoShadow: { label: 'Shadow', min: 0, max: 2, step: 0.05, plain: 0, shows: (v) => (v === 0 ? 'None' : `${Math.round(v * 100)}%`) },
  logoOpacity: { label: 'Opacity', min: 0.15, max: 1, step: 0.01, plain: 1, shows: (v) => `${Math.round(v * 100)}%` },
  bgBright: { label: 'Light', min: -0.5, max: 0.5, step: 0.01, plain: 0, shows: (v) => (v === 0 ? 'As painted' : `${v > 0 ? '+' : ''}${Math.round(v * 100)}%`) },
  bgBlur: { label: 'Soft focus', min: 0, max: 1, step: 0.02, plain: 0, shows: (v) => (v === 0 ? 'Sharp' : `${Math.round(v * 100)}%`) },
  bgZoom: { label: 'Zoom', min: 1, max: 3, step: 0.02, plain: 1, shows: (v) => (v === 1 ? 'As made' : `${Math.round(v * 100)}%`) },
  bgX: { label: 'Across', min: -1, max: 1, step: 0.02, plain: 0, shows: (v) => (v === 0 ? 'Middle' : `${v < 0 ? 'Left' : 'Right'} ${Math.round(Math.abs(v) * 100)}%`) },
  bgY: { label: 'Up and down', min: -1, max: 1, step: 0.02, plain: 0, shows: (v) => (v === 0 ? 'Middle' : `${v < 0 ? 'Up' : 'Down'} ${Math.round(Math.abs(v) * 100)}%`) },
  bgOverlayAmount: { label: 'Colour from below', min: 0, max: 1, step: 0.02, plain: 0, shows: (v) => (v === 0 ? 'None' : `${Math.round(v * 100)}%`) },
  bgVignette: { label: 'Dark edges', min: 0, max: 1, step: 0.02, plain: 0, shows: (v) => (v === 0 ? 'None' : `${Math.round(v * 100)}%`) },
  warmth: { label: 'Warmth', min: -1, max: 1, step: 0.02, plain: 0, shows: (v) => (v === 0 ? 'Natural' : `${v > 0 ? 'Warmer' : 'Cooler'} ${Math.round(Math.abs(v) * 100)}%`) },
  contrast: { label: 'Contrast', min: -0.5, max: 0.5, step: 0.01, plain: 0, shows: (v) => (v === 0 ? 'Natural' : `${v > 0 ? '+' : ''}${Math.round(v * 100)}%`) },
  saturation: { label: 'Colour', min: -1, max: 1, step: 0.02, plain: 0, shows: (v) => (v === -1 ? 'Black and white' : v === 0 ? 'Natural' : `${v > 0 ? '+' : ''}${Math.round(v * 100)}%`) },
  shadowLength: { label: 'Length', min: 0.3, max: 3, step: 0.05, plain: 1, shows: (v) => `${Math.round(v * 100)}%` },
  reflection: { label: 'Strength', min: 0, max: 2, step: 0.05, plain: 1, shows: (v) => `${Math.round(v * 100)}%` },
  reflectionSoft: { label: 'Softness', min: 0, max: 3, step: 0.05, plain: 0, shows: (v) => (v === 0 ? 'As the surface gives it' : `+${Math.round(v * 100)}%`) },
  bright: { label: 'Light on the bottle', min: -0.3, max: 0.3, step: 0.01, plain: 0, shows: (v) => (v === 0 ? 'As it is' : `${v > 0 ? '+' : ''}${Math.round(v * 100)}%`) },
  textSize: { label: 'Size', min: 0.6, max: 1.6, step: 0.02, plain: 1, shows: (v) => `${Math.round(v * 100)}%` },
};

/** A change to send: the pieces' places and looks, the words. */
type Change = { choices?: Record<string, unknown>; lines?: HeadlineLine[] };

/**
 * Two changes made one after the other, as one: what the later one sets wins.
 * A piece put back on a preset place lets go of where it was dragged, as the
 * server has it - so a drag then a preset ends on the preset.
 */
function mergeChange(a: Change, b: Change): Change {
  const ac = (a.choices ?? {}) as Record<string, unknown> & { place?: Record<string, unknown>; style?: Record<string, unknown> };
  const bc = (b.choices ?? {}) as Record<string, unknown> & { place?: Record<string, unknown>; style?: Record<string, unknown> };
  const place = { ...(ac.place ?? {}) };
  if (bc.logo !== undefined) delete place.logo;
  if (bc.bottle !== undefined || bc.size !== undefined) { delete place.bottle; if (bc.bottle !== undefined) delete place.text; }
  Object.assign(place, bc.place ?? {});
  const style = { ...(ac.style ?? {}), ...(bc.style ?? {}) };
  const choices = { ...ac, ...bc, ...(Object.keys(place).length ? { place } : {}), ...(Object.keys(style).length ? { style } : {}) };
  if (!Object.keys(place).length) delete (choices as Record<string, unknown>).place;
  const lines = b.lines ?? a.lines;
  return { ...(Object.keys(choices).length ? { choices } : {}), ...(lines ? { lines } : {}) };
}

/** The post as it stood at one moment: what undo goes back to. */
type Snapshot = { choices: Manifest['choices']; lines: HeadlineLine[] | null };

/** A snapshot as a change to send: every piece put back exactly as it was. */
const restoring = (s: Snapshot) => ({
  choices: {
    bottle: s.choices.bottle,
    size: s.choices.size,
    logo: s.choices.logo,
    headline: s.choices.headline ?? 'shown',
    texts: s.choices.texts ?? [],
    pictures: s.choices.pictures ?? [],
    order: s.choices.order ?? null,
    locked: s.choices.locked ?? [],
    bottleFile: s.choices.bottleFile ?? null,
    logoFile: s.choices.logoFile ?? null,
    place: {
      bottle: s.choices.place?.bottle ?? null, shadow: s.choices.place?.shadow ?? null, reflection: s.choices.place?.reflection ?? null,
      logo: s.choices.place?.logo ?? null, text: s.choices.place?.text ?? null,
    },
    style: {
      ink: s.choices.style?.ink ?? null, align: s.choices.style?.align ?? null, textSize: s.choices.style?.textSize ?? null,
      font: s.choices.style?.font ?? null,
      backing: s.choices.style?.backing ?? null, backingInk: s.choices.style?.backingInk ?? null,
      shadow: s.choices.style?.shadow ?? null, bright: s.choices.style?.bright ?? null, shadowSoft: s.choices.style?.shadowSoft ?? null,
      shadowAngle: s.choices.style?.shadowAngle ?? null, shadowLength: s.choices.style?.shadowLength ?? null,
      reflection: s.choices.style?.reflection ?? null, reflectionSoft: s.choices.style?.reflectionSoft ?? null,
      logoBright: s.choices.style?.logoBright ?? null, logoShadow: s.choices.style?.logoShadow ?? null,
      logoOpacity: s.choices.style?.logoOpacity ?? null, logoTone: s.choices.style?.logoTone ?? null, bottleCrop: s.choices.style?.bottleCrop ?? null, logoCrop: s.choices.style?.logoCrop ?? null, bgBright: s.choices.style?.bgBright ?? null, bgBlur: s.choices.style?.bgBlur ?? null,
      bgZoom: s.choices.style?.bgZoom ?? null, bgX: s.choices.style?.bgX ?? null, bgY: s.choices.style?.bgY ?? null, bgFlip: s.choices.style?.bgFlip ?? null,
      bgOverlay: s.choices.style?.bgOverlay ?? null, bgOverlayAmount: s.choices.style?.bgOverlayAmount ?? null, bgVignette: s.choices.style?.bgVignette ?? null,
      warmth: s.choices.style?.warmth ?? null, contrast: s.choices.style?.contrast ?? null, saturation: s.choices.style?.saturation ?? null,
      textSpacing: s.choices.style?.textSpacing ?? null, textLeading: s.choices.style?.textLeading ?? null, textStroke: s.choices.style?.textStroke ?? null,
      textStrokeInk: s.choices.style?.textStrokeInk ?? null, ink2: s.choices.style?.ink2 ?? null,
    },
  },
  ...(s.lines ? { lines: s.lines } : {}),
});

/** Where a dragged piece settles when it comes near: the middle, and a margin in from each edge. */
const SNAP = 0.012;
const MARGIN = 0.05;
function snapped(box: Frac, piece: Piece, others: Frac[] = []): { box: Frac; guides: { x: number[]; y: number[] } } {
  const guides = { x: [] as number[], y: [] as number[] };
  let { x, y } = box;
  // The post's middle and margins, then the edges and middles of every other piece - as Canva lines them up.
  const linesX = [0.5, MARGIN, 1 - MARGIN, ...others.flatMap((o) => [o.x, o.x + o.w / 2, o.x + o.w])];
  const linesY = [0.5, MARGIN, 1 - MARGIN, ...others.flatMap((o) => [o.y, o.y + o.h / 2, o.y + o.h])];
  const nearest = (anchors: number[], lines: number[], skip?: (a: number, line: number) => boolean) => {
    let best: [number, number] | null = null;
    for (const a of anchors) for (const line of lines) {
      if (skip?.(a, line)) continue;
      const d = Math.abs(a - line);
      if (d < SNAP && (!best || d < Math.abs(best[0] - best[1]))) best = [a, line];
    }
    return best;
  };
  const nearX = nearest([x, x + box.w / 2, x + box.w], linesX);
  if (nearX) { x += nearX[1] - nearX[0]; guides.x.push(nearX[1]); }
  // A bottle stands on its surface: it does not settle its foot on the bottom margin.
  const foot = y + box.h;
  const nearY = nearest([y, y + box.h / 2, foot], linesY, (a, line) => piece === 'bottle' && a === foot && line === 1 - MARGIN);
  if (nearY) { y += nearY[1] - nearY[0]; guides.y.push(nearY[1]); }
  return { box: { ...box, x, y }, guides };
}

/** A box moved by so much, its pivot with it. */
const shiftBox = (b: Frac, dx: number, dy: number): Frac => ({
  ...b, x: b.x + dx, y: b.y + dy, ...(b.px !== undefined && b.py !== undefined ? { px: b.px + dx, py: b.py + dy } : {}),
});

const SHAPES: { value: string | null; label: string }[] = [
  { value: null, label: 'As made' }, { value: '1:1', label: 'Square 1:1' }, { value: '3:2', label: 'Landscape 3:2' },
  { value: '2:3', label: 'Portrait 2:3' }, { value: '4:5', label: 'Portrait 4:5' },
];

type HeadlineOption = { from: 'words' | 'brand'; lines: HeadlineLine[] };

/** The steps, in the order a designer builds a post. Each adds its layers to the canvas. */
const STUDIO_STEPS: { id: 'background' | 'bottle' | 'pictures' | 'logo' | 'words' | 'download'; label: string; adds: LayerName[] }[] = [
  { id: 'background', label: 'Background', adds: ['background'] },
  { id: 'bottle', label: 'Bottle', adds: ['shadow', 'reflection', 'bottle'] },
  { id: 'pictures', label: 'Glass', adds: ['pictures'] },
  { id: 'logo', label: 'Logo', adds: ['logo'] },
  { id: 'words', label: 'Headline', adds: ['headline', 'texts'] },
  { id: 'download', label: 'Download', adds: [] },
];
/** Top to bottom, as an editor lists them. */
const LAYER_LIST: { name: LayerName; label: string }[] = [
  { name: 'logo', label: 'Logo' },
  { name: 'texts', label: 'Text' },
  { name: 'headline', label: 'Headline' },
  { name: 'pictures', label: 'Pictures' },
  { name: 'bottle', label: 'Bottle' },
  { name: 'reflection', label: 'Bottle reflection' },
  { name: 'shadow', label: 'Bottle shadow' },
  { name: 'background', label: 'Background' },
];
/** Which pictures each draggable piece is made of. */
const PIECE_LAYERS: Record<BasePiece, LayerName[]> = {
  bottle: ['bottle', 'shadow', 'reflection'], shadow: ['shadow'], reflection: ['reflection'], logo: ['logo'], text: ['headline'],
};
const PIECE_OF: Partial<Record<LayerName, Piece>> = { bottle: 'bottle', shadow: 'bottle', reflection: 'bottle', logo: 'logo', headline: 'text' };
const PIECE_LABEL: Record<BasePiece, string> = { bottle: 'Bottle', shadow: 'Shadow', reflection: 'Reflection', logo: 'Logo', text: 'Headline' };
/** The pieces that turn, by a handle above them. */
const TURNING = new Set<Piece>(['bottle', 'shadow', 'reflection', 'logo']);
const turns = (piece: Piece) => TURNING.has(piece) || isPic(piece);
const layersOfPiece = (piece: Piece): LayerName[] => (isBlock(piece) ? ['texts'] : isPic(piece) ? ['pictures'] : PIECE_LAYERS[piece]);
const labelOf = (piece: Piece): string => (isBlock(piece) ? 'Text' : isPic(piece) ? 'Picture' : PIECE_LABEL[piece]);
/** A short id for a new block of text. */
const blockId = () => Math.random().toString(36).replace(/[^a-z0-9]/g, '').slice(2, 10).padEnd(6, '0');
const TEXT_SIZES_C = { min: 0.015, max: 0.2 };
const middleOf = (b: Frac) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
/** Where a piece turns and sizes about: its own point when it has one, else its middle. */
const pivotOf = (b: Frac) => (b.px !== undefined && b.py !== undefined ? { x: b.px, y: b.py } : middleOf(b));

const ALIGNS: { value: PostStyle['align'] | null; label: string }[] = [
  { value: null, label: 'As designed' }, { value: 'left', label: 'Left' }, { value: 'center', label: 'Centre' }, { value: 'right', label: 'Right' },
];

const BOTTLE_PLACES: { value: Layers['bottle']; label: string }[] = [
  { value: 'left', label: 'Left' }, { value: 'center', label: 'Centre' }, { value: 'right', label: 'Right' }, { value: 'none', label: 'No bottle' },
];
const EXPORTS: { format: 'png' | 'psd' | 'svg' | 'pdf'; label: string; note: string }[] = [
  { format: 'psd', label: 'PSD', note: 'Photoshop - every part its own layer, the headline as live text' },
  { format: 'svg', label: 'SVG', note: 'Illustrator, Figma, Canva - layers, the headline as live text' },
  { format: 'pdf', label: 'PDF', note: 'For print - the headline stays sharp text' },
  { format: 'png', label: 'PNG', note: 'The finished post, flat' },
];

/**
 * Layers handed over with a change, held here by what they hold: shown at
 * once, never fetched. Shared by every studio on the page, a few at a time.
 */
const handed = new Map<string, string>();
function keepHanded(id: string, manifest: Manifest, fresh: Partial<Record<LayerName, string>> | undefined) {
  for (const [name, b64] of Object.entries(fresh ?? {}) as [LayerName, string][]) {
    const v = manifest.layers.find((l) => l.name === name)?.v;
    if (!v) continue;
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    handed.set(`${id}:${name}:${v}`, URL.createObjectURL(new Blob([bytes], { type: 'image/png' })));
  }
  // The oldest let go: twenty is several changes back for every layer.
  while (handed.size > 20) {
    const [key, url] = handed.entries().next().value!;
    URL.revokeObjectURL(url);
    handed.delete(key);
  }
}

/** A layer's picture, addressed by what it holds - the browser keeps one that has not changed. */
const layerSrc = (id: string, manifest: Manifest, name: LayerName) => {
  const v = manifest.layers.find((l) => l.name === name)?.v ?? manifest.version;
  return handed.get(`${id}:${name}:${v}`) ?? `/api/media/generations/${id}/layers/${name}?v=${encodeURIComponent(v)}`;
};

/**
 * Loads the pictures of a version before it is shown, so nothing jumps back
 * while it arrives. A layer that did not change is already here.
 */
function preload(id: string, manifest: Manifest): Promise<void> {
  // A layer a post does not have is never shown, and one set before it existed is not stored at all.
  return Promise.all(manifest.layers.filter((l) => l.present && l.name !== 'pictures').map((l) => new Promise<void>((done) => {
    const img = new Image();
    img.onload = () => done();
    img.onerror = () => done();
    img.src = layerSrc(id, manifest, l.name);
  }))).then(() => undefined);
}

/**
 * A post designed layer by layer, as a designer builds one: the background
 * first, alone on the canvas; then the bottle, the logo and the headline,
 * each dragged where it should go and pulled bigger or smaller by its corner;
 * then the file to take away.
 *
 * The background is the only part ever made, and it is made once. Dragging
 * happens here in the browser, instantly; where a piece is dropped is then
 * set into the post on the server, for nothing, while the next one is placed.
 */
function LayerStudio({ generation, layers, fresh, onChanged }: {
  generation: MediaGenerationDTO;
  layers: Layers;
  /** Just made: start from the background alone. Otherwise open on the finished post. */
  fresh: boolean;
  onChanged: (generation: MediaGenerationDTO) => void;
}) {
  const { note } = useToast();
  const [step, setStep] = useState(fresh ? 0 : STUDIO_STEPS.length - 1);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [hidden] = useState<Set<LayerName>>(new Set());
  const [selected, setSelected] = useState<Piece | null>(null);
  /** Which of the bottle, its shadow and its reflection the bottle step is setting: the one last chosen. */
  const [part, setPart] = useState<'bottle' | 'shadow' | 'reflection'>('bottle');
  /** The furthest step come to, so going back to an earlier one leaves what was added after it on the post. */
  const [furthest, setFurthest] = useState(step);
  useEffect(() => { setFurthest((f) => Math.max(f, step)); }, [step]);
  /** A piece clicked on the post: its own settings opened - the bottle's, a glass's or added bottle's, the logo's, the words'. */
  const openSettingsFor = (piece: Piece) => {
    const id: (typeof STUDIO_STEPS)[number]['id'] | null =
      piece === 'bottle' || piece === 'shadow' || piece === 'reflection' ? 'bottle'
        : isPic(piece) ? 'pictures'
          : piece === 'logo' ? 'logo'
            : piece === 'text' || piece.startsWith('t:') ? 'words'
              : null;
    if (!id) return;
    const at = STUDIO_STEPS.findIndex((x) => x.id === id);
    if (at >= 0) setStep(at);
  };
  useEffect(() => {
    if (selected === 'bottle' || selected === 'shadow' || selected === 'reflection') setPart(selected);
  }, [selected]);
  /** Where pieces are shown while dragged and until the post catches up. */
  const [moved, setMoved] = useState<Partial<Record<Piece, Frac>>>({});
  const [saving, setSaving] = useState(false);
  /** A piece turned on or off, shown so at once while the post catches up. */
  const [want, setWant] = useState<{ logo?: boolean; headline?: boolean }>({});
  /** Every bottle and logo in the brand's library - each flavour, each pack, each logo - to choose from on the post. Free. */
  const [library, setLibrary] = useState<{
    brand: string | null;
    bottles: { id: string; name: string; variant: string | null }[];
    allBottles: { id: string; name: string; variant: string | null }[];
    logos: { id: string; name: string; tone: 'light' | 'dark' | 'colour'; variant: string | null }[];
    bottleFile: string | null;
  }>({ brand: null, bottles: [], allBottles: [], logos: [], bottleFile: null });
  /** The bottle's crop as it is being slid, set on the post when let go. */
  const [cropDraft, setCropDraft] = useState<{ l: number; t: number; r: number; b: number } | null>(null);
  /** The bottle's height or the logo's width as it is being slid, set on the post when let go. */
  const [sizeDraft, setSizeDraft] = useState<{ bottle?: number; logo?: number }>({});
  /** The logo's crop as it is being slid. */
  const [logoCropDraft, setLogoCropDraft] = useState<{ l: number; t: number; r: number; b: number } | null>(null);
  // Asked for once the post's layers are here - before that the post may not be laid out, and nothing comes -
  // and asked again on each step until it has come, so the library never needs the page reloaded.
  const libraryHere = useRef(false);
  const libraryAsking = useRef(false);
  const layersHere = Boolean(manifest);
  useEffect(() => {
    if (!layersHere || libraryHere.current || libraryAsking.current) return;
    libraryAsking.current = true;
    void fetch(`/api/media/generations/${generation.id}/glass`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((b: Partial<typeof library> | null) => {
        if (!b?.brand) return;
        libraryHere.current = true;
        setLibrary({ brand: b.brand ?? null, bottles: b.bottles ?? [], allBottles: b.allBottles ?? [], logos: b.logos ?? [], bottleFile: b.bottleFile ?? null });
      })
      .catch(() => undefined)
      .finally(() => { libraryAsking.current = false; });
  }, [generation.id, layersHere, step]);
  /** Another bottle stood on the same surface beside the bottle, as tall as it: for several flavours together. */
  const addBottle = async (file: string) => {
    const now = manifest?.choices.pictures ?? [];
    if (now.length >= 8) { note('A post takes at most 8 added pictures.'); return; }
    const box = manifest?.boxes.bottle ?? null;
    const aspect = await new Promise<number>((done) => {
      const img = new Image();
      img.onload = () => done(img.naturalWidth ? img.naturalHeight / img.naturalWidth : 3);
      img.onerror = () => done(3);
      img.src = `/api/drive/files/${file}/content?size=320`;
    });
    const postAspect = manifest ? manifest.height / manifest.width : 1.25;
    const h = box ? box.h : 0.55;
    const w = Math.min(0.5, (h * postAspect) / aspect);
    const foot = box ? box.y + box.h : 0.92;
    // Alternately right and left of the bottle, one step further out each time.
    const k = now.filter((pc) => pc.file && !pc.shape).length;
    const sideRight = k % 2 === 0;
    const step = Math.floor(k / 2) + 1;
    const cx = box ? box.x + box.w / 2 + (sideRight ? 1 : -1) * step * (box.w * 0.95) : 0.5;
    const pic: PictureC = {
      id: blockId(), file, aspect, w,
      x: Math.min(0.98 - w, Math.max(0.02, cx - w / 2)), y: foot - (w * aspect) / postAspect,
      ground: 0.6, mirror: 0.45,
    };
    await arrange({ choices: { pictures: [...now, pic] } });
  };
  const [painting, setPainting] = useState(false);
  const [backgroundNote, setBackgroundNote] = useState('');
  const [exportShape, setExportShape] = useState<string | null>(null);
  const [guides, setGuides] = useState<{ x: number[]; y: number[] }>({ x: [], y: [] });
  const [options, setOptions] = useState<HeadlineOption[] | null>(null);
  /** The colours the headline may take: the brand's own, read with the other headlines. */
  const [inks, setInks] = useState<string[]>([]);
  /** The faces the headline may be set in; `own` false where a free look-alike stands in for the brand's file. */
  const [fonts, setFonts] = useState<{ id: string; label: string; own: boolean }[]>([]);
  /** The headline's words being changed on the picture itself, line by line. */
  const [inline, setInline] = useState<HeadlineLine[] | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ piece: Piece; mode: 'move' | 'resize' | 'turn'; x: number; y: number; from: Frac; others?: { piece: Piece; from: Frac }[] } | null>(null);
  /** An edge being pulled to crop a piece, as on any editor: where its box would end, shown until let go. */
  const cropDrag = useRef<{ piece: Piece; side: 'l' | 'r' | 't' | 'b'; x: number; y: number; from: Frac } | null>(null);
  const [cropBox, setCropBox] = useState<{ piece: Piece; box: Frac } | null>(null);
  /** The bottle or the logo as just cropped, shown cut on its layer until the post comes back cut. */
  const [clips, setClips] = useState<Partial<Record<'bottle' | 'logo', Frac>>>({});
  /** Pieces chosen together - Shift and click - to move, line up or hold still as one. */
  const [group, setGroup] = useState<Set<Piece>>(new Set());
  /** A picture or a block of text copied, to paste here or on another post. */
  const clip = useRef<{ kind: 'picture'; item: PictureC } | { kind: 'text'; item: TextBlockC } | null>(null);
  /** The picture being touched up with the brush. */
  const [brushing, setBrushing] = useState<string | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  // Undo and redo: the post as it stood before each change, kept here in the browser.
  const latest = useRef<Snapshot | null>(null);
  const undos = useRef<Snapshot[]>([]);
  const redos = useRef<Snapshot[]>([]);
  const [, setHistoryShown] = useState(0);
  const showHistory = () => setHistoryShown((n) => n + 1);

  const load = useCallback(async (): Promise<Manifest | null> => {
    const res = await fetch(`/api/media/generations/${generation.id}/layers`, { cache: 'no-store' }).catch(() => null);
    if (!res?.ok) return null;
    return (await res.json()) as Manifest;
  }, [generation.id]);

  useEffect(() => {
    let live = true;
    void load().then((m) => {
      if (!live) return;
      if (m) { showing.current = m.version; setManifest(m); latest.current = { choices: m.choices, lines: generation.headline ?? null }; }
      else note('The layers could not be loaded.');
    });
    return () => { live = false; };
    // The headline is read once, as the studio opens; after that it comes back with each change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, note]);

  // Other headlines, fetched once the headline step is open: read from what CIP holds, nothing spent.
  const onWords = ['words', 'background', 'pictures'].includes(STUDIO_STEPS[step]?.id ?? '');
  useEffect(() => {
    if (!onWords || options) return;
    let live = true;
    void fetch(`/api/media/generations/${generation.id}/headlines`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : { options: [] }))
      .then((b: { options?: HeadlineOption[]; inks?: string[]; fonts?: { id: string; label: string; own: boolean }[] }) => {
        if (live) { setOptions(b.options ?? []); setInks(b.inks ?? []); setFonts(b.fonts ?? []); }
      })
      .catch(() => { if (live) setOptions([]); });
    return () => { live = false; };
  }, [onWords, options, generation.id]);

  /**
   * Sends a change and shows the post as it then stands - one change at a
   * time, in the order made, so a quick second drag never lands first.
   */
  const pending = useRef(0);
  /** How many times each piece was dropped: a drop still saving is not undone by an earlier one landing. */
  const drops = useRef<Partial<Record<Piece, number>>>({});
  /**
   * The change waiting its turn while another is on its way. A change made
   * then joins it, so five quick drags are one save, not five in a row.
   */
  const waiting = useRef<{ body: Change; seen: Map<Piece, number>; run: Promise<boolean> } | null>(null);
  /** The arrangement on the page: sent with a change, so the server need not read the post again. */
  const showing = useRef<string | null>(null);
  /** A look being slid: shown on the picture at once, and set into the post when let go. */
  const [drafts, setDrafts] = useState<Partial<Record<SlideKey, number>>>({});
  /**
   * The added pictures and text blocks as last sent. A second drag made before the first is
   * saved builds on this - built on what is shown, it put the first piece back where it was.
   */
  const sentLists = useRef<{ pictures?: PictureC[]; texts?: TextBlockC[] }>({});
  const listNow = <K extends 'pictures' | 'texts'>(key: K): NonNullable<Manifest['choices'][K]> =>
    (sentLists.current[key] ?? manifest?.choices[key] ?? []) as NonNullable<Manifest['choices'][K]>;
  const arrange = (
    given: Change | null,
    settles: Piece[] = [],
    /** A change made here, or a step back or forward through the ones made. */
    mode: 'do' | 'undo' | 'redo' = 'do',
  ): Promise<boolean> => {
    const dropped = (p: Piece) => (drops.current[p] = (drops.current[p] ?? 0) + 1);
    if (mode !== 'do') sentLists.current = {};
    else if (given?.choices) {
      const c = given.choices as { pictures?: PictureC[]; texts?: TextBlockC[] };
      if (c.pictures) sentLists.current.pictures = c.pictures;
      if (c.texts) sentLists.current.texts = c.texts;
    }
    if (mode === 'do' && given && waiting.current) {
      const w = waiting.current;
      w.body = mergeChange(w.body, given);
      for (const p of settles) w.seen.set(p, dropped(p));
      return w.run;
    }
    // Pictures are drawn on this page: a change to them is shown at once, the post set behind it.
    if (mode === 'do' && given?.choices && Array.isArray((given.choices as { pictures?: unknown }).pictures)) {
      const pictures = (given.choices as { pictures: PictureC[] }).pictures;
      setManifest((m) => (m ? { ...m, choices: { ...m.choices, pictures } } : m));
    }
    pending.current += 1;
    setSaving(true);
    const seen = new Map(settles.map((p) => [p, dropped(p)] as const));
    let mine: { body: Change; seen: Map<Piece, number>; run: Promise<boolean> } | null = null;
    const settle = () => {
      const done = [...seen].filter(([p, n]) => drops.current[p] === n).map(([p]) => p);
      setMoved((m) => { const left = { ...m }; for (const p of done) delete left[p]; return left; });
      pending.current -= 1;
      if (pending.current === 0) { setSaving(false); setWant({}); sentLists.current = {}; }
      showHistory();
    };
    const run = queue.current.then(async () => {
      // On its way now: what is made from here waits for the next turn.
      if (mine && waiting.current === mine) waiting.current = null;
      // Taken here, in turn, so each step back is to the post as the change before left it.
      const was = latest.current;
      let body = mine ? mine.body : given;
      const from = mode === 'undo' ? undos.current : redos.current;
      const to = mode === 'undo' ? redos.current : undos.current;
      let target: Snapshot | undefined;
      if (mode === 'do') {
        if (was) undos.current.push(was);
        redos.current = [];
      } else {
        target = from.pop();
        if (!target || !was) { if (target) from.push(target); settle(); return false; }
        to.push(was);
        body = restoring(target);
      }
      const res = await fetch(`/api/media/generations/${generation.id}/layers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, version: showing.current }),
      }).catch(() => null);
      if (!res?.ok) {
        const message = (await res?.json().catch(() => null) as { message?: string } | null)?.message;
        note(message ?? 'That change could not be made.');
        // What was shown at once goes back to the post as it is.
        const back = latest.current;
        if (back) setManifest((m) => (m ? { ...m, choices: back.choices } : m));
        // Nothing changed, so nothing is kept to go back to.
        if (mode === 'do') undos.current.pop();
        else { to.pop(); from.push(target!); }
        settle();
        return false;
      }
      // The post and its layers come back together; only the layers that changed are fetched.
      const next = (await res.json()) as { generation: MediaGenerationDTO; layers: Manifest; fresh?: Partial<Record<LayerName, string>> };
      latest.current = { choices: next.layers.choices, lines: next.generation.headline ?? null };
      keepHanded(generation.id, next.layers, next.fresh);
      await preload(generation.id, next.layers);
      showing.current = next.layers.version;
      setManifest(next.layers);
      onChanged(next.generation);
      settle();
      return true;
    });
    queue.current = run.catch(() => undefined);
    // A change can be joined until its turn; a step back or forward never is, nor what came before it.
    if (mode === 'do' && given) { mine = { body: given, seen, run }; waiting.current = mine; } else waiting.current = null;
    return run;
  };

  /**
   * A new background, painted with what the person asked for - the one call
   * here that is paid for - or the one before it back, which is not.
   */
  const paint = async (which: 'new' | 'previous' | 'own', own?: File) => {
    setPainting(true);
    // A picture brought from here goes as itself; nothing is painted for it.
    const form = new FormData();
    if (own) form.append('file', own);
    const res = await fetch(`/api/media/generations/${generation.id}/background`, which === 'own'
      ? { method: 'POST', body: form }
      : {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(which === 'previous' ? { action: 'previous' } : { note: backgroundNote }),
        }).catch(() => null);
    if (!res?.ok) {
      setPainting(false);
      const message = (await res?.json().catch(() => null) as { message?: string } | null)?.message;
      note(message ?? 'The background could not be made. Nothing was changed.');
      return;
    }
    const next = ((await res.json()) as { generation: MediaGenerationDTO }).generation;
    const fresh = await load();
    if (fresh) await preload(generation.id, fresh);
    if (fresh) { showing.current = fresh.version; setManifest(fresh); latest.current = { choices: fresh.choices, lines: next.headline ?? null }; }
    setMoved({});
    setPainting(false);
    onChanged(next);
    note(which === 'previous' ? 'Back to the background before' : which === 'own' ? 'Your picture is the background now' : 'New background in place');
  };

  // What the steps so far have put on the canvas, less what was hidden by hand.
  // Every layer of the furthest step come to stays shown: going back to set a piece hides nothing after it.
  const reached = new Set(STUDIO_STEPS.slice(0, Math.max(step, furthest) + 1).flatMap((s) => s.adds));
  const present = new Set(manifest?.layers.filter((l) => l.present).map((l) => l.name) ?? []);
  // Turned off here: gone at once. Turned on: shown as soon as its picture is set.
  if (want.logo === false) present.delete('logo');
  if (want.headline === false) present.delete('headline');
  const logoOn = want.logo ?? layers.logo !== 'none';
  const headlineOn = want.headline ?? layers.headline !== 'none';
  const shows = (name: LayerName) => reached.has(name) && present.has(name) && !hidden.has(name);
  const current = STUDIO_STEPS[step]!;

  /** A piece where the post has it, turned as it was left. */
  const setBox = (piece: Piece): Frac | null => {
    if (isPic(piece)) {
      const pic = manifest?.choices.pictures?.find((x) => x.id === piece.slice(2));
      return pic && manifest ? { x: pic.x, y: pic.y, w: pic.w, h: (pic.w * pic.aspect * manifest.width) / manifest.height, r: pic.rotate ?? 0 } : null;
    }
    if (isBlock(piece)) {
      const t = manifest?.boxes.texts?.find((x) => x.id === piece.slice(2));
      return t ? { x: t.x, y: t.y, w: t.w, h: t.h, r: 0 } : null;
    }
    const b = manifest?.boxes[piece];
    if (!b) return null;
    const r = piece === 'bottle' ? manifest?.choices.place?.bottle?.rotate
      : piece === 'logo' ? manifest?.choices.place?.logo?.rotate
      : FROM_FOOT.has(piece) ? manifest?.choices.place?.[piece as FromFoot]?.rotate : 0;
    const pivot = piece === 'shadow' ? manifest?.boxes.shadowPivot : piece === 'reflection' ? manifest?.boxes.reflectionPivot : null;
    return { ...b, r: r ?? 0, ...(pivot ? { px: pivot.x, py: pivot.y } : {}) };
  };
  const boxOf = (piece: Piece): Frac | null => moved[piece] ?? setBox(piece);
  const draggable = (piece: Piece) => layersOfPiece(piece).some((n) => shows(n)) && Boolean(setBox(piece));

  /**
   * The transform that carries a piece's picture from where it was set to
   * where it is shown - moved, sized and turned about its middle. The shadow
   * goes with the bottle, unless it is the one being moved.
   */
  const pieceShowing = (name: LayerName): Piece | undefined =>
    name === 'shadow' || name === 'reflection' ? (moved[name] ? name : moved.bottle ? 'bottle' : undefined) : PIECE_OF[name];
  /** A layer cut to a piece's new crop while the post catches up: everything outside the cropped box hidden. */
  const clipOf = (name: LayerName): React.CSSProperties => {
    const b = name === 'bottle' ? clips.bottle : name === 'logo' ? clips.logo : undefined;
    if (!b) return {};
    const pct = (v: number) => `${(Math.max(0, v) * 100).toFixed(2)}%`;
    return { clipPath: `inset(${pct(b.y)} ${pct(1 - b.x - b.w)} ${pct(1 - b.y - b.h)} ${pct(b.x)})` };
  };
  const transformFor = (name: LayerName): string | undefined => {
    const piece = pieceShowing(name);
    return piece ? transformOfPiece(piece) : undefined;
  };
  /** The same for one piece: an added block of text moves on its own, out of the one layer they share. */
  const transformOfPiece = (piece: Piece): string | undefined => {
    const from = setBox(piece);
    const to = piece ? moved[piece] : null;
    if (!from || !to) return undefined;
    const a = pivotOf(from);
    const b = pivotOf(to);
    return `translate(${b.x * 100}%, ${b.y * 100}%) rotate(${(to.r ?? 0) - (from.r ?? 0)}deg) scale(${to.h / from.h}) translate(${-a.x * 100}%, ${-a.y * 100}%)`;
  };
  const originFor = (name: LayerName): string | undefined => (pieceShowing(name) ? '0 0' : undefined);

  const locked = new Set<Piece>((manifest?.choices.locked ?? []) as Piece[]);
  const startDrag = (piece: Piece, mode: 'move' | 'resize' | 'turn') => (e: React.PointerEvent) => {
    const from = boxOf(piece);
    if (!from) return;
    e.preventDefault();
    e.stopPropagation();
    // Shift and click: one more piece chosen with the others, or one let go.
    if (e.shiftKey && mode === 'move') {
      setGroup((g) => {
        const next = new Set(g.size ? g : selected ? [selected] : []);
        if (next.has(piece)) next.delete(piece); else next.add(piece);
        return next;
      });
      setSelected(piece);
      return;
    }
    setSelected(piece);
    if (mode === 'move') openSettingsFor(piece);
    if (!group.has(piece)) setGroup(new Set([piece]));
    // Held still: chosen, never moved.
    if (locked.has(piece)) return;
    const others = mode === 'move' && group.has(piece) && group.size > 1
      ? [...group].filter((o) => o !== piece && !locked.has(o) && boxOf(o)).map((o) => ({ piece: o, from: boxOf(o)! }))
      : undefined;
    drag.current = { piece, mode, x: e.clientX, y: e.clientY, from, others };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };
  /** Whether a piece can be cropped by its edges: the bottle, the logo, a picture or a glass - upright. */
  const croppable = (piece: Piece): boolean => {
    const b = boxOf(piece);
    if (!b || Math.abs(b.r ?? 0) > 0.5 || locked.has(piece)) return false;
    if (piece === 'bottle' || piece === 'logo') return true;
    if (isPic(piece)) { const pic = (manifest?.choices.pictures ?? []).find((x) => x.id === piece.slice(2)); return Boolean(pic?.file); }
    return false;
  };
  /** The crop a piece has now, on each side, a share of the piece itself. */
  const cropOf = (piece: Piece): { l: number; t: number; r: number; b: number } => {
    const none = { l: 0, t: 0, r: 0, b: 0 };
    if (piece === 'bottle') return manifest?.choices.style?.bottleCrop ?? none;
    if (piece === 'logo') return manifest?.choices.style?.logoCrop ?? none;
    if (isPic(piece)) return (manifest?.choices.pictures ?? []).find((x) => x.id === piece.slice(2))?.crop ?? none;
    return none;
  };
  const startCrop = (piece: Piece, side: 'l' | 'r' | 't' | 'b') => (e: React.PointerEvent) => {
    const from = boxOf(piece);
    if (!from) return;
    e.preventDefault();
    e.stopPropagation();
    setSelected(piece);
    cropDrag.current = { piece, side, x: e.clientX, y: e.clientY, from };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };
  /** An edge pulled: the piece's crop on that side, kept between nothing and nearly half of it. */
  const croppedTo = (d: NonNullable<typeof cropDrag.current>, clientX: number, clientY: number) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const f = d.from;
    const c = cropOf(d.piece);
    const vx = Math.max(0.05, 1 - c.l - c.r);
    const vy = Math.max(0.05, 1 - c.t - c.b);
    const horizontal = d.side === 'l' || d.side === 'r';
    const moved = horizontal ? (clientX - d.x) / rect.width : (clientY - d.y) / rect.height;
    // Pulled inwards crops more; outwards gives back what was cropped.
    const inward = d.side === 'l' || d.side === 't' ? moved : -moved;
    const span = horizontal ? f.w : f.h;
    const v = horizontal ? vx : vy;
    const next = Math.min(0.45, Math.max(0, c[d.side] + (inward / span) * v));
    const by = next - c[d.side];
    const cut = (by / v) * span;
    const box: Frac = { ...f };
    if (d.side === 'l') { box.x = f.x + cut; box.w = f.w - cut; }
    if (d.side === 'r') box.w = f.w - cut;
    if (d.side === 't') { box.y = f.y + cut; box.h = f.h - cut; }
    if (d.side === 'b') box.h = f.h - cut;
    return { box, crop: { ...c, [d.side]: Math.round(next * 1000) / 1000 } };
  };
  const onCropMove = (e: React.PointerEvent) => {
    const d = cropDrag.current;
    if (!d) return false;
    const got = croppedTo(d, e.clientX, e.clientY);
    if (got) setCropBox({ piece: d.piece, box: got.box });
    return true;
  };
  /** The crop let go: set into the post, the piece staying the size it was - what was cut is simply gone. */
  const onCropDrop = (e: React.PointerEvent) => {
    const d = cropDrag.current;
    if (!d) return false;
    cropDrag.current = null;
    setCropBox(null);
    const got = croppedTo(d, e.clientX, e.clientY);
    if (!got || !manifest) return true;
    const { box, crop } = got;
    const none = !crop.l && !crop.t && !crop.r && !crop.b;
    if (d.piece === 'bottle' || d.piece === 'logo') setClips((c) => ({ ...c, [d.piece]: box }));
    const unclip = () => setClips((c) => { const n = { ...c }; delete n[d.piece as 'bottle' | 'logo']; return n; });
    if (d.piece === 'bottle') {
      void arrange({ choices: { style: { bottleCrop: none ? null : crop }, place: { bottle: { cx: box.x + box.w / 2, base: box.y + box.h, height: box.h, ...(box.r ? { rotate: box.r } : {}) } } } }, ['bottle']).then(unclip);
    } else if (d.piece === 'logo') {
      void arrange({ choices: { style: { logoCrop: none ? null : crop }, place: { logo: { x: box.x, y: box.y, w: box.w, ...(box.r ? { rotate: box.r } : {}) } } } }, ['logo']).then(unclip);
    } else if (isPic(d.piece)) {
      const id = d.piece.slice(2);
      const f = d.from;
      const pictures = listNow('pictures').map((pic) => (pic.id !== id ? pic : {
        ...pic, crop, x: box.x, y: box.y, w: box.w,
        // Its shape follows what is left of it.
        aspect: pic.aspect * (box.h / f.h) / (box.w / f.w),
      }));
      void arrange({ choices: { pictures } }, [d.piece]);
    }
    return true;
  };

  /** Every other piece on the post, to line a moved one up with. */
  const guideBoxes = (moving: Piece): Frac[] => handles
    .filter((h) => h !== moving && !group.has(h) && !(moving === 'bottle' && (h === 'shadow' || h === 'reflection')))
    .map((h) => boxOf(h))
    .filter((b): b is Frac => Boolean(b) && !b!.r);

  const onMove = (e: React.PointerEvent) => {
    if (onCropMove(e)) return;
    const d = drag.current;
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!d || !rect) return;
    const dx = (e.clientX - d.x) / rect.width;
    const dy = (e.clientY - d.y) / rect.height;
    const f = d.from;
    if (d.mode === 'turn') {
      // Turned about its middle, by the angle the pointer went round it; it settles upright, or on its side, when near.
      const pivot = pivotOf(f);
      const cx = rect.left + pivot.x * rect.width;
      const cy = rect.top + pivot.y * rect.height;
      const by = Math.atan2(e.clientY - cy, e.clientX - cx) - Math.atan2(d.y - cy, d.x - cx);
      let r = (f.r ?? 0) + (by * 180) / Math.PI;
      r = ((((r + 180) % 360) + 360) % 360) - 180;
      if (!e.altKey) for (const at of [0, 90, -90, 180, -180]) if (Math.abs(r - at) < 4) r = at;
      setGuides({ x: [], y: [] });
      setMoved((m) => ({ ...m, [d.piece]: { ...f, r: Math.round(r * 10) / 10 } }));
      return;
    }
    // Moved: it settles on the middle or a margin when it comes near, and a line shows it.
    // Held with Alt, it goes exactly where it is put.
    const raw = d.mode === 'move'
      ? { ...f, x: f.x + dx, y: f.y + dy }
      : (() => {
          // From the corner, keeping its shape: whichever way was pulled further.
          const k = Math.max(0.25, Math.min(4, Math.max((f.w + dx) / f.w, (f.h + dy) / f.h)));
          if (f.px === undefined || f.py === undefined) return { x: f.x, y: f.y, w: f.w * k, h: f.h * k, r: f.r };
          // Grown out from its pivot, which stays where it is.
          return { ...f, x: f.px + (f.x - f.px) * k, y: f.py + (f.y - f.py) * k, w: f.w * k, h: f.h * k };
        })();
    const settled = d.mode === 'move' && !e.altKey ? snapped(raw, d.piece, guideBoxes(d.piece)) : { box: raw, guides: { x: [], y: [] } };
    const box: Frac = { ...settled.box };
    if (f.px !== undefined && f.py !== undefined && d.mode === 'move') { box.px = f.px + (box.x - f.x); box.py = f.py + (box.y - f.y); }
    setGuides(settled.guides);
    // The others chosen with it go the same way.
    const along = Object.fromEntries((d.others ?? []).map((o) => [o.piece, shiftBox(o.from, box.x - f.x, box.y - f.y)]));
    setMoved((m) => ({ ...m, ...along, [d.piece]: box }));
  };

  /** Where a piece was left, set into the post. */
  const commit = (piece: Piece, to: Frac | undefined) => {
    if (!manifest) return;
    const from = setBox(piece);
    const same = to && from && Math.abs(to.x - from.x) < 0.002 && Math.abs(to.y - from.y) < 0.002 && Math.abs(to.h - from.h) < 0.002
      && Math.abs((to.r ?? 0) - (from.r ?? 0)) < 0.5;
    if (!to || !from || same) {
      setMoved((m) => { const next = { ...m }; delete next[piece]; return next; });
      return;
    }
    if (isPic(piece)) {
      const id = piece.slice(2);
      const pictures = listNow('pictures').map((pic) => (pic.id !== id ? pic : {
        ...pic, x: to.x, y: to.y, w: Math.min(1.5, Math.max(0.02, to.w)), rotate: to.r ?? 0,
      }));
      void arrange({ choices: { pictures } }, [piece]);
      return;
    }
    if (isBlock(piece)) {
      const id = piece.slice(2);
      const k = to.h / from.h;
      const texts = listNow('texts').map((b) => (b.id !== id ? b : {
        ...b, x: b.x + (to.x - from.x), y: b.y + (to.y - from.y),
        size: Math.min(TEXT_SIZES_C.max, Math.max(TEXT_SIZES_C.min, b.size * k)), width: Math.min(1.2, b.width * k),
      }));
      void arrange({ choices: { texts } }, [piece]);
      return;
    }
    const place: Placement = {};
    if (piece === 'bottle') place.bottle = { cx: to.x + to.w / 2, base: to.y + to.h, height: to.h, rotate: to.r ?? 0 };
    if (piece === 'shadow' || piece === 'reflection') {
      // Moved, sized and turned from where it was: the server keeps it against where the scene casts it.
      const was = manifest.choices.place?.[piece] ?? { dx: 0, dy: 0, scale: 1, rotate: 0 };
      const a = pivotOf(from);
      const b = pivotOf(to);
      place[piece] = { dx: was.dx + (b.x - a.x), dy: was.dy + (b.y - a.y), scale: was.scale * (to.h / from.h), rotate: to.r ?? 0 };
    }
    if (piece === 'logo') place.logo = { x: to.x, y: to.y, w: to.w, rotate: to.r ?? 0 };
    if (piece === 'text') {
      const was = manifest.choices.place?.text?.scale ?? 1;
      const anchor = manifest.boxes.textAnchor?.x ?? from.x;
      place.text = { x: anchor + (to.x - from.x), y: to.y, scale: was * (to.h / from.h) };
    }
    void arrange({ choices: { place } }, [piece]);
  };

  const onDrop = (e?: React.PointerEvent) => {
    if (e && onCropDrop(e)) return;
    const d = drag.current;
    drag.current = null;
    setGuides({ x: [], y: [] });
    if (!d) return;
    commit(d.piece, moved[d.piece]);
    for (const o of d.others ?? []) commit(o.piece, moved[o.piece]);
  };

  // --- lining up, and holding still -------------------------------------------------
  /** What the line-up buttons act on: the pieces chosen together, else the one chosen. */
  const lineUpOn = (): Piece[] => [...(group.size > 1 ? group : selected ? [selected] : [])].filter((x) => !locked.has(x) && boxOf(x));
  /** The chosen pieces lined up: on the post's margins and middle for one, on each other for several. */
  const lineUp = (how: 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom') => {
    const ps = lineUpOn();
    if (!ps.length) return;
    const boxes = ps.map((x) => [x, boxOf(x)!] as const);
    const x0 = Math.min(...boxes.map(([, b]) => b.x)); const x1 = Math.max(...boxes.map(([, b]) => b.x + b.w));
    const y0 = Math.min(...boxes.map(([, b]) => b.y)); const y1 = Math.max(...boxes.map(([, b]) => b.y + b.h));
    const area = ps.length > 1 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : { x: MARGIN, y: MARGIN, w: 1 - 2 * MARGIN, h: 1 - 2 * MARGIN };
    const placed: Partial<Record<Piece, Frac>> = {};
    for (const [x, b] of boxes) {
      const dx = how === 'left' ? area.x - b.x : how === 'center' ? area.x + area.w / 2 - (b.x + b.w / 2) : how === 'right' ? area.x + area.w - (b.x + b.w) : 0;
      const dy = how === 'top' ? area.y - b.y : how === 'middle' ? area.y + area.h / 2 - (b.y + b.h / 2) : how === 'bottom' ? area.y + area.h - (b.y + b.h) : 0;
      placed[x] = shiftBox(b, dx, dy);
    }
    setMoved((m) => ({ ...m, ...placed }));
    for (const [x] of boxes) commit(x, placed[x]);
  };
  /** Three or more chosen pieces, spaced evenly between the first and the last. */
  const spaceOut = (axis: 'x' | 'y') => {
    const ps = lineUpOn();
    if (ps.length < 3) return;
    const along = (b: Frac) => (axis === 'x' ? { at: b.x, size: b.w } : { at: b.y, size: b.h });
    const boxes = ps.map((x) => [x, boxOf(x)!] as const).sort((a, b) => along(a[1]).at - along(b[1]).at);
    const first = along(boxes[0]![1]);
    const last = along(boxes[boxes.length - 1]![1]);
    const gap = (last.at + last.size - first.at - boxes.reduce((t, [, b]) => t + along(b).size, 0)) / (boxes.length - 1);
    let at = first.at;
    const placed: Partial<Record<Piece, Frac>> = {};
    for (const [x, b] of boxes) {
      const d = at - along(b).at;
      placed[x] = axis === 'x' ? shiftBox(b, d, 0) : shiftBox(b, 0, d);
      at += along(b).size + gap;
    }
    setMoved((m) => ({ ...m, ...placed }));
    for (const [x] of boxes) commit(x, placed[x]);
  };
  /** The chosen pieces held still, or let go. */
  const toggleLock = () => {
    const ps = [...(group.size > 1 ? group : selected ? [selected] : [])];
    if (!ps.length) return;
    const all = ps.every((x) => locked.has(x));
    const next = new Set(locked);
    for (const x of ps) if (all) next.delete(x); else next.add(x);
    void arrange({ choices: { locked: [...next] } });
  };
  /** A picture or a block of text, again, a little down and across - or pasted from another post. */
  const placeCopy = (c: NonNullable<typeof clip.current>) => {
    const id = blockId();
    if (c.kind === 'picture') {
      const item = { ...c.item, id, x: Math.min(0.9, c.item.x + 0.03), y: Math.min(0.9, c.item.y + 0.03) };
      void arrange({ choices: { pictures: [...listNow('pictures'), item].slice(-8) } }).then((ok) => ok && setSelected(`p:${id}`));
    } else {
      const item = { ...c.item, id, x: Math.min(0.9, c.item.x + 0.03), y: Math.min(0.92, c.item.y + 0.03) };
      void arrange({ choices: { texts: [...listNow('texts'), item].slice(-6) } }).then((ok) => ok && setSelected(`t:${id}`));
    }
  };
  const copyOf = (piece: Piece | null): NonNullable<typeof clip.current> | null => {
    if (!piece) return null;
    if (isPic(piece)) { const item = listNow('pictures').find((x) => x.id === piece.slice(2)); return item ? { kind: 'picture', item } : null; }
    if (isBlock(piece)) { const item = listNow('texts').find((x) => x.id === piece.slice(2)); return item ? { kind: 'text', item } : null; }
    return null;
  };
  const removePiece = (piece: Piece) => {
    if (isPic(piece)) void arrange({ choices: { pictures: listNow('pictures').filter((x) => x.id !== piece.slice(2)) } });
    else if (isBlock(piece)) void arrange({ choices: { texts: listNow('texts').filter((x) => x.id !== piece.slice(2)) } });
    else return;
    setSelected(null);
    setGroup(new Set());
  };

  // The keyboard, as an editor has it: Ctrl+Z, Ctrl+Shift+Z or Ctrl+Y, and the
  // arrows to nudge the chosen piece - Shift for a bigger step. A run of
  // nudges is saved once, when they stop.
  const nudge = useRef<{ piece: Piece; box: Frac; timer: ReturnType<typeof setTimeout> } | null>(null);
  const keys = useRef<(e: KeyboardEvent) => void>(() => undefined);
  keys.current = (e: KeyboardEvent) => {
    const typing = e.target instanceof HTMLElement && (e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName));
    if (typing || !manifest) return;
    const k = e.key.toLowerCase();
    const mod = e.ctrlKey || e.metaKey;
    if (k === 'escape') { setSelected(null); setGroup(new Set()); return; }
    if ((k === 'delete' || k === 'backspace') && selected && (isPic(selected) || isBlock(selected)) && !locked.has(selected)) {
      e.preventDefault();
      removePiece(selected);
      return;
    }
    if (mod && k === 'd' && copyOf(selected)) { e.preventDefault(); placeCopy(copyOf(selected)!); return; }
    if (mod && k === 'c' && copyOf(selected)) {
      clip.current = copyOf(selected);
      // Kept in this browser too, to paste on another post.
      try { localStorage.setItem('cip-studio-clip', JSON.stringify(clip.current)); } catch { /* not kept: pasted here only */ }
      note('Copied - Ctrl+V to paste, here or on another post.');
      return;
    }
    if (mod && k === 'v') {
      let c = clip.current;
      try { c = c ?? (JSON.parse(localStorage.getItem('cip-studio-clip') ?? 'null') as typeof c); } catch { /* nothing kept */ }
      if (c) { e.preventDefault(); placeCopy(c); }
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (k === 'z' || k === 'y')) {
      e.preventDefault();
      const back = k === 'z' && !e.shiftKey;
      if ((back ? undos : redos).current.length) void arrange(null, [], back ? 'undo' : 'redo');
      return;
    }
    const d = e.shiftKey ? 0.02 : 0.004;
    const by = ({ arrowleft: [-d, 0], arrowright: [d, 0], arrowup: [0, -d], arrowdown: [0, d] } as Record<string, [number, number]>)[k];
    if (!by || !selected || !draggable(selected) || locked.has(selected)) return;
    e.preventDefault();
    const piece = selected;
    const start = nudge.current?.piece === piece ? nudge.current.box : boxOf(piece);
    if (!start) return;
    const box: Frac = { ...start, x: start.x + by[0], y: start.y + by[1] };
    // A pivot goes with the piece it belongs to.
    if (box.px !== undefined && box.py !== undefined) { box.px += by[0]; box.py += by[1]; }
    if (nudge.current) clearTimeout(nudge.current.timer);
    nudge.current = { piece, box, timer: setTimeout(() => { nudge.current = null; commit(piece, box); }, 450) };
    setMoved((m) => ({ ...m, [piece]: box }));
  };
  useEffect(() => {
    const on = (e: KeyboardEvent) => keys.current(e);
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);

  const choice = <K extends 'bottle' | 'size' | 'logo'>(key: K, options: { value: Layers[K]; label: string }[]) => (
    <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={`chip ${layers[key] === o.value ? 'on' : ''}`}
          aria-pressed={layers[key] === o.value}
          onClick={() => layers[key] !== o.value && void arrange({ choices: { [key]: o.value } })}
        >
          {o.label}
        </button>
      ))}
    </div>
  );

  const style: PostStyle = manifest?.choices.style ?? {};
  /** Where a look stands: as it is being slid, else as it was set, else as designed. */
  const valueOf = (key: SlideKey): number | null => drafts[key] ?? style[key] ?? SLIDES[key].plain;
  const setLook = (key: SlideKey, v: number | null) => {
    const plain = SLIDES[key].plain;
    const was = style[key] ?? plain;
    if (v === was) { setDrafts((d) => { const n = { ...d }; delete n[key]; return n; }); return; }
    void arrange({ choices: { style: { [key]: v === plain ? null : v } } }).then(() =>
      // Let go of the slid value once the post shows it - unless it was slid on since.
      setDrafts((d) => { if (d[key] !== v) return d; const n = { ...d }; delete n[key]; return n; }));
  };
  const slide = (key: SlideKey, extra?: React.ReactNode) => {
    const k = SLIDES[key];
    const v = valueOf(key);
    const shown = v ?? 0;
    const let_go = () => { const d = drafts[key]; if (d !== undefined) setLook(key, d); };
    return (
      <div className="studio-slide">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
          <span className="tiny muted">{k.label}</span>
          <span className="row" style={{ gap: 6, alignItems: 'center' }}>
            <span className="tiny">{v === null ? 'Away from the light' : k.shows(v)}</span>
            {extra}
            {v !== k.plain && (
              <button type="button" className="studio-reset" onClick={() => setLook(key, k.plain)} title="Back to as designed">
                Reset
              </button>
            )}
          </span>
        </div>
        <input
          type="range"
          min={k.min}
          max={k.max}
          step={k.step}
          value={shown}
          aria-label={k.label}
          onChange={(e) => { const n = Number(e.target.value); setDrafts((d) => ({ ...d, [key]: n })); }}
          onPointerUp={let_go}
          onKeyUp={let_go}
          onBlur={let_go}
          onDoubleClick={() => setLook(key, k.plain)}
        />
      </div>
    );
  };
  /**
   * What sliding shows before the post catches up: the bottle lighter or
   * darker, the shadow fainter or softer, the words bigger or smaller - by CSS,
   * on the layers already here. The post itself is set when the slider is let go.
   */
  const previewOf = (name: LayerName): React.CSSProperties => {
    const set = (key: SlideKey) => style[key] ?? SLIDES[key].plain ?? 0;
    const now = (key: SlideKey) => drafts[key];
    const out: React.CSSProperties = {};
    const filters: string[] = [];
    if (name === 'bottle' && now('bright') !== undefined) filters.push(`brightness(${((1 + now('bright')!) / (1 + set('bright'))).toFixed(3)})`);
    if (name === 'shadow') {
      const strength = now('shadow');
      if (strength !== undefined && set('shadow') > 0) out.opacity = Math.min(1, strength / set('shadow'));
      const soft = now('shadowSoft');
      if (soft !== undefined && soft > set('shadowSoft')) filters.push(`blur(${((soft - set('shadowSoft')) * 4).toFixed(1)}px)`);
    }
    // The whole post's contrast and colour, slid: every layer alike.
    const grading: string[] = [];
    if (now('contrast') !== undefined) grading.push(`contrast(${((1 + now('contrast')!) / (1 + set('contrast'))).toFixed(3)})`);
    if (now('saturation') !== undefined) grading.push(`saturate(${((1 + now('saturation')!) / Math.max(0.02, 1 + set('saturation'))).toFixed(3)})`);
    if (now('warmth') !== undefined && now('warmth') !== set('warmth')) {
      const d = now('warmth')! - set('warmth');
      grading.push(d > 0 ? `sepia(${(d * 0.35).toFixed(3)})` : `hue-rotate(${(d * 12).toFixed(1)}deg)`);
    }
    filters.push(...grading);
    if (name === 'background' && (now('bgZoom') !== undefined || now('bgX') !== undefined || now('bgY') !== undefined)) {
      // From the background as set to as slid: bigger by the one over the other, moved by the difference -
      // on the screen, as the server moves it, mirrored or not.
      const zs = set('bgZoom') || 1; const zd = now('bgZoom') ?? zs;
      const shift = (axis: 'bgX' | 'bgY') => ((now(axis) ?? set(axis)) * (zd - 1)) / 2 - ((set(axis) * (zs - 1)) / 2) * (zd / zs);
      out.transform = `translate(${(shift('bgX') * 100).toFixed(2)}%, ${(shift('bgY') * 100).toFixed(2)}%) scale(${(zd / zs).toFixed(4)})`;
      out.transformOrigin = '50% 50%';
    }
    if (name === 'background') {
      const bright = now('bgBright');
      if (bright !== undefined) filters.push(`brightness(${((1 + bright) / (1 + set('bgBright'))).toFixed(3)})`);
      const blur = now('bgBlur');
      if (blur !== undefined && blur > set('bgBlur')) filters.push(`blur(${((blur - set('bgBlur')) * 8).toFixed(1)}px)`);
    }
    if (name === 'logo') {
      const bright = now('logoBright');
      if (bright !== undefined) filters.push(`brightness(${((1 + bright) / (1 + set('logoBright'))).toFixed(3)})`);
      const opacity = now('logoOpacity');
      if (opacity !== undefined) out.opacity = Math.min(1, opacity / set('logoOpacity'));
    }
    if (name === 'reflection') {
      const strength = now('reflection');
      if (strength !== undefined && set('reflection') > 0) out.opacity = Math.min(1, strength / set('reflection'));
      const soft = now('reflectionSoft');
      if (soft !== undefined && soft > set('reflectionSoft')) filters.push(`blur(${((soft - set('reflectionSoft')) * 3).toFixed(1)}px)`);
    }
    if (filters.length) out.filter = filters.join(' ');
    if (name === 'headline' && now('textSize') !== undefined && !moved.text && manifest?.boxes.text) {
      const b = manifest.boxes.text;
      out.transform = `scale(${(now('textSize')! / set('textSize')).toFixed(3)})`;
      out.transformOrigin = `${b.x * 100}% ${b.y * 100}%`;
    }
    return out;
  };
  /** One look of the post, chosen from a few: the one it has is lit, and choosing what it is already sends nothing. */
  const looks = <K extends keyof PostStyle>(key: K, options: { value: PostStyle[K] | null; label: string }[], plain: PostStyle[K] | null) => {
    const now = style[key] ?? plain;
    return (
      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
        {options.map((o) => (
          <button
            key={o.label}
            type="button"
            className={`chip ${now === o.value ? 'on' : ''}`}
            aria-pressed={now === o.value}
            onClick={() => now !== o.value && void arrange({ choices: { style: { [key]: o.value === plain ? null : o.value } } })}
          >
            {o.label}
          </button>
        ))}
      </div>
    );
  };

  /** On or off: a piece on the post, or left off it. */
  const toggle = (on: boolean, labels: [string, string], set: (on: boolean) => void) => (
    <div className="row" style={{ gap: 6 }}>
      {[true, false].map((value, i) => (
        <button
          key={labels[i]}
          type="button"
          className={`chip ${on === value ? 'on' : ''}`}
          aria-pressed={on === value}
          onClick={() => on !== value && set(value)}
        >
          {labels[i]}
        </button>
      ))}
    </div>
  );

  // The shadow and the reflection first, so the bottle's box lies over them where they meet.
  // The layers from the bottom up: the background, then each piece in the order a person put them.
  const order: StackGroupC[] = stackOfC(manifest?.choices.order);
  const stacked = [
    LAYER_LIST.find((l) => l.name === 'background')!,
    ...order.flatMap((g) => STACK_LAYERS[g].map((n) => LAYER_LIST.find((l) => l.name === n)!)),
  ];
  const handles = ([
    'shadow', 'reflection', 'bottle', 'text', 'logo',
    ...(manifest?.choices.pictures ?? []).map((pic) => `p:${pic.id}` as Piece),
    ...(manifest?.boxes.texts ?? []).map((t) => `t:${t.id}` as Piece),
  ] as Piece[]).filter(draggable);
  /** A picture's look as being slid, before the post catches up. */
  const [picDrafts, setPicDrafts] = useState<Record<string, Partial<PictureC>>>({});
  /** The canvas's width on screen, for a picture's shadow to be the size the post will have it. */
  const [canvasW, setCanvasW] = useState(600);
  useEffect(() => {
    const el = canvasRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const watch = new ResizeObserver(() => setCanvasW(el.clientWidth || 600));
    watch.observe(el);
    return () => watch.disconnect();
  }, [manifest !== null]);
  const picturesShown = () => (manifest?.choices.pictures ?? []).map((pic) => {
    const b = boxOf(`p:${pic.id}`);
    if (!b) return null;
    const look = { ...pic, ...(picDrafts[pic.id] ?? {}) };
    const filters: string[] = [];
    if (look.bright) filters.push(`brightness(${(1 + look.bright).toFixed(3)})`);
    if (look.shadow) {
      const size = Math.max(b.w * canvasW, (b.h * canvasW * (manifest!.height / manifest!.width)));
      filters.push(`drop-shadow(0 ${(b.h * canvasW * (manifest!.height / manifest!.width) * 0.02 * look.shadow).toFixed(1)}px ${(size * 0.025 * look.shadow).toFixed(1)}px rgba(0,0,0,${Math.min(0.8, 0.4 * look.shadow).toFixed(2)}))`);
    }
    const W = manifest!.width;
    const src = look.shape
      ? shapeSrc(look.shape, look.w * W, look.w * W * look.aspect)
      : `/api/drive/files/${look.file}/content?size=640`;
    const c = look.crop ?? { l: 0, t: 0, r: 0, b: 0 };
    const kw = 1 - c.l - c.r;
    const kh = 1 - c.t - c.b;
    // The picture inside its box, larger by what is cropped, moved by what is cut off its top and left.
    const inner: React.CSSProperties = { position: 'absolute', left: `${(-c.l / kw) * 100}%`, top: `${(-c.t / kh) * 100}%`, width: `${100 / kw}%`, height: `${100 / kh}%` };
    // As the server fades it: up to six tenths of the way in from each edge, of half its short side.
    const fade = look.feather ? (look.feather * 0.6 * Math.min(b.w * W, b.h * manifest!.height)) / 2 : 0;
    const fx = fade ? (fade / (b.w * W)) * 100 : 0;
    const fy = fade ? (fade / (b.h * (manifest!.height))) * 100 : 0;
    const mask = fade
      ? `linear-gradient(to right, transparent, #000 ${fx.toFixed(1)}%, #000 ${(100 - fx).toFixed(1)}%, transparent), linear-gradient(to bottom, transparent, #000 ${fy.toFixed(1)}%, #000 ${(100 - fy).toFixed(1)}%, transparent)`
      : undefined;
    // Its shadow on the surface, at its foot, as the server lays it.
    const footW = b.w * 0.84;
    const footH = (b.w * W * 0.09) / manifest!.height;
    const ground = look.ground ? (
      <span
        key={`pic-ground-${pic.id}`}
        className={`studio-pic ${shows('pictures') ? '' : 'is-hidden'}`}
        style={{
          left: `${(b.x + b.w / 2 - footW / 2) * 100}%`, top: `${(b.y + b.h * 0.985 - footH / 2) * 100}%`,
          width: `${footW * 100}%`, height: `${footH * 100}%`, borderRadius: '50%',
          background: `rgba(0,0,0,${Math.min(0.75, 0.7 * look.ground).toFixed(2)})`,
          filter: `blur(${Math.max(2, b.w * canvasW * 0.04).toFixed(1)}px)`,
        }}
      />
    ) : null;
    // Its reflection on the surface, as the server lays it: upside down below its foot, fading away.
    const mirrorDeep = b.h * 0.55;
    const reflection = look.mirror && Math.abs(b.r ?? 0) < 8 ? (
      <div
        key={`pic-mirror-${pic.id}`}
        className={`studio-pic ${shows('pictures') ? '' : 'is-hidden'}`}
        style={{
          left: `${b.x * 100}%`, top: `${(b.y + b.h * 0.99) * 100}%`, width: `${b.w * 100}%`, height: `${mirrorDeep * 100}%`,
          overflow: 'hidden', opacity: Math.min(0.6, 0.45 * look.mirror) * (look.opacity ?? 1),
          maskImage: 'linear-gradient(to bottom, #000, transparent)', WebkitMaskImage: 'linear-gradient(to bottom, #000, transparent)',
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt="" draggable={false} style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: `${(b.h / mirrorDeep) * 100}%`, transform: `scaleY(-1)${look.flip ? ' scaleX(-1)' : ''}` }} />
      </div>
    ) : null;
    return [ground, reflection, (
      <div
        key={`pic-${pic.id}`}
        className={`studio-pic ${shows('pictures') ? '' : 'is-hidden'}`}
        style={{
          left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%`,
          transform: `rotate(${b.r ?? 0}deg)${look.flip ? ' scaleX(-1)' : ''}`,
          opacity: look.opacity ?? 1,
          overflow: 'hidden',
          ...(filters.length ? { filter: filters.join(' ') } : {}),
          ...(mask ? { maskImage: mask, WebkitMaskImage: mask, maskComposite: 'intersect', WebkitMaskComposite: 'source-in' } as React.CSSProperties : {}),
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt="" draggable={false} style={inner} />
        {look.tint && look.tintAmount ? (
          // The colour laid over the picture only, never its clear ground.
          <span style={{ ...inner, background: look.tint, opacity: look.tintAmount, maskImage: `url("${src}")`, WebkitMaskImage: `url("${src}")`, maskSize: '100% 100%', WebkitMaskSize: '100% 100%' } as React.CSSProperties} />
        ) : null}
      </div>
    )];
  });

  return (
    <div className="studio">
      <div className="studio-stage">
        <div
          ref={canvasRef}
          className="studio-canvas"
          style={{
            aspectRatio: manifest ? `${manifest.width} / ${manifest.height}` : '1 / 1',
            // A tall story is held to the screen's height, and narrows to keep its shape.
            width: manifest ? `min(100%, calc(72vh * ${manifest.width} / ${manifest.height}))` : '100%',
            // While the background is zoomed or moved by a slider, what goes past the post is not shown.
            ...(drafts.bgZoom !== undefined || drafts.bgX !== undefined || drafts.bgY !== undefined ? { overflow: 'hidden' } : {}),
          }}
          onPointerMove={onMove}
          onPointerUp={onDrop}
          onPointerCancel={onDrop}
          onPointerDown={() => { setSelected(null); setGroup(new Set()); }}
        >
          {manifest
            ? stacked.map((l) => (l.name === 'pictures' ? picturesShown() : l.name === 'texts' ? (
                (manifest.boxes.texts ?? []).map((t) => {
                  const pad = 0.012;
                  const piece = `t:${t.id}` as Piece;
                  return (
                    <img
                      key={`texts-${t.id}`}
                      src={layerSrc(generation.id, manifest, 'texts')}
                      alt=""
                      draggable={false}
                      className={`studio-layer ${shows('texts') ? '' : 'is-hidden'}`}
                      style={{
                        clipPath: `inset(${(t.y - pad) * 100}% ${(1 - t.x - t.w - pad) * 100}% ${(1 - t.y - t.h - pad) * 100}% ${(t.x - pad) * 100}%)`,
                        transform: transformOfPiece(piece), transformOrigin: '0 0',
                      }}
                    />
                  );
                })
              ) : (
                <img
                  key={l.name}
                  src={layerSrc(generation.id, manifest, l.name)}
                  alt=""
                  draggable={false}
                  className={`studio-layer ${shows(l.name) ? '' : 'is-hidden'}`}
                  style={{ transform: transformFor(l.name), transformOrigin: originFor(l.name), ...previewOf(l.name), ...clipOf(l.name) }}
                />
              )))
            : <div className="studio-wait">Laying out the layers…</div>}
          {painting && <div className="studio-wait">Painting a new background…</div>}

          {cropBox && (
            <div className="studio-crop-box" style={{ left: `${cropBox.box.x * 100}%`, top: `${cropBox.box.y * 100}%`, width: `${cropBox.box.w * 100}%`, height: `${cropBox.box.h * 100}%` }} />
          )}
          {manifest && handles.map((piece) => {
            const b = boxOf(piece)!;
            return (
              <div
                key={piece}
                className={`studio-box ${selected === piece ? 'is-on' : ''} ${group.size > 1 && group.has(piece) ? 'is-grouped' : ''} ${locked.has(piece) ? 'is-locked' : ''}`}
                style={{
                  left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%`,
                  ...(b.r ? {
                    transform: `rotate(${b.r}deg)`,
                    transformOrigin: `${((pivotOf(b).x - b.x) / b.w) * 100}% ${((pivotOf(b).y - b.y) / b.h) * 100}%`,
                  } : {}),
                }}
                onPointerDown={startDrag(piece, 'move')}
                onDoubleClick={piece === 'text' && generation.headline ? () => setInline(generation.headline!.map((l) => ({ ...l }))) : undefined}
                title={piece === 'text'
                  ? 'Drag the headline; pull its corner to resize; double-click to change its words'
                  : turns(piece)
                    ? `Drag the ${labelOf(piece).toLowerCase()}; pull its corner to resize; turn it by the round handle`
                    : `Drag the ${labelOf(piece).toLowerCase()}; pull its corner to resize`}
              >
                <span className="studio-box-label" style={b.r ? { transform: `rotate(${-b.r}deg)` } : undefined}>{locked.has(piece) ? '🔒 ' : ''}{labelOf(piece)}{b.r ? ` · ${Math.round(b.r)}°` : ''}</span>
                {b.px !== undefined && b.py !== undefined && (
                  <span
                    className="studio-box-pivot"
                    style={{ left: `${((b.px - b.x) / b.w) * 100}%`, top: `${((b.py - b.y) / b.h) * 100}%` }}
                    title="It turns about here - the bottle's foot"
                  />
                )}
                {turns(piece) && !locked.has(piece) && (
                  <span
                    // The reflection hangs below the foot: its handle goes below it, clear of the bottle.
                    className={`studio-box-turn ${piece === 'reflection' ? 'is-below' : ''}`}
                    onPointerDown={startDrag(piece, 'turn')}
                    aria-label={`Turn the ${labelOf(piece).toLowerCase()}`}
                    title="Drag round to turn; Alt for any angle"
                  >
                    <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
                      <path d="M13 8a5 5 0 1 1-1.6-3.7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                      <path d="M13.2 1.8v3.4H9.8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </span>
                )}
                {selected === piece && group.size <= 1 && croppable(piece) && (['l', 'r', 't', 'b'] as const).map((side) => (
                  <span key={side} className={`studio-box-crop is-${side}`} onPointerDown={startCrop(piece, side)}
                    aria-label={`Crop the ${labelOf(piece).toLowerCase()} from the ${{ l: 'left', r: 'right', t: 'top', b: 'foot' }[side]}`}
                    title="Pull to crop - pull back out to give it back" />
                ))}
                {!locked.has(piece) && <span className="studio-box-grip" onPointerDown={startDrag(piece, 'resize')} aria-label={`Resize the ${labelOf(piece).toLowerCase()}`} title="Pull to make it bigger or smaller">
                  <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true">
                    <path d="M4 12L12 4M7.5 4H12v4.5M4 7.5V12h4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>}
              </div>
            );
          })}
          {inline && manifest?.boxes.text && (() => {
            const b = boxOf('text')!;
            const save = () => {
              const lines = inline.filter((l) => l.text.trim());
              setInline(null);
              if (lines.length && lines.map((l) => l.text).join('|') !== (generation.headline ?? []).map((l) => l.text).join('|')) void arrange({ lines });
            };
            return (
              <div
                className="studio-inline"
                style={{ left: `${Math.min(b.x, 0.6) * 100}%`, top: `${b.y * 100}%`, minWidth: `${Math.max(b.w, 0.3) * 100}%` }}
                onPointerDown={(e) => e.stopPropagation()}
              >
                {inline.map((line, i) => (
                  <input
                    key={i}
                    className="field-input"
                    value={line.text}
                    maxLength={80}
                    autoFocus={i === 0}
                    aria-label={`Headline line ${i + 1}`}
                    onChange={(e) => setInline((all) => all!.map((l, n) => (n === i ? { ...l, text: e.target.value } : l)))}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { e.preventDefault(); save(); }
                      if (e.key === 'Escape') { e.preventDefault(); setInline(null); }
                    }}
                  />
                ))}
                <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                  <button type="button" className="btn btn-primary btn-sm" onClick={save}>Set</button>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setInline(null)}>Cancel</button>
                  <span className="tiny muted">Enter to set, Esc to leave it</span>
                </div>
              </div>
            );
          })()}
          {guides.x.map((x) => <span key={`x${x}`} className="studio-guide is-v" style={{ left: `${x * 100}%` }} />)}
          {guides.y.map((y) => <span key={`y${y}`} className="studio-guide is-h" style={{ top: `${y * 100}%` }} />)}
        </div>
        <div className="row" style={{ gap: 8, justifyContent: 'center', alignItems: 'center', marginTop: 10, flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-ghost btn-sm" disabled={!undos.current.length} onClick={() => void arrange(null, [], 'undo')} title="Undo (Ctrl+Z)">
            Undo
          </button>
          <button type="button" className="btn btn-ghost btn-sm" disabled={!redos.current.length} onClick={() => void arrange(null, [], 'redo')} title="Redo (Ctrl+Shift+Z)">
            Redo
          </button>
          {Boolean(selected) && (
            <span className="studio-tools" role="toolbar" aria-label="Line up">
              {([
                ['left', 'Line up on the left', 'M3 2v12M6 4h7v3H6zM6 9h4v3H6z'],
                ['center', 'Line up on the middle', 'M8 2v12M4 4h8v3H4zM5.5 9h5v3h-5z'],
                ['right', 'Line up on the right', 'M13 2v12M3 4h7v3H3zM6 9h4v3H6z'],
                ['top', 'Line up at the top', 'M2 3h12M4 6v7h3V6zM9 6v4h3V6z'],
                ['middle', 'Line up across the middle', 'M2 8h12M4 4v8h3V4zM9 5.5v5h3v-5z'],
                ['bottom', 'Line up at the foot', 'M2 13h12M4 3v7h3V3zM9 6v4h3V6z'],
              ] as const).map(([how, label, d]) => (
                <button key={how} type="button" className="studio-tool" onClick={() => lineUp(how)} title={group.size > 1 ? `${label} - of each other` : `${label} of the post`} aria-label={label}>
                  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d={d} fill="none" stroke="currentColor" strokeWidth="1.4" /></svg>
                </button>
              ))}
              {group.size > 2 && (
                <>
                  <button type="button" className="studio-tool is-word" onClick={() => spaceOut('x')} title="Space them evenly across">Space ↔</button>
                  <button type="button" className="studio-tool is-word" onClick={() => spaceOut('y')} title="Space them evenly down">Space ↕</button>
                </>
              )}
              <button
                type="button"
                className={`studio-tool is-word ${[...(group.size > 1 ? group : [selected!])].every((x) => locked.has(x)) ? 'is-on' : ''}`}
                onClick={toggleLock}
                title="Hold it still, so a drag cannot move it"
              >
                {[...(group.size > 1 ? group : [selected!])].every((x) => locked.has(x)) ? 'Unlock' : 'Lock'}
              </button>
            </span>
          )}
          <span className="tiny muted">
            {saving
              ? 'Saving where you put it…'
              : handles.length
                ? 'Drag to move, Shift-click to choose several, arrows to nudge, Delete, Ctrl+D, Ctrl+C/V. All free.'
                : 'The background alone. Add the bottle next.'}
          </span>
        </div>
        {/* What a designer would point at - measured on the post, nothing spent. */}
        {Boolean(manifest?.checks?.length) && step > 0 && (
          <ul className="studio-checks">
            {manifest!.checks!.map((given) => {
              const c = typeof given === 'string' ? { text: given } : given;
              return (
                <li key={c.text}>
                  <Icon name="alert" size={13} /> <span className="grow">{c.text}</span>
                  {c.fix && (
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => void arrange(c.fix!.choices)} title="Put it right - free">
                      Fix it
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <aside className="studio-panel">
        <ol className="studio-steps">
          {STUDIO_STEPS.map((s, i) => (
            <li key={s.id}>
              <button
                type="button"
                className={`studio-step ${i === step ? 'is-on' : ''} ${i < step ? 'is-done' : ''}`}
                onClick={() => setStep(i)}
                aria-current={i === step ? 'step' : undefined}
              >
                <span className="studio-step-n">{i < step ? <Icon name="check" size={12} /> : i + 1}</span>
                {s.label}
              </button>
            </li>
          ))}
        </ol>

        <div className="studio-body">
          {current.id === 'background' && (
            <>
              <p className="studio-q">The background, made for this post.</p>
              <p className="tiny muted">
                Painted in the brand&apos;s own style, with room for the bottle on any side. Everything you place on it
                next is free.
              </p>
              <div className="studio-group">
                <p className="studio-group-title">Background</p>
                {slide('bgBright')}
                {slide('bgBlur')}
                <p className="tiny muted" style={{ margin: 0 }}>Darker or softer, the bottle and the words stand out more. Free.</p>
              </div>
              <div className="studio-group">
                <p className="studio-group-title">Frame it</p>
                {slide('bgZoom')}
                {(valueOf('bgZoom') ?? 1) > 1 && slide('bgX')}
                {(valueOf('bgZoom') ?? 1) > 1 && slide('bgY')}
                <div className="row" style={{ gap: 6 }}>
                  <button type="button" className={`chip ${style.bgFlip ? 'on' : ''}`} aria-pressed={Boolean(style.bgFlip)} onClick={() => void arrange({ choices: { style: { bgFlip: !style.bgFlip } } })}>
                    Mirror it
                  </button>
                </div>
              </div>
              <div className="studio-group">
                <p className="studio-group-title">Colour and edges</p>
                <span className="row headline-line-inks">
                  {['#000000', '#ffffff', ...inks.filter((i) => !['#000000', '#ffffff'].includes(i))].map((ink) => (
                    <button
                      key={ink}
                      type="button"
                      className={`headline-ink ${(style.bgOverlay ?? '#000000') === ink ? 'is-on' : ''}`}
                      style={{ background: ink }}
                      onClick={() => void arrange({ choices: { style: { bgOverlay: ink, ...((style.bgOverlayAmount ?? 0) === 0 ? { bgOverlayAmount: 0.5 } : {}) } } })}
                      aria-label={`Colour from below in ${ink}`}
                    />
                  ))}
                  <AnyColour value={style.bgOverlay && !['#000000', '#ffffff', ...inks].includes(style.bgOverlay) ? style.bgOverlay : null} label="Any colour from below"
                    onPick={(ink) => void arrange({ choices: { style: { bgOverlay: ink, ...((style.bgOverlayAmount ?? 0) === 0 ? { bgOverlayAmount: 0.5 } : {}) } } })} />
                </span>
                {slide('bgOverlayAmount')}
                {slide('bgVignette')}
              </div>
              <div className="studio-group">
                <p className="studio-group-title">The whole post</p>
                <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                  {POST_LOOKS.map((l) => {
                    const on = (['warmth', 'contrast', 'saturation'] as const).every((k) => (style[k] ?? null) === (l.style[k] ?? null));
                    return (
                      <button key={l.label} type="button" className={`chip ${on ? 'on' : ''}`} aria-pressed={on} onClick={() => !on && void arrange({ choices: { style: l.style } })}>
                        {l.label}
                      </button>
                    );
                  })}
                </div>
                {slide('warmth')}
                {slide('contrast')}
                {slide('saturation')}
                <p className="tiny muted" style={{ margin: 0 }}>Every layer alike, and the files you download too. Free.</p>
              </div>
            </>
          )}

          {current.id === 'bottle' && (
            <>
              <p className="studio-q">The bottle, its shadow and its reflection</p>
              {/* With no bottle, where it would stand is all there is to set. */}
              {layers.bottle === 'none' && (
                <>
                  <p className="tiny muted">Drag it on the picture, and pull its corner to make it bigger or smaller - or start from a place:</p>
                  {choice('bottle', BOTTLE_PLACES)}
                </>
              )}
              {layers.bottle !== 'none' && library.bottles.length > 1 && part === 'bottle' && (
                <div className="studio-group">
                  <p className="studio-group-title">Which bottle · {library.bottles.length} in the library</p>
                  <div className="lib-strip" role="listbox" aria-label="The brand's bottles and packs">
                    {library.bottles.map((b) => {
                      const on = (manifest?.choices.bottleFile ?? library.bottleFile) === b.id;
                      return (
                        <button key={b.id} type="button" className={`lib-pick is-bottle ${on ? 'is-on' : ''}`} aria-selected={on}
                          onClick={() => { if (!on) void arrange({ choices: { bottleFile: b.id } }); }} title={b.name}>
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={`/api/drive/files/${b.id}/content?size=320`} alt="" className="lib-img" loading="lazy" />
                          <span className="lib-name">{b.variant ?? 'Standard'}</span>
                        </button>
                      );
                    })}
                  </div>
                  <p className="tiny muted" style={{ margin: 0 }}>Choose any flavour or pack - it is set in the same place, with its shadow and reflection. Free.</p>
                </div>
              )}
              {layers.bottle !== 'none' && part === 'bottle' && library.brand === 'Magic Moments' && library.allBottles.length > 0 && (
                <div className="studio-group">
                  <p className="studio-group-title">Add another bottle · {(manifest?.choices.pictures ?? []).length}/8 on the post</p>
                  <div className="lib-strip" role="listbox" aria-label="Add another Magic Moments bottle">
                    {library.allBottles.map((b) => (
                      <button key={b.id} type="button" className="lib-pick is-bottle" onClick={() => void addBottle(b.id)} title={`Add ${b.name} beside the others`}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={`/api/drive/files/${b.id}/content?size=320`} alt="" className="lib-img" loading="lazy" />
                        <span className="lib-name">+ {b.variant ?? 'Plain'}</span>
                      </button>
                    ))}
                  </div>
                  <p className="tiny muted" style={{ margin: 0 }}>Each one stands on the same surface beside the bottle, its size, with its shadow and reflection - drag, resize, turn or crop it in Pictures. Free.</p>
                </div>
              )}
              {layers.bottle !== 'none' && part === 'bottle' && (() => {
                const crop = cropDraft ?? manifest?.choices.style?.bottleCrop ?? { l: 0, t: 0, r: 0, b: 0 };
                const commit = () => {
                  if (!cropDraft) return;
                  const sent = cropDraft;
                  void arrange({ choices: { style: { bottleCrop: sent.l || sent.t || sent.r || sent.b ? sent : null } } }).then(() => setCropDraft((d) => (d === sent ? null : d)));
                };
                return (
                  <div className="studio-group">
                    <p className="studio-group-title">Size, light and crop</p>
                    {slide('bright')}
                    {manifest?.boxes.bottle && (() => {
                      const b = manifest.boxes.bottle;
                      const h = sizeDraft.bottle ?? b.h;
                      const commit = () => {
                        const v = sizeDraft.bottle;
                        if (v === undefined) return;
                        const k = v / b.h;
                        setMoved((m) => ({ ...m, bottle: { ...b, x: b.x + b.w / 2 - (b.w * k) / 2, y: b.y + b.h - v, w: b.w * k, h: v } }));
                        void arrange({ choices: { place: { bottle: { cx: b.x + b.w / 2, base: b.y + b.h, height: v, ...(manifest.choices.place?.bottle?.rotate ? { rotate: manifest.choices.place.bottle.rotate } : {}) } } } }, ['bottle'])
                          .then(() => setSizeDraft((d) => { const n = { ...d }; if (n.bottle === v) delete n.bottle; return n; }));
                      };
                      return (
                        <div className="studio-slide">
                          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
                            <span className="tiny muted">Size</span><span className="tiny">{Math.round(h * 100)}% of the height</span>
                          </div>
                          <input type="range" min={0.15} max={1.2} step={0.01} value={h} aria-label="The bottle's size"
                            onChange={(e) => setSizeDraft((d) => ({ ...d, bottle: Number(e.target.value) }))} onPointerUp={commit} onKeyUp={commit} onBlur={commit} />
                        </div>
                      );
                    })()}
                    {(['l', 'r', 't', 'b'] as const).map((side) => (
                      <div className="studio-slide" key={side}>
                        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
                          <span className="tiny muted">{{ l: 'Crop the left', r: 'Crop the right', t: 'Crop the top', b: 'Crop the foot' }[side]}</span>
                          <span className="tiny">{Math.round(crop[side] * 100)}%</span>
                        </div>
                        <input type="range" min={0} max={0.45} step={0.01} value={crop[side]} aria-label={`Crop the bottle - ${side}`}
                          onChange={(e) => setCropDraft({ ...crop, [side]: Number(e.target.value) })} onPointerUp={commit} onKeyUp={commit} onBlur={commit} />
                      </div>
                    ))}
                    {(crop.l || crop.t || crop.r || crop.b) ? (
                      <button type="button" className="btn btn-ghost btn-sm" style={{ justifySelf: 'start' }}
                        onClick={() => { setCropDraft(null); void arrange({ choices: { style: { bottleCrop: null } } }); }}>
                        Uncrop
                      </button>
                    ) : null}
                    <p className="tiny muted" style={{ margin: 0 }}>Cut a box, a pouch or an edge away. Resize and turn it on the picture. Free.</p>
                  </div>
                );
              })()}
              {layers.bottle !== 'none' && (
                <>
                  {((part === 'bottle' && Boolean(manifest?.choices.place?.bottle?.rotate))
                    || (part === 'shadow' && manifest?.choices.place?.shadow)
                    || (part === 'reflection' && manifest?.choices.place?.reflection)) && (
                    <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                      {part === 'bottle' && Boolean(manifest?.choices.place?.bottle?.rotate) && (
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => void arrange({ choices: { place: { bottle: { ...manifest!.choices.place!.bottle!, rotate: 0 } } } })}
                        >
                          Stand the bottle straight
                        </button>
                      )}
                      {part === 'shadow' && manifest?.choices.place?.shadow && (
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void arrange({ choices: { place: { shadow: null } } })}>
                          Shadow back where it falls
                        </button>
                      )}
                      {part === 'reflection' && manifest?.choices.place?.reflection && (
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void arrange({ choices: { place: { reflection: null } } })}>
                          Reflection back under the bottle
                        </button>
                      )}
                    </div>
                  )}
                  <p className="tiny muted" style={{ margin: 0 }}>
                    Click the bottle, its shadow or its reflection on the picture - or choose one here - to set it on its own.
                  </p>
                  <div className="studio-parts" role="tablist" aria-label="What to set">
                    {(['bottle', 'shadow', 'reflection'] as const)
                      .filter((piece) => piece !== 'reflection' || Boolean(manifest?.boxes.reflection))
                      .map((piece) => (
                        <button
                          key={piece}
                          type="button"
                          role="tab"
                          aria-selected={part === piece}
                          className={`studio-part ${part === piece ? 'is-on' : ''}`}
                          onClick={() => { setPart(piece); setSelected(piece); }}
                        >
                          {labelOf(piece)}
                        </button>
                      ))}
                  </div>
                  {part === 'bottle' && (
                    <div className="studio-group">
                      <p className="studio-group-title">Bottle</p>
                      <span className="tiny muted">Where it stands</span>
                      {choice('bottle', BOTTLE_PLACES)}
                      <p className="tiny muted" style={{ margin: 0 }}>Drag it to move, pull its corner to size it, the round handle to turn it.</p>
                    </div>
                  )}
                  {part === 'shadow' && (
                    <div className="studio-group">
                      <p className="studio-group-title">Shadow</p>
                      {slide('shadow')}
                      {slide('shadowSoft')}
                      {slide('shadowAngle', valueOf('shadowAngle') === null ? null : (
                        <button type="button" className="studio-reset" onClick={() => setLook('shadowAngle', null)} title="Fall away from the scene's light">
                          Auto
                        </button>
                      ))}
                      {slide('shadowLength')}
                      <p className="tiny muted" style={{ margin: 0 }}>
                        Drag it on the picture to move it, its corner to size it, the round handle to turn it about the bottle&apos;s foot.
                      </p>
                    </div>
                  )}
                  {part === 'reflection' && manifest?.boxes.reflection && (
                    <div className="studio-group">
                      <p className="studio-group-title">Reflection</p>
                      {slide('reflection')}
                      {slide('reflectionSoft')}
                      <p className="tiny muted" style={{ margin: 0 }}>
                        Drag it on the picture to move it, its corner to size it, the round handle to turn it about the bottle&apos;s foot.
                      </p>
                    </div>
                  )}
                </>
              )}
            </>
          )}

          {current.id === 'pictures' && manifest && (
            <StudioPictures
              generationId={generation.id}
              bottleFiles={library.allBottles.map((b) => b.id)}
              bottle={manifest.boxes.bottle}
              pictures={manifest.choices.pictures ?? []}
              postAspect={manifest.height / manifest.width}
              selected={selected && isPic(selected) ? selected.slice(2) : null}
              onSelect={(id) => setSelected(id ? `p:${id}` : null)}
              drafts={picDrafts}
              inks={inks}
              fonts={fonts}
              onBrush={(file) => setBrushing(file)}
              onDraft={(id, look) => setPicDrafts((d) => ({ ...d, [id]: { ...(d[id] ?? {}), ...look } }))}
              onChange={(make, settle) => arrange({ choices: { pictures: make(listNow('pictures')) } }).then((ok) => {
                if (settle) setPicDrafts((d) => { const n = { ...d }; delete n[settle]; return n; });
                return ok;
              })}
            />
          )}

          {brushing && manifest && (
            <CutoutBrush
              file={brushing}
              onClose={() => setBrushing(null)}
              onSaved={(file) => {
                const was = brushing;
                setBrushing(null);
                void arrange({ choices: { pictures: listNow('pictures').map((x) => (x.file === was ? { ...x, file } : x)) } });
                note('Touched up - free.');
              }}
            />
          )}

          {current.id === 'logo' && (
            <>
              <p className="studio-q">The logo</p>
              {toggle(
                logoOn,
                ['Logo', 'No logo'],
                (on) => { setWant((w) => ({ ...w, logo: on })); void arrange({ choices: { logo: on ? 'top-right' : 'none' } }); },
              )}
              {logoOn && (
                <>
                  <p className="tiny muted">Drag it on the picture to place it; pull its corner to resize it; the round handle turns it.</p>
                  {Boolean(manifest?.choices.place?.logo?.rotate) && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      style={{ justifySelf: 'start' }}
                      onClick={() => void arrange({ choices: { place: { logo: { ...manifest!.choices.place!.logo!, rotate: 0 } } } })}
                    >
                      Stand the logo straight
                    </button>
                  )}
                  {library.logos.length > 0 && (
                    <div className="studio-group">
                      <p className="studio-group-title">Which logo · {library.logos.length} in the library</p>
                      <div className="lib-strip" role="listbox" aria-label="The brand's logos">
                        <button type="button" className={`lib-pick is-auto ${!manifest?.choices.logoFile && !style.logoTone ? 'is-on' : ''}`}
                          aria-selected={!manifest?.choices.logoFile && !style.logoTone}
                          onClick={() => void arrange({ choices: { logoFile: null, style: { logoTone: null } } })} title="The one that stands out against the picture">
                          <span className="lib-auto">Auto</span>
                          <span className="lib-name">Best for the picture</span>
                        </button>
                        {library.logos.map((l) => {
                          const on = manifest?.choices.logoFile === l.id;
                          return (
                            <button key={l.id} type="button" className={`lib-pick ${on ? 'is-on' : ''}`} aria-selected={on}
                              onClick={() => void arrange({ choices: { logoFile: l.id, style: { logoTone: null } } })} title={l.name}>
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img src={`/api/drive/files/${l.id}/content?size=320`} alt="" className={`lib-img is-${l.tone}`} loading="lazy" />
                              <span className="lib-name">{l.variant ? `${l.variant} · ` : ''}{l.tone === 'light' ? 'White' : l.tone === 'dark' ? 'Dark' : 'Colour'}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                  <div className="studio-group">
                    <p className="studio-group-title">Logo</p>
                    {slide('logoBright')}
                    {slide('logoShadow')}
                    {slide('logoOpacity')}
                  </div>
                  {(() => {
                    const crop = logoCropDraft ?? manifest?.choices.style?.logoCrop ?? { l: 0, t: 0, r: 0, b: 0 };
                    const commit = () => {
                      if (!logoCropDraft) return;
                      const sent = logoCropDraft;
                      void arrange({ choices: { style: { logoCrop: sent.l || sent.t || sent.r || sent.b ? sent : null } } }).then(() => setLogoCropDraft((d) => (d === sent ? null : d)));
                    };
                    return (
                      <div className="studio-group">
                        <p className="studio-group-title">Size and crop</p>
                        {manifest?.boxes.logo && (() => {
                          const lb = manifest.boxes.logo;
                          const w = sizeDraft.logo ?? lb.w;
                          const commit = () => {
                            const v = sizeDraft.logo;
                            if (v === undefined) return;
                            // Kept to its right edge when it sits on the right, as a logo in a corner is.
                            const x = lb.x + lb.w / 2 > 0.5 ? lb.x + lb.w - v : lb.x;
                            const k = v / lb.w;
                            setMoved((m) => ({ ...m, logo: { ...lb, x, w: v, h: lb.h * k } }));
                            void arrange({ choices: { place: { logo: { x, y: lb.y, w: v, ...(manifest.choices.place?.logo?.rotate ? { rotate: manifest.choices.place.logo.rotate } : {}) } } } }, ['logo'])
                              .then(() => setSizeDraft((d) => { const n = { ...d }; if (n.logo === v) delete n.logo; return n; }));
                          };
                          return (
                            <div className="studio-slide">
                              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
                                <span className="tiny muted">Size</span><span className="tiny">{Math.round(w * 100)}% of the width</span>
                              </div>
                              <input type="range" min={0.05} max={0.6} step={0.005} value={w} aria-label="The logo's size"
                                onChange={(e) => setSizeDraft((d) => ({ ...d, logo: Number(e.target.value) }))} onPointerUp={commit} onKeyUp={commit} onBlur={commit} />
                            </div>
                          );
                        })()}
                        {(['l', 'r', 't', 'b'] as const).map((side) => (
                          <div className="studio-slide" key={side}>
                            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
                              <span className="tiny muted">{{ l: 'Crop the left', r: 'Crop the right', t: 'Crop the top', b: 'Crop the foot' }[side]}</span>
                              <span className="tiny">{Math.round(crop[side] * 100)}%</span>
                            </div>
                            <input type="range" min={0} max={0.45} step={0.01} value={crop[side]} aria-label={`Crop the logo - ${side}`}
                              onChange={(e) => setLogoCropDraft({ ...crop, [side]: Number(e.target.value) })} onPointerUp={commit} onKeyUp={commit} onBlur={commit} />
                          </div>
                        ))}
                        {(crop.l || crop.t || crop.r || crop.b) ? (
                          <button type="button" className="btn btn-ghost btn-sm" style={{ justifySelf: 'start' }}
                            onClick={() => { setLogoCropDraft(null); void arrange({ choices: { style: { logoCrop: null } } }); }}>
                            Uncrop
                          </button>
                        ) : null}
                        <p className="tiny muted" style={{ margin: 0 }}>Keep only the mark, or drop a line under it - for posts where the full logo is too much. Free.</p>
                      </div>
                    );
                  })()}
                </>
              )}
            </>
          )}

          {current.id === 'words' && generation.headline && (
            <>
              <p className="studio-q">The headline</p>
              {toggle(
                headlineOn,
                ['Headline', 'No headline'],
                (on) => { setWant((w) => ({ ...w, headline: on })); void arrange({ choices: { headline: on ? 'shown' : 'none' } }); },
              )}
              {headlineOn && (
              <TextEditor
                key={generation.headline.map((l) => l.text).join('|')}
                generation={generation}
                lines={generation.headline}
                hint="Suggested for this post, in the brand's own type. Change the words here; drag them on the picture to move them."
                saveLabel="Set the headline"
                fonts={fonts}
                inks={inks}
                onSave={async (lines) => arrange({ lines })}
                onDone={() => note('Headline set')}
              />
              )}
              {headlineOn && (
                <div className="stack" style={{ gap: 6 }}>
                  {inks.length > 0 && (
                    <>
                      <p className="tiny muted" style={{ margin: 0 }}>Colour - the brand&apos;s own</p>
                      <div className="row" style={{ gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                        <button
                          type="button"
                          className={`chip ${!style.ink ? 'on' : ''}`}
                          aria-pressed={!style.ink}
                          onClick={() => style.ink && void arrange({ choices: { style: { ink: null } } })}
                        >
                          As designed
                        </button>
                        {inks.map((ink) => (
                          <button
                            key={ink}
                            type="button"
                            className={`studio-swatch ${style.ink === ink ? 'is-on' : ''}`}
                            style={{ background: ink }}
                            aria-label={`Set the headline in ${ink}`}
                            aria-pressed={style.ink === ink}
                            title={ink}
                            onClick={() => style.ink !== ink && void arrange({ choices: { style: { ink } } })}
                          />
                        ))}
                        <AnyColour
                          value={style.ink && !inks.includes(style.ink) ? style.ink : null}
                          label="Any other colour for the headline"
                          onPick={(ink) => void arrange({ choices: { style: { ink } } })}
                        />
                      </div>
                    </>
                  )}
                  <p className="tiny muted" style={{ margin: 0 }}>Behind the words</p>
                  <div className="row" style={{ gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                    {([
                      { value: null, label: 'Auto', title: 'A soft shade where the picture is too busy for the words - as CIP sets it' },
                      { value: 'none', label: 'Nothing', title: 'No shade and no box: the words straight on the picture' },
                      { value: 'box', label: 'Box', title: 'A solid box behind each line, in a colour you choose' },
                    ] as const).map((o) => (
                      <button
                        key={o.label}
                        type="button"
                        className={`chip ${(style.backing ?? null) === o.value ? 'on' : ''}`}
                        aria-pressed={(style.backing ?? null) === o.value}
                        title={o.title}
                        onClick={() => (style.backing ?? null) !== o.value && void arrange({ choices: { style: { backing: o.value } } })}
                      >
                        {o.label}
                      </button>
                    ))}
                  </div>
                  {style.backing === 'box' && (
                    <div className="row" style={{ gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                      <span className="tiny muted">Box colour</span>
                      {inks.map((ink) => (
                        <button
                          key={ink}
                          type="button"
                          className={`studio-swatch ${(style.backingInk ?? '#ffffff') === ink ? 'is-on' : ''}`}
                          style={{ background: ink }}
                          aria-label={`A box in ${ink}`}
                          title={ink}
                          onClick={() => (style.backingInk ?? '#ffffff') !== ink && void arrange({ choices: { style: { backingInk: ink } } })}
                        />
                      ))}
                      <AnyColour
                        value={style.backingInk && !inks.includes(style.backingInk) ? style.backingInk : null}
                        label="Any other colour for the box"
                        onPick={(backingInk) => void arrange({ choices: { style: { backingInk } } })}
                      />
                    </div>
                  )}
                  {fonts.length > 0 && (
                    <>
                      <p className="tiny muted" style={{ margin: 0 }}>Font</p>
                      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                        <button
                          type="button"
                          className={`chip ${!style.font ? 'on' : ''}`}
                          aria-pressed={!style.font}
                          onClick={() => style.font && void arrange({ choices: { style: { font: null } } })}
                        >
                          As designed
                        </button>
                        {fonts.map((f) => (
                          <button
                            key={f.id}
                            type="button"
                            className={`chip ${style.font === f.id ? 'on' : ''}`}
                            aria-pressed={style.font === f.id}
                            title={f.own ? f.label : `${f.label} - a free look-alike stands in until its font file is added`}
                            onClick={() => style.font !== f.id && void arrange({ choices: { style: { font: f.id } } })}
                          >
                            {f.label}{!f.own && <span className="studio-alike" aria-label="look-alike"> ≈</span>}
                          </button>
                        ))}
                      </div>
                      {fonts.some((f) => !f.own) && (
                        <p className="tiny muted" style={{ margin: 0 }}>
                          ≈ The brand&apos;s own font file is not in CIP yet: the nearest free face stands in until it is added.
                        </p>
                      )}
                    </>
                  )}
                  <p className="tiny muted" style={{ margin: 0 }}>Line up</p>
                  {looks('align', ALIGNS, null)}
                  {slide('textSize')}
                  <p className="tiny muted" style={{ margin: 0 }}>Or double-click the headline on the picture to change its words there.</p>
                </div>
              )}
              {headlineOn && Boolean(options?.length) && (
                <div className="stack" style={{ gap: 6 }}>
                  <p className="tiny muted" style={{ margin: 0 }}>Try another - free, from these words and the brand&apos;s own posts:</p>
                  <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                    {options!.map((o) => (
                      <button
                        key={o.lines.map((l) => `${l.role}:${l.text}`).join('|')}
                        type="button"
                        className="chip"
                        title={o.from === 'brand' ? 'A headline from the brand\'s own posts' : 'The same words, broken another way'}
                        onClick={() => void arrange({ lines: o.lines })}
                      >
                        {o.lines.map((l) => l.text).join(' / ')}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

          {current.id === 'words' && manifest && generation.headline && headlineOn && (
            <div className="studio-group">
              <p className="studio-group-title">The headline&apos;s letters</p>
              <TextLookControls
                value={{ spacing: style.textSpacing, lineHeight: style.textLeading, stroke: style.textStroke, strokeInk: style.textStrokeInk, ink2: style.ink2 }}
                inks={inks}
                onChange={(c) => void arrange({ choices: { style: {
                  ...('spacing' in c ? { textSpacing: c.spacing ?? null } : {}),
                  ...('lineHeight' in c ? { textLeading: c.lineHeight ?? null } : {}),
                  ...('stroke' in c ? { textStroke: c.stroke ?? null } : {}),
                  ...('strokeInk' in c ? { textStrokeInk: c.strokeInk ?? null } : {}),
                  ...('ink2' in c ? { ink2: c.ink2 ?? null } : {}),
                } } })}
              />
            </div>
          )}

          {current.id === 'words' && manifest && (
            <TextBlocks
              blocks={manifest.choices.texts ?? []}
              generation={generation}
              fonts={fonts}
              inks={inks}
              selected={selected && isBlock(selected) ? selected.slice(2) : null}
              onSelect={(id) => setSelected(`t:${id}`)}
              onChange={(texts) => arrange({ choices: { texts } })}
            />
          )}

          {current.id === 'download' && (
            <>
              <p className="studio-q">Take it to your editor</p>
              <p className="tiny muted" style={{ margin: 0 }}>Size</p>
              <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                {SHAPES.map((s) => (
                  <button
                    key={s.label}
                    type="button"
                    className={`chip ${exportShape === s.value ? 'on' : ''}`}
                    aria-pressed={exportShape === s.value}
                    onClick={() => setExportShape(s.value)}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
              {exportShape && (
                <p className="tiny muted" style={{ margin: 0 }}>
                  Laid out again for this size on the same background - free. Where the size needs more background
                  than was painted, its own edges are carried out softly.
                </p>
              )}
              {exportShape && !['1:1', '4:5', '9:16', '16:9'].includes(exportShape) && (
                <p className="tiny muted" style={{ margin: 0 }}>
                  A print size comes 1080 pixels on its short side - right for laying out and approval. For the printer,
                  take the PSD, SVG or PDF: the headline stays live text there, and the pictures can be swapped for full-size ones.
                </p>
              )}
              <div className="stack" style={{ gap: 6 }}>
                {EXPORTS.map((e) => (
                  <a key={e.format} className="studio-export" href={exportUrl(generation.id, e.format, exportShape)} download>
                    <span className="btn btn-ghost btn-sm"><Icon name="download" size={14} /> {e.label}</span>
                    <span className="tiny muted">{e.note}</span>
                  </a>
                ))}
              </div>
            </>
          )}

          <div className="row" style={{ gap: 8, justifyContent: 'space-between', marginTop: 4 }}>
            <button type="button" className="btn btn-ghost btn-sm" disabled={step === 0} onClick={() => setStep((s) => s - 1)}>
              Back
            </button>
            {step < STUDIO_STEPS.length - 1 && (
              <button type="button" className="btn btn-primary btn-sm" onClick={() => setStep((s) => s + 1)}>
                Next: {STUDIO_STEPS[step + 1]!.label} <Icon name="arrow-right" size={14} />
              </button>
            )}
          </div>
        </div>

        {/* A picture of your own, or a new one painted: only where the background is set. */}
        {current.id === 'background' && (
        <div className="studio-redesign">
          <p className="insp-label">Your own background</p>
          <p className="tiny muted" style={{ margin: 0 }}>
            Bring any picture - the bottle, the logo and the headline are set on it just where they are. Free: nothing is painted.
          </p>
          <label className={`btn btn-ghost btn-sm studio-upload ${painting || saving ? 'is-off' : ''}`}>
            <Icon name="upload" size={14} /> {painting ? 'Setting it on your picture…' : 'Use my own picture'}
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              hidden
              disabled={painting || saving}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (!file) return;
                if (file.size > 15 * 1024 * 1024) { note('That picture is over 15 MB. Bring a smaller one.'); return; }
                void paint('own', file);
              }}
            />
          </label>
          <p className="insp-label" style={{ marginTop: 6 }}>Redesign the background</p>
        <textarea
          className="field-input"
          rows={3}
          maxLength={400}
          value={backgroundNote}
          onChange={(e) => setBackgroundNote(e.target.value)}
          placeholder="What should it show? e.g. a rooftop at night with diyas and rangoli, city lights behind"
          aria-label="What the new background should show"
          disabled={painting}
        />
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-primary btn-sm" disabled={painting || saving} onClick={() => void paint('new')}>
            {painting ? 'Painting a new background…' : 'Make a new background'}
          </button>
          {layers.previousBackground && (
            <button type="button" className="btn btn-ghost btn-sm" disabled={painting || saving} onClick={() => void paint('previous')}>
              Use the one before
            </button>
          )}
        </div>
        <p className="tiny muted">
          A new background uses credits for one picture, painted at the lowest quality - the least it costs, and
          the only step here that spends anything. The bottle, logo and headline stay where you put them. Going
          back to the one before is free, and so is your own picture.
        </p>
        </div>
        )}
      </aside>
    </div>
  );
}

/**
 * Any colour at all, for when the brand's own are not enough: picked in the
 * browser's own picker, and set once the picking stops rather than on every
 * shade passed on the way.
 */
/**
 * The letters of any words: the room between them and between lines, an outline and its colour,
 * and a second colour they fade to. Slid, each is set when let go; null puts it back as designed.
 */
function TextLookControls({ value, inks, onChange }: {
  value: TextLookC;
  inks: string[];
  onChange: (change: { [K in keyof TextLookC]?: TextLookC[K] | null }) => void;
}) {
  const [draft, setDraft] = useState<TextLookC>({});
  const v = { ...value, ...draft };
  const letGo = (key: 'spacing' | 'lineHeight' | 'stroke', plain: number) => {
    const d = draft[key];
    if (d === undefined) return;
    setDraft((x) => { const n = { ...x }; delete n[key]; return n; });
    if (d !== (value[key] ?? plain)) onChange({ [key]: d === plain ? null : d, ...(key === 'stroke' && d && !value.strokeInk ? { strokeInk: '#000000' } : {}) });
  };
  const slider = (key: 'spacing' | 'lineHeight' | 'stroke', label: string, min: number, max: number, step: number, plain: number, shows: (n: number) => string) => (
    <div className="studio-slide">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
        <span className="tiny muted">{label}</span>
        <span className="row" style={{ gap: 6, alignItems: 'center' }}>
          <span className="tiny">{shows(v[key] ?? plain)}</span>
          {value[key] !== undefined && <button type="button" className="studio-reset" onClick={() => onChange({ [key]: null })}>Reset</button>}
        </span>
      </div>
      <input type="range" min={min} max={max} step={step} value={v[key] ?? plain} aria-label={label}
        onChange={(e) => { const n = Number(e.target.value); setDraft((x) => ({ ...x, [key]: n })); }}
        onPointerUp={() => letGo(key, plain)} onKeyUp={() => letGo(key, plain)} onBlur={() => letGo(key, plain)} />
    </div>
  );
  const colours = ['#000000', '#ffffff', ...inks.filter((i) => !['#000000', '#ffffff'].includes(i))];
  return (
    <div className="stack" style={{ gap: 8 }}>
      {slider('spacing', 'Letter spacing', -0.08, 0.6, 0.005, 0, (n) => (n === 0 ? 'As designed' : `${n > 0 ? '+' : ''}${Math.round(n * 100)}%`))}
      {slider('lineHeight', 'Line spacing', 0.7, 2.5, 0.02, 1.15, (n) => `${n.toFixed(2)}×`)}
      {slider('stroke', 'Outline', 0, 0.25, 0.005, 0, (n) => (n === 0 ? 'None' : `${Math.round(n * 100)}%`))}
      {(v.stroke ?? 0) > 0 && (
        <span className="row headline-line-inks">
          {colours.map((ink) => (
            <button key={ink} type="button" className={`headline-ink ${(value.strokeInk ?? '#000000') === ink ? 'is-on' : ''}`} style={{ background: ink }}
              onClick={() => onChange({ strokeInk: ink })} aria-label={`Outline in ${ink}`} />
          ))}
          <AnyColour value={value.strokeInk && !colours.includes(value.strokeInk) ? value.strokeInk : null} label="Any outline colour" onPick={(ink) => onChange({ strokeInk: ink })} />
        </span>
      )}
      <span className="tiny muted">Fading to</span>
      <span className="row headline-line-inks">
        <button type="button" className={`chip ${value.ink2 ? '' : 'on'}`} onClick={() => value.ink2 && onChange({ ink2: null })}>One colour</button>
        {colours.map((ink) => (
          <button key={ink} type="button" className={`headline-ink ${value.ink2 === ink ? 'is-on' : ''}`} style={{ background: ink }}
            onClick={() => onChange({ ink2: ink })} aria-label={`Fading to ${ink}`} />
        ))}
        <AnyColour value={value.ink2 && !colours.includes(value.ink2) ? value.ink2 : null} label="Fading to any colour" onPick={(ink) => onChange({ ink2: ink })} />
      </span>
    </div>
  );
}

/**
 * A brush over a cut-out: take off what is still there and should not be, and - when the picture
 * it was cut from was kept - bring back what was taken by mistake, like the ice in a glass. Done
 * here in the browser; the result is kept as a new picture. Free.
 */
function CutoutBrush({ file, onClose, onSaved }: { file: string; onClose: () => void; onSaved: (file: string) => void }) {
  const { note } = useToast();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const original = useRef<HTMLImageElement | null>(null);
  const originalId = useRef<string | null>(null);
  const undo = useRef<ImageData[]>([]);
  const last = useRef<{ x: number; y: number } | null>(null);
  const [tool, setTool] = useState<'erase' | 'restore'>('erase');
  const [size, setSize] = useState(0.04);
  const [ready, setReady] = useState(false);
  const [canRestore, setCanRestore] = useState(false);
  const [saving, setSaving] = useState(false);
  const [, setSteps] = useState(0);

  useEffect(() => {
    let live = true;
    const load = (src: string) => new Promise<HTMLImageElement>((done, fail) => { const img = new Image(); img.onload = () => done(img); img.onerror = fail; img.src = src; });
    void (async () => {
      const img = await load(`/api/drive/files/${file}/content?disposition=inline`).catch(() => null);
      if (!live) return;
      if (!img) { note('That picture could not be opened.'); onClose(); return; }
      const c = canvasRef.current!;
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext('2d')!.drawImage(img, 0, 0);
      setReady(true);
      const res = await fetch(`/api/media/pictures/${file}`, { cache: 'no-store' }).catch(() => null);
      const body = res?.ok ? ((await res.json()) as { original: string | null }) : { original: null };
      if (!live || !body.original) return;
      const o = await load(`/api/drive/files/${body.original}/content?disposition=inline`).catch(() => null);
      if (!live || !o) return;
      original.current = o;
      originalId.current = body.original;
      setCanRestore(true);
    })();
    return () => { live = false; };
    // Opened once for the file it was opened on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file]);

  const at = (e: React.PointerEvent) => {
    const c = canvasRef.current!;
    const r = c.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * c.width, y: ((e.clientY - r.top) / r.height) * c.height };
  };
  /** One dab of the brush. */
  const dab = (x: number, y: number) => {
    const c = canvasRef.current!;
    const ctx = c.getContext('2d')!;
    const radius = Math.max(2, size * Math.max(c.width, c.height));
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    if (tool === 'erase') {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fill();
    } else if (original.current) {
      ctx.clip();
      ctx.clearRect(x - radius, y - radius, radius * 2, radius * 2);
      ctx.drawImage(original.current, 0, 0, c.width, c.height);
    }
    ctx.restore();
  };
  const stroke = (to: { x: number; y: number }) => {
    const from = last.current ?? to;
    const c = canvasRef.current!;
    const step = Math.max(1, size * Math.max(c.width, c.height) * 0.35);
    const n = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / step));
    for (let i = 1; i <= n; i++) dab(from.x + ((to.x - from.x) * i) / n, from.y + ((to.y - from.y) * i) / n);
    last.current = to;
  };
  const save = async () => {
    setSaving(true);
    const blob = await new Promise<Blob | null>((done) => canvasRef.current!.toBlob(done, 'image/png'));
    if (!blob) { setSaving(false); return; }
    const form = new FormData();
    form.append('file', new File([blob], 'touched-up.png', { type: 'image/png' }));
    form.append('cut', '0');
    if (originalId.current) form.append('original', originalId.current);
    const res = await fetch('/api/media/pictures', { method: 'POST', body: form }).catch(() => null);
    setSaving(false);
    if (!res?.ok) { note('It could not be kept. Nothing was changed.'); return; }
    onSaved(((await res.json()) as { picture: { file: string } }).picture.file);
  };

  return (
    <div className="brush-veil" role="dialog" aria-modal="true" aria-label="Fix the cut-out" onPointerDown={(e) => e.stopPropagation()}>
      <div className="brush-panel">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <p className="studio-q" style={{ margin: 0 }}>Fix the cut-out</p>
          <span className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            <button type="button" className={`chip ${tool === 'erase' ? 'on' : ''}`} onClick={() => setTool('erase')}>Take off</button>
            <button type="button" className={`chip ${tool === 'restore' ? 'on' : ''}`} onClick={() => setTool('restore')} disabled={!canRestore}
              title={canRestore ? 'Paint back what was taken by mistake' : 'Only for a picture CIP cut out itself'}>Bring back</button>
            <button type="button" className="btn btn-ghost btn-sm" disabled={!undo.current.length} onClick={() => {
              const was = undo.current.pop();
              if (was) canvasRef.current!.getContext('2d')!.putImageData(was, 0, 0);
              setSteps((n) => n + 1);
            }}>Undo</button>
          </span>
        </div>
        <div className="studio-slide">
          <div className="row" style={{ justifyContent: 'space-between' }}><span className="tiny muted">Brush size</span><span className="tiny">{Math.round(size * 100)}%</span></div>
          <input type="range" min={0.005} max={0.15} step={0.005} value={size} onChange={(e) => setSize(Number(e.target.value))} aria-label="Brush size" />
        </div>
        <div className="brush-board">
          <canvas
            ref={canvasRef}
            className="brush-canvas"
            style={{ opacity: ready ? 1 : 0.2 }}
            onPointerDown={(e) => {
              if (!ready) return;
              (e.target as Element).setPointerCapture?.(e.pointerId);
              const c = canvasRef.current!;
              undo.current.push(c.getContext('2d')!.getImageData(0, 0, c.width, c.height));
              if (undo.current.length > 12) undo.current.shift();
              setSteps((n) => n + 1);
              last.current = null;
              stroke(at(e));
            }}
            onPointerMove={(e) => { if (e.buttons === 1 && ready) stroke(at(e)); }}
            onPointerUp={() => { last.current = null; }}
          />
        </div>
        <p className="tiny muted" style={{ margin: 0 }}>
          Paint over what should go. {canRestore ? 'Bring back paints the picture as it came, for anything the cut took by mistake. ' : ''}Kept as a new picture; the old one stays in Drive.
        </p>
        <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary btn-sm" disabled={!ready || saving} onClick={() => void save()}>{saving ? 'Keeping it…' : 'Use it'}</button>
        </div>
      </div>
    </div>
  );
}

function AnyColour({ value, label, onPick }: { value: string | null; label: string; onPick: (hex: string) => void }) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [shown, setShown] = useState<string | null>(value);
  useEffect(() => setShown(value), [value]);
  return (
    <label className={`studio-swatch is-any ${value ? 'is-on' : ''}`} title={label} style={shown ? { background: shown } : undefined}>
      {!shown && <Icon name="plus" size={12} />}
      <input
        type="color"
        value={shown ?? '#ffffff'}
        aria-label={label}
        onChange={(e) => {
          const hex = e.target.value.toLowerCase();
          setShown(hex);
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => onPick(hex), 450);
        }}
      />
    </label>
  );
}

/**
 * Text besides the headline: a line under it, an offer, a call to act. Each
 * block its own lines - each with its part, face and colour - and its own
 * face, colour, size, lining up, weight, italic, capitals and shadow. Placed
 * and sized on the picture by dragging, like any other piece.
 */
/** How a picture's look is slid: its range and how it reads. */
const PIC_SLIDES: { key: 'opacity' | 'bright' | 'shadow'; label: string; min: number; max: number; step: number; plain: number; shows: (v: number) => string }[] = [
  { key: 'opacity', label: 'Opacity', min: 0.1, max: 1, step: 0.01, plain: 1, shows: (v) => `${Math.round(v * 100)}%` },
  { key: 'bright', label: 'Light', min: -0.5, max: 0.5, step: 0.01, plain: 0, shows: (v) => (v === 0 ? 'As it is' : `${v > 0 ? '+' : ''}${Math.round(v * 100)}%`) },
  { key: 'shadow', label: 'Shadow', min: 0, max: 2, step: 0.05, plain: 0, shows: (v) => (v === 0 ? 'None' : `${Math.round(v * 100)}%`) },
];
type PictureFind = { id: string; name: string; type: string; mine: boolean; brand: string | null; glass: boolean };

/**
 * Pictures laid on the post as they are - a glass beside the bottle, ice, a lemon - from the
 * computer or from Drive. A plain ground (a glass shot on white) can be taken off on the way in.
 * Nothing is painted and no model is asked: free. Each is dragged, sized and turned on the post.
 */
function StudioPictures({ generationId, bottleFiles, bottle, pictures, postAspect, selected, onSelect, drafts, onDraft, onChange, inks, fonts, onBrush }: {
  /** The brand's bottles: a picture that is one is lit as "the bottle", any other as "the glass". */
  bottleFiles: string[];
  /** The post, for its brand's glasses and its scene. */
  generationId: string;
  /** Where the bottle stands, for a glass set beside it. */
  bottle: { x: number; y: number; w: number; h: number } | null;
  pictures: PictureC[];
  /** The brand's colours, and the faces words may be set in. */
  inks: string[];
  fonts: { id: string; label: string; own: boolean }[];
  /** Open the brush on a picture's file. */
  onBrush: (file: string) => void;
  /** The post's height over its width. */
  postAspect: number;
  selected: string | null;
  onSelect: (id: string | null) => void;
  drafts: Record<string, Partial<PictureC>>;
  onDraft: (id: string, look: Partial<PictureC>) => void;
  /** How to change the pictures as they now stand; `settle`: the picture whose slid look this sets, let go of once it is. */
  onChange: (make: (all: PictureC[]) => PictureC[], settle?: string) => Promise<boolean>;
}) {
  const { note } = useToast();
  const [cut, setCut] = useState(true);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<PictureFind[] | null>(null);
  /** The post's brand, once known: its pictures are listed first. */
  const brandRef = useRef<string | null>(null);
  // Searched for only: the brand's glasses are in their own row above, so nothing is listed until asked.
  const look = useCallback(async (q: string) => {
    if (!q.trim()) { setFound(null); return; }
    const params = new URLSearchParams({ ...(q ? { q } : {}), ...(brandRef.current ? { brand: brandRef.current } : {}) });
    const res = await fetch(`/api/media/pictures?${params}`, { cache: 'no-store' }).catch(() => null);
    const body = res?.ok ? ((await res.json()) as { pictures: PictureFind[] }) : { pictures: [] };
    setFound(body.pictures);
  }, []);

  /** A picture laid in the middle of the post, a little apart from the last: a quarter of it wide, no taller than half. */
  const place = async (picture: { file: string; aspect: number }, size = 0.24): Promise<boolean> => {
    let w = size;
    const tall = (v: number) => (v * picture.aspect) / postAspect;
    if (tall(w) > 0.5) w = (0.5 * postAspect) / picture.aspect;
    const step = (pictures.length % 4) * 0.04;
    const pic: PictureC = { id: blockId(), file: picture.file, aspect: picture.aspect, x: 0.5 - w / 2 + step, y: 0.5 - tall(w) / 2 + step, w };
    const ok = await onChange((all) => [...all, pic]);
    if (ok) onSelect(pic.id);
    return ok;
  };

  // The post's brand, so its own pictures are listed first - and its glasses, to set beside the bottle.
  const [brandOf, setBrandOf] = useState<{ brand: string; glasses?: { id: string; name: string }[] } | null>(null);
  const loadBrand = useCallback(() => {
    void fetch(`/api/media/generations/${generationId}/glass`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((b: typeof brandOf) => { if (b) setBrandOf(b); })
      .catch(() => undefined);
  }, [generationId]);
  useEffect(() => { loadBrand(); }, [loadBrand]);
  // The list again once the brand is known, its own pictures first.
  useEffect(() => {
    if (!brandOf || brandRef.current === brandOf.brand) return;
    brandRef.current = brandOf.brand;
    void look(query);
    // Once per brand; the query is the one shown.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brandOf]);
  /** A picture's shape, read from the picture itself. */
  const aspectOf = (file: string) => new Promise<number>((done) => {
    const img = new Image();
    img.onload = () => done(img.naturalWidth ? img.naturalHeight / img.naturalWidth : 1);
    img.onerror = () => done(1);
    img.src = `/api/drive/files/${file}/content?size=320`;
  });
  /**
   * A glass stood beside the bottle as a designer would: on the same surface, about four tenths of its
   * height, on the side with more room - its shadow on the counter and its reflection under it.
   */
  const besideBottle = async (file: string) => {
    if (pictures.length >= 8) { note('A post takes at most 8 added pictures.'); return; }
    const aspect = await aspectOf(file);
    const h = bottle ? bottle.h * 0.42 : 0.3;
    const w = Math.min(0.6, (h * postAspect) / aspect);
    const foot = bottle ? bottle.y + bottle.h : 0.8;
    const left = bottle ? bottle.x + bottle.w / 2 > 0.5 : false;
    const x = bottle ? (left ? bottle.x - w - 0.015 : bottle.x + bottle.w + 0.015) : 0.5 - w / 2;
    const pic: PictureC = {
      id: blockId(), file, aspect, w,
      x: Math.min(0.98 - w, Math.max(0.02, x)), y: foot - (w * aspect) / postAspect,
      ground: 0.55, mirror: 0.45,
    };
    const ok = await onChange((all) => [...all, pic]);
    if (ok) { onSelect(pic.id); note('Glass set beside the bottle - free. Drag it anywhere.'); }
  };
  /** A studio picture taken away (archived in Drive, restorable). */
  const removePicture = async (f: PictureFind) => {
    if (!window.confirm(`Remove "${f.name}" from Studio pictures? It stays in Drive's archive.`)) return;
    const res = await fetch(`/api/media/pictures/${f.id}`, { method: 'DELETE' }).catch(() => null);
    if (!res?.ok) { note('It could not be removed.'); return; }
    void look(query);
  };
  /** A picture set into the scene where it stands: lit in its light, as bright as it. Free. */
  const [matching, setMatching] = useState(false);
  const matchScene = async (pic: PictureC) => {
    if (!pic.file || matching) return;
    setMatching(true);
    const box = { x: pic.x, y: pic.y, w: pic.w, h: (pic.w * pic.aspect) / postAspect };
    const res = await fetch(`/api/media/generations/${generationId}/match`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file: pic.file, box }),
    }).catch(() => null);
    setMatching(false);
    if (!res?.ok) { note('The scene could not be matched.'); return; }
    const look2 = (await res.json()) as { tint: string; tintAmount: number; bright: number };
    void update(pic.id, { ...look2, ground: pic.ground ?? 0.5 });
    note('Lit as the scene is - free. Undo puts it back.');
  };

  /** A picture made ready on the server, then laid on the post. */
  const add = async (from: { file: File } | { fileId: string }) => {
    if (pictures.length >= 8) { note('A post takes at most 8 added pictures.'); return; }
    setBusy(true);
    let res: Response | null;
    if ('file' in from) {
      const form = new FormData();
      form.append('file', from.file);
      form.append('cut', cut ? '1' : '0');
      res = await fetch('/api/media/pictures', { method: 'POST', body: form }).catch(() => null);
    } else {
      res = await fetch('/api/media/pictures', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fileId: from.fileId, cut }),
      }).catch(() => null);
    }
    if (!res?.ok) {
      setBusy(false);
      const message = (await res?.json().catch(() => null) as { message?: string } | null)?.message;
      note(message ?? 'That picture could not be added.');
      return;
    }
    const done = (await res.json()) as { picture: { file: string; aspect: number }; outcome: 'cut' | 'already-clear' | 'not-plain' | 'kept' };
    const ok = await place(done.picture);
    setBusy(false);
    if (!ok) return;
    if ('file' in from) void look(query);
    note(cut && done.outcome === 'not-plain'
      ? 'Added. Its background is not one plain colour, so it was kept as it is.'
      : cut && done.outcome === 'cut' ? 'Added, its background taken off - free.' : 'Added - free.');
  };

  const chosen = pictures.find((p) => p.id === selected) ?? null;
  /** A look being slid on the chosen one, set into the post when let go. */
  const letGoAll = () => {
    if (!chosen) return;
    const d = drafts[chosen.id];
    if (d && Object.keys(d).length) void update(chosen.id, d, chosen.id);
  };
  const now = chosen ? { ...chosen, ...(drafts[chosen.id] ?? {}) } : null;
  const range = (label: string, shown: string, v: number, min: number, max: number, step: number, change: (v: number) => Partial<PictureC>) => (
    <div className="studio-slide" key={label}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
        <span className="tiny muted">{label}</span>
        <span className="tiny">{shown}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={v} aria-label={label}
        onChange={(e) => onDraft(chosen!.id, change(Number(e.target.value)))} onPointerUp={letGoAll} onKeyUp={letGoAll} onBlur={letGoAll} />
    </div>
  );
  /** A side cut, the box's shape following it: what was shown stays where it was. */
  const cropTo = (side: 'l' | 't' | 'r' | 'b', v: number): Partial<PictureC> => {
    const c = now!.crop ?? { l: 0, t: 0, r: 0, b: 0 };
    const base = now!.aspect * (1 - c.l - c.r) / (1 - c.t - c.b);
    const next = { ...c, [side]: v };
    return { crop: next, aspect: base * (1 - next.t - next.b) / (1 - next.l - next.r) };
  };
  const swatches = (value: string | undefined, pick: (ink: string) => void, label: string, extra: string[] = ['#ffffff', '#000000']) => (
    <span className="row headline-line-inks">
      {[...extra, ...inks.filter((i) => !extra.includes(i))].map((ink) => (
        <button key={ink} type="button" className={`headline-ink ${value === ink ? 'is-on' : ''}`} style={{ background: ink }} onClick={() => pick(ink)} aria-label={`${label} ${ink}`} />
      ))}
      <AnyColour value={value && ![...extra, ...inks].includes(value) ? value : null} label={`Any colour - ${label}`} onPick={pick} />
    </span>
  );
  const update = (id: string, change: Partial<PictureC>, settle?: string) =>
    onChange((all) => all.map((p) => (p.id === id ? { ...p, ...change } : p)), settle);
  /** One step towards the front or the back, among the added pictures. */
  const move = (id: string, by: 1 | -1) => void onChange((all) => {
    const at = all.findIndex((p) => p.id === id);
    const to = at + by;
    if (at < 0 || to < 0 || to >= all.length) return all;
    const next = [...all];
    [next[at], next[to]] = [next[to]!, next[at]!];
    return next;
  });

  return (
    <>
      {(brandOf?.glasses?.length ?? 0) > 0 && (
        <div className="studio-group">
          <p className="studio-group-title">{brandOf!.brand}&apos;s glasses · {brandOf!.glasses!.length}</p>
          <div className="lib-strip" role="listbox" aria-label="The brand's glasses">
            {brandOf!.glasses!.map((g) => (
              <button key={g.id} type="button" className="lib-pick is-glass" disabled={busy}
                onClick={() => void besideBottle(g.id)} title={`${g.name} - set it beside the bottle`}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`/api/drive/files/${g.id}/content?size=320`} alt="" className="lib-img" loading="lazy" />
                <span className="lib-name">{g.name.replace(/^.*? glass - /, '').replace(/\.png$/i, '')}</span>
              </button>
            ))}
          </div>
          <p className="tiny muted" style={{ margin: 0 }}>Click one: it stands beside the bottle on the same surface, with its shadow and reflection. Click again to add another - up to 8 pictures on a post. Drag, resize, turn or crop each in the list below. Free.</p>
        </div>
      )}
      <p className="studio-q">A picture, ice, anything - laid on the post</p>
      <p className="tiny muted" style={{ margin: 0 }}>
        Bring a picture, or take one from Drive. Drag it on the post, pull its corner to size it, turn it by the round handle. Free - nothing is painted.
      </p>
      <label className="row tiny" style={{ gap: 6, alignItems: 'center' }}>
        <input type="checkbox" checked={cut} onChange={(e) => setCut(e.target.checked)} />
        Take a plain background off (white, grey, any one colour)
      </label>
      <label className={`btn btn-ghost btn-sm studio-upload ${busy ? 'is-off' : ''}`}>
        <Icon name="upload" size={14} /> {busy ? 'Adding it…' : 'Add a picture from my computer'}
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp"
          hidden
          disabled={busy}
          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void add({ file: f }); }}
        />
      </label>

      <form className="row" style={{ gap: 6 }} onSubmit={(e) => { e.preventDefault(); void look(query); }}>
        <input
          className="field-input"
          style={{ flex: 1, minWidth: 0 }}
          placeholder="Find in Drive: ice, lemon, flowers…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Find a picture in Drive"
        />
        <button type="submit" className="btn btn-ghost btn-sm">Find</button>
      </form>
      {found && found.length > 0 && (
        <div className="studio-picks">
          {found.map((f) => (
            <span key={f.id} className="studio-pick-wrap">
              <button
                type="button"
                className={`studio-pick ${brandOf && f.brand?.toLowerCase() === brandOf.brand.toLowerCase() ? 'is-brand' : ''}`}
                disabled={busy}
                onClick={() => void add({ fileId: f.id })}
                title={`${f.name}${f.brand ? ` - ${f.brand}` : ''}${f.mine ? '' : ' - from Drive'}`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`/api/drive/files/${f.id}/content?size=160`} alt={f.name} loading="lazy" />
              </button>
              {f.mine && (
                <button type="button" className="studio-pick-x" onClick={() => void removePicture(f)} aria-label={`Remove ${f.name}`} title="Remove from Studio pictures">×</button>
              )}
            </span>
          ))}
        </div>
      )}
      {found && found.length === 0 && (
        <p className="tiny muted" style={{ margin: 0 }}>
          Nothing in Drive by that name.
        </p>
      )}

      {pictures.length > 0 && (
        <div className="studio-group">
          <p className="studio-group-title">On this post</p>
          <div className="studio-picks is-on-post">
            {[...pictures].reverse().map((p) => (
              <button
                key={p.id}
                type="button"
                className={`studio-pick ${p.id === selected ? 'is-on' : ''}`}
                onClick={() => onSelect(p.id === selected ? null : p.id)}
                aria-pressed={p.id === selected}
                title="Choose it to change it"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={pictureSrc(p, 160)} alt="" style={p.flip ? { transform: 'scaleX(-1)' } : undefined} />
              </button>
            ))}
          </div>
          {!chosen && <p className="tiny muted" style={{ margin: 0 }}>Choose one, here or on the post, to change it.</p>}
          {chosen && now && chosen.shape && (
            <div className="studio-group">
              <p className="studio-group-title">The shape</p>
              <label className="tiny muted">Fill</label>
              {swatches(chosen.shape.fill, (fill) => void update(chosen.id, { shape: { ...chosen.shape!, fill } }), 'Fill')}
              <label className="tiny muted">Outline</label>
              {swatches(chosen.shape.stroke, (stroke) => void update(chosen.id, { shape: { ...chosen.shape!, stroke, strokeW: chosen.shape!.strokeW || 0.04 } }), 'Outline')}
              {range('Outline width', now.shape?.strokeW ? `${Math.round(now.shape.strokeW * 100)}%` : 'None', now.shape?.strokeW ?? 0, 0, 0.3, 0.01,
                (v) => ({ shape: { ...chosen.shape!, ...now.shape, strokeW: v, stroke: now.shape?.stroke ?? '#ffffff' } }))}
              {range('Shape', now.aspect < 1 ? 'Wider' : now.aspect > 1 ? 'Taller' : 'Even', Math.log(now.aspect), Math.log(0.02), Math.log(4), 0.01,
                (v) => ({ aspect: Math.round(Math.exp(v) * 1000) / 1000 }))}
              {(chosen.shape.kind === 'badge' || chosen.shape.kind === 'button' || chosen.shape.kind === 'round' || chosen.shape.kind === 'circle' || chosen.shape.kind === 'rect') && (
                <>
                  <label className="tiny muted">Words in it</label>
                  <input
                    key={`${chosen.id}-${chosen.shape.text ?? ''}`}
                    className="field-input"
                    defaultValue={chosen.shape.text ?? ''}
                    maxLength={40}
                    placeholder="NEW, 20% OFF, Shop now…"
                    onBlur={(e) => { const text = e.target.value.trim(); if (text !== (chosen.shape!.text ?? '')) void update(chosen.id, { shape: { ...chosen.shape!, text, ink: chosen.shape!.ink ?? '#ffffff' } }); }}
                    onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                  />
                  {chosen.shape.text && (
                    <>
                      {swatches(chosen.shape.ink, (ink) => void update(chosen.id, { shape: { ...chosen.shape!, ink } }), 'Words in')}
                      <select className="field-input" value={chosen.shape.font ?? ''} onChange={(e) => void update(chosen.id, { shape: { ...chosen.shape!, font: e.target.value || undefined } })} aria-label="Face for the words">
                        <option value="">Poppins</option>
                        {fonts.filter((f) => f.id !== 'poppins').map((f) => <option key={f.id} value={f.id}>{f.label}{f.own ? '' : ' ≈'}</option>)}
                      </select>
                    </>
                  )}
                </>
              )}
            </div>
          )}
          {chosen && now && chosen.file && (
            <div className="studio-group">
              <p className="studio-group-title">Make it sit in the scene</p>
              {range(chosen.file && bottleFiles.includes(chosen.file) ? 'Light on this bottle' : 'Light on the glass', (now.bright ?? 0) === 0 ? 'As it is' : `${(now.bright ?? 0) > 0 ? '+' : ''}${Math.round((now.bright ?? 0) * 100)}%`, now.bright ?? 0, -0.5, 0.5, 0.01, (v) => ({ bright: Math.abs(v) < 0.005 ? 0 : v }))}
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                style={{ justifySelf: 'start' }}
                disabled={matching}
                onClick={() => void matchScene(chosen)}
                title="Lit in the colour of the light where it stands, and as bright as the scene - free"
              >
                {matching ? 'Matching…' : 'Match the scene'}
              </button>
              {range('Shadow on the surface', now.ground ? `${Math.round(now.ground * 100)}%` : 'None', now.ground ?? 0, 0, 1, 0.02, (v) => ({ ground: v }))}
              {(now.ground ?? 0) > 0 && range('Shadow softness', `${Math.round((now.groundSoft ?? 0.2) * 100)}%`, now.groundSoft ?? 0.2, 0, 1, 0.02, (v) => ({ groundSoft: v }))}
              {range('Reflection on the surface', now.mirror ? `${Math.round(now.mirror * 100)}%` : 'None', now.mirror ?? 0, 0, 1, 0.02, (v) => ({ mirror: v }))}
              {(now.mirror ?? 0) > 0 && range('Reflection softness', `${Math.round((now.mirrorSoft ?? 0.2) * 100)}%`, now.mirrorSoft ?? 0.2, 0, 1, 0.02, (v) => ({ mirrorSoft: v }))}
              <p className="tiny muted" style={{ margin: 0 }}>Matching lights it as the scene is; the shadow and reflection stand it on the counter. All free.</p>
            </div>
          )}
          {chosen && now && chosen.file && (
            <div className="studio-group">
              <p className="studio-group-title">Size, crop, edges and colour</p>
              {range('Size', `${Math.round(now.w * 100)}% of the width`, now.w, 0.03, 1.2, 0.005, (v) => ({ w: v }))}
              {(['l', 'r', 't', 'b'] as const).map((side) => range(
                { l: 'Crop the left', r: 'Crop the right', t: 'Crop the top', b: 'Crop the foot' }[side],
                `${Math.round((now.crop?.[side] ?? 0) * 100)}%`, now.crop?.[side] ?? 0, 0, 0.45, 0.01, (v) => cropTo(side, v)))}
              {range('Soft edges', now.feather ? `${Math.round(now.feather * 100)}%` : 'Sharp', now.feather ?? 0, 0, 1, 0.02, (v) => ({ feather: v }))}
              <label className="tiny muted">A colour over it</label>
              {swatches(chosen.tint, (tint) => void update(chosen.id, { tint, tintAmount: chosen.tintAmount || 0.35 }), 'Colour over it')}
              {chosen.tint && range('How strong', `${Math.round((now.tintAmount ?? 0) * 100)}%`, now.tintAmount ?? 0, 0, 1, 0.02, (v) => ({ tintAmount: v }))}
            </div>
          )}
          {chosen && (
            <>
              {PIC_SLIDES.filter((k) => k.key !== 'bright').map((k) => {
                const v = drafts[chosen.id]?.[k.key] ?? chosen[k.key] ?? k.plain;
                const letGo = () => {
                  const d = drafts[chosen.id]?.[k.key];
                  if (d !== undefined && d !== (chosen[k.key] ?? k.plain)) void update(chosen.id, { [k.key]: d }, chosen.id);
                };
                return (
                  <div key={k.key} className="studio-slide">
                    <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
                      <span className="tiny muted">{k.label}</span>
                      <span className="row" style={{ gap: 6, alignItems: 'center' }}>
                        <span className="tiny">{k.shows(v)}</span>
                        {v !== k.plain && (
                          <button type="button" className="studio-reset" onClick={() => { onDraft(chosen.id, { [k.key]: k.plain }); void update(chosen.id, { [k.key]: k.plain }, chosen.id); }}>
                            Reset
                          </button>
                        )}
                      </span>
                    </div>
                    <input
                      type="range" min={k.min} max={k.max} step={k.step} value={v} aria-label={k.label}
                      onChange={(e) => onDraft(chosen.id, { [k.key]: Number(e.target.value) })}
                      onPointerUp={letGo} onKeyUp={letGo} onBlur={letGo}
                    />
                  </div>
                );
              })}
              <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                {chosen.file && (
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => onBrush(chosen.file!)} title="Take off, or bring back, what the cut-out got wrong - free">
                    Fix the cut-out
                  </button>
                )}
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => void update(chosen.id, { flip: !chosen.flip })}>Flip</button>
                {Boolean(chosen.rotate) && (
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => void update(chosen.id, { rotate: 0 })}>Stand it straight</button>
                )}
                <button type="button" className="btn btn-ghost btn-sm" disabled={pictures.at(-1)?.id === chosen.id} onClick={() => move(chosen.id, 1)} title="In front of the other pictures">Forward</button>
                <button type="button" className="btn btn-ghost btn-sm" disabled={pictures[0]?.id === chosen.id} onClick={() => move(chosen.id, -1)} title="Behind the other pictures">Back</button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={pictures.length >= 8}
                  onClick={() => {
                    const copy = { ...chosen, id: blockId(), x: chosen.x + 0.04, y: chosen.y + 0.04 };
                    void onChange((all) => [...all, copy]).then((ok) => ok && onSelect(copy.id));
                  }}
                >
                  Duplicate
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => { onSelect(null); void onChange((all) => all.filter((p) => p.id !== chosen.id)); }}
                >
                  Remove
                </button>
              </div>
              <p className="tiny muted" style={{ margin: 0 }}>
                Behind the bottle or over the words? Move &quot;Pictures&quot; in the order below.
              </p>
            </>
          )}
        </div>
      )}
    </>
  );
}

function TextBlocks({ blocks, generation, fonts, inks, selected, onSelect, onChange }: {
  blocks: TextBlockC[];
  generation: MediaGenerationDTO;
  fonts: { id: string; label: string; own: boolean }[];
  inks: string[];
  selected: string | null;
  onSelect: (id: string) => void;
  onChange: (texts: TextBlockC[]) => Promise<boolean>;
}) {
  const [sizes, setSizes] = useState<Record<string, number>>({});
  const update = (id: string, change: Partial<TextBlockC>) => onChange(blocks.map((b) => (b.id === id ? { ...b, ...change } : b)));
  const add = () => {
    const below = blocks.length ? Math.max(...blocks.map((b) => b.y)) + 0.09 : 0.78;
    void onChange([...blocks, {
      id: blockId(), lines: [{ text: 'Your text here', role: 'lead' }], x: 0.07, y: Math.min(0.9, below), width: 0.6, size: 0.045,
      align: 'left', weight: 'bold', italic: false, upper: false, shadow: true,
    }]);
  };
  const letSize = (b: TextBlockC) => { const v = sizes[b.id]; if (v !== undefined && v !== b.size) void update(b.id, { size: v }); };

  return (
    <div className="text-blocks">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <p className="studio-group-title" style={{ margin: 0 }}>More text</p>
        <button type="button" className="btn btn-ghost btn-sm" onClick={add} disabled={blocks.length >= 6}>
          <Icon name="plus" size={14} /> Add text
        </button>
      </div>
      {blocks.length === 0 && (
        <p className="tiny muted" style={{ margin: 0 }}>
          A line under the headline, an offer, a call to act - each its own block, dragged where it goes.
        </p>
      )}
      {blocks.map((b, n) => {
        const size = sizes[b.id] ?? b.size;
        return (
          <section key={b.id} className={`text-block ${selected === b.id ? 'is-on' : ''}`} onClick={() => onSelect(b.id)}>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <span className="text-block-title">Text {n + 1}</span>
              <span className="row" style={{ gap: 4 }}>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={blocks.length >= 6}
                  onClick={(e) => { e.stopPropagation(); void onChange([...blocks, { ...b, id: blockId(), y: Math.min(0.92, b.y + 0.08) }]); }}
                  title="Duplicate"
                >
                  Duplicate
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={(e) => { e.stopPropagation(); void onChange(blocks.filter((x) => x.id !== b.id)); }}
                  aria-label={`Delete text ${n + 1}`}
                  title="Delete"
                >
                  <Icon name="trash" size={14} />
                </button>
              </span>
            </div>

            <TextEditor
              key={b.lines.map((l) => l.text).join('|')}
              generation={generation}
              lines={b.lines}
              hint="Its words, line by line. Each line may take its own part, font and colour."
              saveLabel="Set the words"
              fonts={fonts}
              inks={inks}
              onSave={async (lines) => update(b.id, { lines })}
              onDone={() => undefined}
            />

            <div className="text-block-look">
              <label className="tiny muted">Font</label>
              <select className="field-input" value={b.font ?? ''} onChange={(e) => void update(b.id, { font: e.target.value || undefined })}>
                <option value="">Poppins</option>
                {fonts.filter((f) => f.id !== 'poppins').map((f) => <option key={f.id} value={f.id}>{f.label}{f.own ? '' : ' ≈'}</option>)}
              </select>

              <label className="tiny muted">Colour</label>
              <span className="row headline-line-inks">
                {['#ffffff', ...inks.filter((i) => i !== '#ffffff')].map((ink) => (
                  <button
                    key={ink}
                    type="button"
                    className={`headline-ink ${(b.ink ?? '#ffffff') === ink ? 'is-on' : ''}`}
                    style={{ background: ink }}
                    onClick={() => void update(b.id, { ink })}
                    aria-label={`Text ${n + 1} in ${ink}`}
                  />
                ))}
                <AnyColour
                  value={b.ink && !['#ffffff', ...inks].includes(b.ink) ? b.ink : null}
                  label={`Any other colour for text ${n + 1}`}
                  onPick={(ink) => void update(b.id, { ink })}
                />
              </span>

              <label className="tiny muted">Size {Math.round(size * 1000) / 10}%</label>
              <input
                type="range" min={TEXT_SIZES_C.min} max={TEXT_SIZES_C.max} step={0.005} value={size}
                onChange={(e) => setSizes((x) => ({ ...x, [b.id]: Number(e.target.value) }))}
                onPointerUp={() => letSize(b)} onKeyUp={() => letSize(b)} onBlur={() => letSize(b)}
                aria-label={`Text ${n + 1} size`}
              />

              <label className="tiny muted">Line up</label>
              <span className="row" style={{ gap: 4 }}>
                {(['left', 'center', 'right'] as const).map((a) => (
                  <button key={a} type="button" className={`chip ${b.align === a ? 'on' : ''}`} onClick={() => b.align !== a && void update(b.id, { align: a })}>
                    {a === 'left' ? 'Left' : a === 'center' ? 'Centre' : 'Right'}
                  </button>
                ))}
              </span>

              <label className="tiny muted">Weight</label>
              <span className="row" style={{ gap: 4 }}>
                {(['regular', 'bold', 'black'] as const).map((w) => (
                  <button key={w} type="button" className={`chip ${b.weight === w ? 'on' : ''}`} onClick={() => b.weight !== w && void update(b.id, { weight: w })}>
                    {w === 'regular' ? 'Regular' : w === 'bold' ? 'Bold' : 'Black'}
                  </button>
                ))}
              </span>

              <label className="tiny muted">Letters</label>
              <TextLookControls
                value={b}
                inks={inks}
                onChange={(c) => void update(b.id, Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v ?? undefined])) as Partial<TextBlockC>)}
              />

              <label className="tiny muted">Style</label>
              <span className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
                <button type="button" className={`chip ${b.italic ? 'on' : ''}`} aria-pressed={b.italic} onClick={() => void update(b.id, { italic: !b.italic })}><i>Italic</i></button>
                <button type="button" className={`chip ${b.upper ? 'on' : ''}`} aria-pressed={b.upper} onClick={() => void update(b.id, { upper: !b.upper })}>CAPS</button>
                <button type="button" className={`chip ${b.shadow ? 'on' : ''}`} aria-pressed={b.shadow} onClick={() => void update(b.id, { shadow: !b.shadow })}>Shadow</button>
              </span>
            </div>
            <p className="tiny muted" style={{ margin: 0 }}>Drag it on the picture to place it; pull its corner to size it.</p>
          </section>
        );
      })}
    </div>
  );
}

/** One result, with the 0-10 rating that teaches the next one. */
function Result({
  generation: given, compact = false, onRated, onBuildOn,
}: {
  generation: MediaGenerationDTO;
  compact?: boolean;
  onRated: () => void;
  /** Carries this picture into the next request. Images only: a video is not a reference. */
  onBuildOn?: (generation: MediaGenerationDTO) => void;
}) {
  const { note } = useToast();
  const [score, setScore] = useState<number | null>(null);
  const [comment, setComment] = useState('');
  const [sent, setSent] = useState(false);
  const [open, setOpen] = useState(!compact);
  const [editing, setEditing] = useState(false);
  const commentRef = useRef<HTMLInputElement | null>(null);
  // The post as last arranged here, until a newer one arrives from outside.
  const [generation, setGeneration] = useState(given);
  useEffect(() => setGeneration(given), [given]);

  const rate = async () => {
    if (score === null) return;
    const res = await fetch('/api/brain/feedback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ generationId: generation.id, score, comment: comment.trim() || null }),
    });
    if (!res.ok) {
      note('That rating could not be saved.');
      return;
    }
    setSent(true);
    note('CIP will use that next time');
    onRated();
  };

  return (
    <article className="card gen-card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span className="stack grow">
          <span className="gen-prompt">{generation.prompt.slice(0, 160)}</span>
          <span className="tiny muted">
            {generation.provider}/{generation.model}
            {generation.width && generation.height
              ? ` · ${generation.width}×${generation.height}`
              : ''}
            {' · '}{relativeDay(generation.createdAt)}
          </span>
        </span>
        <Pill tone={toneFor(generation.status)}>{labelFor(generation.status)}</Pill>
      </div>

      {generation.errorMessage && (
        <p className="small" style={{ marginTop: 8 }}>{generation.errorMessage}</p>
      )}

      {generation.hasAsset && generation.status === 'completed' && (
        <>
          {/* A post put together from its parts is designed here, layer by
              layer; any other picture is shown as the one piece it is. */}
          {generation.layers ? (
            <LayerStudio
              generation={generation}
              layers={generation.layers}
              fresh={!compact}
              onChanged={(next) => {
                setGeneration(next);
                onRated();
              }}
            />
          ) : (
          <div className="row" style={{ marginTop: 12, gap: 14, alignItems: 'flex-end' }}>
            {/* A video keeps its controls, so it is not wrapped in a link that
                would swallow a click on play. An image opens full size. */}
            {generation.type === 'video' ? (
              <span className="gen-asset">
                <video src={assetUrl(generation.id)} controls preload="metadata" />
              </span>
            ) : (
              <a
                className="gen-asset"
                href={assetUrl(generation.id)}
                target="_blank"
                rel="noreferrer"
                title="Open full size"
              >
                <img src={assetUrl(generation.id)} alt="" loading="lazy" />
              </a>
            )}

            {/* A plain link, so the browser saves it the way it saves anything
                else — right-click, open in a new tab and keyboard all work. */}
            <a
              className="btn btn-ghost btn-sm"
              href={assetDownloadUrl(generation.id)}
              download
            >
              <Icon name="download" size={15} /> Download
            </a>

            {/* Ask for a change to this picture rather than describing the
                whole thing again and getting a different one. */}
            {onBuildOn && generation.type === 'image' && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => onBuildOn(generation)}
              >
                <Icon name="sparkle" size={15} /> Build on this
              </button>
            )}

            {/* The words of a post put together from the brand's own files can
                be set again on the same scene - no new picture, nothing spent. */}
            {generation.headline && !generation.layers && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setEditing((v) => !v)}
                aria-expanded={editing}
              >
                <Icon name="pencil" size={15} /> Change text
              </button>
            )}
          </div>
          )}
          {editing && generation.headline && !generation.layers && (
            <TextEditor
              generation={generation}
              lines={generation.headline}
              onDone={() => {
                setEditing(false);
                onRated();
              }}
            />
          )}
        </>
      )}

      {generation.status === 'completed' && !sent && (
        open ? (
          <div className="rate-row" style={{ marginTop: 12 }}>
            <span className="tiny muted">How good is it?</span>
            <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
              {Array.from({ length: 11 }, (_, n) => (
                <button
                  key={n}
                  type="button"
                  className={`score ${score === n ? 'on' : ''}`}
                  onClick={() => {
                    setScore(n);
                    commentRef.current?.focus();
                  }}
                >
                  {n}
                </button>
              ))}
            </div>
            <input
              ref={commentRef}
              className="field-input"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="What would make it better? (optional)"
            />
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => void rate()}
              disabled={score === null}
            >
              Save
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            style={{ marginTop: 10 }}
            onClick={() => setOpen(true)}
          >
            Rate this
          </button>
        )
      )}

      {sent && (
        <p className="tiny muted" style={{ marginTop: 10 }}>
          Rated. CIP uses it in the next brief, and states it as the brand&rsquo;s own once
          enough ratings agree.
        </p>
      )}
    </article>
  );
}

function toneFor(status: MediaGenerationDTO['status']): 'ok' | 'warn' | 'stop' | 'neutral' {
  if (status === 'completed') return 'ok';
  if (status === 'failed') return 'stop';
  if (status === 'cancelled') return 'neutral';
  return 'warn';
}

function labelFor(status: MediaGenerationDTO['status']): string {
  if (status === 'queued') return 'Queued';
  if (status === 'processing') return 'Making it';
  if (status === 'completed') return 'Ready';
  if (status === 'failed') return 'Failed';
  return 'Cancelled';
}
