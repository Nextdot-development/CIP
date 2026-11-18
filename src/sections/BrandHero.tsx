'use client';

import { useState, type CSSProperties } from 'react';
import { Icon } from '../components/ui/Icon';
import { useToast } from '@/context/toast';
import type { ProductBrainDTO } from '@/server/brain/productBrain';
import type { OpenQuestion } from '@/server/brain/questions';

/**
 * A brand at a glance, at the top of its Brand Brain: its name in its own
 * colours and how it sounds, then four plain cards - how its posts look, what
 * it says, what it pours, and where and when. Each is read from what CIP holds
 * and left plainly empty where it holds nothing.
 */
export function BrandHero({ product, reportHref }: { product: ProductBrainDTO; reportHref: string }) {
  const { note } = useToast();
  const id = product.identity;
  const [a, b] = [id.palette[0]?.hex, id.palette[1]?.hex ?? id.palette[0]?.hex];
  // The card takes the brand's own colours for its accent; the house's, when there are none.
  const style = { ...(a ? { '--b1': a } : {}), ...(b ? { '--b2': b } : {}) } as CSSProperties;
  const share = Math.round((product.covered / 6) * 100);

  const copy = (hex: string) => {
    void navigator.clipboard?.writeText(hex).then(() => note(`${hex} copied`), () => undefined);
  };

  return (
    <>
      <section className="bh" style={style} aria-label={`${product.brand ?? 'All brands'} at a glance`}>
        <div className="bh-top">
          <div className="bh-id">
            <p className="eyebrow">Brand Brain</p>
            <h1 className="bh-name">{product.brand ?? 'All brands'}</h1>
            <p className="bh-note">
              {id.note ?? (product.brand
                ? 'Everything CIP has learned about this brand, in one place.'
                : 'Choose a brand in the sidebar to see one on its own.')}
            </p>
            {(id.tone.length > 0 || id.social) && (
              <div className="bh-tone" aria-label="How it sounds">
                {id.tone.map((t) => <span key={t} className="bh-chip is-tone">{t}</span>)}
                {id.social && <span className="bh-chip is-social">{id.social}</span>}
              </div>
            )}
          </div>

          <div className="bh-meter">
            <div className="bh-progress" role="img" aria-label={`${product.covered} of 6 areas known`}>
              <div className="bh-progress-head"><b>{product.covered}</b> of 6 areas known</div>
              <div className="bh-bar"><i style={{ width: `${share}%` }} /></div>
            </div>
            <dl className="bh-stats">
              <div><dt>Files</dt><dd>{product.assets.toLocaleString('en-IN')}</dd></div>
              <div><dt>Facts</dt><dd>{product.facts.toLocaleString('en-IN')}</dd></div>
              {product.updatedAgo && <div><dt>Updated</dt><dd>{product.updatedAgo}</dd></div>}
            </dl>
            <a className="exportbtn" href={reportHref} download>
              <Icon name="download" size={14} /> Download report
            </a>
          </div>
        </div>
      </section>

      <div className="bb-grid" style={style}>
        <section className="bb-card is-wide" aria-label="How its posts look">
          <h2 className="bb-h"><Icon name="image" size={15} /> How its posts look</h2>
          {id.palette.length > 0 && (
            <div className="bh-swatches">
              {id.palette.map((p) => (
                <button key={p.hex} type="button" className="bh-swatch" onClick={() => copy(p.hex)} title={`Copy ${p.hex}`}>
                  <span className="bh-swatch-chip" style={{ background: p.hex }} />
                  <span className="bh-swatch-hex">{p.hex}</span>
                </button>
              ))}
            </div>
          )}
          {id.look.length || id.fonts.length ? (
            <dl className="bb-rows">
              {id.look.map((l) => (
                <div key={l.label}><dt>{l.label}</dt><dd>{l.value}</dd></div>
              ))}
              {id.fonts.length > 0 && <div><dt>Type</dt><dd>{id.fonts.join(' · ')}</dd></div>}
            </dl>
          ) : !id.palette.length && <p className="bh-empty">Nothing learned about its look yet.</p>}
        </section>

        <section className="bb-card" aria-label="What it says">
          <h2 className="bb-h"><Icon name="megaphone" size={15} /> What it says</h2>
          {id.lines.length ? (
            <ul className="bh-lines">
              {id.lines.map((l) => <li key={l}>{l}</li>)}
            </ul>
          ) : <p className="bh-empty">No lines learned yet.</p>}
        </section>

        <section className="bb-card" aria-label="What it pours">
          <h2 className="bb-h"><Icon name="box" size={15} /> Packs and serve</h2>
          {id.variants.length > 0 && (
            <div className="bh-chips">{id.variants.map((v) => <span key={v} className="bh-chip">{v}</span>)}</div>
          )}
          {id.serve && <p className="bb-text">{id.serve}</p>}
          {!id.variants.length && !id.serve && <p className="bh-empty">No packs named yet.</p>}
        </section>

        <section className="bb-card is-wide" aria-label="Where and when">
          <h2 className="bb-h"><Icon name="compass" size={15} /> Where and when</h2>
          <dl className="bb-rows">
            <div>
              <dt>Sold in</dt>
              <dd>{id.markets.length
                ? <span className="bh-chips is-inline">{id.markets.map((m) => <span key={m} className="bh-chip is-market">{m}</span>)}</span>
                : <span className="bh-empty is-inline">No markets yet.</span>}</dd>
            </div>
            {id.occasions.length > 0 && (
              <div>
                <dt>Occasions</dt>
                <dd><span className="bh-chips is-inline">{id.occasions.map((o) => <span key={o} className="bh-chip">{o}</span>)}</span></dd>
              </div>
            )}
            {id.awards.length > 0 && (
              <div><dt>Awards</dt><dd>{id.awards.join(' · ')}</dd></div>
            )}
          </dl>
        </section>
      </div>
    </>
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
