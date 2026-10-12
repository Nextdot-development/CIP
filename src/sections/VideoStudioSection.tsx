'use client';

import { useCallback, useEffect, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { useToast } from '@/context/toast';
import type { EditPlan, VideoEditDTO, VideoTemplateDTO } from '@/server/video/edit';

/** 83.4 as "1:23". */
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

const STATUS: Record<VideoEditDTO['status'], string> = {
  planning: 'Planning…',
  planned: 'Plan ready to review',
  approved: 'Waiting to be made',
  rendering: 'Being made…',
  ready: 'Film ready',
  failed: 'Could not be made',
};

async function send<T>(url: string, init?: RequestInit): Promise<T | { message: string }> {
  const res = await fetch(url, init).catch(() => null);
  const body = (await res?.json().catch(() => null)) as (T & { message?: string }) | null;
  if (!res?.ok || !body) return { message: body?.message ?? 'That did not work. Try again in a moment.' };
  return body;
}
const failed = (x: unknown): x is { message: string } => typeof x === 'object' && x !== null && 'message' in x && Object.keys(x).length === 1;

/**
 * A doctor's recording into a finished film in the house template.
 *
 * Choose the recording and say who the doctor is; CIP hears it and plans the
 * edit - what to cut, the title, the key points, the b-roll. A person reads
 * the plan, changes what they like, and approves it; only then is the film
 * made. Every key point is shown with any rule it might break.
 */
export function VideoStudioSection() {
  const { note } = useToast();
  const [edits, setEdits] = useState<VideoEditDTO[]>([]);
  const [recordings, setRecordings] = useState<{ id: string; name: string }[]>([]);
  // Which film is open; what it says is always read from the list.
  const [openId, setOpenId] = useState<string | null>(null);
  const [form, setForm] = useState({ fileId: '', doctorName: '', doctorTitle: '' });
  const [planning, setPlanning] = useState(false);

  const load = useCallback(async () => {
    const [e, r] = await Promise.all([
      send<{ edits: VideoEditDTO[] }>('/api/video/edits'),
      send<{ recordings: { id: string; name: string }[] }>('/api/video/recordings'),
    ]);
    if (!failed(e)) setEdits(e.edits);
    if (!failed(r)) setRecordings(r.recordings);
  }, []);
  useEffect(() => { void load(); }, [load]);

  // While a film is being made, look again every few seconds.
  const busy = edits.some((e) => e.status === 'approved' || e.status === 'rendering');
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => void load(), 8_000);
    return () => clearInterval(timer);
  }, [busy, load]);
  const open = edits.find((e) => e.id === openId) ?? null;

  const plan = async () => {
    setPlanning(true);
    try {
      const body = await send<{ edit: VideoEditDTO }>('/api/video/edits', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(form),
      });
      if (failed(body)) { note(body.message); return; }
      setOpenId(body.edit.id);
      setForm({ fileId: '', doctorName: '', doctorTitle: '' });
      await load();
    } finally {
      setPlanning(false);
    }
  };

  return (
    <div className="rise">
      <header className="page-head">
        <p className="eyebrow">Video Studio</p>
        <h1>Doctor recordings into finished films</h1>
        <p className="lede">
          Choose a recording. CIP cuts the fumbles, writes the title and key points, finds b-roll in your library and
          checks every point against your rules. You read the plan and approve it before the film is made.
        </p>
      </header>

      <TemplateCard />

      <section className="card pad" style={{ marginTop: 16 }}>
        <p className="strong">New film</p>
        <div className="video-form">
          <select className="field-input" value={form.fileId} onChange={(e) => setForm({ ...form, fileId: e.target.value })}>
            <option value="">Choose a recording…</option>
            {recordings.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
          <input className="field-input" placeholder="Doctor's name, e.g. Dr. A. Kumar" value={form.doctorName}
            onChange={(e) => setForm({ ...form, doctorName: e.target.value })} />
          <input className="field-input" placeholder="Speciality, e.g. Neurology (optional)" value={form.doctorTitle}
            onChange={(e) => setForm({ ...form, doctorTitle: e.target.value })} />
          <button type="button" className="btn btn-primary btn-sm" disabled={planning || !form.fileId || !form.doctorName.trim()}
            onClick={() => void plan()}>
            {planning ? 'Listening and planning… about a minute' : 'Plan the edit'}
          </button>
        </div>
        <p className="tiny muted">Recordings come from your Drive folder. Add a new one there and it appears here.</p>
      </section>

      {edits.length > 0 && (
        <section className="card pad" style={{ marginTop: 16 }}>
          <p className="strong">Films</p>
          <ul className="video-list">
            {edits.map((e) => (
              <li key={e.id}>
                <button type="button" className={`video-row ${open?.id === e.id ? 'is-open' : ''}`} onClick={() => setOpenId(e.id)}>
                  <span className="small strong">{e.plan?.title || e.sourceName}</span>
                  <span className="tiny muted">{e.doctorName}</span>
                  <span className={`tiny video-status s-${e.status}`}>{STATUS[e.status]}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {open && <PlanEditor key={`${open.id}-${open.status}`} edit={open} onChanged={() => void load()} />}
    </div>
  );
}

function PlanEditor({ edit, onChanged }: { edit: VideoEditDTO; onChanged: (e: VideoEditDTO) => void }) {
  const { note } = useToast();
  const [plan, setPlan] = useState<EditPlan | null>(edit.plan);
  const [saving, setSaving] = useState(false);
  const locked = edit.status === 'approved' || edit.status === 'rendering' || edit.status === 'planning';

  if (edit.status === 'failed' && !edit.plan) {
    return <section className="card pad" style={{ marginTop: 16 }}><p className="small"><Icon name="alert" size={14} /> {edit.error}</p></section>;
  }
  if (!plan) return null;

  const save = async (approve: boolean) => {
    setSaving(true);
    try {
      const saved = await send<{ edit: VideoEditDTO }>(`/api/video/edits/${edit.id}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ plan }),
      });
      if (failed(saved)) { note(saved.message); return; }
      if (!approve) { note('Saved'); onChanged(saved.edit); return; }
      const approved = await send<{ edit: VideoEditDTO }>(`/api/video/edits/${edit.id}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'approve' }),
      });
      if (failed(approved)) { note(approved.message); return; }
      note('Approved. The film is being made.');
      onChanged(approved.edit);
    } finally {
      setSaving(false);
    }
  };
  const drop = <K extends 'cuts' | 'points' | 'broll'>(key: K, i: number) =>
    setPlan({ ...plan, [key]: plan[key].filter((_, j) => j !== i) });

  const concerns = plan.points.filter((p) => p.concern).length;

  return (
    <section className="card pad" style={{ marginTop: 16 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <p className="strong">{edit.sourceName}</p>
        <span className={`tiny video-status s-${edit.status}`}>{STATUS[edit.status]}</span>
      </div>
      {edit.error && <p className="small" style={{ color: 'var(--stop-700)' }}>{edit.error}</p>}

      {edit.status === 'ready' && (
        <div style={{ margin: '12px 0' }}>
          <video src={`/api/video/edits/${edit.id}/film?disposition=inline`} controls style={{ width: '100%', maxHeight: 420, borderRadius: 8 }} />
          <a className="btn btn-sm" href={`/api/video/edits/${edit.id}/film`} style={{ marginTop: 8 }}>
            <Icon name="download" size={14} /> Download
          </a>
        </div>
      )}

      <label className="tiny muted">Title</label>
      <input className="field-input" value={plan.title} disabled={locked} onChange={(e) => setPlan({ ...plan, title: e.target.value })} />
      <p className="tiny muted">Shown at the start with {edit.doctorName}{edit.doctorTitle ? ` · ${edit.doctorTitle}` : ''}.</p>

      <p className="small strong video-head">Key points on screen</p>
      {concerns > 0 && (
        <p className="tiny" style={{ color: 'var(--warn-700)' }}>
          <Icon name="alert" size={12} /> {concerns} point{concerns === 1 ? '' : 's'} may break a rule. Reword or remove before approving.
        </p>
      )}
      {plan.points.map((p, i) => (
        <div key={i} className={`video-item ${p.concern ? 'has-concern' : ''}`}>
          <span className="tiny muted">{clock(p.from)}–{clock(p.to)}</span>
          <input className="field-input" value={p.text} disabled={locked}
            onChange={(e) => setPlan({ ...plan, points: plan.points.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)) })} />
          {!locked && <button type="button" className="linkbtn tiny" onClick={() => drop('points', i)}>Remove</button>}
          {p.concern && <p className="tiny video-concern">{p.concern}{p.rules.length ? ` — ${p.rules.join('; ')}` : ''}</p>}
        </div>
      ))}

      <p className="small strong video-head">Cut out ({plan.cuts.length})</p>
      {plan.cuts.length === 0 && <p className="tiny muted">Nothing to cut.</p>}
      {plan.cuts.map((c, i) => (
        <div key={i} className="video-item">
          <span className="tiny muted">{clock(c.from)}–{clock(c.to)}</span>
          <span className="small">{c.reason}</span>
          {!locked && <button type="button" className="linkbtn tiny" onClick={() => drop('cuts', i)}>Keep it in</button>}
        </div>
      ))}

      <p className="small strong video-head">B-roll</p>
      {plan.broll.length === 0 && <p className="tiny muted">None.</p>}
      {plan.broll.map((b, i) => (
        <div key={i} className="video-item">
          <span className="tiny muted">{clock(b.from)}–{clock(b.to)}</span>
          <span className="small">{b.query}</span>
          <span className="tiny muted">{b.fileName ?? 'No matching footage in your library'}</span>
          {!locked && <button type="button" className="linkbtn tiny" onClick={() => drop('broll', i)}>Remove</button>}
        </div>
      ))}

      {!locked && (
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button type="button" className="btn btn-sm" disabled={saving} onClick={() => void save(false)}>Save changes</button>
          <button type="button" className="btn btn-primary btn-sm" disabled={saving || !plan.title.trim()} onClick={() => void save(true)}>
            {edit.status === 'ready' ? 'Make it again' : 'Approve & make film'}
          </button>
        </div>
      )}
    </section>
  );
}

/** The fixed frames around every film. */
function TemplateCard() {
  const { note } = useToast();
  const [t, setT] = useState<VideoTemplateDTO | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    void send<{ template: VideoTemplateDTO }>('/api/video/template').then((b) => { if (!failed(b)) setT(b.template); });
  }, []);
  if (!t) return null;

  const uploadLogo = async (file: File) => {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch('/api/drive/files', { method: 'POST', body: form }).catch(() => null);
    if (!res?.ok) { note('The logo could not be uploaded. Use a PNG under 4 MB.'); return; }
    setT({ ...t, logoFileId: ((await res.json()) as { id: string }).id });
  };
  const save = async () => {
    setSaving(true);
    try {
      const body = await send<{ template: VideoTemplateDTO }>('/api/video/template', {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(t),
      });
      if (failed(body)) note(body.message);
      else { setT(body.template); note('Template saved'); }
    } finally {
      setSaving(false);
    }
  };

  return (
    <details className="card pad" style={{ marginTop: 16 }}>
      <summary className="small strong" style={{ cursor: 'pointer' }}>
        House template {t.disclaimerText ? '' : '· add your disclaimer'}
      </summary>
      <div className="video-template">
        <label className="tiny muted">Logo {t.logoFileId ? '(set)' : ''}
          <input type="file" accept="image/png,image/jpeg" onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadLogo(f); }} />
        </label>
        {(['background', 'accent', 'ink'] as const).map((k) => (
          <label key={k} className="tiny muted">{k === 'ink' ? 'Text colour' : k === 'accent' ? 'Accent colour' : 'Background'}
            <input type="color" value={t[k]} onChange={(e) => setT({ ...t, [k]: e.target.value })} />
          </label>
        ))}
        <label className="tiny muted">Intro seconds
          <input className="field-input" type="number" step="0.5" value={t.introSeconds} onChange={(e) => setT({ ...t, introSeconds: Number(e.target.value) })} />
        </label>
        <label className="tiny muted">End screen seconds
          <input className="field-input" type="number" step="0.5" value={t.outroSeconds} onChange={(e) => setT({ ...t, outroSeconds: Number(e.target.value) })} />
        </label>
        <label className="tiny muted video-wide">Disclaimer, exactly as approved (shown before the end screen)
          <textarea className="field-input" rows={2} value={t.disclaimerText ?? ''} onChange={(e) => setT({ ...t, disclaimerText: e.target.value })} />
        </label>
        <label className="tiny muted video-wide">End screen line, e.g. website or helpline
          <input className="field-input" value={t.endScreenText ?? ''} onChange={(e) => setT({ ...t, endScreenText: e.target.value })} />
        </label>
      </div>
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
        <button type="button" className="btn btn-sm" disabled={saving} onClick={() => void save()}>Save template</button>
      </div>
    </details>
  );
}
