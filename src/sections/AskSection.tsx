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
  return [
    { value: null, label: 'Auto' },
    ...(chosen?.aspectRatios ?? []).map((ratio) => ({
      value: ratio,
      label: SHAPE_LABELS[ratio] ?? ratio,
    })),
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

  const busy = phase === 'planning' || phase === 'making' || phase === 'checking';

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

      {result?.status === 'generated' && result.qc && <QcOutcome qc={result.qc} />}

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
type GenerationCheckState =
  | { state: 'waiting' }
  | { state: 'unchecked' }
  | { state: 'failed' }
  | { state: 'ready'; id: string; score: number | null; flags: number; broke: string[] };

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
            check: {
              id: string; status: string; score: number | null;
              flags?: { status: string; severity?: string; citedRule?: { rule: string } | null }[];
            } | null;
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
          // The same test the generator's own loop uses: a rule, not a
          // pattern, found broken, and not disputed. See rulesBroken.
          broke: flags
            .filter((f) => f.status !== 'disputed' && f.citedRule && f.severity !== 'note')
            .map((f) => f.citedRule!.rule),
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
    <div className="gencheck">
      <Icon name="shield" size={13} />
      {check.broke.length === 0 ? (
        <Pill tone="ok">Passed QC</Pill>
      ) : (
        <Pill tone="stop">Did not pass QC</Pill>
      )}
      <Pill tone={tone}>{check.score === null ? 'Not judged' : `${check.score} / 100`}</Pill>
      <span>{check.flags === 0 ? 'No flags' : `${check.flags} flag${check.flags === 1 ? '' : 's'}`}</span>
      <a href={`/check?check=${check.id}`}>See the check</a>
      {check.broke.length > 0 && (
        <p className="gencheck-broke">Breaks: {check.broke.join('; ')}</p>
      )}
    </div>
  );
}

/**
 * How the picture got to where it is: made once and passed, or made again
 * because a version broke a rule - and, when it never passed, why it stopped.
 */
function QcOutcome({ qc }: { qc: GenerationQc }) {
  const fixed = qc.earlier.filter((e) => e.broke.length > 0);
  const why: Record<GenerationQc['stopped'], string> = {
    passed: '',
    out_of_tries: `It was made ${qc.attempts} times and every version broke a rule.`,
    out_of_time: 'It ran out of time to make another version.',
    generation_failed: 'Making another version failed.',
    check_failed: 'The check itself could not run.',
    left_to_you: 'Change the layers below to fix it - nothing is made again on its own.',
  };

  return (
    <Card className="pad">
      <p className="strong" style={{ marginBottom: 4 }}>
        <Icon name={qc.verdict === 'passed' ? 'check' : 'alert'} size={15} />{' '}
        {qc.verdict === 'passed'
          ? qc.attempts === 1
            ? 'Passed every QC rule first time'
            : `Passed QC on version ${qc.attempts}`
          : qc.verdict === 'failed'
            ? 'This does not pass QC yet'
            : 'This has not been checked'}
      </p>
      {fixed.length > 0 && (
        <ul className="small" style={{ margin: '6px 0 0', paddingLeft: 18 }}>
          {fixed.map((e, i) => (
            <li key={e.generationId}>
              Version {i + 1} broke: {e.broke.join('; ')}
              {qc.verdict === 'passed' ? ' — fixed.' : '.'}
            </li>
          ))}
        </ul>
      )}
      {qc.verdict === 'failed' && (
        <>
          <p className="small" style={{ marginTop: 6 }}>
            {why[qc.stopped]} This is the closest version. It still breaks:
          </p>
          <ul className="small" style={{ margin: '4px 0 0', paddingLeft: 18 }}>
            {qc.broke.map((b, i) => (
              <li key={i}><strong>{b.rule}</strong> — {b.message}</li>
            ))}
          </ul>
          <p className="tiny muted" style={{ marginTop: 6 }}>
            Fix it with &ldquo;Build on this&rdquo;, or dispute a flag on the check if the rule does not apply.
          </p>
        </>
      )}
      {qc.verdict === 'unchecked' && (
        <p className="small" style={{ marginTop: 6 }}>{why[qc.stopped]} Do not treat it as approved until it has been checked.</p>
      )}
    </Card>
  );
}

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
function TextEditor({ generation, lines: initial, onDone, onSave, saveLabel = 'Save as new version', hint }: {
  generation: MediaGenerationDTO;
  lines: HeadlineLine[];
  onDone: () => void;
  /** Saves the lines another way - on the post itself, for one arranged layer by layer. */
  onSave?: (lines: HeadlineLine[]) => Promise<boolean>;
  saveLabel?: string;
  hint?: string;
}) {
  const { note } = useToast();
  const [lines, setLines] = useState<HeadlineLine[]>(initial);
  const [saving, setSaving] = useState(false);
  const set = (i: number, change: Partial<HeadlineLine>) =>
    setLines((all) => all.map((l, n) => (n === i ? { ...l, ...change } : l)));
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
        <div key={i} className="row" style={{ gap: 8 }}>
          <select
            className="field-input"
            style={{ width: 120 }}
            value={line.role}
            onChange={(e) => set(i, { role: e.target.value as HeadlineLine['role'] })}
            aria-label={`Line ${i + 1} style`}
          >
            {LINE_PARTS.map((p) => <option key={p.role} value={p.role}>{p.label}</option>)}
          </select>
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
type LayerName = 'background' | 'shadow' | 'bottle' | 'headline' | 'logo';
type Frac = { x: number; y: number; w: number; h: number };
type Piece = 'bottle' | 'logo' | 'text';
type Placement = {
  bottle?: { cx: number; base: number; height: number };
  logo?: { x: number; y: number; w: number };
  text?: { x: number; y: number; scale: number };
};
type Manifest = {
  width: number;
  height: number;
  version: string;
  /** `v` is what the layer holds: it changes only when that layer does. */
  layers: { name: LayerName; present: boolean; v?: string }[];
  boxes: { bottle: Frac | null; logo: Frac | null; text: Frac | null; textAnchor: { x: number } | null };
  choices: { place?: Placement };
};

/** The steps, in the order a designer builds a post. Each adds its layers to the canvas. */
const STUDIO_STEPS: { id: 'background' | 'bottle' | 'logo' | 'words' | 'download'; label: string; adds: LayerName[] }[] = [
  { id: 'background', label: 'Background', adds: ['background'] },
  { id: 'bottle', label: 'Bottle', adds: ['shadow', 'bottle'] },
  { id: 'logo', label: 'Logo', adds: ['logo'] },
  { id: 'words', label: 'Headline', adds: ['headline'] },
  { id: 'download', label: 'Download', adds: [] },
];
/** Top to bottom, as an editor lists them. */
const LAYER_LIST: { name: LayerName; label: string }[] = [
  { name: 'logo', label: 'Logo' },
  { name: 'headline', label: 'Headline' },
  { name: 'bottle', label: 'Bottle' },
  { name: 'shadow', label: 'Bottle shadow' },
  { name: 'background', label: 'Background' },
];
/** Which pictures each draggable piece is made of. */
const PIECE_LAYERS: Record<Piece, LayerName[]> = { bottle: ['bottle', 'shadow'], logo: ['logo'], text: ['headline'] };
const PIECE_OF: Partial<Record<LayerName, Piece>> = { bottle: 'bottle', shadow: 'bottle', logo: 'logo', headline: 'text' };
const PIECE_LABEL: Record<Piece, string> = { bottle: 'Bottle', logo: 'Logo', text: 'Headline' };

const BOTTLE_PLACES: { value: Layers['bottle']; label: string }[] = [
  { value: 'left', label: 'Left' }, { value: 'center', label: 'Centre' }, { value: 'right', label: 'Right' }, { value: 'none', label: 'No bottle' },
];
const EXPORTS: { format: 'png' | 'psd' | 'svg' | 'pdf'; label: string; note: string }[] = [
  { format: 'psd', label: 'PSD', note: 'Photoshop - every part its own layer, the headline as live text' },
  { format: 'svg', label: 'SVG', note: 'Illustrator, Figma, Canva - layers, the headline as live text' },
  { format: 'pdf', label: 'PDF', note: 'For print - the headline stays sharp text' },
  { format: 'png', label: 'PNG', note: 'The finished post, flat' },
];

/** A layer's picture, addressed by what it holds - the browser keeps one that has not changed. */
const layerSrc = (id: string, manifest: Manifest, name: LayerName) => {
  const v = manifest.layers.find((l) => l.name === name)?.v ?? manifest.version;
  return `/api/media/generations/${id}/layers/${name}?v=${encodeURIComponent(v)}`;
};

/**
 * Loads the pictures of a version before it is shown, so nothing jumps back
 * while it arrives. A layer that did not change is already here.
 */
function preload(id: string, manifest: Manifest): Promise<void> {
  return Promise.all(manifest.layers.map((l) => new Promise<void>((done) => {
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
  const [hidden, setHidden] = useState<Set<LayerName>>(new Set());
  const [selected, setSelected] = useState<Piece | null>(null);
  /** Where pieces are shown while dragged and until the post catches up. */
  const [moved, setMoved] = useState<Partial<Record<Piece, Frac>>>({});
  const [saving, setSaving] = useState(false);
  /** A piece turned on or off, shown so at once while the post catches up. */
  const [want, setWant] = useState<{ logo?: boolean; headline?: boolean }>({});
  const [painting, setPainting] = useState(false);
  const [backgroundNote, setBackgroundNote] = useState('');
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ piece: Piece; mode: 'move' | 'resize'; x: number; y: number; from: Frac } | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  const load = useCallback(async (): Promise<Manifest | null> => {
    const res = await fetch(`/api/media/generations/${generation.id}/layers`, { cache: 'no-store' }).catch(() => null);
    if (!res?.ok) return null;
    return (await res.json()) as Manifest;
  }, [generation.id]);

  useEffect(() => {
    let live = true;
    void load().then((m) => {
      if (!live) return;
      if (m) setManifest(m);
      else note('The layers could not be loaded.');
    });
    return () => { live = false; };
  }, [load, note]);

  /**
   * Sends a change and shows the post as it then stands - one change at a
   * time, in the order made, so a quick second drag never lands first.
   */
  const pending = useRef(0);
  /** How many times each piece was dropped: a drop still saving is not undone by an earlier one landing. */
  const drops = useRef<Partial<Record<Piece, number>>>({});
  const arrange = (body: { choices?: Record<string, unknown>; lines?: HeadlineLine[] }, settles: Piece[] = []): Promise<boolean> => {
    pending.current += 1;
    setSaving(true);
    const seen = settles.map((p) => [p, (drops.current[p] = (drops.current[p] ?? 0) + 1)] as const);
    const settle = () => {
      const done = seen.filter(([p, n]) => drops.current[p] === n).map(([p]) => p);
      setMoved((m) => { const left = { ...m }; for (const p of done) delete left[p]; return left; });
      pending.current -= 1;
      if (pending.current === 0) { setSaving(false); setWant({}); }
    };
    const run = queue.current.then(async () => {
      const res = await fetch(`/api/media/generations/${generation.id}/layers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }).catch(() => null);
      if (!res?.ok) {
        const message = (await res?.json().catch(() => null) as { message?: string } | null)?.message;
        note(message ?? 'That change could not be made.');
        settle();
        return false;
      }
      // The post and its layers come back together; only the layers that changed are fetched.
      const next = (await res.json()) as { generation: MediaGenerationDTO; layers: Manifest };
      await preload(generation.id, next.layers);
      setManifest(next.layers);
      onChanged(next.generation);
      settle();
      return true;
    });
    queue.current = run.catch(() => undefined);
    return run;
  };

  /**
   * A new background, painted with what the person asked for - the one call
   * here that is paid for - or the one before it back, which is not.
   */
  const paint = async (which: 'new' | 'previous') => {
    setPainting(true);
    const res = await fetch(`/api/media/generations/${generation.id}/background`, {
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
    if (fresh) setManifest(fresh);
    setMoved({});
    setPainting(false);
    onChanged(next);
    note(which === 'previous' ? 'Back to the background before' : 'New background in place');
  };

  // What the steps so far have put on the canvas, less what was hidden by hand.
  const reached = new Set(STUDIO_STEPS.slice(0, step + 1).flatMap((s) => s.adds));
  const present = new Set(manifest?.layers.filter((l) => l.present).map((l) => l.name) ?? []);
  // Turned off here: gone at once. Turned on: shown as soon as its picture is set.
  if (want.logo === false) present.delete('logo');
  if (want.headline === false) present.delete('headline');
  const logoOn = want.logo ?? layers.logo !== 'none';
  const headlineOn = want.headline ?? layers.headline !== 'none';
  const shows = (name: LayerName) => reached.has(name) && present.has(name) && !hidden.has(name);
  const current = STUDIO_STEPS[step]!;

  const boxOf = (piece: Piece): Frac | null => moved[piece] ?? manifest?.boxes[piece] ?? null;
  const draggable = (piece: Piece) => PIECE_LAYERS[piece].some((n) => shows(n)) && Boolean(manifest?.boxes[piece]);

  /** The transform that carries a piece's picture from where it was set to where it is shown. */
  const transformFor = (name: LayerName): string | undefined => {
    const piece = PIECE_OF[name];
    const from = piece ? manifest?.boxes[piece] : null;
    const to = piece ? moved[piece] : null;
    if (!from || !to) return undefined;
    const k = to.h / from.h;
    return `translate(${(to.x - from.x) * 100}%, ${(to.y - from.y) * 100}%) scale(${k})`;
  };
  const originFor = (name: LayerName): string | undefined => {
    const piece = PIECE_OF[name];
    const from = piece ? manifest?.boxes[piece] : null;
    return from ? `${from.x * 100}% ${from.y * 100}%` : undefined;
  };

  const startDrag = (piece: Piece, mode: 'move' | 'resize') => (e: React.PointerEvent) => {
    const from = boxOf(piece);
    if (!from) return;
    e.preventDefault();
    e.stopPropagation();
    setSelected(piece);
    drag.current = { piece, mode, x: e.clientX, y: e.clientY, from };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };

  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!d || !rect) return;
    const dx = (e.clientX - d.x) / rect.width;
    const dy = (e.clientY - d.y) / rect.height;
    const f = d.from;
    const box = d.mode === 'move'
      ? { ...f, x: f.x + dx, y: f.y + dy }
      : (() => {
          // From the corner, keeping its shape: whichever way was pulled further.
          const k = Math.max(0.25, Math.min(4, Math.max((f.w + dx) / f.w, (f.h + dy) / f.h)));
          return { x: f.x, y: f.y, w: f.w * k, h: f.h * k };
        })();
    setMoved((m) => ({ ...m, [d.piece]: box }));
  };

  const onDrop = () => {
    const d = drag.current;
    drag.current = null;
    if (!d || !manifest) return;
    const to = moved[d.piece];
    const from = manifest.boxes[d.piece];
    if (!to || !from || (Math.abs(to.x - from.x) < 0.002 && Math.abs(to.y - from.y) < 0.002 && Math.abs(to.h - from.h) < 0.002)) {
      setMoved((m) => { const next = { ...m }; delete next[d.piece]; return next; });
      return;
    }
    const place: Placement = {};
    if (d.piece === 'bottle') place.bottle = { cx: to.x + to.w / 2, base: to.y + to.h, height: to.h };
    if (d.piece === 'logo') place.logo = { x: to.x, y: to.y, w: to.w };
    if (d.piece === 'text') {
      const was = manifest.choices.place?.text?.scale ?? 1;
      const anchor = manifest.boxes.textAnchor?.x ?? from.x;
      place.text = { x: anchor + (to.x - from.x), y: to.y, scale: was * (to.h / from.h) };
    }
    void arrange({ choices: { place } }, [d.piece]);
  };

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

  const handles = (['bottle', 'text', 'logo'] as Piece[]).filter(draggable);

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
          }}
          onPointerMove={onMove}
          onPointerUp={onDrop}
          onPointerCancel={onDrop}
          onPointerDown={() => setSelected(null)}
        >
          {manifest
            ? [...LAYER_LIST].reverse().map((l) => (
                <img
                  key={l.name}
                  src={layerSrc(generation.id, manifest, l.name)}
                  alt=""
                  draggable={false}
                  className={`studio-layer ${shows(l.name) ? '' : 'is-hidden'}`}
                  style={{ transform: transformFor(l.name), transformOrigin: originFor(l.name) }}
                />
              ))
            : <div className="studio-wait">Laying out the layers…</div>}
          {painting && <div className="studio-wait">Painting a new background…</div>}

          {manifest && handles.map((piece) => {
            const b = boxOf(piece)!;
            return (
              <div
                key={piece}
                className={`studio-box ${selected === piece ? 'is-on' : ''}`}
                style={{ left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%` }}
                onPointerDown={startDrag(piece, 'move')}
                title={`Drag the ${PIECE_LABEL[piece].toLowerCase()}; pull its corner to resize`}
              >
                <span className="studio-box-label">{PIECE_LABEL[piece]}</span>
                <span className="studio-box-grip" onPointerDown={startDrag(piece, 'resize')} aria-label={`Resize the ${PIECE_LABEL[piece].toLowerCase()}`} />
              </div>
            );
          })}
        </div>
        <p className="tiny muted" style={{ margin: '10px 0 0', textAlign: 'center' }}>
          {saving
            ? 'Saving where you put it…'
            : handles.length
              ? 'Drag a piece to move it; pull its corner to make it bigger or smaller. All free.'
              : 'The background alone. Add the bottle next.'}
        </p>
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
            </>
          )}

          {current.id === 'bottle' && (
            <>
              <p className="studio-q">Where should the bottle stand?</p>
              <p className="tiny muted">Drag it on the picture, and pull its corner to make it bigger or smaller - or start from a place:</p>
              {choice('bottle', BOTTLE_PLACES)}
            </>
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
                <p className="tiny muted">Drag it on the picture to place it; pull its corner to resize it.</p>
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
                onSave={async (lines) => arrange({ lines })}
                onDone={() => note('Headline set')}
              />
              )}
            </>
          )}

          {current.id === 'download' && (
            <>
              <p className="studio-q">Take it to your editor</p>
              <div className="stack" style={{ gap: 6 }}>
                {EXPORTS.map((e) => (
                  <a key={e.format} className="studio-export" href={exportUrl(generation.id, e.format)} download>
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

        <div className="studio-layers">
          <p className="insp-label">Layers</p>
          {LAYER_LIST.map((l) => {
            const there = reached.has(l.name) && present.has(l.name);
            const locked = l.name === 'background';
            return (
              <button
                key={l.name}
                type="button"
                className={`studio-layer-row ${there ? '' : 'is-off'} ${selected && PIECE_OF[l.name] === selected ? 'is-on' : ''}`}
                disabled={!there || locked}
                onClick={() => setHidden((h) => {
                  const next = new Set(h);
                  if (next.has(l.name)) next.delete(l.name); else next.add(l.name);
                  return next;
                })}
                title={locked ? 'The background stays' : there ? 'Show or hide' : 'Added in a later step'}
              >
                <span className="studio-eye">
                  {locked ? <Icon name="lock" size={12} /> : there && !hidden.has(l.name) ? <Icon name="check" size={12} /> : null}
                </span>
                {l.label}
              </button>
            );
          })}
        </div>

        <div className="studio-redesign">
          <p className="insp-label">Redesign the background</p>
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
          A new background uses credits for one picture - the only step here that does. The bottle, logo and
          headline stay where you put them. Going back to the one before is free.
        </p>
        </div>
      </aside>
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
          {/* A post designed layer by layer is not checked here: it is checked,
              when wanted, on the Creative QC page, once it is arranged. */}
          {generation.type === 'image' && !generation.layers && (
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
