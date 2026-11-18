'use client';

import { useState } from 'react';
import { Icon } from '../components/ui/Icon';
import { useToast } from '@/context/toast';
import { useAskSeed } from '@/context/NavContext';
import { useWorkspace } from '@/context/workspace';
import type { ClientBrief } from '@/server/brain/clientBriefs';

/**
 * The briefs the client sent, newest first: what each asks to be made, at what size, and the files
 * that came with it. "Start" puts one piece in the composer below - the request written out, the
 * shape and market chosen - so a brief becomes a first visual without being typed out again.
 */
export function ClientBriefs({ briefs }: { briefs: ClientBrief[] }) {
  const company = useWorkspace().name;
  const { note } = useToast();
  const { setSeed } = useAskSeed();
  const [open, setOpen] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  if (!briefs.length) return null;
  const shown = all ? briefs : briefs.slice(0, 4);

  const start = (brief: ClientBrief, piece: ClientBrief['deliverables'][number]) => {
    // The brand the piece names, else the brief's only one; a piece for several is left to choose.
    const named = brief.brands.filter((b) => piece.what.toLowerCase().includes(b.toLowerCase()));
    const brand = named.length === 1 ? named[0]! : brief.brands.length === 1 ? brief.brands[0]! : null;
    setSeed({ text: piece.request, mode: 'instant', shape: piece.ratio ?? null, market: brief.market, brand });
    document.querySelector('.composer')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    note('Added to the request below. Look it over, then make it.');
  };

  return (
    <section className="cbriefs" aria-label={`Briefs from ${company}`}>
      <div className="cbriefs-head">
        <p className="groundedlabel" style={{ margin: 0 }}>Briefs from {company}</p>
        <span className="tiny muted">{briefs.length} briefs · from their emails, filed in Drive</span>
      </div>
      <div className="cbriefs-list">
        {shown.map((b) => {
          const isOpen = open === b.id;
          return (
            <article key={b.id} className={`cbrief ${isOpen ? 'is-open' : ''}`}>
              <button type="button" className="cbrief-top" onClick={() => setOpen(isOpen ? null : b.id)} aria-expanded={isOpen}>
                <span className="cbrief-title">{b.title}</span>
                <span className="cbrief-meta">
                  {[b.market, b.date && new Date(b.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }), `${b.deliverables.length} to make`]
                    .filter(Boolean).join(' · ')}
                </span>
                <Icon name="chevron-down" size={14} />
              </button>
              {isOpen && (
                <div className="cbrief-body">
                  {b.from && <p className="tiny muted" style={{ margin: 0 }}>From {b.from}</p>}
                  {b.brands.length > 0 && (
                    <div className="groundedtags">{b.brands.map((x) => <span key={x} className="gtag">{x}</span>)}</div>
                  )}
                  <ul className="cbrief-pieces">
                    {b.deliverables.map((d, i) => (
                      <li key={i}>
                        <span>
                          {d.what}
                          {(d.size || d.ratio) && <span className="cbrief-size">{d.size ?? d.ratio}</span>}
                        </span>
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => start(b, d)}>Start</button>
                      </li>
                    ))}
                  </ul>
                  {b.notes.length > 0 && (
                    <>
                      <p className="groundedlabel">The brief says</p>
                      <ul className="cbrief-notes">{b.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
                    </>
                  )}
                  {b.skus.length > 0 && (
                    <>
                      <p className="groundedlabel">Products</p>
                      <ul className="cbrief-notes">{b.skus.map((n, i) => <li key={i}>{n}</li>)}</ul>
                    </>
                  )}
                  {b.files.length > 0 && (
                    <>
                      <p className="groundedlabel">Sent with it</p>
                      <div className="groundedtags">
                        {b.files.map((f) => (
                          <a key={f.id} className="gtag" href={`/api/drive/files/${f.id}/content`} target="_blank" rel="noreferrer" title={f.note ?? f.name}>
                            {f.name}
                          </a>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              )}
            </article>
          );
        })}
      </div>
      {briefs.length > 4 && (
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAll(!all)}>
          {all ? 'Fewer' : `All ${briefs.length} briefs`}
        </button>
      )}
    </section>
  );
}
