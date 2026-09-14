'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { EmptyState, Pill } from '../components/ui/Bits';
import { Icon } from '../components/ui/Icon';
import { useToast } from '@/context/toast';
import type { ComplianceRule, CreativeCheck, CheckFlag, Learned } from '@/server/brain/checker';

/**
 * The Consistency & Compliance Checker.
 *
 * A reviewer picks a creative, CIP scores it against what it has learned about
 * the brand and against the rules the market has to obey, and every flag says
 * which of those it came from. The summary comes before the detail - a
 * reviewer needs to know whether it can ship before they need to know why.
 *
 * Two things this screen will not do. It will not show a score without saying
 * how much the score stands on: a hundred against no rules is not a pass. And
 * it will not let a flag stand unchallenged: every open flag carries
 * "Disagree? Correct this", because a brain that cannot be corrected drifts.
 */

type ImageOption = { id: string; name: string; brand: string | null; market: string | null };
type RecentCheck = Omit<CreativeCheck, 'flags'>;

type Tone = 'ok' | 'warn' | 'stop' | 'neutral';

/** Whether it can ship, read off the flags that still stand. */
function verdictFor(check: CreativeCheck): { tone: Tone; label: string } {
  if (check.status === 'failed') return { tone: 'stop', label: 'Check failed' };
  if (check.score === null) return { tone: 'neutral', label: 'Nothing to judge against' };
  const blocking = check.flags.some(
    (f) => f.status !== 'disputed' && f.dimension === 'compliance' && f.severity === 'critical',
  );
  if (blocking) return { tone: 'stop', label: 'Cannot ship' };
  if (check.score >= 80) return { tone: 'ok', label: 'Ready' };
  return { tone: 'warn', label: 'Needs attention' };
}

/** The same judgement for a check whose flags are not loaded. */
function verdictForScore(check: RecentCheck): { tone: Tone; label: string } {
  if (check.status === 'failed') return { tone: 'stop', label: 'Failed' };
  if (check.score === null) return { tone: 'neutral', label: 'Not judged' };
  if (check.score < 50) return { tone: 'stop', label: 'Below the bar' };
  if (check.score >= 80) return { tone: 'ok', label: 'Ready' };
  return { tone: 'warn', label: 'Needs attention' };
}

const SEVERITY_TONE: Record<CheckFlag['severity'], Tone> = { critical: 'stop', warning: 'warn', note: 'neutral' };
const DIMENSION_LABEL = { visual: 'Visual', verbal: 'Verbal', compliance: 'Compliance' } as const;
const SOURCE_LABEL = { regulation: 'Regulation', suggested: 'Suggested by CIP', manual: 'Added by your team' } as const;

const LEARNED_NOTE: Record<Exclude<Learned, null>, string> = {
  fact_rejected: 'Understood. CIP will stop expecting that of this brand.',
  rule_retired: 'Understood. That suggested rule is retired.',
  rule_kept: 'Recorded. The rule stays, because it comes from a regulator.',
};

async function send<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { message?: string };
  if (!res.ok) throw new Error(data.message ?? 'That did not work. Try again in a moment.');
  return data as T;
}

/** A date that renders the same on the server and in the browser. */
function when(iso: string): string {
  return iso.slice(0, 16).replace('T', ' ');
}

export function CheckSection({
  configured,
  images,
  recent: initialRecent,
  rules,
  brands,
  markets,
}: {
  configured: boolean;
  images: ImageOption[];
  recent: RecentCheck[];
  rules: ComplianceRule[];
  brands: string[];
  markets: string[];
}) {
  const { note } = useToast();

  const [query, setQuery] = useState('');
  const [brandFilter, setBrandFilter] = useState('');
  const [selected, setSelected] = useState<ImageOption | null>(null);
  const [brand, setBrand] = useState('');
  const [market, setMarket] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CreativeCheck | null>(null);
  const [recent, setRecent] = useState(initialRecent);
  const [showRules, setShowRules] = useState(false);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return images.filter(
      (image) =>
        (!brandFilter || image.brand === brandFilter) &&
        (!q || image.name.toLowerCase().includes(q)),
    );
  }, [images, query, brandFilter]);

  const run = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      const { check } = await send<{ check: CreativeCheck }>('/api/brain/checks', {
        fileId: selected.id,
        ...(brand ? { brand } : {}),
        ...(market ? { market } : {}),
      });
      setResult(check);
      setRecent((list) => [check, ...list.filter((c) => c.id !== check.id)].slice(0, 20));
    } catch (error) {
      note(error instanceof Error ? error.message : 'That could not be checked.');
    } finally {
      setBusy(false);
    }
  };

  const open = async (checkId: string) => {
    try {
      const { check } = await send<{ check: CreativeCheck }>(`/api/brain/checks/${checkId}`);
      setResult(check);
    } catch (error) {
      note(error instanceof Error ? error.message : 'That check could not be opened.');
    }
  };

  if (!configured) {
    return (
      <div className="rise">
        <PageHead />
        <EmptyState
          icon="shield"
          title="The Brain is not switched on here"
          copy="Checking a creative needs a vision model. Once the Brain is configured on this server, you can score any image against your brand and its rules."
        />
      </div>
    );
  }

  if (images.length === 0) {
    return (
      <div className="rise">
        <PageHead />
        <EmptyState
          icon="image"
          title="No images to check yet"
          copy="Add a creative - a banner, a packshot, a social post - and CIP will score it against your brand and the rules its market has to obey."
          action={
            <Link className="btn btn-primary btn-sm" href="/teach">
              Add data <Icon name="arrow-right" size={14} />
            </Link>
          }
        />
      </div>
    );
  }

  const activeRules = rules.filter((r) => r.active);

  return (
    <div className="rise">
      <PageHead />

      <div className="check-layout">
        {/* ------------------------------------------------ choose a creative */}
        <section className="check-pick" aria-label="Choose a creative">
          <div className="check-filters">
            <label className="check-search">
              <Icon name="search" size={15} />
              <input
                id="check-search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Find an image by name"
              />
            </label>
            {brands.length > 0 && (
              <select id="check-brand-filter" value={brandFilter} onChange={(e) => setBrandFilter(e.target.value)} aria-label="Filter by brand">
                <option value="">All brands</option>
                {brands.map((b) => <option key={b} value={b}>{b}</option>)}
              </select>
            )}
          </div>

          <div className="check-grid" role="listbox" aria-label="Images">
            {visible.map((image) => (
              <button
                key={image.id}
                type="button"
                role="option"
                aria-selected={selected?.id === image.id}
                className={`check-thumb ${selected?.id === image.id ? 'is-on' : ''}`}
                onClick={() => {
                  setSelected(image);
                  setBrand('');
                  setMarket('');
                }}
                title={image.name}
              >
                <img
                  src={`/api/drive/files/${image.id}/content?disposition=inline`}
                  alt=""
                  loading="lazy"
                  decoding="async"
                />
                <span className="check-thumb-name">{image.name}</span>
              </button>
            ))}
            {visible.length === 0 && <p className="muted small check-none">No image matches that.</p>}
          </div>

          <div className="check-run">
            <div className="check-run-fields">
              <label className="check-field">
                <span>Brand</span>
                <select id="check-brand" value={brand} onChange={(e) => setBrand(e.target.value)} disabled={!selected}>
                  <option value="">{selected?.brand ? `From the file (${selected.brand})` : 'Not set'}</option>
                  {brands.map((b) => <option key={b} value={b}>{b}</option>)}
                </select>
              </label>
              <label className="check-field">
                <span>Market</span>
                <select id="check-market" value={market} onChange={(e) => setMarket(e.target.value)} disabled={!selected}>
                  <option value="">{selected?.market ? `From the file (${selected.market})` : 'Not set'}</option>
                  {markets.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              </label>
            </div>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void run()}
              disabled={!selected || busy}
            >
              <Icon name="shield" size={16} /> {busy ? 'Checking…' : 'Check this creative'}
            </button>
          </div>
          {selected && !selected.market && !market && (
            <p className="tiny muted check-hint">
              No market set, so only rules that apply everywhere will be used. Pick one to include that
              market&apos;s own requirements.
            </p>
          )}
        </section>

        {/* ------------------------------------------------ the outcome */}
        <section className="check-outcome" aria-live="polite" aria-label="Result">
          {busy && <CheckingState name={selected?.name ?? ''} />}
          {!busy && result && <Result check={result} onChange={setResult} />}
          {!busy && !result && (
            <RecentList recent={recent} onOpen={(id) => void open(id)} />
          )}
        </section>
      </div>

      {/* ------------------------------------------------ what it checks against */}
      <section className="check-rules">
        <button
          type="button"
          className="check-rules-toggle"
          aria-expanded={showRules}
          onClick={() => setShowRules((v) => !v)}
        >
          <Icon name="book" size={16} />
          <span className="grow">Rules CIP checks against</span>
          <span className="muted small">{activeRules.length} active</span>
          <Icon name="chevron-down" size={16} className={showRules ? 'flip' : ''} />
        </button>
        {showRules && <RulesList rules={rules} />}
      </section>
    </div>
  );
}

function PageHead() {
  return (
    <header className="page-head">
      <p className="eyebrow">Consistency Check</p>
      <h1>Check a creative before it goes live</h1>
      <p className="lede">
        Scored against what CIP has learned about the brand and the rules its market has to obey.
        Every flag says which rule it came from, and every flag can be corrected.
      </p>
    </header>
  );
}

function CheckingState({ name }: { name: string }) {
  return (
    <div className="check-card check-working">
      <span className="check-working-dot" aria-hidden="true" />
      <div className="stack gap-6">
        <p className="strong">Checking {name}</p>
        <p className="small muted">
          Reading the creative against the brand&apos;s patterns and its market&apos;s rules. This
          usually takes under a minute.
        </p>
      </div>
    </div>
  );
}

function Meter({ label, value }: { label: string; value: number | null }) {
  const tone: Tone = value === null ? 'neutral' : value >= 80 ? 'ok' : value >= 50 ? 'warn' : 'stop';
  return (
    <div className={`check-meter tone-${tone}`}>
      <div className="spread">
        <span className="small">{label}</span>
        <span className="check-meter-value">{value === null ? 'not judged' : value}</span>
      </div>
      <div className="check-meter-track" aria-hidden="true">
        <i style={{ width: `${value ?? 0}%` }} />
      </div>
    </div>
  );
}

function Result({ check, onChange }: { check: CreativeCheck; onChange: (c: CreativeCheck) => void }) {
  const verdict = verdictFor(check);
  const standing = check.flags.filter((f) => f.status !== 'disputed');

  return (
    <div className="check-card">
      <div className="check-head">
        <div className={`check-score tone-${verdict.tone}`}>
          <span className="check-score-num">{check.score ?? '—'}</span>
          <span className="check-score-of">{check.score === null ? '' : '/ 100'}</span>
        </div>
        <div className="stack gap-6 grow">
          <Pill tone={verdict.tone}>{verdict.label}</Pill>
          <p className="strong truncate" title={check.subject}>{check.subject}</p>
          <p className="tiny muted">
            {[check.brand, check.market].filter(Boolean).join(' · ') || 'No brand or market set'}
          </p>
        </div>
      </div>

      <div className="check-meters">
        <Meter label="Visual" value={check.visualScore} />
        <Meter label="Verbal" value={check.verbalScore} />
        <Meter label="Compliance" value={check.complianceScore} />
      </div>

      {/* How much the number stands on, next to the number. */}
      <p className="tiny muted check-basis">
        Judged against {check.factsConsidered} brand pattern{check.factsConsidered === 1 ? '' : 's'} and{' '}
        {check.rulesConsidered} compliance rule{check.rulesConsidered === 1 ? '' : 's'}.
      </p>

      {check.status === 'failed' && check.errorMessage && (
        <p className="small check-error">{check.errorMessage}</p>
      )}
      {check.summary && <p className="small check-summary">{check.summary}</p>}

      <div className="check-flags">
        <p className="check-flags-title">
          {standing.length === 0
            ? 'No flags standing'
            : `${standing.length} flag${standing.length === 1 ? '' : 's'} to review`}
        </p>
        {check.flags.map((flag) => (
          <FlagRow key={flag.id} flag={flag} onChange={onChange} />
        ))}
      </div>
    </div>
  );
}

function FlagRow({ flag, onChange }: { flag: CheckFlag; onChange: (c: CreativeCheck) => void }) {
  const { note } = useToast();
  const [disputing, setDisputing] = useState(false);
  const [reason, setReason] = useState<'exception' | 'wrong_rule'>('exception');
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async (body: Record<string, unknown>) => {
    setSaving(true);
    try {
      const result = await send<{ check: CreativeCheck; learned: Learned }>(
        `/api/brain/checks/flags/${flag.id}`,
        body,
      );
      onChange(result.check);
      setDisputing(false);
      setText('');
      if (body.decision === 'accept') note('Flag accepted.');
      else note(result.learned ? LEARNED_NOTE[result.learned] : 'Recorded as an exception. The score no longer counts it.');
    } catch (error) {
      note(error instanceof Error ? error.message : 'That could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  const idBase = `flag-${flag.id}`;

  return (
    <article className={`check-flag sev-${flag.severity} ${flag.status === 'disputed' ? 'is-disputed' : ''}`}>
      <div className="row gap-8 check-flag-tags">
        <Pill tone={SEVERITY_TONE[flag.severity]}>{flag.severity}</Pill>
        <span className="tiny muted">{DIMENSION_LABEL[flag.dimension]}</span>
        {flag.status === 'accepted' && <span className="tiny check-state">Accepted</span>}
        {flag.status === 'disputed' && (
          <span className="tiny check-state">
            Disputed · {flag.disputeReason === 'wrong_rule' ? 'rule is wrong' : 'exception'}
          </span>
        )}
      </div>

      <p className="check-flag-message">{flag.message}</p>

      <div className="check-cite">
        {flag.citedRule && (
          <>
            <span className="tiny muted">Rule</span>
            <span className="small">{flag.citedRule.rule}</span>
            <span className="tiny muted">
              {SOURCE_LABEL[flag.citedRule.source]}
              {flag.citedRule.referenceUrl && (
                <>
                  {' · '}
                  <a href={flag.citedRule.referenceUrl} target="_blank" rel="noreferrer noopener" className="check-link">
                    Source
                  </a>
                </>
              )}
            </span>
          </>
        )}
        {flag.citedFact && (
          <>
            <span className="tiny muted">What this brand usually does</span>
            <span className="small">{flag.citedFact.attribute}: {flag.citedFact.value}</span>
          </>
        )}
      </div>

      {flag.correction && <p className="small check-correction">&ldquo;{flag.correction}&rdquo;</p>}

      {flag.status === 'open' && !disputing && (
        <div className="row gap-8 check-flag-actions">
          <button type="button" className="btn btn-ghost btn-sm" disabled={saving} onClick={() => void submit({ decision: 'accept' })}>
            <Icon name="check" size={14} /> Accept
          </button>
          <button type="button" className="btn btn-sm btn-quiet" disabled={saving} onClick={() => setDisputing(true)}>
            Disagree? Correct this
          </button>
        </div>
      )}

      {disputing && (
        <form
          className="check-dispute"
          onSubmit={(e) => {
            e.preventDefault();
            void submit({ decision: 'dispute', reason, correction: text });
          }}
        >
          <fieldset>
            <legend className="small strong">What is wrong with this flag?</legend>
            <label className="check-choice" htmlFor={`${idBase}-exception`}>
              <input
                id={`${idBase}-exception`}
                type="radio"
                name={`${idBase}-reason`}
                checked={reason === 'exception'}
                onChange={() => setReason('exception')}
              />
              <span>
                <span className="small strong">This creative is an exception</span>
                <span className="tiny muted">The rule is right. This piece is allowed to differ.</span>
              </span>
            </label>
            <label className="check-choice" htmlFor={`${idBase}-wrong`}>
              <input
                id={`${idBase}-wrong`}
                type="radio"
                name={`${idBase}-reason`}
                checked={reason === 'wrong_rule'}
                onChange={() => setReason('wrong_rule')}
              />
              <span>
                <span className="small strong">The rule itself is wrong</span>
                <span className="tiny muted">
                  {flag.citedRule?.source === 'regulation'
                    ? 'This one comes from a regulator, so it will be recorded but kept.'
                    : 'CIP will stop applying it to this brand.'}
                </span>
              </span>
            </label>
          </fieldset>
          <label className="check-field" htmlFor={`${idBase}-note`}>
            <span>Why (optional)</span>
            <textarea
              id={`${idBase}-note`}
              rows={2}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="A line for whoever reads this later"
            />
          </label>
          <div className="row gap-8">
            <button type="submit" className="btn btn-primary btn-sm" disabled={saving}>
              {saving ? 'Saving…' : 'Save correction'}
            </button>
            <button type="button" className="btn btn-sm btn-quiet" disabled={saving} onClick={() => setDisputing(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </article>
  );
}

function RecentList({ recent, onOpen }: { recent: RecentCheck[]; onOpen: (id: string) => void }) {
  if (recent.length === 0) {
    return (
      <div className="check-card check-empty">
        <Icon name="shield" size={22} />
        <p className="strong">Pick an image to check</p>
        <p className="small muted">
          Its score, the flags it raised and the rule behind each one will appear here.
        </p>
      </div>
    );
  }

  return (
    <div className="check-card">
      <p className="check-flags-title">Recent checks</p>
      <ul className="check-recent">
        {recent.map((check) => {
          const verdict = verdictForScore(check);
          return (
            <li key={check.id}>
              <button type="button" className="check-recent-row" onClick={() => onOpen(check.id)}>
                <span className={`check-recent-score tone-${verdict.tone}`}>{check.score ?? '—'}</span>
                <span className="stack grow">
                  <span className="small strong truncate">{check.subject}</span>
                  <span className="tiny muted">
                    {[check.brand, check.market].filter(Boolean).join(' · ') || 'No brand or market'} · {when(check.createdAt)}
                  </span>
                </span>
                <Pill tone={verdict.tone}>{verdict.label}</Pill>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function RulesList({ rules }: { rules: ComplianceRule[] }) {
  const groups = new Map<string, ComplianceRule[]>();
  for (const rule of rules) {
    const key = rule.market ?? 'Every market';
    groups.set(key, [...(groups.get(key) ?? []), rule]);
  }

  if (rules.length === 0) {
    return (
      <p className="small muted check-rules-empty">
        No compliance rules yet. Without them, a check can only compare a creative with the brand&apos;s
        own patterns.
      </p>
    );
  }

  return (
    <div className="check-rules-body">
      {[...groups.entries()].map(([group, list]) => (
        <div key={group} className="check-rules-group">
          <p className="check-rules-market">{group}</p>
          <ul>
            {list.map((rule) => (
              <li key={rule.id} className={rule.active ? '' : 'is-retired'}>
                <span className={`check-req req-${rule.requirement}`}>
                  {rule.requirement === 'required' ? 'Required' : 'Forbidden'}
                </span>
                <span className="stack grow">
                  <span className="small">{rule.rule}</span>
                  <span className="tiny muted">
                    {SOURCE_LABEL[rule.source]}
                    {rule.brand ? ` · ${rule.brand}` : ''}
                    {rule.category === 'medium' ? ' · where and when it runs, not judged from an image' : ''}
                    {!rule.active ? ' · retired' : ''}
                    {rule.referenceUrl && (
                      <>
                        {' · '}
                        <a href={rule.referenceUrl} target="_blank" rel="noreferrer noopener" className="check-link">
                          Source
                        </a>
                      </>
                    )}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
