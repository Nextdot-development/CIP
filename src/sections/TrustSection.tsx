import { useMemo, useState } from 'react';
import { useTenant } from '../context/tenantStore';
import { useNav } from '../context/NavContext';
import { Card, EmptyState, Pill, StatusPill } from '../components/ui/Bits';
import { Icon } from '../components/ui/Icon';
import type { WorkItem } from '../data/types';

type Tab = 'all' | 'blocked' | 'review' | 'progress' | 'done';

const TABS: { id: Tab; label: string }[] = [
  { id: 'all', label: 'Everything' },
  { id: 'blocked', label: 'Cannot ship' },
  { id: 'review', label: 'Needs approval' },
  { id: 'progress', label: 'In progress' },
  { id: 'done', label: 'Completed' },
];

const MATCH: Record<Tab, (w: WorkItem) => boolean> = {
  all: () => true,
  blocked: (w) => w.status === 'blocked',
  review: (w) => w.status === 'in_review',
  progress: (w) => w.status === 'in_progress',
  done: (w) => w.status === 'completed',
};

/** Red only ever means "this cannot be shipped". */
function edge(w: WorkItem) {
  if (w.status === 'blocked') return 'stop';
  if (w.status === 'in_review') return 'warn';
  if (w.status === 'completed') return 'ok';
  return 'busy';
}

export function TrustSection({ onNote }: { onNote: (s: string) => void }) {
  const { tenant } = useTenant();
  const { go } = useNav();
  const [tab, setTab] = useState<Tab>('all');
  const t = tenant.trust;

  const counts = useMemo(
    () => ({
      all: t.work.length,
      blocked: t.work.filter(MATCH.blocked).length,
      review: t.work.filter(MATCH.review).length,
      progress: t.work.filter(MATCH.progress).length,
      done: t.work.filter(MATCH.done).length,
    }),
    [t.work],
  );

  const shown = t.work.filter(MATCH[tab]);
  const expiring = t.rights.filter((r) => r.daysLeft <= 30);

  return (
    <div className="rise">
      <header className="page-head">
        <p className="eyebrow">Trust</p>
        <h1>Everything is checked, tracked and improving</h1>
        <p className="lede">
          Where your work stands, what is holding anything up, and what we have learned about {tenant.name} this month.
        </p>
      </header>

      <div className="trust-summary">
        <div className={`tsum ${counts.blocked > 0 ? 'is-stop' : ''}`}>
          <p className="ts-value">{counts.blocked}</p>
          <p className="ts-label">
            {counts.blocked === 0 ? 'Nothing is blocked. Everything can ship.' : 'Cannot be shipped until fixed'}
          </p>
        </div>
        <div className={`tsum ${counts.review > 0 ? 'is-warn' : ''}`}>
          <p className="ts-value">{counts.review}</p>
          <p className="ts-label">Waiting on an approval from your side</p>
        </div>
        <div className="tsum">
          <p className="ts-value">{counts.progress}</p>
          <p className="ts-label">Being made by your pod right now</p>
        </div>
        <div className="tsum">
          <p className="ts-value">{counts.done}</p>
          <p className="ts-label">Delivered and cleared this month</p>
        </div>
      </div>

      <div className="sec-head">
        <div>
          <h2>Your work</h2>
          <p className="hint">Every item says plainly where it is and what it needs.</p>
        </div>
      </div>

      <div className="tabs" role="tablist">
        {TABS.map((x) => (
          <button
            key={x.id}
            type="button"
            role="tab"
            aria-selected={tab === x.id}
            className={`tab ${tab === x.id ? 'on' : ''}`}
            onClick={() => setTab(x.id)}
          >
            {x.label} <span className="n">{counts[x.id]}</span>
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <Card>
          <EmptyState
            icon="sparkle"
            title="Nothing in this list — which is good news"
            copy="When you have work at this stage it appears here, with the reason in plain language."
            action={
              <button type="button" className="btn btn-primary btn-sm" onClick={() => go('ask')}>
                Create something
              </button>
            }
          />
        </Card>
      ) : (
        shown.map((w) => (
          <article className={`work-item ${edge(w)}`} key={w.id}>
            <span className="stack grow">
              <span className="spread">
                <span className="wi-title">{w.title}</span>
                <StatusPill status={w.status} />
              </span>
              <span className="wi-meta">{w.meta}</span>

              {w.reason && (
                <span className={`wi-reason ${w.reason.tone}`}>
                  <Icon name={w.reason.tone === 'stop' ? 'alert' : w.reason.tone === 'warn' ? 'clock' : 'check'} size={16} />
                  <span>{w.reason.text}</span>
                </span>
              )}

              {w.fixes && (
                <span className="wi-fix">
                  {w.fixes.map((f, i) => (
                    <button
                      key={f}
                      type="button"
                      className={`btn btn-sm ${i === 0 ? 'btn-primary' : 'btn-ghost'}`}
                      onClick={() => onNote(`${f} — your pod has been told`)}
                    >
                      {f}
                    </button>
                  ))}
                </span>
              )}

              {w.owner && (
                <span className="wi-people">
                  <Icon name="people" size={14} /> With {w.owner}
                </span>
              )}
            </span>
          </article>
        ))
      )}

      <div className="sec-head">
        <div>
          <h2>Rights and licences</h2>
          <p className="hint">What you are allowed to use, and until when.</p>
        </div>
      </div>

      <Card>
        {t.rights.map((r) => (
          <div className="rights-row" key={r.id}>
            <span className="stack grow">
              <span className="rr-title">{r.title}</span>
              <span className="rr-note">{r.note}</span>
            </span>
            {r.daysLeft <= 14 ? (
              <Pill tone="warn">Expires in {r.daysLeft} days</Pill>
            ) : r.daysLeft <= 60 ? (
              <Pill tone="neutral">{r.daysLeft} days left</Pill>
            ) : (
              <Pill tone="ok">Valid</Pill>
            )}
          </div>
        ))}
        {expiring.length > 0 && (
          <p className="tiny muted" style={{ marginTop: 12 }}>
            We will remind you two weeks before anything expires, so nothing you have published has to come down.
          </p>
        )}
      </Card>

      <ChecksAndLearnings />
    </div>
  );
}

function ChecksAndLearnings() {
  const { tenant } = useTenant();
  const t = tenant.trust;

  return (
    <>
      <div className="sec-head">
        <div>
          <h2>Brand and compliance checks</h2>
          <p className="hint">Run on everything before it reaches you. Nothing skips this.</p>
        </div>
      </div>

      <Card>
        {t.checks.map((c) => (
          <div className="check-row" key={c.id}>
            <span
              style={{
                width: 28,
                height: 28,
                borderRadius: 9,
                display: 'grid',
                placeItems: 'center',
                flex: '0 0 auto',
                background:
                  c.state === 'pass' ? 'var(--ok-050)' : c.state === 'attention' ? 'var(--warn-050)' : 'var(--stop-050)',
                color:
                  c.state === 'pass' ? 'var(--ok-700)' : c.state === 'attention' ? 'var(--warn-700)' : 'var(--stop-700)',
              }}
            >
              <Icon name={c.state === 'pass' ? 'check' : c.state === 'attention' ? 'clock' : 'alert'} size={15} />
            </span>
            <span className="stack grow">
              <span className="cr-name">{c.name}</span>
              <span className="cr-note">{c.note}</span>
            </span>
            {c.state === 'pass' && <Pill tone="ok">Cleared</Pill>}
            {c.state === 'attention' && <Pill tone="warn">Needs attention</Pill>}
            {c.state === 'fail' && <Pill tone="stop">Cannot ship</Pill>}
          </div>
        ))}
      </Card>

      <div className="sec-head">
        <div>
          <h2>What we learned this month</h2>
          <p className="hint">Every insight here already changes how we work for you.</p>
        </div>
      </div>

      <div className="home-grid" style={{ marginTop: 0 }}>
        <Card>
          {t.learnings.map((l) => (
            <div className="learn-row" key={l.id}>
              <span className="lr-icon">
                <Icon name="sparkle" size={16} />
              </span>
              <span className="stack grow">
                <span className="lr-text">{l.text}</span>
                <span className="lr-effect">{l.effect}</span>
              </span>
            </div>
          ))}
        </Card>

        <Card title="What this month cost">
          <p className="ts-value" style={{ fontSize: 30, fontWeight: 700, color: 'var(--ink-900)', letterSpacing: '-0.03em' }}>
            {t.cost.total}
          </p>
          <p className="small muted" style={{ margin: '6px 0 16px' }}>
            {t.cost.note}
          </p>

          <div className="cost-bar">
            {t.cost.split.map((s) => (
              <i key={s.label} style={{ width: `${s.pct}%`, background: s.color }} title={`${s.label} — ${s.amount}`} />
            ))}
          </div>

          <div className="cost-legend">
            {t.cost.split.map((s) => (
              <span className="cl" key={s.label}>
                <span className="swatch" style={{ background: s.color }} />
                {s.label}
                <b className="strong">{s.amount}</b>
              </span>
            ))}
          </div>
        </Card>
      </div>
    </>
  );
}
