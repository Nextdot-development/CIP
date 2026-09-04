'use client';

import type { CSSProperties } from 'react';
import { useWorkspace } from '@/context/workspace';
import { Card } from './ui/Bits';
import { Icon } from './ui/Icon';
import type { MetricView } from '@/lib/presentation';

const TONE: Record<MetricView['tone'], { bg: string; fg: string }> = {
  brand: { bg: 'var(--brand-soft)', fg: 'var(--brand-deep)' },
  ok: { bg: 'var(--ok-050)', fg: 'var(--ok-700)' },
  warn: { bg: 'var(--warn-050)', fg: 'var(--warn-700)' },
  stop: { bg: 'var(--stop-050)', fg: 'var(--stop-700)' },
  neutral: { bg: 'var(--ink-050)', fg: 'var(--ink-600)' },
};

/** Business numbers only. No tokens, no model costs, no telemetry. */
export function MonthlySummary() {
  const workspace = useWorkspace();
  const m = workspace.month;

  return (
    <Card
      title="This month at a glance"
      action={<span className="pill pill-neutral">{m.label}</span>}
    >
      <div className="metrics">
        {m.metrics.map((k) => {
          const tone = TONE[k.tone] ?? TONE.neutral;
          return (
            <div className="metric" key={k.label}>
              <span className="m-icon" style={{ background: tone.bg, color: tone.fg } as CSSProperties}>
                <Icon name={k.icon} size={17} />
              </span>
              <span className="stack grow">
                <span className="m-value">{k.value}</span>
                <span className="m-label">{k.label}</span>
                {k.note && <span className="m-label" style={{ marginTop: 4 }}>{k.note}</span>}
                {k.delta && (
                  <span className="m-delta">
                    <Icon name="trend" size={13} /> {k.delta}
                  </span>
                )}
              </span>
            </div>
          );
        })}
      </div>

    </Card>
  );
}
