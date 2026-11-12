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
                    : chosen?.aspectRatios.includes(option.value)
                      ? `${IMAGE_PROVIDER_LABELS[chosen.choice]} makes this size directly`
                      : 'Made at the nearest size the generator has, then cut to this one'
                }
              >
                {option.label}
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
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void (mediaType === 'image' && ownPicture ? placeOnOwn() : send())}
            disabled={busy || (mediaType === 'image' && ownPicture ? false : !draft.trim() || !ready)}
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
type LayerName = 'background' | 'shadow' | 'reflection' | 'bottle' | 'headline' | 'texts' | 'logo';
/**
 * A piece's box in fractions of the post, how far it is turned (degrees,
 * clockwise) for one that turns, and the point it turns and sizes about when
 * that is not its middle - the shadow's is the bottle's foot.
 */
type Frac = { x: number; y: number; w: number; h: number; r?: number; px?: number; py?: number };
type BasePiece = 'bottle' | 'shadow' | 'reflection' | 'logo' | 'text';
/** A piece on the post: one of its own, or a block of text a person added - "t:" and its id. */
type Piece = BasePiece | `t:${string}`;
const isBlock = (piece: Piece): piece is `t:${string}` => piece.startsWith('t:');
/** Text a person added besides the headline: its lines, place and look. */
type TextBlockC = {
  id: string; lines: HeadlineLine[]; x: number; y: number; width: number; size: number;
  align: 'left' | 'center' | 'right'; weight: 'regular' | 'bold' | 'black'; italic: boolean; upper: boolean; shadow: boolean;
  font?: string; ink?: string;
};
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
  choices: { bottle: Layers['bottle']; size: Layers['size']; logo: Layers['logo']; headline?: 'shown' | 'none'; place?: Placement; style?: PostStyle; texts?: TextBlockC[]; order?: StackGroupC[] };
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
};
type SlideKey = 'textSize' | 'shadow' | 'bright' | 'shadowSoft' | 'shadowAngle' | 'shadowLength' | 'reflection' | 'reflectionSoft'
  | 'logoBright' | 'logoShadow' | 'logoOpacity' | 'bgBright' | 'bgBlur';
/** The pieces that can lie over or under one another, from the bottom up as CIP lays them. */
const STACK_C = ['bottle', 'headline', 'texts', 'logo'] as const;
type StackGroupC = (typeof STACK_C)[number];
const STACK_LABEL: Record<StackGroupC, string> = { bottle: 'Bottle', headline: 'Headline', texts: 'Text', logo: 'Logo' };
const STACK_LAYERS: Record<StackGroupC, LayerName[]> = { bottle: ['shadow', 'reflection', 'bottle'], headline: ['headline'], texts: ['texts'], logo: ['logo'] };

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
    order: s.choices.order ?? null,
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
      logoOpacity: s.choices.style?.logoOpacity ?? null, bgBright: s.choices.style?.bgBright ?? null, bgBlur: s.choices.style?.bgBlur ?? null,
    },
  },
  ...(s.lines ? { lines: s.lines } : {}),
});

/** Where a dragged piece settles when it comes near: the middle, and a margin in from each edge. */
const SNAP = 0.012;
const MARGIN = 0.05;
function snapped(box: Frac, piece: Piece): { box: Frac; guides: { x: number[]; y: number[] } } {
  const guides = { x: [] as number[], y: [] as number[] };
  let { x, y } = box;
  const nearX = ([[x + box.w / 2, 0.5], [x, MARGIN], [x + box.w, 1 - MARGIN]] as const).find(([at, line]) => Math.abs(at - line) < SNAP);
  if (nearX) { x += nearX[1] - nearX[0]; guides.x.push(nearX[1]); }
  // A bottle stands on its surface: only the words and the logo settle on the bottom margin.
  const ys: (readonly [number, number])[] = [[y + box.h / 2, 0.5], [y, MARGIN]];
  if (piece !== 'bottle') ys.push([y + box.h, 1 - MARGIN]);
  const nearY = ys.find(([at, line]) => Math.abs(at - line) < SNAP);
  if (nearY) { y += nearY[1] - nearY[0]; guides.y.push(nearY[1]); }
  return { box: { ...box, x, y }, guides };
}

const SHAPES: { value: string | null; label: string }[] = [
  { value: null, label: 'As made' }, { value: '1:1', label: 'Square 1:1' }, { value: '4:5', label: 'Portrait 4:5' },
  { value: '9:16', label: 'Story 9:16' }, { value: '16:9', label: 'Wide 16:9' },
  // Print and retail, as Radico's briefs ask for them.
  { value: '1:1.414', label: 'Poster A2/A3' }, { value: '1:2', label: 'Standee 36x72in' }, { value: '4:3', label: 'Billboard 4x3m' },
  { value: '5:1', label: 'Jumia desktop 1200x240' }, { value: '720:261', label: 'Jumia mobile 720x261' },
  { value: '41:16', label: 'Shelf top 41x16in' }, { value: '18:60', label: 'Shelf side 18x60in' },
];

type HeadlineOption = { from: 'words' | 'brand'; lines: HeadlineLine[] };

/** The steps, in the order a designer builds a post. Each adds its layers to the canvas. */
const STUDIO_STEPS: { id: 'background' | 'bottle' | 'logo' | 'words' | 'download'; label: string; adds: LayerName[] }[] = [
  { id: 'background', label: 'Background', adds: ['background'] },
  { id: 'bottle', label: 'Bottle', adds: ['shadow', 'reflection', 'bottle'] },
  { id: 'logo', label: 'Logo', adds: ['logo'] },
  { id: 'words', label: 'Headline', adds: ['headline', 'texts'] },
  { id: 'download', label: 'Download', adds: [] },
];
/** Top to bottom, as an editor lists them. */
const LAYER_LIST: { name: LayerName; label: string }[] = [
  { name: 'logo', label: 'Logo' },
  { name: 'texts', label: 'Text' },
  { name: 'headline', label: 'Headline' },
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
const TURNS = new Set<Piece>(['bottle', 'shadow', 'reflection', 'logo']);
const layersOfPiece = (piece: Piece): LayerName[] => (isBlock(piece) ? ['texts'] : PIECE_LAYERS[piece]);
const labelOf = (piece: Piece): string => (isBlock(piece) ? 'Text' : PIECE_LABEL[piece]);
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
  /** Which of the bottle, its shadow and its reflection the bottle step is setting: the one last chosen. */
  const [part, setPart] = useState<'bottle' | 'shadow' | 'reflection'>('bottle');
  useEffect(() => {
    if (selected === 'bottle' || selected === 'shadow' || selected === 'reflection') setPart(selected);
  }, [selected]);
  /** Where pieces are shown while dragged and until the post catches up. */
  const [moved, setMoved] = useState<Partial<Record<Piece, Frac>>>({});
  const [saving, setSaving] = useState(false);
  /** A piece turned on or off, shown so at once while the post catches up. */
  const [want, setWant] = useState<{ logo?: boolean; headline?: boolean }>({});
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
  const drag = useRef<{ piece: Piece; mode: 'move' | 'resize' | 'turn'; x: number; y: number; from: Frac } | null>(null);
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
  const onWords = STUDIO_STEPS[step]?.id === 'words';
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
  const arrange = (
    given: Change | null,
    settles: Piece[] = [],
    /** A change made here, or a step back or forward through the ones made. */
    mode: 'do' | 'undo' | 'redo' = 'do',
  ): Promise<boolean> => {
    const dropped = (p: Piece) => (drops.current[p] = (drops.current[p] ?? 0) + 1);
    if (mode === 'do' && given && waiting.current) {
      const w = waiting.current;
      w.body = mergeChange(w.body, given);
      for (const p of settles) w.seen.set(p, dropped(p));
      return w.run;
    }
    pending.current += 1;
    setSaving(true);
    const seen = new Map(settles.map((p) => [p, dropped(p)] as const));
    let mine: { body: Change; seen: Map<Piece, number>; run: Promise<boolean> } | null = null;
    const settle = () => {
      const done = [...seen].filter(([p, n]) => drops.current[p] === n).map(([p]) => p);
      setMoved((m) => { const left = { ...m }; for (const p of done) delete left[p]; return left; });
      pending.current -= 1;
      if (pending.current === 0) { setSaving(false); setWant({}); }
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
  const reached = new Set(STUDIO_STEPS.slice(0, step + 1).flatMap((s) => s.adds));
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

  const startDrag = (piece: Piece, mode: 'move' | 'resize' | 'turn') => (e: React.PointerEvent) => {
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
    const settled = d.mode === 'move' && !e.altKey ? snapped(raw, d.piece) : { box: raw, guides: { x: [], y: [] } };
    const box: Frac = { ...settled.box };
    if (f.px !== undefined && f.py !== undefined && d.mode === 'move') { box.px = f.px + (box.x - f.x); box.py = f.py + (box.y - f.y); }
    setGuides(settled.guides);
    setMoved((m) => ({ ...m, [d.piece]: box }));
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
    if (isBlock(piece)) {
      const id = piece.slice(2);
      const k = to.h / from.h;
      const texts = (manifest.choices.texts ?? []).map((b) => (b.id !== id ? b : {
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

  const onDrop = () => {
    const d = drag.current;
    drag.current = null;
    setGuides({ x: [], y: [] });
    if (!d) return;
    commit(d.piece, moved[d.piece]);
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
    if ((e.ctrlKey || e.metaKey) && (k === 'z' || k === 'y')) {
      e.preventDefault();
      const back = k === 'z' && !e.shiftKey;
      if ((back ? undos : redos).current.length) void arrange(null, [], back ? 'undo' : 'redo');
      return;
    }
    const d = e.shiftKey ? 0.02 : 0.004;
    const by = ({ arrowleft: [-d, 0], arrowright: [d, 0], arrowup: [0, -d], arrowdown: [0, d] } as Record<string, [number, number]>)[k];
    if (!by || !selected || !draggable(selected)) return;
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
  const order: StackGroupC[] = manifest?.choices.order ?? [...STACK_C];
  const stacked = [
    LAYER_LIST.find((l) => l.name === 'background')!,
    ...order.flatMap((g) => STACK_LAYERS[g].map((n) => LAYER_LIST.find((l) => l.name === n)!)),
  ];
  /** A piece one step up or down the stack. */
  const restack = (g: StackGroupC, by: 1 | -1) => {
    const at = order.indexOf(g);
    const to = at + by;
    if (to < 0 || to >= order.length) return;
    const next = [...order];
    [next[at], next[to]] = [next[to]!, next[at]!];
    void arrange({ choices: { order: next } });
  };
  const handles = ([
    'shadow', 'reflection', 'bottle', 'text', 'logo',
    ...(manifest?.boxes.texts ?? []).map((t) => `t:${t.id}` as Piece),
  ] as Piece[]).filter(draggable);

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
            ? stacked.map((l) => (l.name === 'texts' ? (
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
                  style={{ transform: transformFor(l.name), transformOrigin: originFor(l.name), ...previewOf(l.name) }}
                />
              )))
            : <div className="studio-wait">Laying out the layers…</div>}
          {painting && <div className="studio-wait">Painting a new background…</div>}

          {manifest && handles.map((piece) => {
            const b = boxOf(piece)!;
            return (
              <div
                key={piece}
                className={`studio-box ${selected === piece ? 'is-on' : ''}`}
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
                  : TURNS.has(piece)
                    ? `Drag the ${labelOf(piece).toLowerCase()}; pull its corner to resize; turn it by the round handle`
                    : `Drag the ${labelOf(piece).toLowerCase()}; pull its corner to resize`}
              >
                <span className="studio-box-label" style={b.r ? { transform: `rotate(${-b.r}deg)` } : undefined}>{labelOf(piece)}{b.r ? ` · ${Math.round(b.r)}°` : ''}</span>
                {b.px !== undefined && b.py !== undefined && (
                  <span
                    className="studio-box-pivot"
                    style={{ left: `${((b.px - b.x) / b.w) * 100}%`, top: `${((b.py - b.y) / b.h) * 100}%` }}
                    title="It turns about here - the bottle's foot"
                  />
                )}
                {TURNS.has(piece) && (
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
                <span className="studio-box-grip" onPointerDown={startDrag(piece, 'resize')} aria-label={`Resize the ${labelOf(piece).toLowerCase()}`} title="Pull to make it bigger or smaller">
                  <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true">
                    <path d="M4 12L12 4M7.5 4H12v4.5M4 7.5V12h4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
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
          <span className="tiny muted">
            {saving
              ? 'Saving where you put it…'
              : handles.length
                ? 'Drag to move, pull a corner to resize, arrow keys to nudge. All free.'
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
                      {slide('bright')}
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
                  <div className="studio-group">
                    <p className="studio-group-title">Logo</p>
                    {slide('logoBright')}
                    {slide('logoShadow')}
                    {slide('logoOpacity')}
                  </div>
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

        <div className="studio-layers">
          <p className="insp-label">Order - what lies over what</p>
          <ol className="studio-stack">
            {[...order].reverse().map((g, i, top) => (
              <li key={g}>
                <span>{STACK_LABEL[g]}</span>
                <span className="row" style={{ gap: 2 }}>
                  <button type="button" className="studio-stack-btn" disabled={i === 0} onClick={() => restack(g, 1)} aria-label={`Bring the ${STACK_LABEL[g].toLowerCase()} forward`} title="Bring forward">↑</button>
                  <button type="button" className="studio-stack-btn" disabled={i === top.length - 1} onClick={() => restack(g, -1)} aria-label={`Send the ${STACK_LABEL[g].toLowerCase()} back`} title="Send back">↓</button>
                </span>
              </li>
            ))}
            <li className="is-fixed"><span>Background</span><Icon name="lock" size={12} /></li>
          </ol>
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
      </aside>
    </div>
  );
}

/**
 * Any colour at all, for when the brand's own are not enough: picked in the
 * browser's own picker, and set once the picking stops rather than on every
 * shade passed on the way.
 */
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
