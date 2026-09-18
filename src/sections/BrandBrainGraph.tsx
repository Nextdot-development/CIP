'use client';

import { useState } from 'react';
import type { ProductBrainDTO } from '@/server/brain/productBrain';

/**
 * The Product Brain graph: the brand's DNA at the centre, six areas around it,
 * and the strongest few things in each area hanging off it.
 *
 * Drawn as one SVG on a fixed coordinate plane so it scales with the page
 * rather than overflowing it. Hovering or focusing a dot shows what it is -
 * the words CIP actually stored, not a label written for the picture.
 */
const W = 900;
const H = 540;
const CX = W / 2;
const CY = H / 2;

type Tip = { x: number; y: number; label: string; detail: string };

export function BrandBrainGraph({ brain }: { brain: ProductBrainDTO }) {
  const [tip, setTip] = useState<Tip | null>(null);
  const n = brain.clusters.length;

  const placed = brain.clusters.map((cluster, i) => {
    const angle = -Math.PI / 2 + Math.PI / n + (i * 2 * Math.PI) / n;
    const x = CX + Math.cos(angle) * 255;
    const y = CY + Math.sin(angle) * 172;
    const leaves = cluster.leaves.map((leaf, j) => {
      const spread = (j - (cluster.leaves.length - 1) / 2) * 0.62;
      const a = angle + spread;
      return {
        ...leaf,
        x: Math.min(W - 18, Math.max(18, x + Math.cos(a) * 108)),
        y: Math.min(H - 16, Math.max(16, y + Math.sin(a) * 84)),
      };
    });
    return { ...cluster, x, y, leaves };
  });

  const coreLabel = brain.brand ?? 'All brands';

  return (
    <div className="graphwrap" onMouseLeave={() => setTip(null)}>
      {brain.updatedAgo && (
        <div className="livepill">
          <span className="livedot" />
          Live — updated {brain.updatedAgo}
        </div>
      )}
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Brand DNA of ${coreLabel}, in six areas`}>
        {placed.map((c) => (
          <line
            key={`e-${c.key}`}
            className={`edge-core ${c.count === 0 ? 'is-empty' : ''}`}
            x1={CX}
            y1={CY}
            x2={c.x}
            y2={c.y}
          />
        ))}
        {placed.flatMap((c) =>
          c.leaves.map((leaf, j) => (
            <line key={`l-${c.key}-${j}`} className="edge-leaf" x1={c.x} y1={c.y} x2={leaf.x} y2={leaf.y} />
          )),
        )}

        <g className="core">
          <circle cx={CX} cy={CY} r={56} className="core-halo" />
          <circle cx={CX} cy={CY} r={48} className="core-dot" />
          <text x={CX} y={CY - 4} className="corelabel">Brand</text>
          <text x={CX} y={CY + 13} className="corelabel">DNA</text>
        </g>

        {placed.map((c) => (
          <g key={c.key} className={`cluster ${c.count === 0 ? 'is-empty' : ''}`}>
            <circle cx={c.x} cy={c.y} r={30} />
            <text x={c.x} y={c.y + 5} className="clustercount">{c.count}</text>
            <text x={c.x} y={c.y + 50} className="clusterlabel">{c.label}</text>
            <text x={c.x} y={c.y + 65} className="clusterunit">
              {c.count === 0 ? 'nothing learned yet' : `${c.count} ${c.unit}`}
            </text>
          </g>
        ))}

        {placed.flatMap((c) =>
          c.leaves.map((leaf, j) => (
            <circle
              key={`d-${c.key}-${j}`}
              className="leaf"
              cx={leaf.x}
              cy={leaf.y}
              r={6}
              tabIndex={0}
              aria-label={`${c.label}: ${leaf.label} — ${leaf.detail}`}
              onMouseEnter={() => setTip({ x: leaf.x, y: leaf.y, label: leaf.label, detail: leaf.detail })}
              onFocus={() => setTip({ x: leaf.x, y: leaf.y, label: leaf.label, detail: leaf.detail })}
              onBlur={() => setTip(null)}
            />
          )),
        )}
      </svg>

      {tip && (
        <div
          className={`leaftip ${tip.x > W * 0.62 ? 'is-left' : ''}`}
          style={{ left: `${(tip.x / W) * 100}%`, top: `${(tip.y / H) * 100}%` }}
          role="tooltip"
        >
          <span className="leaftip-k">{tip.label}</span>
          <span>{tip.detail}</span>
        </div>
      )}

      <div className="legend">
        <div className="item"><span className="sw sw-core" />Core DNA</div>
        <div className="item"><span className="sw sw-area" />Area</div>
        <div className="item"><span className="sw sw-signal" />Signal — hover to read</div>
      </div>
    </div>
  );
}
