'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
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

type Phase = 'idle' | 'planning' | 'asking' | 'done';

type PlanSummary = {
  taskType: string | null;
  platform: string | null;
  campaign: string | null;
  product: string | null;
  brandRules: string[];
  learnedPreferences: string[];
  avoid: string[];
  references: { fileId: string; fileName: string }[];
  confidence: number;
};

type BrainResult =
  | { status: 'generated'; generation: MediaGenerationDTO; briefId: string; plan: PlanSummary }
  | { status: 'needs_clarification'; briefId: string; question: string; plan: PlanSummary };

export function AskSection({
  initial,
  providers,
}: {
  initial: MediaGenerationDTO[];
  providers: ProviderStatusDTO;
}) {
  const workspace = useWorkspace();
  const { seed } = useAskSeed();
  const { note } = useToast();

  const [draft, setDraft] = useState(seed?.text ?? '');
  const [mediaType, setMediaType] = useState<MediaType>('image');
  // Named explicitly rather than left to the default. Sending no provider is
  // how a request quietly went to a key Google had revoked while a working one
  // sat next to it.
  const [provider, setProvider] = useState<ImageProviderChoice>(providers.defaultImageProvider);
  const [phase, setPhase] = useState<Phase>('idle');
  const [result, setResult] = useState<BrainResult | null>(null);
  const [answer, setAnswer] = useState('');
  const [history, setHistory] = useState(initial);

  const chosen = providers.images.find((p) => p.choice === provider) ?? null;
  const videoReady = providers.video.configured;
  const ready = mediaType === 'image' ? Boolean(chosen?.configured) : videoReady;

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

    setPhase(clarification ? 'asking' : 'planning');
    try {
      const res = await fetch('/api/brain/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          request: text,
          mediaType,
          ...(mediaType === 'image' ? { provider } : {}),
          ...(clarification ? { clarification } : {}),
        }),
      });

      const body = (await res.json()) as Partial<BrainResult> & { message?: string };
      if (!res.ok || !body.status) {
        note(body.message ?? 'That could not be made.');
        setPhase('idle');
        return;
      }

      const outcome = body as BrainResult;
      setResult(outcome);
      setPhase('done');
      setAnswer('');
      if (outcome.status === 'generated') {
        note(mediaType === 'video' ? 'Queued — this takes a few minutes' : 'Made');
        void refresh();
      }
    } catch {
      note('That could not be sent.');
      setPhase('idle');
    }
  };

  const busy = phase === 'planning' || phase === 'asking';

  return (
    <div className="rise">
      <header className="page-head">
        <p className="eyebrow">Ask</p>
        <h1>Make something</h1>
        <p className="lede">
          Describe it the way you would to a colleague. CIP writes the brief from what it has
          learned about {workspace.name}, then makes it.
        </p>
      </header>

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
            {busy ? 'Thinking…' : 'Make it'} <Icon name="arrow-right" size={14} />
          </button>
        </div>
      </Card>

      {/* What CIP decided, before what it produced. Shown either way, because
          the reasoning is what makes a bad result correctable. */}
      {result && <Plan plan={result.plan} />}

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
        <Result generation={result.generation} onRated={() => void refresh()} />
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
        <div className="gen-list">
          {history.map((g) => (
            <Result key={g.id} generation={g} compact onRated={() => void refresh()} />
          ))}
        </div>
      )}
    </div>
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

      {context.length > 0 && (
        <p className="small muted" style={{ marginBottom: 10 }}>{context.join(' · ')}</p>
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

      {plan.references.length > 0 && (
        <p className="tiny muted" style={{ marginTop: 10 }}>
          Looked at {plan.references.map((r) => r.fileName).join(', ')}
        </p>
      )}
    </Card>
  );
}

/** One result, with the 0-10 rating that teaches the next one. */
function Result({
  generation, compact = false, onRated,
}: {
  generation: MediaGenerationDTO;
  compact?: boolean;
  onRated: () => void;
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
            {generation.width ? ` · ${generation.width}×${generation.height}` : ''}
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
          </div>
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

      {sent && <p className="tiny muted" style={{ marginTop: 10 }}>Rated. CIP has learned from it.</p>}
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
