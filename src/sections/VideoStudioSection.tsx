'use client';

import { useCallback, useEffect, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { useToast } from '@/context/toast';
import type { EditPlan, VideoEditDTO, VideoTemplateDTO } from '@/server/video/edit';

/** 83.4 as "1:23". */
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** A block that wants b-roll and has no answer yet (as the server counts it). */
const brollAsked = (b: EditPlan['blocks'][number]) => Boolean(b.visuals.trim()) && !b.footage && !b.brollSkipped;

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
  const EMPTY = { fileId: '', doctorName: '', doctorTitle: '', hospitalLine: '', givenPlan: '', brollIds: [] as string[] };
  const [form, setForm] = useState(EMPTY);
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
      setForm(EMPTY);
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
          Choose a recording. CIP cuts the fumbles, writes the on-screen text block by block (or uses yours, word for word), places
          your b-roll and checks every block against your rules. Any block still needing b-roll is asked about. You read the plan and
          approve it before the film is made.
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
          <input className="field-input" placeholder="Designation, e.g. Senior Consultant – Cardiology (optional)" value={form.doctorTitle}
            onChange={(e) => setForm({ ...form, doctorTitle: e.target.value })} />
          <input className="field-input" placeholder="Hospital | City, e.g. Narayana Health City | Bengaluru (optional)" value={form.hospitalLine}
            onChange={(e) => setForm({ ...form, hospitalLine: e.target.value })} />
          <label className="tiny muted video-wide">
            Your plan (optional) — paste the OST table, or write a block a paragraph: [00:12–00:40] a heading line, then a point a line,
            then &quot;Visuals: …&quot;. It goes on screen exactly as written; CIP only fits it to the recording. Leave empty and CIP writes it.
            <textarea className="field-input" rows={4} value={form.givenPlan}
              onChange={(e) => setForm({ ...form, givenPlan: e.target.value })} />
          </label>
          {recordings.length > 1 && (
            <div className="tiny muted video-wide">
              B-roll you already have (optional) — each block takes the clip that fits it. Anything not covered is asked about later.
              <div className="video-picks">
                {recordings.filter((r) => r.id !== form.fileId).map((r) => (
                  <label key={r.id} className="tiny">
                    <input type="checkbox" checked={form.brollIds.includes(r.id)} onChange={(e) => setForm({
                      ...form,
                      brollIds: e.target.checked ? [...form.brollIds, r.id] : form.brollIds.filter((x) => x !== r.id),
                    })} /> {r.name}
                  </label>
                ))}
              </div>
            </div>
          )}
          <button type="button" className="btn btn-primary btn-sm" disabled={planning || !form.fileId || !form.doctorName.trim()}
            onClick={() => void plan()}>
            {planning ? 'Listening and planning… about a minute' : 'Plan the edit'}
          </button>
        </div>
        <p className="tiny muted">Recordings and b-roll come from your Drive folder. Add a new one there and it appears here.</p>
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

      {open && <PlanEditor key={`${open.id}-${open.status}`} edit={open} footage={recordings} onChanged={() => void load()} />}
    </div>
  );
}

function PlanEditor({ edit, footage, onChanged }: {
  edit: VideoEditDTO; footage: { id: string; name: string }[]; onChanged: (e: VideoEditDTO) => void;
}) {
  const { note } = useToast();
  const [plan, setPlan] = useState<EditPlan | null>(edit.plan);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState<number | null>(null);
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
  const setBlock = (i: number, change: Partial<EditPlan['blocks'][number]>) =>
    setPlan({ ...plan, blocks: plan.blocks.map((b, j) => (j === i ? { ...b, ...change } : b)) });

  const concerns = plan.blocks.filter((b) => b.concern).length;
  const asked = plan.blocks.filter(brollAsked).length;
  const library = footage.filter((f) => f.id !== edit.sourceFileId);

  const uploadBroll = async (i: number, file: File) => {
    setUploading(i);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch('/api/drive/files', { method: 'POST', body: form }).catch(() => null);
      const body = (await res?.json().catch(() => null)) as { id?: string; name?: string; message?: string } | null;
      if (!res?.ok || !body?.id) { note(body?.message ?? 'The clip could not be uploaded.'); return; }
      setBlock(i, { footage: { fileId: body.id, fileName: body.name ?? file.name }, brollSkipped: false });
    } finally {
      setUploading(null);
    }
  };

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
      <p className="tiny muted">
        Name plate: {edit.doctorName}{edit.doctorTitle ? ` · ${edit.doctorTitle}` : ''}{edit.hospitalLine ? ` · ${edit.hospitalLine}` : ''}.
        {edit.givenPlan ? ' On-screen text is your own plan, word for word.' : ''}
      </p>

      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <p className="small strong video-head">On-screen text ({plan.blocks.length} blocks)</p>
        <a className="linkbtn tiny" href={`/api/video/edits/${edit.id}/ost`}>Download OST sheet</a>
      </div>
      {concerns > 0 && (
        <p className="tiny" style={{ color: 'var(--warn-700)' }}>
          <Icon name="alert" size={12} /> {concerns} block{concerns === 1 ? '' : 's'} may break a rule. Reword or remove before approving.
        </p>
      )}
      {asked > 0 && !locked && (
        <p className="tiny" style={{ color: 'var(--warn-700)' }}>
          <Icon name="alert" size={12} /> {asked} block{asked === 1 ? ' needs' : 's need'} b-roll. Answer each question below to approve.
        </p>
      )}
      {plan.blocks.map((b, i) => (
        <div key={i} className={`video-block ${b.concern ? 'has-concern' : ''}`}>
          <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
            <span className="tiny muted">{clock(b.from)}–{clock(b.to)}</span>
            {!locked && (
              <button type="button" className="linkbtn tiny"
                onClick={() => setPlan({ ...plan, blocks: plan.blocks.filter((_, j) => j !== i) })}>Remove</button>
            )}
          </div>
          <input className="field-input video-heading" value={b.heading} disabled={locked}
            onChange={(e) => setBlock(i, { heading: e.target.value })} />
          <textarea className="field-input" rows={Math.max(2, b.bullets.length)} disabled={locked}
            value={b.bullets.join('\n')} placeholder="One pointer a line"
            onChange={(e) => setBlock(i, { bullets: e.target.value.split('\n') })} />
          {brollAsked(b) && !locked ? (
            <div className="video-broll">
              <span className="tiny strong">B-roll needed: {b.visuals}</span>
              <div className="row">
                <select className="field-input" value="" onChange={(e) => {
                  const f = library.find((x) => x.id === e.target.value);
                  if (f) setBlock(i, { footage: { fileId: f.id, fileName: f.name }, brollSkipped: false });
                }}>
                  <option value="">{b.suggestion ? `Suggested: ${b.suggestion.fileName}` : 'Choose from your library…'}</option>
                  {b.suggestion && <option value={b.suggestion.fileId}>Use {b.suggestion.fileName}</option>}
                  {library.filter((f) => f.id !== b.suggestion?.fileId).map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                </select>
                <label className="btn btn-sm">
                  {uploading === i ? 'Uploading…' : 'Upload a clip'}
                  <input type="file" accept="video/*" hidden disabled={uploading !== null}
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadBroll(i, f); }} />
                </label>
                <button type="button" className="linkbtn tiny" onClick={() => setBlock(i, { brollSkipped: true })}>
                  No b-roll — keep the doctor
                </button>
              </div>
            </div>
          ) : (
            <p className="tiny muted">
              Visuals: {b.visuals || '—'} · {b.footage ? `b-roll: ${b.footage.fileName}` : b.brollSkipped ? 'no b-roll, the doctor stays on screen' : 'no b-roll'}
              {!locked && (b.footage || b.brollSkipped) && (
                <> · <button type="button" className="linkbtn tiny" onClick={() => setBlock(i, { footage: null, brollSkipped: false })}>Change</button></>
              )}
            </p>
          )}
          {b.concern && <p className="tiny video-concern">{b.concern}{b.rules.length ? ` — ${b.rules.join('; ')}` : ''}</p>}
        </div>
      ))}

      <p className="small strong video-head">Cut out ({plan.cuts.length})</p>
      {plan.cuts.length === 0 && <p className="tiny muted">Nothing to cut.</p>}
      {plan.cuts.map((c, i) => (
        <div key={i} className="video-item">
          <span className="tiny muted">{clock(c.from)}–{clock(c.to)}</span>
          <span className="small">{c.reason}</span>
          {!locked && (
            <button type="button" className="linkbtn tiny"
              onClick={() => setPlan({ ...plan, cuts: plan.cuts.filter((_, j) => j !== i) })}>Keep it in</button>
          )}
        </div>
      ))}

      {!locked && (
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button type="button" className="btn btn-sm" disabled={saving} onClick={() => void save(false)}>Save changes</button>
          <button type="button" className="btn btn-primary btn-sm" disabled={saving || !plan.title.trim() || asked > 0} onClick={() => void save(true)}>
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
  const [videos, setVideos] = useState<{ id: string; name: string }[]>([]);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    void send<{ template: VideoTemplateDTO }>('/api/video/template').then((b) => { if (!failed(b)) setT(b.template); });
    void send<{ recordings: { id: string; name: string }[] }>('/api/video/recordings').then((b) => { if (!failed(b)) setVideos(b.recordings); });
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
        <label className="tiny muted">Logo corner (horizontal films)
          <select className="field-input" value={t.logoCorner}
            onChange={(e) => setT({ ...t, logoCorner: e.target.value as VideoTemplateDTO['logoCorner'] })}>
            <option value="top-right">Top right</option>
            <option value="top-left">Top left</option>
          </select>
        </label>
        {(['background', 'accent', 'ink'] as const).map((k) => (
          <label key={k} className="tiny muted">{k === 'ink' ? 'Text colour' : k === 'accent' ? 'Accent (panel bar, name)' : 'Brand colour (panels)'}
            <input type="color" value={t[k]} onChange={(e) => setT({ ...t, [k]: e.target.value })} />
          </label>
        ))}
        <label className="tiny muted">Disclaimer seconds
          <input className="field-input" type="number" step="0.5" value={t.disclaimerSeconds} onChange={(e) => setT({ ...t, disclaimerSeconds: Number(e.target.value) })} />
        </label>
        <label className="tiny muted video-wide">Disclaimer, exactly as approved (a band after the doctor&apos;s introduction)
          <textarea className="field-input" rows={2} value={t.disclaimerText ?? ''} onChange={(e) => setT({ ...t, disclaimerText: e.target.value })} />
        </label>
        {([['endVideoFileId', 'End screen video, horizontal'], ['endVideoVerticalFileId', 'End screen video, vertical']] as const).map(([k, label]) => (
          <label key={k} className="tiny muted">{label}
            <select className="field-input" value={t[k] ?? ''} onChange={(e) => setT({ ...t, [k]: e.target.value || null })}>
              <option value="">Draw one (logo and tagline)</option>
              {videos.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
          </label>
        ))}
        <label className="tiny muted">Tagline on a drawn end screen
          <input className="field-input" placeholder="Take Care" value={t.tagline ?? ''} onChange={(e) => setT({ ...t, tagline: e.target.value })} />
        </label>
        <label className="tiny muted">Drawn end screen seconds
          <input className="field-input" type="number" step="0.5" value={t.outroSeconds} onChange={(e) => setT({ ...t, outroSeconds: Number(e.target.value) })} />
        </label>
      </div>
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
        <button type="button" className="btn btn-sm" disabled={saving} onClick={() => void save()}>Save template</button>
      </div>
    </details>
  );
}
