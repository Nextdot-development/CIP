'use client';

import { useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { EmptyState, Pill } from '../components/ui/Bits';
import { Icon } from '../components/ui/Icon';
import { useToast } from '@/context/toast';
import type { MarketSignalKind } from '@/server/brain/providers/types';
import type { MarketSignalDTO, MarketSourceDTO } from '@/server/brain/market';

/**
 * Competitive & Market Intelligence, in the prototype's shapes: comparison
 * bars, then insight cards.
 *
 * Everything on it comes from reports the company added, and every number can
 * be traced to the words of the report it came from - "What the report says"
 * under each card, and the file itself one click away. A signal that is wrong
 * can be removed, and stays removed.
 */

const KIND_LABEL: Record<MarketSignalKind, string> = {
  share: 'Share',
  growth: 'Growth',
  price: 'Price',
  distribution: 'Distribution',
  consumer: 'Consumer insight',
  competitor_move: 'Competitor move',
  regulation: 'Regulation',
  trend: 'Trend',
  other: 'Signal',
};

const STATUS_LABEL: Record<MarketSourceDTO['status'], { text: string; tone: 'ok' | 'warn' | 'stop' | 'neutral' }> = {
  pending: { text: 'Waiting to be read', tone: 'neutral' },
  reading: { text: 'Reading…', tone: 'warn' },
  ready: { text: 'Read', tone: 'ok' },
  failed: { text: 'Could not read', tone: 'stop' },
  no_text: { text: 'No readable text', tone: 'stop' },
};

const contentUrl = (id: string) => `/api/drive/files/${id}/content?disposition=inline`;

function formatValue(signal: MarketSignalDTO): string {
  if (signal.value === null) return '';
  const n = Number.isInteger(signal.value) ? String(signal.value) : signal.value.toFixed(1);
  if (!signal.unit) return n;
  return signal.unit === '%' ? `${n}%` : `${n} ${signal.unit}`;
}

type Group = { key: string; title: string; rows: MarketSignalDTO[] };

const METRIC_FILLER = new Set(['market', 'of', 'the', 'by', 'in', 'total', 'overall', 'percent', 'percentage', 'pct']);

/**
 * What a metric measures, for putting like with like.
 *
 * Reports name the same measure differently - "market share", "share of
 * market", "Share (%)" - and grouping on the words as written split one
 * comparison into three charts of one bar each. Filler words go; the words
 * that change the meaning ("volume", "value") stay, because volume share and
 * value share are different numbers.
 */
function metricKey(metric: string): string {
  const words = metric
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word && !METRIC_FILLER.has(word));
  return words.sort().join(' ') || metric.toLowerCase();
}

async function postJson(url: string, body: unknown): Promise<void> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(data.message ?? 'That did not work.');
  }
}

export function MarketSection({
  configured,
  brand,
  sources,
  signals,
}: {
  configured: boolean;
  brand: string | null;
  sources: MarketSourceDTO[];
  signals: MarketSignalDTO[];
}) {
  const router = useRouter();
  const { note } = useToast();
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [market, setMarket] = useState<string | null>(null);
  const [kind, setKind] = useState<MarketSignalKind | null>(null);
  const [showRemoved, setShowRemoved] = useState(false);
  const [working, setWorking] = useState<string | null>(null);

  const active = signals.filter((s) => s.status === 'active');
  const removed = signals.filter((s) => s.status === 'rejected');
  const markets = useMemo(
    () => [...new Set(active.map((s) => s.market).filter((m): m is string => Boolean(m)))].sort(),
    [active],
  );
  const kinds = useMemo(() => [...new Set(active.map((s) => s.kind))], [active]);

  const visible = active.filter((s) => (!market || s.market === market) && (!kind || s.kind === kind));

  // Percentages that measure the same thing, in the same market and period,
  // are one comparison. Anything else stands on its own.
  const { groups, singles } = useMemo(() => {
    const map = new Map<string, MarketSignalDTO[]>();
    for (const s of visible) {
      if (s.value === null || s.unit !== '%') continue;
      const key = [metricKey(s.metric ?? s.kind), (s.market ?? '').toLowerCase(), (s.period ?? '').toLowerCase()].join('|');
      map.set(key, [...(map.get(key) ?? []), s]);
    }
    const grouped: Group[] = [];
    const inGroup = new Set<string>();
    for (const [key, rows] of map) {
      if (new Set(rows.map((r) => r.subject.toLowerCase())).size < 2) continue;
      const first = rows[0]!;
      grouped.push({
        key,
        title: [first.metric ?? KIND_LABEL[first.kind], first.market ?? 'All markets', first.period].filter(Boolean).join(' · '),
        rows: [...rows].sort((a, b) => (b.value ?? 0) - (a.value ?? 0)),
      });
      rows.forEach((r) => inGroup.add(r.id));
    }
    return { groups: grouped, singles: visible.filter((s) => !inGroup.has(s.id)) };
  }, [visible]);

  const upload = async (files: FileList) => {
    setUploading(true);
    let added = 0;
    try {
      for (const file of Array.from(files)) {
        const form = new FormData();
        form.append('file', file);
        const res = await fetch('/api/market/sources', { method: 'POST', body: form });
        if (res.ok) added += 1;
        else {
          const data = (await res.json().catch(() => ({}))) as { message?: string };
          note(data.message ?? `"${file.name}" could not be added.`);
        }
      }
      if (added > 0) note(`${added} report${added === 1 ? '' : 's'} added. CIP is reading ${added === 1 ? 'it' : 'them'} now.`);
      router.refresh();
    } finally {
      setUploading(false);
    }
  };

  const act = async (id: string, run: () => Promise<void>, done: string) => {
    setWorking(id);
    try {
      await run();
      note(done);
      router.refresh();
    } catch (error) {
      note(error instanceof Error ? error.message : 'That did not work.');
    } finally {
      setWorking(null);
    }
  };

  const remove = (signal: MarketSignalDTO) =>
    act(signal.id, () => postJson(`/api/market/signals/${signal.id}`, { status: 'rejected' }), 'Removed. CIP will not use it again.');
  const restore = (signal: MarketSignalDTO) =>
    act(signal.id, () => postJson(`/api/market/signals/${signal.id}`, { status: 'active' }), 'Put back.');
  const reread = (source: MarketSourceDTO) =>
    act(source.id, () => postJson(`/api/market/sources/${source.id}`, { action: 'reread' }), 'Reading it again.');

  const competitors = new Set(active.filter((s) => s.subjectType === 'competitor').map((s) => s.subject.toLowerCase())).size;
  const read = sources.filter((s) => s.status === 'ready').length;

  const addButton = (
    <>
      <button type="button" className="btnprimary" onClick={() => fileInput.current?.click()} disabled={uploading}>
        <Icon name="upload" size={15} /> {uploading ? 'Adding…' : 'Add market reports'}
      </button>
      <input
        id="market-files"
        ref={fileInput}
        type="file"
        multiple
        hidden
        onChange={(event) => {
          if (event.target.files?.length) void upload(event.target.files);
          event.target.value = '';
        }}
      />
    </>
  );

  return (
    <div className="rise">
      <header className="page-head pagehead-row">
        <div>
          <p className="eyebrow">Market Intelligence</p>
          <h1>Competitive &amp; Market Intelligence{brand ? ` — ${brand}` : ''}</h1>
          <p className="lede">
            Where {brand ?? 'the portfolio'} is gaining or losing ground, read from the market reports you add.
            Every number links back to the words of the report it came from.
          </p>
        </div>
        <div className="headside">
          <div className="statrow">
            <div className="statchip"><span className="n">{read}</span><span className="l">reports read</span></div>
            <div className="statchip"><span className="n">{active.length}</span><span className="l">signals</span></div>
            <div className="statchip"><span className="n">{competitors}</span><span className="l">competitors</span></div>
            <div className="statchip"><span className="n">{markets.length}</span><span className="l">markets</span></div>
          </div>
          {sources.length > 0 && addButton}
        </div>
      </header>

      {!configured && (
        <p className="chatnotice">
          <Icon name="alert" size={15} /> The Brain is not configured on this server, so reports will be stored but not read.
        </p>
      )}

      {sources.length === 0 ? (
        <div className="marketempty">
          <EmptyState
            icon="bars"
            title="Add the market data CIP should know"
            copy="Industry reports, retail audits, social listening exports, competitor annual reports - as PDF, Excel, CSV, Word or PowerPoint. CIP reads each one and keeps only what it can quote. Files in a Google Drive folder named “Market Intelligence” are read too."
            action={addButton}
          />
        </div>
      ) : (
        <>
          {(markets.length > 0 || kinds.length > 1) && (
            <div className="calfilters" role="group" aria-label="Filter signals">
              <button type="button" className={`chip ${market === null ? 'is-on' : ''}`} aria-pressed={market === null} onClick={() => setMarket(null)}>
                Every market
              </button>
              {markets.map((m) => (
                <button key={m} type="button" className={`chip ${market === m ? 'is-on' : ''}`} aria-pressed={market === m} onClick={() => setMarket(m)}>
                  {m}
                </button>
              ))}
              {kinds.length > 1 && (
                <select
                  className="marketkind"
                  aria-label="Kind of signal"
                  value={kind ?? ''}
                  onChange={(event) => setKind((event.target.value || null) as MarketSignalKind | null)}
                >
                  <option value="">Every kind</option>
                  {kinds.map((k) => (
                    <option key={k} value={k}>{KIND_LABEL[k]}</option>
                  ))}
                </select>
              )}
            </div>
          )}

          {groups.map((group) => (
            <section key={group.key} className="vizcard" aria-label={group.title}>
              <p className="vizcard-title">{group.title}</p>
              {group.rows.map((row) => (
                <div key={row.id} className="vizbar" title={row.excerpt}>
                  <div className={`who ${row.subjectType === 'own_brand' ? 'is-own' : ''}`}>
                    {row.subjectType === 'competitor' ? '— ' : ''}
                    {row.subject}
                  </div>
                  <div className="track">
                    <div
                      className="fill"
                      style={{
                        width: `${Math.max(2, Math.min(100, row.value ?? 0))}%`,
                        background: row.subjectType === 'own_brand' ? 'var(--brand)' : 'var(--ink-400)',
                      }}
                    />
                  </div>
                  <div className="pct">{formatValue(row)}</div>
                  <button
                    type="button"
                    className="vizremove"
                    aria-label={`Remove: ${row.statement}`}
                    title="Wrong? Remove it"
                    onClick={() => void remove(row)}
                    disabled={working === row.id}
                  >
                    <Icon name="close" size={12} />
                  </button>
                </div>
              ))}
              <p className="vizsource">
                From{' '}
                {[...new Map(group.rows.map((r) => [r.fileId, r.fileName]))].map(([id, name], i) => (
                  <span key={id}>
                    {i > 0 && ', '}
                    <a href={contentUrl(id)} target="_blank" rel="noreferrer noopener">{name}</a>
                  </span>
                ))}
              </p>
            </section>
          ))}

          {singles.length > 0 && (
            <div className="insightgrid">
              {singles.map((signal) => (
                <article key={signal.id} className="insightcard">
                  <div className="spread">
                    <div className="k">{KIND_LABEL[signal.kind]}</div>
                    {signal.value !== null && <span className="signalvalue">{formatValue(signal)}</span>}
                  </div>
                  <p>{signal.statement}</p>
                  <p className="signalmeta">
                    {[signal.subjectType === 'own_brand' ? `${signal.subject} (ours)` : signal.subject, signal.market, signal.period]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                  <details className="signalquote">
                    <summary>What the report says</summary>
                    <blockquote>&ldquo;{signal.excerpt}&rdquo;</blockquote>
                    <a href={contentUrl(signal.fileId)} target="_blank" rel="noreferrer noopener">{signal.fileName}</a>
                  </details>
                  <button type="button" className="correctlink" onClick={() => void remove(signal)} disabled={working === signal.id}>
                    Wrong? Remove it
                  </button>
                </article>
              ))}
            </div>
          )}

          {active.length === 0 && (
            <p className="small muted marketwait">
              Nothing has been read out of these reports yet. Reading takes a minute or two per report; this page
              shows the signals once they are in.
            </p>
          )}

          {removed.length > 0 && (
            <div className="marketremoved">
              <button type="button" className="acceptlink" onClick={() => setShowRemoved((v) => !v)}>
                {showRemoved ? 'Hide' : 'Show'} {removed.length} removed signal{removed.length === 1 ? '' : 's'}
              </button>
              {showRemoved && (
                <ul>
                  {removed.map((signal) => (
                    <li key={signal.id}>
                      <span className="small">{signal.statement}</span>
                      <button type="button" className="correctlink" onClick={() => void restore(signal)} disabled={working === signal.id}>
                        Put back
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <section className="marketsources" aria-label="Reports">
            <h2>Reports</h2>
            <ul>
              {sources.map((source) => {
                // A status this page has no words for is shown as it is,
                // rather than read off an undefined and taking the whole of
                // Market Intelligence down with it - which would happen to the
                // company most likely to see a new one: the one whose report
                // is being read right now.
                const status = STATUS_LABEL[source.status] ?? {
                  text: source.status,
                  tone: 'neutral' as const,
                };
                return (
                  <li key={source.id}>
                    <Icon name="doc" size={16} />
                    <span className="stack grow">
                      <a className="small strong truncate" href={contentUrl(source.fileId)} target="_blank" rel="noreferrer noopener">
                        {source.fileName}
                      </a>
                      <span className="tiny muted">
                        {source.status === 'ready'
                          ? `${source.signals} signal${source.signals === 1 ? '' : 's'}${source.summary ? ` · ${source.summary}` : ''}`
                          : (source.errorMessage ?? 'Added ' + source.createdAt.slice(0, 10))}
                      </span>
                    </span>
                    <Pill tone={status.tone}>{status.text}</Pill>
                    {(source.status === 'ready' || source.status === 'failed' || source.status === 'no_text') && (
                      <button type="button" className="acceptlink" onClick={() => void reread(source)} disabled={working === source.id}>
                        Read again
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}
