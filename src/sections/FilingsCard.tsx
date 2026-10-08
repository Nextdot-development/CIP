'use client';

import { useEffect, useState } from 'react';
import { Pill } from '../components/ui/Bits';
import { Icon } from '../components/ui/Icon';
import { useToast } from '@/context/toast';
import type { MarketDigestDTO, MarketFeedDTO } from '@/server/brain/filings';

/** "3 hours ago", roughly. */
function ago(iso: string | null): string {
  if (!iso) return 'not yet';
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

/**
 * The listed companies whose stock exchange filings CIP fetches by itself.
 *
 * Results, earnings call transcripts and investor presentations arrive here
 * within a few hours of being filed on NSE, and are read like any report.
 * Said plainly when NSE refuses: a feed that has quietly stopped is worse than
 * none.
 */
export function FilingsCard() {
  const { note } = useToast();
  const [feeds, setFeeds] = useState<MarketFeedDTO[] | null>(null);
  const [symbol, setSymbol] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [digest, setDigest] = useState<MarketDigestDTO | null>(null);

  useEffect(() => {
    let stopped = false;
    void fetch('/api/market/feeds', { cache: 'no-store' })
      .then((res) => (res.ok ? (res.json() as Promise<{ feeds: MarketFeedDTO[] }>) : null))
      .then((body) => { if (!stopped && body) setFeeds(body.feeds); })
      .catch(() => {});
    void fetch('/api/market/digest', { cache: 'no-store' })
      .then((res) => (res.ok ? (res.json() as Promise<{ digest: MarketDigestDTO | null }>) : null))
      .then((body) => { if (!stopped && body) setDigest(body.digest); })
      .catch(() => {});
    return () => { stopped = true; };
  }, []);

  const call = async (key: string, url: string, init: RequestInit, done?: string) => {
    setBusy(key);
    try {
      const res = await fetch(url, init).catch(() => null);
      const body = (await res?.json().catch(() => null)) as { feeds?: MarketFeedDTO[]; message?: string } | null;
      if (!res?.ok) { note(body?.message ?? 'That did not work. Try again in a moment.'); return; }
      if (body?.feeds) setFeeds(body.feeds);
      if (done) note(done);
    } finally {
      setBusy(null);
    }
  };

  const writeNow = async () => {
    setBusy('digest');
    try {
      const res = await fetch('/api/market/digest', { method: 'POST' }).catch(() => null);
      const body = (await res?.json().catch(() => null)) as { digest?: MarketDigestDTO; message?: string } | null;
      if (!res?.ok || !body?.digest) { note(body?.message ?? 'The note could not be written. Try again in a moment.'); return; }
      setDigest(body.digest);
    } finally {
      setBusy(null);
    }
  };

  if (!feeds) return null;

  return (
    <section className="card pad filings">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <p className="strong"><Icon name="bolt" size={15} /> Exchange filings, fetched automatically</p>
        <span className="tiny muted">From NSE, checked every 3 hours</span>
      </div>
      <p className="tiny muted" style={{ marginTop: 4 }}>
        Results, earnings call transcripts, investor presentations and press releases are fetched within a few
        hours of being filed, and read like any report. Routine notices are left out.
      </p>

      {feeds.length > 0 && (
        <div className="filing-digest">
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
            <p className="small strong">
              {digest ? `The week to ${new Date(digest.periodEnd).toLocaleDateString()}` : 'This week'}
            </p>
            <button type="button" className="btn btn-sm btn-ghost" disabled={busy !== null} onClick={() => void writeNow()}>
              {busy === 'digest' ? 'Writing…' : 'Write it now'}
            </button>
          </div>
          {digest ? (
            <>
              <p className="small">{digest.headline}</p>
              <ul className="filing-list">
                {digest.points.map((p, i) => (
                  <li key={i}>
                    <strong>{p.company}</strong>{' — '}{p.point}{' '}
                    {p.fileId && (
                      <a className="tiny" href={`/api/drive/files/${p.fileId}/content?disposition=inline`} target="_blank" rel="noreferrer">
                        filing
                      </a>
                    )}
                  </li>
                ))}
              </ul>
              <p className="tiny muted">From {digest.filings} filings, as CIP read them. Written every week.</p>
            </>
          ) : (
            <p className="tiny muted">
              A short note on what these companies filed is written every week, once their filings have been read.
            </p>
          )}
        </div>
      )}

      {feeds.map((feed) => (
        <div key={feed.id} className="filing-feed">
          <div className="row" style={{ justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
            <span>
              <strong>{feed.displayName}</strong> <span className="tiny muted">NSE: {feed.symbol}</span>{' '}
              {!feed.enabled && <Pill tone="neutral">Paused</Pill>}
            </span>
            <span className="row" style={{ gap: 6 }}>
              <span className="tiny muted">Checked {ago(feed.lastCheckedAt)}</span>
              <button type="button" className="btn btn-sm" disabled={busy !== null || !feed.enabled}
                onClick={() => void call(`check-${feed.id}`, `/api/market/feeds/${feed.id}`, { method: 'POST' }, 'Checked for new filings.')}>
                {busy === `check-${feed.id}` ? 'Checking…' : 'Check now'}
              </button>
              <button type="button" className="btn btn-sm btn-ghost" disabled={busy !== null}
                onClick={() => void call(`toggle-${feed.id}`, `/api/market/feeds/${feed.id}`, {
                  method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: !feed.enabled }),
                })}>
                {feed.enabled ? 'Pause' : 'Resume'}
              </button>
            </span>
          </div>
          {feed.lastError && <p className="tiny" style={{ color: 'var(--stop-700)', marginTop: 4 }}>{feed.lastError}</p>}
          {feed.recent.length > 0 ? (
            <ul className="filing-list">
              {feed.recent.map((item, i) => (
                <li key={i}>
                  <span className="tiny muted">{item.publishedAt ? item.publishedAt.slice(0, 10) : ''}</span>{' '}
                  {item.fileId ? (
                    <a href={`/api/drive/files/${item.fileId}/content?disposition=inline`} target="_blank" rel="noreferrer">
                      {item.category ?? 'Filing'}
                    </a>
                  ) : (item.category ?? 'Filing')}
                  {' — '}<span className="muted">{item.title.slice(0, 140)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="tiny muted" style={{ marginTop: 4 }}>Nothing fetched yet.</p>
          )}
        </div>
      ))}

      <form
        className="row filing-add"
        onSubmit={(e) => {
          e.preventDefault();
          void call('add', '/api/market/feeds', {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ symbol, name }),
          }, 'Watching it. New filings will be fetched on the next check.').then(() => { setSymbol(''); setName(''); });
        }}
      >
        <input value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder="NSE symbol, e.g. UNITDSPR" aria-label="NSE symbol" />
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name, e.g. United Spirits" aria-label="Company name" />
        <button type="submit" className="btn btn-sm" disabled={busy !== null || symbol.trim().length < 2}>
          Watch a company
        </button>
      </form>
    </section>
  );
}
