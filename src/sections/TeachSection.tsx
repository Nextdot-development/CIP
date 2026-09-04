'use client';

import { useState } from 'react';
import { useWorkspace } from '@/context/workspace';
import { useToast } from '@/context/toast';
import { Card, EmptyState, Progress } from '../components/ui/Bits';
import { Icon } from '../components/ui/Icon';
import type { IconName } from '../components/ui/Icon';

/**
 * Teach — "help CIP understand our brand".
 * Deliberately free of anything technical: no confidence scores, no graph,
 * no model talk. Just what we know, what we are missing and what that unlocks.
 */
export function TeachSection() {
  const workspace = useWorkspace();
  const { note: onNote } = useToast();
  const bb = workspace.brandBrain;
  const [answered, setAnswered] = useState<string[]>([]);

  const pending = bb.confirmations.filter((c) => !answered.includes(c.id));

  return (
    <div className="rise">
      <header className="page-head">
        <p className="eyebrow">Teach</p>
        <h1>Your brand, in our hands</h1>
        <p className="lede">
          The more we understand about {workspace.name}, the better and faster everything we make for you gets.
        </p>
      </header>

      <section className="teach-hero">
        <div>
          <div className="row" style={{ alignItems: 'baseline' }}>
            <span className="big-pct">{bb.understanding}%</span>
            <span className="pct-word">understood</span>
          </div>
          <p className="pct-note">{bb.note}</p>
          <div style={{ marginTop: 20, maxWidth: 480 }}>
            <Progress value={bb.understanding} goal={bb.unlockAt} />
            <p className="tiny muted" style={{ marginTop: 8 }}>
              The marker shows {bb.unlockAt}% — where paid campaigns unlock.
            </p>
          </div>
        </div>
        <div>
          <p className="unlock-title">What your progress unlocks</p>
          <div className="unlock-list">
            {bb.unlocks.map((u) => {
              const open = bb.understanding >= u.at;
              return (
                <div className={`unlock ${open ? 'open' : ''}`} key={u.label}>
                  <Icon name={open ? 'unlock' : 'lock'} size={15} />
                  <span className="u-label">{u.label}</span>
                  <span className="u-at">{open ? 'Available' : `at ${u.at}%`}</span>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      <div className="sec-head">
        <div>
          <h2>Waiting for you</h2>
          <p className="hint">A few quick answers move your brand understanding forward the fastest.</p>
        </div>
      </div>

      <Card>
        {pending.length === 0 ? (
          <EmptyState
            icon="check"
            title="Nothing needs your answer right now"
            copy="We will ask here whenever something about your brand is unclear. Add assets or guidelines any time to move faster."
          />
        ) : (
          pending.map((c) => (
            <div className="confirm-row" key={c.id}>
              <span className="stack grow">
                <span className="cr-q">{c.question}</span>
                <span className="cr-a">{c.context}</span>
              </span>
              <span className="cr-actions">
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => {
                    setAnswered((a) => [...a, c.id]);
                    onNote(`Saved: ${c.suggestion}`);
                  }}
                >
                  {c.suggestion}
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => onNote('We will ask again later')}>
                  Not quite
                </button>
              </span>
            </div>
          ))
        )}
      </Card>

      <div className="sec-head">
        <div>
          <h2>What we know so far</h2>
          <p className="hint">Everything here came from you. Add to any of it whenever you like.</p>
        </div>
      </div>

      <div className="teach-grid">
        {bb.topics.map((t) => (
          <article className="card teach-card" key={t.id}>
            <div className="tc-top">
              <span className="tc-icon"><Icon name={t.icon as IconName} size={19} /></span>
              <h3>{t.title}</h3>
            </div>
            <p className="tc-copy">{t.blurb}</p>
            <div className="tc-items">
              {t.items.map((i) => (
                <span className={`tc-item ${i.done ? '' : 'pending'}`} key={i.label}>
                  {i.done ? <Icon name="check" size={15} className="tick" /> : <Icon name="plus" size={15} className="todo" />}
                  {i.label}
                </span>
              ))}
            </div>
            <div className="tc-foot">
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => onNote(`${t.cta} — coming next`)}>
                {t.cta} <Icon name="arrow-right" size={14} />
              </button>
            </div>
          </article>
        ))}
      </div>

      <div className="sec-head">
        <div>
          <h2>How you sound</h2>
          <p className="hint">We match this on every line of copy we write for you.</p>
        </div>
      </div>

      <Card className="pad">
        <div className="voice-grid">
          <div className="voice-col yes">
            <p className="vc-head"><Icon name="check" size={15} /> {workspace.name} sounds like</p>
            {bb.voice.sounds.map((s) => (
              <p className="voice-line" key={s}>{s}</p>
            ))}
          </div>
          <div className="voice-col no">
            <p className="vc-head"><Icon name="x" size={15} /> {workspace.name} never sounds like</p>
            {bb.voice.neverSounds.map((s) => (
              <p className="voice-line" key={s}>{s}</p>
            ))}
          </div>
        </div>
        <div style={{ marginTop: 26 }}>
          <p className="unlock-title">Your colours</p>
          <div className="swatches">
            {bb.palette.map((p) => (
              <span className="swatch-chip" key={p.hex}>
                <i style={{ background: p.hex }} />
                <span>{p.name}</span>
              </span>
            ))}
          </div>
        </div>
      </Card>
    </div>
  );
}
