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
import { IMAGE_PROVIDER_LABELS, assetDownloadUrl, assetUrl, isInFlight } from '@/types/media';
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
  return [
    { value: null, label: 'Auto' },
    ...(chosen?.aspectRatios ?? []).map((ratio) => ({
      value: ratio,
      label: SHAPE_LABELS[ratio] ?? ratio,
    })),
  ];
}

type Phase = 'idle' | 'planning' | 'making' | 'done';

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
  | { stage: 'done'; result: BrainResult }
  | { stage: 'failed'; message: string };

type BrainResult =
  | { status: 'generated'; generation: MediaGenerationDTO; briefId: string; plan: PlanSummary }
  | { status: 'needs_clarification'; briefId: string; question: string; plan: PlanSummary };

export function AskSection({
  initial,
  providers,
  markets,
  ideation,
}: {
  /** Concept cards, shown under the heading and above the composer. */
  ideation?: ReactNode;
  initial: MediaGenerationDTO[];
  providers: ProviderStatusDTO;
  /** Markets this company has knowledge about. Empty when nothing is placed. */
  markets: string[];
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
  const [mediaType, setMediaType] = useState<MediaType>('image');
  // Named explicitly rather than left to the default. Sending no provider is
  // how a request quietly went to a key Google had revoked while a working one
  // sat next to it.
  const [provider, setProvider] = useState<ImageProviderChoice>(providers.defaultImageProvider);
  const [phase, setPhase] = useState<Phase>('idle');
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
  // A picture already made, to carry into the next one. "The same thing at
  // 9:16" used to start again from nothing and come back a different picture.
  const [basedOn, setBasedOn] = useState<{ id: string; prompt: string } | null>(null);
  const [history, setHistory] = useState(initial);

  const chosen = providers.images.find((p) => p.choice === provider) ?? null;
  const videoReady = providers.video.configured;
  const ready = mediaType === 'image' ? Boolean(chosen?.configured) : videoReady;
  // Every size offered is one this generator makes itself, so there is nothing
  // to warn about before it is pressed.
  const shapes = shapesFor(chosen);

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

  const busy = phase === 'planning' || phase === 'making';

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
          <button
            type="button"
            className={`chip ${mediaType === 'image' ? 'on' : ''}`}
            onClick={() => setMediaType('image')}
          >
            <Icon name="image" size={15} /> Image
          </button>
          <button
            type="button"
            className={`chip ${mediaType === 'video' ? 'on' : ''}`}
            onClick={() => setMediaType('video')}
          >
            <Icon name="video" size={15} /> Video
          </button>

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
        {markets.length > 1 && (
          <div className="row" style={{ gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
            <span className="tiny muted" style={{ marginRight: 2 }}>For:</span>
            {markets.map((name) => (
              <button
                key={name}
                type="button"
                className={`chip ${market === name ? 'on' : ''}`}
                onClick={() => setMarket(market === name ? null : name)}
              >
                {name}
              </button>
            ))}
            {market === null && (
              <span className="tiny muted">— CIP will ask if you do not say</span>
            )}
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
          <div className="row" style={{ gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
            <span className="tiny muted" style={{ marginRight: 2 }}>Size:</span>
            {shapes.map((option) => (
              <button
                key={option.value ?? '__auto'}
                type="button"
                className={`chip ${shape === option.value ? 'on' : ''}`}
                onClick={() => setShape(option.value)}
                disabled={busy}
                title={
                  option.value === null
                    ? 'CIP reads the size from your request, or decides from the format'
                    : `${chosen ? IMAGE_PROVIDER_LABELS[chosen.choice] : 'This generator'} makes this size directly`
                }
              >
                {option.label}
              </button>
            ))}
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
            {ready
              ? mediaType === 'video'
                ? `${providers.video.provider}/${providers.video.model} · queued, takes a few minutes.`
                : `${chosen?.provider}/${chosen?.model} · usually about a minute.`
              : mediaType === 'image'
                ? `${IMAGE_PROVIDER_LABELS[provider]} has no key configured.`
                : 'No video provider is configured.'}
          </span>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void send()}
            disabled={busy || !draft.trim() || !ready}
          >
            {busy ? 'Working…' : 'Make it'} <Icon name="arrow-right" size={14} />
          </button>
        </div>
      </Card>

      {busy && <Working phase={phase} mediaType={mediaType} startedAt={startedAt} />}

      {/* What CIP decided, before what it produced. Shown either way, because
          the reasoning is what makes a bad result correctable — and shown as
          soon as it exists, which is well before the picture. */}
      {(result?.plan ?? planned) && <Plan plan={(result?.plan ?? planned)!} />}

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
  phase, mediaType, startedAt,
}: {
  phase: Phase;
  mediaType: MediaType;
  startedAt: number;
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
      label: mediaType === 'video' ? 'Sending it to the video generator' : 'Making the picture',
      done: 'Sent to the generator',
    },
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

      {/* A placeholder in the shape of what is coming, so the page does not
          jump when it arrives. */}
      <div className="work-skeleton" aria-hidden />

      <p className="tiny muted">
        {mediaType === 'video'
          ? 'Video takes a few minutes. You can leave this page — it keeps going.'
          : 'Usually about a minute.'}
      </p>
    </Card>
  );
}

/** What CIP decided to make, and what it leaned on to decide it. */
function Plan({ plan }: { plan: PlanSummary }) {
  const context = [plan.campaign, plan.product, plan.platform].filter(Boolean);

  return (
    <Card className="pad">
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
        <p className="strong">What CIP understood</p>
        <Pill tone={plan.confidence >= 0.6 ? 'ok' : 'warn'}>
          {Math.round(plan.confidence * 100)}% sure
        </Pill>
      </div>

      <p className="small muted" style={{ marginBottom: 10 }}>
        {[plan.formatLabel, ...context].join(' · ')}
        {/* The shape delivered, which is the one that was asked for. The
            generator's own shape is an implementation detail of getting
            there. */}
        {plan.deliveredShape ? ` · ${plan.deliveredShape}` : plan.aspectRatio ? ` · ${plan.aspectRatio}` : ''}
      </p>

      {/* Only when something was actually trimmed. This used to say "your
          generator makes 1:1, so CIP makes that and cuts it to 1:1 for you",
          which described the mechanism and read as nonsense. */}
      {plan.cropped && plan.deliveredShape && plan.aspectRatio && (
        <p className="small muted" style={{ marginBottom: 10 }}>
          Your generator makes {plan.aspectRatio}, so CIP makes that and cuts it to
          {' '}{plan.deliveredShape} for you.
        </p>
      )}

      {plan.switchedProvider && (
        <p className="small muted" style={{ marginBottom: 10 }}>
          Made with {IMAGE_PROVIDER_LABELS[plan.switchedProvider.to]}: {plan.switchedProvider.because}.
        </p>
      )}

      {/* Only when nothing can be done about it — a video, which is not
          re-cut here. An image is always delivered in the shape asked for. */}
      {!plan.exactShape && !plan.deliveredShape && (
        <p className="small" style={{ marginBottom: 10, color: 'var(--warn-700)' }}>
          <Icon name="alert" size={14} /> Your generator cannot make a
          {' '}{plan.formatLabel.toLowerCase()} exactly. This is the closest shape it offers
          {plan.aspectRatio ? ` (${plan.aspectRatio})` : ''}.
        </p>
      )}

      {/* Whether the generator was shown the actual product. Without it the
          bottle on the result is the model's idea of a bottle, with a label
          carrying words nobody printed — which is worth saying before somebody
          takes it for the real thing. */}
      {plan.productShots?.length > 0 ? (
        <p className="small muted" style={{ marginBottom: 10 }}>
          <Icon name="image" size={14} /> Built from your own product photo
          {plan.productShots.length > 1 ? 's' : ''}: {plan.productShots.join(', ')}
        </p>
      ) : (
        <p className="small" style={{ marginBottom: 10, color: 'var(--warn-700)' }}>
          <Icon name="alert" size={14} /> CIP has no photograph of this product, so the pack in
          this result is invented. Add one under &ldquo;Add data to brain&rdquo; and it will be
          copied instead.
        </p>
      )}

      {/* What this market requires on the creative itself. The checker fails a
          creative for a missing statutory warning, so the brief carries it. */}
      {plan.mustCarry?.length > 0 && (
        <div className="plan-block">
          <p className="tiny muted">Required on the creative itself</p>
          {plan.mustCarry.map((rule) => <p className="small" key={rule}>· {rule}</p>)}
        </div>
      )}

      {plan.brandRules.length > 0 && (
        <div className="plan-block">
          <p className="tiny muted">From your brand</p>
          {plan.brandRules.map((rule) => <p className="small" key={rule}>· {rule}</p>)}
        </div>
      )}

      {plan.learnedPreferences.length > 0 && (
        <div className="plan-block">
          <p className="tiny muted">Learned from your feedback</p>
          {plan.learnedPreferences.map((p) => <p className="small" key={p}>· {p}</p>)}
        </div>
      )}

      {plan.avoid.length > 0 && (
        <div className="plan-block">
          <p className="tiny muted">Avoiding</p>
          {plan.avoid.map((a) => <p className="small" key={a}>· {a}</p>)}
        </div>
      )}

      {/* Used, like everything above, but standing on one or two ratings. The
          page showed these exactly as it shows a pattern forty assets agree
          on, so a single "make the bottle enormous" read as the brand's rule. */}
      {plan.pendingLessons?.length > 0 && (
        <div className="plan-block">
          <p className="tiny muted">Used, but not settled yet</p>
          {plan.pendingLessons.map((lesson) => (
            <p className="small" key={lesson.statement}>
              · {lesson.statement}{' '}
              <span className="muted">
                ({lesson.evidenceCount} rating{lesson.evidenceCount === 1 ? '' : 's'} so far)
              </span>
            </p>
          ))}
        </div>
      )}

      {plan.references.length > 0 && (
        <p className="tiny muted" style={{ marginTop: 10 }}>
          Looked at {plan.references.map((r) => r.fileName).join(', ')}
        </p>
      )}
    </Card>
  );
}

/**
 * What a size that this generator does not make will actually produce.
 *
 * Both outcomes are honest and neither is an error: another configured
 * generator makes it exactly, or the nearest shape is made and cut down.
 */
type GenerationCheckState =
  | { state: 'waiting' }
  | { state: 'unchecked' }
  | { state: 'failed' }
  | { state: 'ready'; id: string; score: number | null; flags: number };

/**
 * The checker's verdict on a generated image.
 *
 * The worker checks every generated image against the brand and its rules
 * before it is treated as final; this shows that verdict under the picture
 * once it lands, and says so plainly while it has not.
 */
function GenerationCheck({ generationId, live }: { generationId: string; live: boolean }) {
  const [check, setCheck] = useState<GenerationCheckState>({ state: 'waiting' });

  useEffect(() => {
    let stopped = false;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const load = async () => {
      const res = await fetch(`/api/brain/checks?generationId=${encodeURIComponent(generationId)}`, { cache: 'no-store' }).catch(() => null);
      const body = res?.ok
        ? ((await res.json().catch(() => null)) as {
            check: { id: string; status: string; score: number | null; flags?: { status: string }[] } | null;
          } | null)
        : null;
      if (stopped) return;

      const found = body?.check;
      if (found && found.status === 'ready') {
        // Counted from the flags if they came, and zero if they did not. Read
        // straight off the body, a reply without them threw inside this
        // effect, where nothing catches it - and the line sat on "Checking it
        // against the brand" for ever, saying the opposite of what happened.
        const flags = Array.isArray(found.flags) ? found.flags : [];
        setCheck({
          state: 'ready',
          id: found.id,
          score: found.score,
          flags: flags.filter((f) => f.status !== 'disputed').length,
        });
        return;
      }
      if (found && found.status === 'failed') {
        setCheck({ state: 'failed' });
        return;
      }

      // Only the picture just made is waited on.
      //
      // Every card used to ask again every six seconds, thirty times: open the
      // history on a company with two dozen results and that is several hundred
      // requests for verdicts that are either already there or will not arrive
      // until the worker next runs. An older one is asked once and left alone.
      if (!live) {
        setCheck({ state: 'unchecked' });
        return;
      }

      tries += 1;
      if (tries > 30) {
        setCheck({ state: 'unchecked' });
        return;
      }
      timer = setTimeout(load, 6_000);
    };

    timer = setTimeout(load, 0);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [generationId, live]);

  if (check.state === 'waiting') {
    return <p className="gencheck"><Icon name="shield" size={13} /> Checking it against the brand and its rules…</p>;
  }
  if (check.state === 'unchecked') {
    return <p className="gencheck"><Icon name="shield" size={13} /> Not checked yet. The worker checks it when it next runs.</p>;
  }
  if (check.state === 'failed') {
    return <p className="gencheck"><Icon name="alert" size={13} /> The consistency check could not run on this one.</p>;
  }
  const tone = check.score === null ? 'neutral' : check.score >= 80 ? 'ok' : check.score >= 50 ? 'warn' : 'stop';
  return (
    <p className="gencheck">
      <Icon name="shield" size={13} />
      <Pill tone={tone}>{check.score === null ? 'Not judged' : `${check.score} / 100`}</Pill>
      <span>{check.flags === 0 ? 'No flags' : `${check.flags} flag${check.flags === 1 ? '' : 's'}`}</span>
      <a href={`/check?check=${check.id}`}>See the check</a>
    </p>
  );
}

/** One result, with the 0-10 rating that teaches the next one. */
function Result({
  generation, compact = false, onRated, onBuildOn,
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
  const commentRef = useRef<HTMLInputElement | null>(null);

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
          </div>
          {generation.type === 'image' && (
            <GenerationCheck generationId={generation.id} live={!compact} />
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
