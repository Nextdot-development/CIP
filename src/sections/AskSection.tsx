'use client';

import { useEffect, useState } from 'react';
import { useWorkspace } from '@/context/workspace';
import { useNavigate } from '@/lib/navigate';
import { useAskSeed } from '@/context/NavContext';
import { useToast } from '@/context/toast';
import type { AskMode } from '@/context/NavContext';
import { PromptSuggestions, RequestComposer } from '../components/RequestComposer';
import { Avatar, Card } from '../components/ui/Bits';
import { Icon } from '../components/ui/Icon';
import { interpret } from '../lib/interpret';
import type { Understanding } from '../lib/interpret';

type Phase = 'compose' | 'thinking' | 'review' | 'working' | 'done';

/**
 * Ask — the heart of the product.
 *
 * Type it like a message to a colleague, see what we understood, correct
 * anything we got wrong, then choose how it gets made: instantly by CIP, or
 * properly by your pod. The difference is stated plainly, never implied.
 */
export function AskSection() {
  const workspace = useWorkspace();
  const { go } = useNavigate();
  const { seed } = useAskSeed();
  const { note: onNote } = useToast();
  const [draft, setDraft] = useState(seed?.text ?? '');
  const [phase, setPhase] = useState<Phase>('compose');
  const [mode, setMode] = useState<AskMode>(seed?.mode ?? 'pod');
  const [u, setU] = useState<Understanding | null>(null);
  const [items, setItems] = useState<string[]>([]);
  const [editing, setEditing] = useState<number | null>(null);

  const run = (text: string, m: AskMode) => {
    if (!text.trim()) return;
    setMode(m);
    setPhase('thinking');
    const result = interpret(text, workspace);
    setTimeout(() => {
      setU(result);
      setItems(result.items);
      setPhase('review');
    }, 900);
  };

  const confirm = () => {
    if (mode === 'pod') {
      setPhase('done');
      onNote('Sent to your pod');
      return;
    }
    setPhase('working');
    setTimeout(() => {
      setPhase('done');
      onNote('Your drafts are ready');
    }, 1800);
  };

  const restart = () => {
    setPhase('compose');
    setDraft('');
    setU(null);
  };

  // A request typed on Home arrives here already written.
  useEffect(() => {
    if (seed && seed.text.trim()) run(seed.text.trim(), seed.mode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed]);

  if (phase === 'working') return <Working />;

  if (phase === 'done' && u) {
    return mode === 'instant' ? (
      <InstantDrafts understanding={u} onSendToPod={() => { setMode('pod'); setPhase('done'); onNote('Sent to your pod'); }} onAgain={restart} />
    ) : (
      <SentToPod understanding={u} items={items} onTrack={() => go('/trust')} onAgain={restart} />
    );
  }

  return (
    <div className="ask-wrap rise">
      <header className="ask-hero">
        <h1>What would you like to create?</h1>
        <p className="lede">Say it in your own words. We will read it back before anything starts.</p>
      </header>

      <RequestComposer
        value={draft}
        onChange={setDraft}
        onSubmit={(m) => run(draft, m)}
        placeholder={workspace.composerPlaceholder}
        autoFocus
      />

      {phase === 'compose' && (
        <PromptSuggestions
          items={workspace.promptSuggestions}
          onPick={(s) => {
            setDraft(s);
            run(s, 'pod');
          }}
        />
      )}

      {phase === 'thinking' && (
        <div className="thinking">
          <span className="pulse" />
          <span className="pulse" />
          <span className="pulse" />
          Reading your request against everything we know about {workspace.name}...
        </div>
      )}

      {phase === 'review' && u && (
        <div className="understanding">
          <Card className="u-card">
            <div className="u-lead">
              <Avatar initials="CIP" tint={[workspace.branding.primary, workspace.branding.deep]} size="lg" />
              <div>
                <p className="u-said">{u.headline}</p>
                <p className="u-sub">Change anything we got wrong — nothing starts until you say so.</p>
              </div>
            </div>

            <div className="u-items">
              {items.map((it, i) => (
                <div className="u-item" key={i}>
                  <span className="u-bullet" />
                  {editing === i ? (
                    <input
                      autoFocus
                      value={it}
                      onChange={(e) => setItems((a) => a.map((v, j) => (j === i ? e.target.value : v)))}
                      onBlur={() => setEditing(null)}
                      onKeyDown={(e) => e.key === 'Enter' && setEditing(null)}
                      aria-label="Edit this line"
                    />
                  ) : (
                    <span className="u-text">{it}</span>
                  )}
                  <span className="u-tools">
                    <button type="button" className="u-tool" onClick={() => setEditing(i)} aria-label="Edit">
                      <Icon name="pencil" size={15} />
                    </button>
                    <button
                      type="button"
                      className="u-tool"
                      onClick={() => setItems((a) => a.filter((_, j) => j !== i))}
                      aria-label="Remove"
                    >
                      <Icon name="x" size={15} />
                    </button>
                  </span>
                </div>
              ))}
              <button
                type="button"
                className="u-add"
                onClick={() => {
                  setItems((a) => [...a, 'Something else you need']);
                  setEditing(items.length);
                }}
              >
                <Icon name="plus" size={15} /> Add something we missed
              </button>
            </div>

            <p className="u-basis">
              <Icon name="sparkle" size={15} /> {u.basis}
            </p>

            <div className="u-actions">
              <button type="button" className="btn btn-primary" onClick={confirm}>
                {mode === 'instant' ? 'This is right — generate now' : 'This is right — start it'}
                <Icon name="arrow-right" size={16} />
              </button>
              <button type="button" className="btn btn-quiet" onClick={() => setPhase('compose')}>
                Let me rewrite it
              </button>
            </div>
          </Card>

          <Plan understanding={u} mode={mode} onMode={setMode} />
        </div>
      )}
    </div>
  );
}

/** How it gets made — stated as a choice, with the trade-off in plain words. */
function ModeSwitch({ mode, onMode }: { mode: AskMode; onMode: (m: AskMode) => void }) {
  return (
    <div className="mode-switch">
      <button type="button" className={`mode-opt ${mode === 'instant' ? 'on' : ''}`} onClick={() => onMode('instant')}>
        <span className="mo-icon"><Icon name="bolt" size={17} /></span>
        <span className="stack grow">
          <span className="mo-title">
            Generate instantly
            {mode === 'instant' && <Icon name="check" size={15} className="mo-tick" />}
          </span>
          <span className="mo-note">CIP drafts it now, on its own. Good for a first look — not checked yet.</span>
        </span>
      </button>
      <button type="button" className={`mode-opt ${mode === 'pod' ? 'on' : ''}`} onClick={() => onMode('pod')}>
        <span className="mo-icon"><Icon name="people" size={17} /></span>
        <span className="stack grow">
          <span className="mo-title">
            Create with pod
            {mode === 'pod' && <Icon name="check" size={15} className="mo-tick" />}
          </span>
          <span className="mo-note">Your people make it and check it. Finished work you can publish.</span>
        </span>
      </button>
    </div>
  );
}

/** What you will get, when, for how much, and where it stands. */
function Plan({
  understanding: u,
  mode,
  onMode,
}: {
  understanding: Understanding;
  mode: AskMode;
  onMode: (m: AskMode) => void;
}) {
  const plan = u.plans[mode];
  // An instant draft skips the checks, so we do not list them as if it did not.
  const deliverables = mode === 'instant' ? u.deliverables.filter((d) => d.id !== 'd-check') : u.deliverables;

  return (
    <Card title="How would you like this made?">
      <ModeSwitch mode={mode} onMode={onMode} />

      <p className="unlock-title" style={{ marginTop: 24 }}>What you will receive</p>
      <div className="deliver-list">
        {deliverables.map((d) => (
          <div className="deliver" key={d.id}>
            <span className="d-icon">
              <Icon name={d.icon} size={17} />
            </span>
            <span className="stack grow">
              <span className="d-title">{d.title}</span>
              <span className="d-note">{mode === 'instant' ? 'First draft' : d.note}</span>
            </span>
          </div>
        ))}
      </div>

      {mode === 'instant' && (
        <p className="unchecked-note">
          <Icon name="alert" size={16} />
          <span>
            Instant drafts skip your brand and compliance checks. Have a look, then send anything you like to your
            pod before it is published.
          </span>
        </p>
      )}

      <div className="plan-grid" style={{ marginTop: 18 }}>
        <div className="plan-stat">
          <p className="ps-label">Timeline</p>
          <p className="ps-value">{plan.timeline.value}</p>
          <p className="ps-note">{plan.timeline.note}</p>
        </div>
        <div className="plan-stat">
          <p className="ps-label">Estimated cost</p>
          <p className="ps-value">{plan.cost.value}</p>
          <p className="ps-note">{plan.cost.note}</p>
        </div>
        <div className="plan-stat">
          <p className="ps-label">Status</p>
          <p className="ps-value">{plan.status.value}</p>
          <p className="ps-note">{plan.status.note}</p>
        </div>
      </div>
    </Card>
  );
}

function Working() {
  const workspace = useWorkspace();
  return (
    <div className="ask-wrap rise">
      <div className="thinking" style={{ padding: '120px 0' }}>
        <span className="pulse" />
        <span className="pulse" />
        <span className="pulse" />
        Writing your drafts in {workspace.name}&apos;s voice...
      </div>
    </div>
  );
}

/** Instant path — drafts in hand, and an honest label on them. */
function InstantDrafts({
  understanding: u,
  onSendToPod,
  onAgain,
}: {
  understanding: Understanding;
  onSendToPod: () => void;
  onAgain: () => void;
}) {
  const workspace = useWorkspace();
  const drafts = u.deliverables.filter((d) => d.id !== 'd-check');

  return (
    <div className="ask-wrap rise">
      <header className="ask-hero">
        <span className="pill pill-brand" style={{ marginBottom: 14 }}>
          <Icon name="bolt" size={14} /> Generated instantly
        </span>
        <h1>Your drafts are ready.</h1>
        <p className="lede">
          Written in {workspace.name}&apos;s voice, from everything we know about your brand. Have a look before anyone
          else does.
        </p>
      </header>

      <Card className="u-card">
        {drafts.map((d) => (
          <div className="draft" key={d.id}>
            <span className="dr-thumb">
              <Icon name={d.icon} size={22} />
            </span>
            <span className="stack grow">
              <span className="dr-title">{d.title}</span>
              <span className="dr-note">First draft • not checked yet</span>
            </span>
            <span className="dr-actions">
              <button type="button" className="btn btn-ghost btn-sm">Preview</button>
              <button type="button" className="btn btn-ghost btn-sm">Download</button>
            </span>
          </div>
        ))}

        <p className="unchecked-note">
          <Icon name="alert" size={16} />
          <span>
            These have not been through your brand and compliance checks. Send them to your pod before you publish
            anything.
          </span>
        </p>

        <div className="u-actions">
          <button type="button" className="btn btn-primary" onClick={onSendToPod}>
            Send to my pod for checks <Icon name="arrow-right" size={16} />
          </button>
          <button type="button" className="btn btn-quiet" onClick={onAgain}>
            Ask for something else
          </button>
        </div>
      </Card>
    </div>
  );
}

const STEPS = ['Understood', 'With your pod', 'In review', 'Ready for you'];

/** Pod path — people have it, and you can see exactly where it stands. */
function SentToPod({
  understanding: u,
  items,
  onTrack,
  onAgain,
}: {
  understanding: Understanding;
  items: string[];
  onTrack: () => void;
  onAgain: () => void;
}) {
  const workspace = useWorkspace();
  const leadName = workspace.pod.members[0]?.name ?? 'Your pod';
  const plan = u.plans.pod;
  const firstDrafts = plan.timeline.note.replace('First drafts reach you in ', '').replace('.', '');

  return (
    <div className="ask-wrap rise">
      <header className="ask-hero">
        <span className="pill pill-ok" style={{ marginBottom: 14 }}>
          <Icon name="check" size={14} /> Sent to your pod
        </span>
        <h1>We are on it.</h1>
        <p className="lede">
          {leadName} and your pod have your request. You will hear from us before anything
          is published.
        </p>
      </header>

      <Card className="u-card">
        <p className="unlock-title">Your request</p>
        <div className="u-items">
          {items.map((it, i) => (
            <div className="u-item" key={i}>
              <span className="u-bullet" />
              <span className="u-text">{it}</span>
            </div>
          ))}
        </div>

        <div className="tracker" style={{ marginTop: 22 }}>
          {STEPS.map((s, i) => (
            <div className={`step ${i === 0 ? 'done' : i === 1 ? 'now' : ''}`} key={s}>
              <span className="bar" />
              <span className="s-label">{s}</span>
            </div>
          ))}
        </div>

        <div className="plan-grid" style={{ marginTop: 24 }}>
          <div className="plan-stat">
            <p className="ps-label">First drafts</p>
            <p className="ps-value">{firstDrafts}</p>
            <p className="ps-note">We will let you know the moment they land.</p>
          </div>
          <div className="plan-stat">
            <p className="ps-label">Estimated cost</p>
            <p className="ps-value">{plan.cost.value}</p>
            <p className="ps-note">You will see the final figure on delivery.</p>
          </div>
          <div className="plan-stat">
            <p className="ps-label">Working on it</p>
            <p className="ps-value row gap-6" style={{ marginTop: 10 }}>
              {workspace.pod.members.slice(0, 3).map((m) => (
                <Avatar key={m.id} initials={m.initials} tint={m.tint} size="sm" title={m.name} />
              ))}
            </p>
            <p className="ps-note">Real people, checking every step.</p>
          </div>
        </div>

        <div className="u-actions">
          <button type="button" className="btn btn-primary" onClick={onTrack}>
            Track it in Trust <Icon name="arrow-right" size={16} />
          </button>
          <button type="button" className="btn btn-quiet" onClick={onAgain}>
            Ask for something else
          </button>
        </div>
      </Card>
    </div>
  );
}
