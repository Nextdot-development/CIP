'use client';

import { useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { EmptyState, Pill } from '../components/ui/Bits';
import { Icon } from '../components/ui/Icon';
import { useToast } from '@/context/toast';
import type { CheckDimension } from '@/server/brain/providers/types';
import type { ComplianceRule, CreativeCheck, CheckFlag, Learned } from '@/server/brain/checker';

/**
 * The Consistency & Compliance Checker, in the prototype's layout: the
 * creative on the left, the verdict on the right, the flags under it.
 *
 * The verdict comes before the detail - a reviewer needs to know whether it
 * can ship before they need to know why.
 *
 * Two things this screen will not do. It will not show a score without saying
 * how much the score stands on: a hundred against no rules is not a pass. And
 * it will not let a flag stand unchallenged: every open flag carries
 * "Disagree? Correct this", because a brain that cannot be corrected drifts.
 */

type ImageOption = { id: string; name: string; brand: string | null; market: string | null };
type RecentCheck = Omit<CreativeCheck, 'flags'>;
type Tone = 'ok' | 'warn' | 'stop' | 'neutral';

const TONE_COLOUR: Record<Tone, string> = {
  ok: 'var(--ok-500)',
  warn: 'var(--warn-500)',
  stop: 'var(--stop-500)',
  neutral: 'var(--ink-400)',
};

/** Whether it can ship, read off the flags that still stand. */
function verdictFor(check: CreativeCheck): { tone: Tone; label: string; headline: string } {
  if (check.status === 'failed') return { tone: 'stop', label: 'Check failed', headline: 'The check did not finish' };
  if (check.score === null) return { tone: 'neutral', label: 'Not judged', headline: 'Nothing to judge this against yet' };
  const blocking = check.flags.some(
    (f) => f.status !== 'disputed' && f.dimension === 'compliance' && f.severity === 'critical',
  );
  if (blocking) return { tone: 'stop', label: 'Cannot ship', headline: 'Cannot ship — fix before publishing' };
  if (check.score >= 80) return { tone: 'ok', label: 'Ready', headline: 'Ready to publish' };
  return { tone: 'warn', label: 'Needs attention', headline: 'Needs review before publishing' };
}

/** The same judgement for a check whose flags are not loaded. */
function verdictForScore(check: RecentCheck): { tone: Tone; label: string } {
  if (check.status === 'failed') return { tone: 'stop', label: 'Failed' };
  if (check.score === null) return { tone: 'neutral', label: 'Not judged' };
  if (check.score < 50) return { tone: 'stop', label: 'Below the bar' };
  if (check.score >= 80) return { tone: 'ok', label: 'Ready' };
  return { tone: 'warn', label: 'Needs attention' };
}

const DIMENSIONS: CheckDimension[] = ['visual', 'verbal', 'compliance'];
const DIMENSION_LABEL: Record<CheckDimension, string> = {
  visual: 'Visual identity',
  verbal: 'Verbal identity',
  compliance: 'Compliance',
};
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

const contentUrl = (id: string) => `/api/drive/files/${id}/content?disposition=inline`;
/** A small copy for grids and previews; the original is still a click away. */
const thumbUrl = (id: string, size: 320 | 1280) => `${contentUrl(id)}&size=${size}`;

export function CheckSection({
  configured,
  images,
  recent: initialRecent,
  rules,
  brands,
  activeBrand,
  markets,
  initialCheck = null,
}: {
  configured: boolean;
  images: ImageOption[];
  recent: RecentCheck[];
  rules: ComplianceRule[];
  brands: string[];
  activeBrand: string | null;
  markets: string[];
  /** A check opened from a link, such as the verdict under a generated image. */
  initialCheck?: CreativeCheck | null;
}) {
  const { note } = useToast();
  const panel = useRef<HTMLDivElement>(null);

  const [query, setQuery] = useState('');
  const [brandFilter, setBrandFilter] = useState(
    activeBrand && images.some((image) => image.brand === activeBrand) ? activeBrand : '',
  );
  const [selected, setSelected] = useState<ImageOption | null>(null);
  const [brand, setBrand] = useState('');
  const [market, setMarket] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CreativeCheck | null>(initialCheck);
  const [recent, setRecent] = useState(initialRecent);
  const [showRules, setShowRules] = useState(false);
  const [ruleList, setRuleList] = useState(rules);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return images.filter(
      (image) => (!brandFilter || image.brand === brandFilter) && (!q || image.name.toLowerCase().includes(q)),
    );
  }, [images, query, brandFilter]);

  // What the check will be judged as: what was chosen here, else what the
  // file says, else the brand in the sidebar.
  const effectiveBrand = brand || selected?.brand || activeBrand || '';

  const run = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      const { check } = await send<{ check: CreativeCheck }>('/api/brain/checks', {
        fileId: selected.id,
        ...(effectiveBrand ? { brand: effectiveBrand } : {}),
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

  const pick = (image: ImageOption) => {
    setSelected(image);
    setBrand('');
    setMarket('');
    setResult(null);
    panel.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  if (!configured) {
    return (
      <div className="rise">
        <PageHead brand={activeBrand} />
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
        <PageHead brand={activeBrand} />
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

  const activeRules = ruleList.filter((r) => r.active);
  const effectiveMarket = market || selected?.market || '';

  return (
    <div className="rise">
      <PageHead brand={activeBrand} />

      <div className="checkerlayout" ref={panel}>
        {/* ------------------------------------------------ the creative */}
        <div className="assetpanel">
          <div className="assetpreview">
            {selected ? (
              <img src={thumbUrl(selected.id, 1280)} alt={`Preview of ${selected.name}`} />
            ) : (
              <span>Pick a creative from your library below</span>
            )}
          </div>
          <div className="assetmeta">
            <div className="row">
              <span>File</span>
              <span className="truncate" title={selected?.name}>{selected?.name ?? '—'}</span>
            </div>
            <label className="row" htmlFor="check-brand">
              <span>Brand</span>
              <select id="check-brand" value={brand} onChange={(e) => setBrand(e.target.value)} disabled={!selected}>
                <option value="">
                  {selected?.brand
                    ? `${selected.brand} (from the file)`
                    : activeBrand
                      ? `${activeBrand} (sidebar)`
                      : 'Not set'}
                </option>
                {brands.map((b) => <option key={b} value={b}>{b}</option>)}
              </select>
            </label>
            <label className="row" htmlFor="check-market">
              <span>Market</span>
              <select id="check-market" value={market} onChange={(e) => setMarket(e.target.value)} disabled={!selected}>
                <option value="">{selected?.market ? `${selected.market} (from the file)` : 'Not set'}</option>
                {markets.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </label>
          </div>
          <button type="button" className="btnprimary check-run" onClick={() => void run()} disabled={!selected || busy}>
            <Icon name="shield" size={15} /> {busy ? 'Checking…' : 'Check this creative'}
          </button>
          {selected && !effectiveMarket && (
            <p className="tiny muted check-hint">
              No market set, so only rules that apply everywhere will be used. Pick one to include that
              market&apos;s own requirements.
            </p>
          )}
        </div>

        {/* ------------------------------------------------ the verdict */}
        <div className="scorepanel" aria-live="polite">
          {busy && <CheckingState name={selected?.name ?? ''} />}
          {!busy && result && <Result check={result} onChange={setResult} />}
          {!busy && !result && <RecentList recent={recent} onOpen={(id) => void open(id)} />}
        </div>
      </div>

      {/* ------------------------------------------------ the library */}
      <section className="check-library" aria-label="Your creatives">
        <div className="check-library-head">
          <h2>Your creatives</h2>
          <div className="check-filters">
            <label className="check-search" htmlFor="check-search">
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
        </div>
        <div className="check-grid" role="listbox" aria-label="Images">
          {visible.map((image) => (
            <button
              key={image.id}
              type="button"
              role="option"
              aria-selected={selected?.id === image.id}
              className={`check-thumb ${selected?.id === image.id ? 'is-on' : ''}`}
              onClick={() => pick(image)}
              title={image.name}
            >
              <img src={thumbUrl(image.id, 320)} alt="" loading="lazy" decoding="async" />
              <span className="check-thumb-name">{image.name}</span>
            </button>
          ))}
          {visible.length === 0 && <p className="small muted check-none">No image matches that.</p>}
        </div>
      </section>

      {/* ------------------------------------------------ what it checks against */}
      <section className="check-rules">
        <button type="button" className="check-rules-toggle" aria-expanded={showRules} onClick={() => setShowRules((v) => !v)}>
          <Icon name="book" size={16} />
          <span className="grow">Rules CIP checks against</span>
          <span className="muted small">{activeRules.length} active</span>
          <Icon name="chevron-down" size={16} className={showRules ? 'flip' : ''} />
        </button>
        {showRules && (
          <RulesList
            rules={ruleList}
            onVerified={(id, verifiedAt) => setRuleList((list) => list.map((r) => (r.id === id ? { ...r, verifiedAt } : r)))}
          />
        )}
      </section>
    </div>
  );
}

function PageHead({ brand }: { brand: string | null }) {
  return (
    <header className="page-head">
      <p className="eyebrow">Consistency Check</p>
      <h1>Consistency &amp; Compliance Check</h1>
      <p className="lede">
        Scored against {brand ? `${brand}'s` : 'the brand’s'} DNA and the market&apos;s compliance rules before
        it goes live. Every flag says which rule it came from, and every flag can be corrected.
      </p>
    </header>
  );
}

function CheckingState({ name }: { name: string }) {
  return (
    <div className="scoreheader check-working">
      <span className="check-working-dot" aria-hidden="true" />
      <div className="stack gap-6">
        <h3>Checking {name}</h3>
        <p className="small muted">
          Reading the creative against the brand&apos;s patterns and its market&apos;s rules. This usually
          takes under a minute.
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
  const degrees = Math.round(((check.score ?? 0) / 100) * 360);
  const scoreOf: Record<CheckDimension, number | null> = {
    visual: check.visualScore,
    verbal: check.verbalScore,
    compliance: check.complianceScore,
  };

  return (
    <>
      <div className="scoreheader">
        <div
          className="scorearc"
          style={{
            background: `conic-gradient(${TONE_COLOUR[verdict.tone]} 0deg ${degrees}deg, var(--ink-100) ${degrees}deg 360deg)`,
          }}
        >
          <div className="scorearcinner">
            <b>{check.score ?? '—'}</b>
            <small>{check.score === null ? '' : '/ 100'}</small>
          </div>
        </div>
        <div className="stack gap-6 grow">
          <h3>{verdict.headline}</h3>
          <p className={`check-verdict tone-${verdict.tone}`}>
            {standing.length === 0
              ? 'No flags standing'
              : `${standing.length} flag${standing.length === 1 ? '' : 's'} found — see below`}
          </p>
          <p className="tiny muted truncate" title={check.subject}>
            {check.subject} · {[check.brand, check.market].filter(Boolean).join(' · ') || 'no brand or market set'}
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
      {check.status === 'failed' && check.errorMessage && <p className="small check-error">{check.errorMessage}</p>}
      {check.summary && <p className="small check-summary">{check.summary}</p>}

      <div className="flagcard">
        {DIMENSIONS.map((dimension) => {
          if (check.status === 'failed') return null;
          const flagged = standing.some((f) => f.dimension === dimension);
          if (flagged) return null;
          const judged = scoreOf[dimension] !== null;
          return (
            <div key={dimension} className="flagrow">
              <div className={`flagicon ${judged ? 'pass' : 'note'}`}>
                <Icon name={judged ? 'check' : 'clock'} size={14} strokeWidth={2.2} />
              </div>
              <div className="grow">
                <p className="flagtitle">{DIMENSION_LABEL[dimension]} — {judged ? 'pass' : 'not judged'}</p>
                <p className="flagdesc">
                  {judged
                    ? 'Nothing here departs from what CIP was checking it against.'
                    : 'CIP had nothing in this area to check it against.'}
                </p>
              </div>
            </div>
          );
        })}
        {check.flags.map((flag) => (
          <FlagRow key={flag.id} flag={flag} onChange={onChange} />
        ))}
      </div>
    </>
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
      const result = await send<{ check: CreativeCheck; learned: Learned }>(`/api/brain/checks/flags/${flag.id}`, body);
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
  const icon = flag.severity === 'critical' ? 'stop' : flag.severity === 'warning' ? 'warn' : 'note';

  return (
    <article className={`flagrow ${flag.status === 'disputed' ? 'is-disputed' : ''}`}>
      <div className={`flagicon ${icon}`}>
        <Icon name="alert" size={14} strokeWidth={2.2} />
      </div>
      <div className="grow">
        <p className="flagtitle">
          {DIMENSION_LABEL[flag.dimension]} — {flag.severity === 'critical' ? 'critical' : flag.severity === 'warning' ? 'flag' : 'note'}
        </p>
        <p className="flagdesc">{flag.message}</p>

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

        {flag.status === 'accepted' && (
          <div className="correctdone"><Icon name="check" size={12} strokeWidth={2.6} /> Accepted</div>
        )}
        {flag.status === 'disputed' && (
          <div className="correctdone">
            <Icon name="check" size={12} strokeWidth={2.6} /> Feedback sent — the brain will factor this in
            {flag.disputeReason === 'wrong_rule' ? ' (rule is wrong)' : ' (exception)'}
          </div>
        )}
        {flag.correction && <p className="small check-correction">&ldquo;{flag.correction}&rdquo;</p>}

        {flag.status === 'open' && !disputing && (
          <div className="flagactions">
            <button type="button" className="correctlink" disabled={saving} onClick={() => setDisputing(true)}>
              Disagree? Correct this
            </button>
            <button type="button" className="acceptlink" disabled={saving} onClick={() => void submit({ decision: 'accept' })}>
              Accept
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
              <button type="submit" className="btnprimary" disabled={saving}>
                {saving ? 'Saving…' : 'Save correction'}
              </button>
              <button type="button" className="btnghost" disabled={saving} onClick={() => setDisputing(false)}>
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>
    </article>
  );
}

function RecentList({ recent, onOpen }: { recent: RecentCheck[]; onOpen: (id: string) => void }) {
  if (recent.length === 0) {
    return (
      <div className="scoreheader check-empty">
        <Icon name="shield" size={22} />
        <div className="stack gap-6">
          <h3>Pick a creative to check</h3>
          <p className="small muted">Its score, the flags it raised and the rule behind each one appear here.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flagcard">
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

function RulesList({
  rules,
  onVerified,
}: {
  rules: ComplianceRule[];
  onVerified: (id: string, verifiedAt: string | null) => void;
}) {
  const groups = new Map<string, ComplianceRule[]>();
  for (const rule of rules) {
    const key = rule.market ?? 'Every market';
    groups.set(key, [...(groups.get(key) ?? []), rule]);
  }

  if (rules.length === 0) {
    return (
      <p className="small muted check-rules-empty">
        No compliance rules yet. Without them, a check can only compare a creative with the brand&apos;s own
        patterns.
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
                    {rule.active && <RuleReview rule={rule} onVerified={onVerified} />}
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

/**
 * Whether a person has confirmed a rule is right, and the button to say so.
 *
 * A rule CIP suggested can raise a flag before anyone has checked it, but it
 * cannot fail a creative until someone has - this is where they do.
 */
function RuleReview({
  rule,
  onVerified,
}: {
  rule: ComplianceRule;
  onVerified: (id: string, verifiedAt: string | null) => void;
}) {
  const { note } = useToast();
  const [saving, setSaving] = useState(false);

  const toggle = async () => {
    setSaving(true);
    try {
      const res = await fetch(`/api/brain/compliance/${rule.id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ verified: !rule.verifiedAt }),
      });
      const data = (await res.json().catch(() => ({}))) as { verifiedAt?: string | null; message?: string };
      if (!res.ok) throw new Error(data.message ?? 'That could not be saved.');
      onVerified(rule.id, data.verifiedAt ?? null);
      note(data.verifiedAt ? 'Marked as verified.' : 'Verification removed.');
    } catch (error) {
      note(error instanceof Error ? error.message : 'That could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <span className="rulereview">
      {' · '}
      <span className={rule.verifiedAt ? 'ruleverified' : 'ruleunverified'}>
        {rule.verifiedAt
          ? `Verified ${rule.verifiedAt.slice(0, 10)}`
          : rule.source === 'suggested'
            ? 'Not yet verified: can warn, cannot fail'
            : 'Not yet verified'}
      </span>
      <button type="button" onClick={() => void toggle()} disabled={saving}>
        {rule.verifiedAt ? 'Undo' : 'Mark verified'}
      </button>
    </span>
  );
}
