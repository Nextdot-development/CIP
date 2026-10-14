'use client';

import { useCallback, useEffect, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { useToast } from '@/context/toast';
import type { EditPlan, VideoEditDTO, VideoTemplateDTO } from '@/server/video/edit';

/** 83.4 as "1:23". */
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** A block that wants b-roll and has no answer yet (as the server counts it). */
const brollAsked = (b: EditPlan['blocks'][number]) => Boolean(b.visuals.trim()) && !b.footage && !b.brollSkipped;

/** Where a film stands, in words - saying so when it is waiting on the person. */
function statusOf(e: VideoEditDTO): { text: string; tone: string } {
  if (e.status === 'planned' && e.plan) {
    const asked = e.plan.blocks.filter(brollAsked).length;
    if (asked > 0) return { text: `Needs b-roll (${asked}) — open to answer`, tone: 's-asking' };
    if (e.plan.blocks.some((b) => b.concern)) return { text: 'Check a block, then approve', tone: 's-asking' };
  }
  return { text: STATUS[e.status], tone: `s-${e.status}` };
}

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
  const EMPTY = { fileId: '', doctorName: '', doctorTitle: '', hospitalLine: '', givenPlan: '', brollIds: [] as string[], autoMake: false, noBroll: false };
  const [form, setForm] = useState(EMPTY);
  const [planning, setPlanning] = useState(false);
  const [uploading, setUploading] = useState<'recording' | 'broll' | null>(null);
  // Which list a Google Drive pick goes into, while the picker is open.
  const [picking, setPicking] = useState<'recording' | 'broll' | null>(null);
  // "Make it straight away" follows the plan box until a person sets it.
  const [autoTouched, setAutoTouched] = useState(false);

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
  // The film a person opens is brought into view: it sits below the list.
  useEffect(() => {
    if (openId) document.getElementById('video-open')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [openId]);

  /** A video now in the workspace joins the lists, and is chosen. */
  const take = (added: { id: string; name: string }[], kind: 'recording' | 'broll') => {
    setRecordings((r) => [...added, ...r.filter((x) => !added.some((a) => a.id === x.id))]);
    setForm((f) => kind === 'recording'
      ? { ...f, fileId: added[0]!.id }
      : { ...f, brollIds: [...new Set([...f.brollIds, ...added.map((a) => a.id)])] });
  };

  /** Uploads to the workspace's files; the new videos join the lists here. */
  const upload = async (files: File[], kind: 'recording' | 'broll') => {
    setUploading(kind);
    try {
      const added: { id: string; name: string }[] = [];
      for (const file of files) {
        const data = new FormData();
        data.append('file', file);
        const res = await fetch('/api/drive/files', { method: 'POST', body: data }).catch(() => null);
        const body = (await res?.json().catch(() => null)) as { id?: string; name?: string; message?: string } | null;
        if (!res?.ok || !body?.id) { note(body?.message ?? `${file.name} could not be uploaded.`); continue; }
        added.push({ id: body.id, name: body.name ?? file.name });
      }
      if (added.length > 0) take(added, kind);
    } finally {
      setUploading(null);
    }
  };

  const plan = async () => {
    setPlanning(true);
    try {
      const body = await send<{ edit: VideoEditDTO }>('/api/video/edits', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(form),
      });
      if (failed(body)) { note(body.message); return; }
      if (body.edit.status === 'approved') note('Planned and sent to be made. It appears below when ready.');
      setOpenId(body.edit.id);
      setForm(EMPTY);
      setAutoTouched(false);
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
          Choose a recording - from here, your computer or Google Drive. Paste your own plan and CIP makes the film from it word for
          word, asking only for b-roll it does not have. Leave the plan empty and CIP writes it - cutting the fumbles and checking every
          block against your rules - for you to read and approve.
        </p>
      </header>

      <TemplateCard />

      <section className="card pad" style={{ marginTop: 16 }}>
        <p className="strong">New film</p>
        <div className="video-form">
          <div className="row" style={{ gap: 6 }}>
            <select className="field-input" style={{ flex: 1, minWidth: 0 }} value={form.fileId} onChange={(e) => setForm({ ...form, fileId: e.target.value })}>
              <option value="">Choose a recording…</option>
              {recordings.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
            <label className="btn btn-sm" title="Upload the doctor's recording from this computer">
              {uploading === 'recording' ? 'Uploading…' : 'Upload'}
              <input type="file" accept="video/*" hidden disabled={uploading !== null}
                onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void upload([f], 'recording'); }} />
            </label>
            <button type="button" className="btn btn-sm" onClick={() => setPicking(picking === 'recording' ? null : 'recording')}>
              Google Drive
            </button>
          </div>
          {picking && (
            <GooglePicker kind={picking} onClose={() => setPicking(null)}
              onPicked={(file) => { take([file], picking); setPicking(null); }} />
          )}
          <input className="field-input" placeholder={form.givenPlan.trim() ? "Doctor's name (or as in your plan)" : "Doctor's name, e.g. Dr. A. Kumar"} value={form.doctorName}
            onChange={(e) => setForm({ ...form, doctorName: e.target.value })} />
          <input className="field-input" placeholder="Designation, e.g. Senior Consultant – Cardiology (optional)" value={form.doctorTitle}
            onChange={(e) => setForm({ ...form, doctorTitle: e.target.value })} />
          <input className="field-input" placeholder="Hospital | City, e.g. Narayana Health City | Bengaluru (optional)" value={form.hospitalLine}
            onChange={(e) => setForm({ ...form, hospitalLine: e.target.value })} />
          <label className="tiny muted video-wide">
            Your plan (optional) — paste it as you write it for the editor: start and end times, the name plate, the title, timed
            on-screen text, where b-roll goes, the description. Or paste the OST table. Your words go on screen exactly as written. Leave
            empty and CIP writes the plan.
            <textarea className="field-input" rows={6} value={form.givenPlan}
              onChange={(e) => setForm({ ...form, givenPlan: e.target.value, autoMake: autoTouched ? form.autoMake : Boolean(e.target.value.trim()) })} />
          </label>
          <div className="tiny muted video-wide">
            <span className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              B-roll you already have (optional) — each block takes the clip that fits it. Anything not covered is asked about later.
              <label className="btn btn-sm">
                {uploading === 'broll' ? 'Uploading…' : 'Upload b-roll'}
                <input type="file" accept="video/*" multiple hidden disabled={uploading !== null}
                  onChange={(e) => { const f = [...(e.target.files ?? [])]; e.target.value = ''; if (f.length) void upload(f, 'broll'); }} />
              </label>
              <button type="button" className="btn btn-sm" onClick={() => setPicking(picking === 'broll' ? null : 'broll')}>
                B-roll from Google Drive
              </button>
            </span>
            {recordings.length > 1 && (
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
            )}
          </div>
          <label className="small video-check">
            <input type="checkbox" checked={form.autoMake}
              onChange={(e) => { setAutoTouched(true); setForm({ ...form, autoMake: e.target.checked }); }} />
            <span>
              Make the film straight away — no review step. It stops only to ask for b-roll your plan wants and you have not given,
              or if a block may break a rule.
            </span>
          </label>
          <label className="small video-check">
            <input type="checkbox" checked={form.noBroll} onChange={(e) => setForm({ ...form, noBroll: e.target.checked })} />
            <span>No b-roll — keep the doctor on screen throughout, and don&apos;t ask for any.</span>
          </label>
          <button type="button" className="btn btn-primary btn-sm"
            disabled={planning || !form.fileId || (!form.doctorName.trim() && !form.givenPlan.trim())}
            onClick={() => void plan()}>
            {planning
              ? form.givenPlan.trim() ? 'Reading your plan and fitting it to the recording…' : 'Listening and planning… about a minute'
              : form.autoMake ? 'Make the film' : 'Plan the edit'}
          </button>
        </div>
        <p className="tiny muted">Upload here, or add videos to your Drive folder and they appear in these lists.</p>
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
                  <span className={`tiny video-status ${statusOf(e).tone}`}>{statusOf(e).text}</span>
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

  const remove = async () => {
    if (!window.confirm('Delete this film and its plan? This cannot be undone.')) return;
    const body = await send<{ ok: true }>(`/api/video/edits/${edit.id}`, { method: 'DELETE' });
    if (failed(body)) { note(body.message); return; }
    note('Deleted');
    onChanged(edit);
  };

  const save = async (approve: boolean, changed: EditPlan = plan) => {
    setSaving(true);
    try {
      if (changed !== plan) setPlan(changed);
      const saved = await send<{ edit: VideoEditDTO }>(`/api/video/edits/${edit.id}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ plan: changed }),
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
    <section id="video-open" className="card pad" style={{ marginTop: 16 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <p className="strong">{edit.plan?.title || edit.sourceName} <span className="tiny muted">· from {edit.sourceName}</span></p>
        <span className="row" style={{ gap: 12, alignItems: 'baseline' }}>
          <span className={`tiny video-status ${statusOf(edit).tone}`}>{statusOf(edit).text}</span>
          {edit.status !== 'rendering' && (
            <button type="button" className="linkbtn tiny" onClick={() => void remove()}>Delete</button>
          )}
        </span>
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
        <div className="video-broll" style={{ margin: '8px 0' }}>
          <span className="small">
            <Icon name="alert" size={12} /> {asked} block{asked === 1 ? ' needs' : 's need'} b-roll. Choose a clip for each below — or go on without it.
          </span>
          <div className="row">
            <button type="button" className="btn btn-primary btn-sm" disabled={saving || concerns > 0}
              title={concerns > 0 ? 'A block may break a rule: check it first' : undefined}
              onClick={() => void save(true, { ...plan, blocks: plan.blocks.map((b) => (brollAsked(b) ? { ...b, brollSkipped: true } : b)) })}>
              Make it without b-roll
            </button>
            <span className="tiny muted">The doctor stays on screen where the b-roll would have been.</span>
          </div>
        </div>
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
          {b.heading || b.bullets.length > 0 ? (
            <>
              <input className="field-input video-heading" value={b.heading} disabled={locked}
                onChange={(e) => setBlock(i, { heading: e.target.value })} />
              <textarea className="field-input" rows={Math.max(2, b.bullets.length)} disabled={locked}
                value={b.bullets.join('\n')} placeholder="One pointer a line"
                onChange={(e) => setBlock(i, { bullets: e.target.value.split('\n') })} />
            </>
          ) : (
            <p className="small strong" style={{ margin: 0 }}>B-roll only — no text on screen</p>
          )}
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

      {(plan.description || edit.givenPlan) && (
        <>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
            <p className="small strong video-head">Description to post with the film</p>
            {plan.description && (
              <button type="button" className="linkbtn tiny"
                onClick={() => void navigator.clipboard?.writeText(plan.description ?? '').then(() => note('Copied'))}>Copy</button>
            )}
          </div>
          <textarea className="field-input" rows={4} disabled={locked} value={plan.description ?? ''}
            placeholder="None in your plan" onChange={(e) => setPlan({ ...plan, description: e.target.value })} />
        </>
      )}

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

/** The newest videos in the connected Google Drive; one click brings one in. */
function GooglePicker({ kind, onPicked, onClose }: {
  kind: 'recording' | 'broll'; onPicked: (file: { id: string; name: string }) => void; onClose: () => void;
}) {
  const { note } = useToast();
  const [list, setList] = useState<{ connected: boolean; videos: { id: string; name: string; sizeBytes: number | null; modifiedAt: string | null }[] } | null>(null);
  const [bringing, setBringing] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  // Looked up once, when the picker opens.
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void send<NonNullable<typeof list>>('/api/video/google').then((b) => {
      if (failed(b)) setError(b.message); else setList(b);
    });
  }, []);

  const pick = async (id: string) => {
    setBringing(id);
    try {
      const body = await send<{ file: { id: string; name: string } }>('/api/video/google', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }),
      });
      if (failed(body)) { note(body.message); return; }
      onPicked(body.file);
    } finally {
      setBringing(null);
    }
  };
  const shown = (list?.videos ?? []).filter((v) => v.name.toLowerCase().includes(query.trim().toLowerCase()));
  const mb = (n: number | null) => (n === null ? '' : ` · ${(n / 1024 / 1024).toFixed(n > 100 * 1024 * 1024 ? 0 : 1)} MB`);

  return (
    <div className="video-broll video-wide">
      <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
        <span className="tiny strong">{kind === 'recording' ? 'Pick the recording' : 'Pick b-roll'} from Google Drive</span>
        <button type="button" className="linkbtn tiny" onClick={onClose}>Close</button>
      </div>
      {error && <span className="tiny">{error}</span>}
      {!list && !error && <span className="tiny muted">Looking in your Google Drive…</span>}
      {list && !list.connected && (
        <span className="tiny">Google Drive is not connected. Connect it from <a href="/teach">Add data to brain</a>, then come back.</span>
      )}
      {list?.connected && (
        <>
          <input className="field-input" placeholder="Search by name" value={query} onChange={(e) => setQuery(e.target.value)} />
          {shown.length === 0 && <span className="tiny muted">No videos found.</span>}
          <div className="video-picks" style={{ flexDirection: 'column', flexWrap: 'nowrap' }}>
            {shown.map((v) => (
              <button key={v.id} type="button" className="linkbtn tiny" style={{ textAlign: 'left' }} disabled={bringing !== null}
                onClick={() => void pick(v.id)}>
                {bringing === v.id ? 'Bringing it in…' : v.name}
                <span className="muted">{mb(v.sizeBytes)}{v.modifiedAt ? ` · ${new Date(v.modifiedAt).toLocaleDateString()}` : ''}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
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
    void send<{ recordings: { id: string; name: string }[] }>('/api/video/recordings?endScreens=1').then((b) => { if (!failed(b)) setVideos(b.recordings); });
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
