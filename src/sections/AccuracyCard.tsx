'use client';

import { useCallback, useEffect, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { useToast } from '@/context/toast';
import type { BenchmarkSummary } from '@/server/brain/benchmark';

/** Creatives of the set checked at once, as a batch is. */
const LANES = 3;

async function readSummary(res: Response | null): Promise<BenchmarkSummary | { message: string }> {
  const body = (await res?.json().catch(() => null)) as (BenchmarkSummary & { message?: string }) | null;
  if (!res?.ok || !body) return { message: body?.message ?? 'That did not work. Try again in a moment.' };
  return body;
}

/**
 * Marks a checked creative as one that should pass or should be flagged.
 *
 * Shown under a report. The person's answer becomes a case in the test set,
 * and every later run of the set is scored against it.
 */
export function TestSetMark({ checkId, page, verdict }: { checkId: string; page: number; verdict: string }) {
  const { note } = useToast();
  const [saved, setSaved] = useState<'pass' | 'flag' | null>(null);
  const [busy, setBusy] = useState(false);

  const mark = async (expected: 'pass' | 'flag') => {
    setBusy(true);
    try {
      const res = await fetch('/api/brain/benchmarks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ checkId, page, expected }),
      }).catch(() => null);
      const body = await readSummary(res);
      if ('message' in body) { note(body.message); return; }
      setSaved(expected);
      note('Added to the accuracy test set');
    } finally {
      setBusy(false);
    }
  };

  if (saved) {
    return (
      <p className="tiny muted qc-testset">
        <Icon name="check" size={12} /> In the test set: should {saved === 'pass' ? 'pass' : 'be flagged'}
      </p>
    );
  }
  return (
    <p className="tiny muted qc-testset">
      Is this verdict right? Add it to the test set as{' '}
      <button type="button" className="linkbtn" disabled={busy} onClick={() => void mark('pass')}>should pass</button>
      {' '}or{' '}
      <button type="button" className="linkbtn" disabled={busy} onClick={() => void mark('flag')}>
        should be flagged{verdict === 'fix' ? ' (for these rules)' : ''}
      </button>
    </p>
  );
}

/**
 * How often the checker gets the right answer.
 *
 * The test set is creatives a person has marked with their right answer. Run
 * it after anything changes - a rule, a prompt - and the score says whether
 * the checker got better or worse, and the list says where it went wrong.
 */
export function AccuracyCard() {
  const { note } = useToast();
  const [summary, setSummary] = useState<BenchmarkSummary | null>(null);
  const [running, setRunning] = useState<{ done: number; total: number } | null>(null);

  const load = useCallback(async () => {
    const res = await fetch('/api/brain/benchmarks', { cache: 'no-store' }).catch(() => null);
    const body = await readSummary(res);
    if (!('message' in body)) setSummary(body);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const run = async () => {
    const res = await fetch('/api/brain/benchmarks/runs', { method: 'POST' }).catch(() => null);
    const started = (await res?.json().catch(() => null)) as { runId?: string; ids?: string[]; message?: string } | null;
    if (!res?.ok || !started?.runId || !started.ids) { note(started?.message ?? 'The test set could not be started.'); return; }

    const { runId, ids } = started;
    let done = 0;
    let next = 0;
    setRunning({ done, total: ids.length });
    const lane = async () => {
      while (next < ids.length) {
        const id = ids[next]!;
        next += 1;
        const answer = await fetch(`/api/brain/benchmarks/runs/${runId}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ benchmarkId: id }),
        }).catch(() => null);
        const body = await readSummary(answer);
        if (!('message' in body)) setSummary(body);
        done += 1;
        setRunning({ done, total: ids.length });
      }
    };
    await Promise.all(Array.from({ length: Math.min(LANES, ids.length) }, lane));
    setRunning(null);
    await load();
  };

  const remove = async (id: string) => {
    const res = await fetch(`/api/brain/benchmarks/${id}`, { method: 'DELETE' }).catch(() => null);
    const body = await readSummary(res);
    if ('message' in body) note(body.message);
    else setSummary(body);
  };

  if (!summary) return null;
  const { items, lastRun } = summary;
  const wrong = items.filter((i) => i.last && !i.last.correct);
  const shouldPass = items.filter((i) => i.expected === 'pass').length;

  return (
    <section className="card pad accuracy" style={{ marginTop: 24 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ margin: 0 }}>Accuracy test set</h2>
          <p className="tiny muted">
            {items.length === 0
              ? 'Empty. Under any report, mark whether the creative should pass or be flagged to add it.'
              : `${items.length} creatives with a known right answer - ${shouldPass} should pass, ${items.length - shouldPass} should be flagged.`}
          </p>
        </div>
        {items.length > 0 && (
          <button type="button" className="btn btn-primary btn-sm" disabled={running !== null} onClick={() => void run()}>
            {running ? `Checking ${running.done} of ${running.total}…` : 'Run the test set'}
          </button>
        )}
      </div>

      {lastRun && lastRun.done > 0 && (
        <p className="accuracy-score">
          <strong>{Math.round((lastRun.correct / lastRun.done) * 100)}%</strong>{' '}
          <span className="small muted">
            {lastRun.correct} of {lastRun.done} right
            {lastRun.done < lastRun.total ? ` (${lastRun.total - lastRun.done} not checked)` : ''} ·{' '}
            {new Date(lastRun.at).toLocaleString()}
          </span>
        </p>
      )}

      {wrong.length > 0 && (
        <>
          <p className="small strong" style={{ marginTop: 12 }}>Where it went wrong</p>
          <ul className="accuracy-wrong">
            {wrong.map((item) => (
              <li key={item.id}>
                <span className="small strong">{item.fileName}{item.page > 1 ? `, page ${item.page}` : ''}</span>
                <span className="tiny">
                  {item.last!.got === 'error'
                    ? ` Could not be checked: ${item.last!.error ?? 'unknown error'}`
                    : item.last!.got !== item.expected
                      ? ` Should ${item.expected === 'pass' ? 'pass' : 'be flagged'}, CIP said ${item.last!.got === 'pass' ? 'pass' : 'flag'}.`
                      : ' Flagged, but not for every rule it breaks.'}
                </span>
                {item.last!.missed.length > 0 && <span className="tiny muted"> Missed: {item.last!.missed.join(' · ')}</span>}
                {item.expected === 'pass' && item.last!.extra.length > 0 && (
                  <span className="tiny muted"> Flagged: {item.last!.extra.join(' · ')}</span>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      {items.length > 0 && (
        <details style={{ marginTop: 12 }}>
          <summary className="small">Everything in the set</summary>
          <ul className="accuracy-items">
            {items.map((item) => (
              <li key={item.id}>
                <span className="small">{item.fileName}{item.page > 1 ? `, page ${item.page}` : ''}</span>
                <span className="tiny muted">
                  {' '}should {item.expected === 'pass' ? 'pass' : `be flagged${item.expectedRules.length ? ` for: ${item.expectedRules.join(' · ')}` : ''}`}
                </span>
                {item.last && <span className="tiny">{item.last.correct ? ' ✓' : ' ✗'}</span>}
                <button type="button" className="linkbtn tiny" onClick={() => void remove(item.id)}>Remove</button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
