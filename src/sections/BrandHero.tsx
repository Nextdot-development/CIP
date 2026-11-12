'use client';

import { useState, type CSSProperties } from 'react';
import { Icon } from '../components/ui/Icon';
import { useToast } from '@/context/toast';
import type { ProductBrainDTO } from '@/server/brain/productBrain';
import type { OpenQuestion } from '@/server/brain/questions';

/**
 * A brand at a glance, at the top of its Brand Brain: its name in its own
 * colours, how it sounds, how much of its DNA CIP has, and then its colours,
 * lines, type, packs and markets - each read from what CIP holds, each left
 * plainly empty where it holds nothing.
 */
export function BrandHero({ product, reportHref }: { product: ProductBrainDTO; reportHref: string }) {
  const { note } = useToast();
  const id = product.identity;
  const [a, b] = [id.palette[0]?.hex, id.palette[1]?.hex ?? id.palette[0]?.hex];
  // The card takes the brand's own colours for its glow; the house's, when there are none.
  const style = { ...(a ? { '--b1': a } : {}), ...(b ? { '--b2': b } : {}) } as CSSProperties;
  const share = product.covered / 6;

  const copy = (hex: string) => {
    void navigator.clipboard?.writeText(hex).then(() => note(`${hex} copied`), () => undefined);
  };

  return (
    <section className="bh" style={style} aria-label={`${product.brand ?? 'All brands'} at a glance`}>
      <div className="bh-top">
        <div className="bh-id">
          <p className="eyebrow">Product Brain</p>
          <h1 className="bh-name">{product.brand ?? 'All brands'}</h1>
          <p className="bh-note">
            {id.note ?? (product.brand
              ? 'Everything CIP has learned about this brand, mapped and connected.'
              : 'Choose a brand in the sidebar to see one on its own.')}
          </p>
          {id.tone.length > 0 && (
            <div className="bh-tone" aria-label="How it sounds">
              {id.tone.map((t) => <span key={t} className="bh-chip is-tone">{t}</span>)}
            </div>
          )}
        </div>

        <div className="bh-meter">
          <div className="bh-ring" role="img" aria-label={`${product.covered} of 6 DNA areas covered`}>
            <svg viewBox="0 0 120 120" width="132" height="132" aria-hidden="true">
              <defs>
                <linearGradient id="bh-ring-ink" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0%" stopColor="var(--b1, var(--brand))" />
                  <stop offset="100%" stopColor="var(--b2, var(--brand-deep))" />
                </linearGradient>
              </defs>
              <circle cx="60" cy="60" r="50" className="bh-ring-track" />
              <circle
                cx="60" cy="60" r="50" className="bh-ring-fill"
                strokeDasharray={`${(2 * Math.PI * 50 * share).toFixed(1)} ${(2 * Math.PI * 50).toFixed(1)}`}
              />
            </svg>
            <span className="bh-ring-text"><b>{product.covered}</b><small>of 6 areas</small></span>
          </div>
          <dl className="bh-stats">
            <div><dt>Assets</dt><dd>{product.assets.toLocaleString('en-IN')}</dd></div>
            <div><dt>Patterns</dt><dd>{product.facts.toLocaleString('en-IN')}</dd></div>
            {product.updatedAgo && <div><dt>Learned</dt><dd>{product.updatedAgo}</dd></div>}
          </dl>
          <a className="exportbtn" href={reportHref} download>
            <Icon name="download" size={14} /> Brand DNA report
          </a>
        </div>
      </div>

      <div className="bh-grid">
        <div className="bh-tile">
          <span className="bh-k"><Icon name="palette" size={14} /> Colours</span>
          {id.palette.length ? (
            <div className="bh-swatches">
              {id.palette.map((p) => (
                <button key={p.hex} type="button" className="bh-swatch" onClick={() => copy(p.hex)} title={`Copy ${p.hex}`}>
                  <span className="bh-swatch-chip" style={{ background: p.hex }} />
                  <span className="bh-swatch-hex">{p.hex}</span>
                </button>
              ))}
            </div>
          ) : <p className="bh-empty">No colours learned yet.</p>}
        </div>

        <div className="bh-tile is-wide">
          <span className="bh-k"><Icon name="megaphone" size={14} /> What it says</span>
          {id.lines.length ? (
            <ul className="bh-lines">
              {id.lines.map((l) => <li key={l}>{l}</li>)}
            </ul>
          ) : <p className="bh-empty">No lines learned yet - its campaign lines appear here as CIP reads them.</p>}
        </div>

        <div className="bh-tile">
          <span className="bh-k"><Icon name="doc" size={14} /> Type</span>
          {id.fonts.length ? (
            <ul className="bh-fonts">
              {id.fonts.map((f, i) => <li key={f} className={i === 0 ? 'is-lead' : ''}>{f}</li>)}
            </ul>
          ) : <p className="bh-empty">No type learned yet.</p>}
        </div>

        <div className="bh-tile is-wide">
          <span className="bh-k"><Icon name="box" size={14} /> Packs</span>
          {id.variants.length ? (
            <div className="bh-chips">{id.variants.map((v) => <span key={v} className="bh-chip">{v}</span>)}</div>
          ) : <p className="bh-empty">No packs named yet.</p>}
        </div>

        <div className="bh-tile is-wide">
          <span className="bh-k"><Icon name="compass" size={14} /> Sold in</span>
          {id.markets.length ? (
            <div className="bh-chips">{id.markets.map((m) => <span key={m} className="bh-chip is-market">{m}</span>)}</div>
          ) : <p className="bh-empty">No markets yet.</p>}
        </div>
      </div>
    </section>
  );
}

/** The newest things CIP learned about the brand, as a strip to glance along. */
export function JustLearned({ recent }: { recent: ProductBrainDTO['identity']['recent'] }) {
  if (!recent.length) return null;
  return (
    <section className="bh-recent" aria-label="Just learned">
      <div className="bh-recent-head">
        <span className="bh-pulse" aria-hidden="true" />
        <h2>Just learned</h2>
      </div>
      <div className="bh-recent-row">
        {recent.map((r, i) => (
          <article key={`${r.attribute}-${i}`} className="bh-fact">
            <span className="bh-fact-k">{r.attribute}</span>
            <p>{r.value}</p>
            <span className="bh-fact-ago">{r.ago}</span>
          </article>
        ))}
      </div>
    </section>
  );
}

/** What CIP could not settle on its own, put to a person - with what it would suggest. */
export function OpenQuestions({ initial }: { initial: OpenQuestion[] }) {
  const { note } = useToast();
  const [questions, setQuestions] = useState(initial);
  const [writing, setWriting] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  if (!questions.length) return null;

  const answer = async (q: OpenQuestion, text: string) => {
    setBusy(q.id);
    const res = await fetch(`/api/brain/questions/${q.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answer: text }),
    }).catch(() => null);
    setBusy(null);
    if (!res?.ok) {
      const message = (await res?.json().catch(() => null) as { message?: string } | null)?.message;
      note(message ?? 'That answer could not be saved.');
      return;
    }
    setQuestions((all) => all.filter((x) => x.id !== q.id));
    note('Answer kept - thank you');
  };

  return (
    <section className="bh-questions" aria-label="CIP would like to check">
      <div className="bh-recent-head">
        <Icon name="help" size={16} />
        <h2>CIP would like to check</h2>
        <span className="bh-count">{questions.length}</span>
      </div>
      <div className="bh-q-grid">
        {questions.map((q) => {
          const draft = writing[q.id];
          return (
            <article key={q.id} className="bh-q">
              <p className="bh-q-title">{q.question}</p>
              <p className="bh-q-context">{q.context}</p>
              <p className="bh-q-suggest"><Icon name="sparkle" size={13} /> {q.suggestion}</p>
              {draft === undefined ? (
                <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                  <button type="button" className="btn btn-primary btn-sm" disabled={busy === q.id} onClick={() => void answer(q, q.suggestion)}>
                    <Icon name="check" size={14} /> That&apos;s right
                  </button>
                  <button type="button" className="btn btn-ghost btn-sm" disabled={busy === q.id} onClick={() => setWriting((w) => ({ ...w, [q.id]: '' }))}>
                    Answer differently
                  </button>
                </div>
              ) : (
                <div className="stack" style={{ gap: 8 }}>
                  <textarea
                    className="field-input"
                    rows={2}
                    maxLength={500}
                    autoFocus
                    value={draft}
                    onChange={(e) => setWriting((w) => ({ ...w, [q.id]: e.target.value }))}
                    placeholder="What is right?"
                    aria-label={`Your answer to: ${q.question}`}
                  />
                  <div className="row" style={{ gap: 8 }}>
                    <button type="button" className="btn btn-primary btn-sm" disabled={busy === q.id || !draft.trim()} onClick={() => void answer(q, draft)}>
                      Save answer
                    </button>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => setWriting((w) => { const n = { ...w }; delete n[q.id]; return n; })}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}
