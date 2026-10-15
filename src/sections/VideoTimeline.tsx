'use client';

import { useEffect, useRef, useState } from 'react';
import type { EditPlan } from '@/server/video/edit';

type Cut = EditPlan['cuts'][number];

const clock = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * The recording on a timeline: its sound drawn as a waveform, the cuts over
 * it in red, the on-screen text blocks above it in blue. Drag a cut's edge to
 * move it, drag across the sound to add one, × to keep a part in. The
 * recording plays beside it with the cuts skipped, so the edit is heard as it
 * will be - before anything is made.
 */
export function VideoTimeline({ editId, duration, cuts, blocks, locked, onChange }: {
  editId: string;
  duration: number;
  cuts: Cut[];
  blocks: EditPlan['blocks'];
  locked: boolean;
  onChange: (cuts: Cut[]) => void;
}) {
  const strip = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [at, setAt] = useState(0);
  const [skip, setSkip] = useState(true);
  const [drag, setDrag] = useState<{ kind: 'edge'; index: number; edge: 'from' | 'to' } | { kind: 'new'; start: number; end: number } | null>(null);
  const latest = useRef({ cuts, onChange });
  useEffect(() => { latest.current = { cuts, onChange }; });

  const timeAt = (clientX: number) => {
    const rect = strip.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0;
    return clamp(((clientX - rect.left) / rect.width) * duration, 0, duration);
  };
  const pct = (t: number) => `${(clamp(t, 0, duration) / duration) * 100}%`;
  const seek = (t: number) => {
    if (video.current) video.current.currentTime = t;
    setAt(t);
  };

  // Dragging: follow the pointer anywhere on the page until it is let go.
  useEffect(() => {
    if (!drag) return;
    const move = (e: PointerEvent) => {
      const t = timeAt(e.clientX);
      if (drag.kind === 'new') {
        setDrag({ ...drag, end: t });
        return;
      }
      latest.current.onChange(latest.current.cuts.map((c, i) => {
        if (i !== drag.index) return c;
        return drag.edge === 'from' ? { ...c, from: Math.min(t, c.to - 0.05) } : { ...c, to: Math.max(t, c.from + 0.05) };
      }));
    };
    const up = () => {
      if (drag.kind === 'new') {
        const from = Math.min(drag.start, drag.end);
        const to = Math.max(drag.start, drag.end);
        if (to - from >= 0.1) {
          latest.current.onChange([...latest.current.cuts, { from, to, reason: 'Cut by hand' }].sort((a, b) => a.from - b.from));
        } else {
          seek(from);
        }
      }
      setDrag(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [drag]); // eslint-disable-line react-hooks/exhaustive-deps

  // Playing with the cuts skipped: a moment inside a cut jumps to its end.
  const onTime = () => {
    const v = video.current;
    if (!v) return;
    if (skip && !v.paused) {
      const inside = latest.current.cuts.find((c) => v.currentTime >= c.from && v.currentTime < c.to - 0.02);
      if (inside) v.currentTime = inside.to;
    }
    setAt(v.currentTime);
  };

  const cutSeconds = cuts.reduce((n, c) => n + Math.max(0, c.to - c.from), 0);

  return (
    <div className="video-timeline">
      <div className="video-timeline-top">
        <video ref={video} src={`/api/video/edits/${editId}/source`} controls preload="metadata" onTimeUpdate={onTime} className="video-timeline-player" />
        <div className="tiny muted video-timeline-help">
          <label className="small">
            <input type="checkbox" checked={skip} onChange={(e) => setSkip(e.target.checked)} /> Play with the cuts skipped
          </label>
          <span>{clock(at)} · {cuts.length} cuts take out {cutSeconds.toFixed(1)} s of {duration.toFixed(1)} s</span>
          {!locked && <span>Drag across the sound to cut a part · drag a red edge to move it · × keeps a part in.</span>}
        </div>
      </div>

      <div className="video-timeline-blocks">
        {blocks.map((b, i) => (
          <span key={i} className={`video-timeline-block ${b.heading ? '' : 'is-broll'}`}
            style={{ left: pct(b.from), width: `calc(${pct(b.to)} - ${pct(b.from)})` }}
            title={`${clock(b.from)}–${clock(b.to)} ${b.heading || 'B-roll'}`}>{b.heading || 'B-roll'}</span>
        ))}
      </div>

      <div ref={strip} className="video-timeline-strip"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          const t = timeAt(e.clientX);
          if (locked) { seek(t); return; }
          setDrag({ kind: 'new', start: t, end: t });
        }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={`/api/video/edits/${editId}/waveform`} alt="" draggable={false} className="video-timeline-wave" />
        {cuts.map((c, i) => (
          <div key={`${i}-${c.from}`} className="video-timeline-cut" style={{ left: pct(c.from), width: `calc(${pct(c.to)} - ${pct(c.from)})` }}
            title={`${clock(c.from)}–${clock(c.to)} ${c.reason}`} onPointerDown={(e) => e.stopPropagation()}>
            {!locked && (
              <>
                <span className="video-timeline-edge is-from" onPointerDown={(e) => { e.stopPropagation(); setDrag({ kind: 'edge', index: i, edge: 'from' }); }} />
                <span className="video-timeline-edge is-to" onPointerDown={(e) => { e.stopPropagation(); setDrag({ kind: 'edge', index: i, edge: 'to' }); }} />
                <button type="button" className="video-timeline-x" title="Keep this part in"
                  onClick={() => onChange(cuts.filter((_, j) => j !== i))}>×</button>
              </>
            )}
          </div>
        ))}
        {drag?.kind === 'new' && (
          <div className="video-timeline-cut is-new"
            style={{ left: pct(Math.min(drag.start, drag.end)), width: `calc(${pct(Math.max(drag.start, drag.end))} - ${pct(Math.min(drag.start, drag.end))})` }} />
        )}
        <span className="video-timeline-head" style={{ left: pct(at) }} />
      </div>
    </div>
  );
}
