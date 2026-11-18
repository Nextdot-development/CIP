'use client';

import { useMemo, useState } from 'react';
import { Icon } from '../components/ui/Icon';
import { useToast } from '@/context/toast';
import { assetUrl } from '@/types/media';

export type RuleVerdict = {
  status: 'passed' | 'broke' | 'look' | 'not-for-this';
  why: string;
  rule: { id: string; code: string | null; domain: string | null; severity: string | null; rule: string };
};
export type RulesSummary = { broke: number; passed: number; look: number };

const countOf = (verdicts: RuleVerdict[]): RulesSummary => ({
  broke: verdicts.filter((v) => v.status === 'broke').length,
  passed: verdicts.filter((v) => v.status === 'passed').length,
  look: verdicts.filter((v) => v.status === 'look').length,
});

/**
 * A check against the rules, as a reviewer reads it: what is broken and why, what to look at for
 * yourself (ticked as you go), and - folded away - what passed. Made with no model.
 */
export function RulesReport({ title, verdicts, note }: { title: string; verdicts: RuleVerdict[]; note?: string }) {
  const [looked, setLooked] = useState<Set<string>>(new Set());
  const [showPassed, setShowPassed] = useState(false);
  const of = (s: RuleVerdict['status']) => verdicts.filter((v) => v.status === s);
  const broke = of('broke'); const look = of('look'); const passed = of('passed'); const notHere = of('not-for-this');
  return (
    <div className="rules-qc-report">
      <p className="strong" style={{ margin: 0 }}>
        {title}:{' '}
        {broke.length ? <span className="rules-qc-bad">{broke.length} broken</span> : <span className="rules-qc-good">nothing broken</span>}
        {' · '}{passed.length} passed · {look.length} to look at ({looked.size} done)
        {notHere.length ? <span className="muted"> · {notHere.length} not for this kind of creative</span> : null}
      </p>
      {note && <p className="tiny muted" style={{ margin: 0 }}>{note}</p>}

      {broke.length > 0 && (
        <ul className="rules-qc-list">
          {broke.map((v) => (
            <li key={v.rule.id} className="is-bad">
              <Icon name="alert" size={14} />
              <span><strong>{v.why}</strong><br /><span className="tiny muted">{v.rule.rule}{v.rule.code ? ` · ${v.rule.code}` : ''}</span></span>
            </li>
          ))}
        </ul>
      )}

      {look.length > 0 && (
        <>
          <p className="groundedlabel">Look at it yourself</p>
          <ul className="rules-qc-list">
            {look.map((v) => (
              <li key={v.rule.id}>
                <label className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
                  <input
                    type="checkbox"
                    checked={looked.has(v.rule.id)}
                    onChange={(e) => setLooked((s) => { const n = new Set(s); if (e.target.checked) n.add(v.rule.id); else n.delete(v.rule.id); return n; })}
                  />
                  <span>{v.rule.rule}{/^(The bottle|Its words|Look at the (logo|pack))/.test(v.why) ? <><br /><span className="tiny muted">{v.why}</span></> : null}</span>
                </label>
              </li>
            ))}
          </ul>
        </>
      )}

      {passed.length > 0 && (
        <>
          <button type="button" className="btn btn-ghost btn-sm" style={{ justifySelf: 'start' }} onClick={() => setShowPassed(!showPassed)}>
            {showPassed ? 'Hide' : 'Show'} the {passed.length} passed
          </button>
          {showPassed && (
            <ul className="rules-qc-list">
              {passed.map((v) => (
                <li key={v.rule.id} className="is-good">
                  <Icon name="check" size={14} />
                  <span>{v.why}<br /><span className="tiny muted">{v.rule.rule}</span></span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

/** What a card says at a glance: broken, or nothing broken and how many to look at. */
function Badge({ s }: { s: RulesSummary }) {
  return s.broke
    ? <span className="rules-qc-badge is-bad"><Icon name="alert" size={11} /> {s.broke} broken · {s.look} to look</span>
    : <span className="rules-qc-badge is-good"><Icon name="check" size={11} /> Nothing broken · {s.look} to look</span>;
}

/**
 * Posts made in CIP's studio, each already checked against its brand's and market's rules from
 * what it is made of - the logo, the words, the bottle - with no model and nothing spent. Open one
 * for what broke, what to look at, and what passed.
 */
export function PostRulesCheck({ posts }: { posts: { id: string; prompt: string; brand: string; market: string | null; verdicts: RuleVerdict[] }[] }) {
  const { note } = useToast();
  const [open, setOpen] = useState<string | null>(null);
  const summaries = useMemo(() => new Map(posts.map((p) => [p.id, countOf(p.verdicts)])), [posts]);
  if (!posts.length) return null;
  const chosen = posts.find((p) => p.id === open) ?? null;

  return (
    <section className="rules-qc" aria-label="Posts made in CIP, checked against the rules">
      <div className="rules-qc-head">
        <div>
          <p className="eyebrow" style={{ margin: 0 }}>Posts made in CIP</p>
          <h2 style={{ margin: '2px 0 4px' }}>Checked against the rules - free</h2>
          <p className="tiny muted" style={{ margin: 0 }}>
            CIP set every piece of these posts itself, so it answers the rules on the logo, the words and the bottle exactly - no AI, nothing spent.
            What the painted background shows is a list for you to look at. Click a post for the details.
          </p>
        </div>
        <span className="rules-qc-free">Free · no AI</span>
      </div>

      <div className="rules-qc-posts">
        {posts.map((p) => (
          <button
            key={p.id}
            type="button"
            className={`rules-qc-post ${open === p.id ? 'is-on' : ''}`}
            onClick={() => { setOpen(open === p.id ? null : p.id); if (!p.verdicts.length) note('No rules apply to this post\'s brand and market yet.'); }}
            title={p.prompt}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={assetUrl(p.id)} alt="" loading="lazy" />
            <Badge s={summaries.get(p.id)!} />
            <span>{p.prompt.slice(0, 48)}{p.prompt.length > 48 ? '…' : ''}</span>
          </button>
        ))}
      </div>

      {chosen && <RulesReport title={`${chosen.brand}${chosen.market ? ` · ${chosen.market}` : ''}`} verdicts={chosen.verdicts} />}
    </section>
  );
}
