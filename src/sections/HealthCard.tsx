'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Icon } from '../components/ui/Icon';
import type { HealthReport } from '@/server/jobs/health';

/** "12 min ago", roughly. */
function ago(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

/**
 * Whether CIP is keeping up.
 *
 * One quiet line when it is. When it is not, each problem in a sentence, with
 * where to go about it - the pump once stopped for days and nobody knew.
 */
export function HealthCard() {
  const [health, setHealth] = useState<HealthReport | null>(null);

  useEffect(() => {
    let stopped = false;
    void fetch('/api/health', { cache: 'no-store' })
      .then((res) => (res.ok ? (res.json() as Promise<HealthReport>) : null))
      .then((body) => { if (!stopped && body) setHealth(body); })
      .catch(() => {});
    return () => { stopped = true; };
  }, []);

  if (!health) return null;
  const { pump, problems, spend } = health;

  // What AI cost this month, biggest part first. Shown whether or not
  // anything is wrong: it is the other thing an owner wants to know.
  const money = (usd: number) => (usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`);
  const spendLine = spend && spend.month > 0 && (
    <p className="tiny muted health-spend">
      AI this month: <strong>{money(spend.month)}</strong>
      {spend.parts.length > 0 && ` · ${spend.parts.slice(0, 4).map((p) => `${p.label} ${money(p.usd)}`).join(' · ')}`}
    </p>
  );

  if (problems.length === 0) {
    return (
      <>
        <p className="tiny muted health-ok">
          <Icon name="check" size={12} /> Keeping up · background work last ran {pump.lastFinishedAt ? ago(pump.lastFinishedAt) : 'recently'}
          {pump.scheduled ? ', every 15 minutes' : ''}
        </p>
        {spendLine}
      </>
    );
  }

  const stopping = problems.some((p) => p.severity === 'stop');
  return (
    <section className={`card pad health ${stopping ? 'is-stop' : 'is-warn'}`}>
      <p className="small strong">
        <Icon name="alert" size={14} /> {stopping ? 'CIP has fallen behind' : 'A few things need a look'}
      </p>
      <ul>
        {problems.map((p, i) => (
          <li key={i} className="small">
            {p.text}{' '}
            {p.href && <Link href={p.href as '/trust'}>See</Link>}
          </li>
        ))}
      </ul>
      {pump.lastFinishedAt && (
        <p className="tiny muted">Background work last ran {ago(pump.lastFinishedAt)} · {pump.passesLastDay} passes in the last day</p>
      )}
      {spendLine}
    </section>
  );
}
