import 'server-only';
import { withCompanyScope } from '../db';
import type { CompanyScope } from '../db';
import { adminSql } from '../db-admin';
import { extractAudio, readVideoMetadata, withTempFile } from '../brain/media';
import { rulesForBrief } from '../brain/checker';
import { companyProfile } from '../brain/category';
import { brain } from '../brain/providers';
import { searchAssets } from '../drive/assetSearch';
import { readFile } from '../drive/service';
import { driveStorage, videoEditKeyFor } from '../drive/storage';
import { renderFilm } from './render';
import { transcribeWords } from './words';
import type { Word } from './words';

/**
 * A doctor's recording, edited into the house template.
 *
 * planning  the words are heard and the edit is planned
 * planned   a person reads the plan - cuts, title, points, b-roll - and may change it
 * approved  it is waiting to be made
 * rendering it is being made
 * ready     the film can be downloaded
 * failed    it could not be planned or made; the reason is kept
 *
 * Nothing is made until a person has approved the plan. A key point is the
 * one step the briefing calls risky - a pointer that overstates the doctor -
 * so every point is checked against the rules and shown with any concern.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Longer recordings than this are cut into parts before they come here. */
const MAX_SECONDS = 20 * 60;

export class VideoEditRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VideoEditRejected';
  }
}

/**
 * One block of on-screen text: a specific heading and a few pointers, up while
 * the doctor says it, with what to show behind it.
 */
export type EditBlock = {
  heading: string;
  bullets: string[];
  from: number;
  to: number;
  /** The visual the plan suggests. */
  visuals: string;
  /** Footage for it from the company's own library, when there is any. */
  footage: { fileId: string; fileName: string } | null;
  concern: string | null;
  /** The rules the block may break, in words. */
  rules: string[];
};

export type EditPlan = {
  title: string;
  cuts: { from: number; to: number; reason: string }[];
  blocks: EditBlock[];
};

/** The longest stretch of a block b-roll covers; the doctor is seen again after it. */
const BROLL_SECONDS = 6;

const clock = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/**
 * The plan as the house's OST sheet: one Markdown table, three columns, a
 * bold heading first in every cell, a bullet a line.
 */
export function ostTable(plan: EditPlan): string {
  const cell = (s: string) => s.replace(/\|/g, '/').replace(/\s+/g, ' ').trim();
  const rows = plan.blocks.map((b) =>
    `| ${clock(b.from)}–${clock(b.to)} | ${[`• **${cell(b.heading)}**`, ...b.bullets.map((x) => `• ${cell(x)}`)].join('<br>')} | ${cell(b.visuals) || '—'} |`,
  );
  return [
    '| Timecode / Section | On-Screen Text (OST – Pointer Format) | Visuals / B-roll Suggestions |',
    '|---|---|---|',
    ...rows,
  ].join('\n') + '\n';
}

export type VideoEditDTO = {
  id: string;
  sourceFileId: string;
  sourceName: string;
  doctorName: string;
  doctorTitle: string | null;
  status: 'planning' | 'planned' | 'approved' | 'rendering' | 'ready' | 'failed';
  plan: EditPlan | null;
  durationSeconds: number | null;
  error: string | null;
  createdAt: string;
};

export type VideoTemplateDTO = {
  logoFileId: string | null;
  background: string;
  accent: string;
  ink: string;
  introSeconds: number;
  outroSeconds: number;
  endScreenText: string | null;
  disclaimerText: string | null;
  disclaimerSeconds: number;
};

// --- the template ------------------------------------------------------------

const DEFAULT_TEMPLATE: VideoTemplateDTO = {
  logoFileId: null, background: '#0b2a4a', accent: '#e8a33d', ink: '#ffffff',
  introSeconds: 2.5, outroSeconds: 3, endScreenText: null, disclaimerText: null, disclaimerSeconds: 4,
};

export async function getTemplate(scope: CompanyScope): Promise<VideoTemplateDTO> {
  const [row] = await withCompanyScope(scope, (tx) => tx<{
    logo_file_id: string | null; background: string; accent: string; ink: string; intro_seconds: string;
    outro_seconds: string; end_screen_text: string | null; disclaimer_text: string | null; disclaimer_seconds: string;
  }[]>`select * from video_templates where company_id = ${scope.companyId}`);
  if (!row) return { ...DEFAULT_TEMPLATE };
  return {
    logoFileId: row.logo_file_id, background: row.background, accent: row.accent, ink: row.ink,
    introSeconds: Number(row.intro_seconds), outroSeconds: Number(row.outro_seconds), endScreenText: row.end_screen_text,
    disclaimerText: row.disclaimer_text, disclaimerSeconds: Number(row.disclaimer_seconds),
  };
}

const HEX = /^#[0-9a-f]{6}$/i;

export async function saveTemplate(scope: CompanyScope, input: Partial<VideoTemplateDTO>): Promise<VideoTemplateDTO> {
  const t = { ...(await getTemplate(scope)), ...input };
  for (const colour of [t.background, t.accent, t.ink]) {
    if (!HEX.test(colour)) throw new VideoEditRejected('Colours are written as #rrggbb.');
  }
  const seconds = (n: number, max: number) => Math.min(max, Math.max(0, Number(n) || 0));
  if (t.logoFileId && !UUID.test(t.logoFileId)) throw new VideoEditRejected('That logo is not in this workspace.');
  await withCompanyScope(scope, (tx) => tx`
    insert into video_templates
      (company_id, logo_file_id, background, accent, ink, intro_seconds, outro_seconds,
       end_screen_text, disclaimer_text, disclaimer_seconds, updated_at)
    values (${scope.companyId}, ${t.logoFileId}, ${t.background}, ${t.accent}, ${t.ink},
            ${seconds(t.introSeconds, 10)}, ${seconds(t.outroSeconds, 10)},
            ${t.endScreenText?.trim().slice(0, 200) || null}, ${t.disclaimerText?.trim().slice(0, 600) || null},
            ${seconds(t.disclaimerSeconds, 15)}, now())
    on conflict (company_id) do update set
      logo_file_id = excluded.logo_file_id, background = excluded.background, accent = excluded.accent,
      ink = excluded.ink, intro_seconds = excluded.intro_seconds, outro_seconds = excluded.outro_seconds,
      end_screen_text = excluded.end_screen_text, disclaimer_text = excluded.disclaimer_text,
      disclaimer_seconds = excluded.disclaimer_seconds, updated_at = now()
  `);
  return getTemplate(scope);
}

// --- planning ----------------------------------------------------------------

type Row = {
  id: string; source_file_id: string; source_name: string; doctor_name: string; doctor_title: string | null;
  status: VideoEditDTO['status']; plan: EditPlan | null; duration_seconds: string | null;
  error_message: string | null; created_at: Date;
};

const toDTO = (r: Row): VideoEditDTO => ({
  id: r.id, sourceFileId: r.source_file_id, sourceName: r.source_name, doctorName: r.doctor_name,
  doctorTitle: r.doctor_title, status: r.status, plan: r.plan,
  durationSeconds: r.duration_seconds === null ? null : Number(r.duration_seconds),
  error: r.error_message, createdAt: r.created_at.toISOString(),
});

const SELECT = `select e.id, e.source_file_id, f.name as source_name, e.doctor_name, e.doctor_title, e.status,
                       e.plan, e.duration_seconds, e.error_message, e.created_at
                  from video_edits e join drive_files f on f.id = e.source_file_id and f.company_id = e.company_id`;

export async function listEdits(scope: CompanyScope): Promise<VideoEditDTO[]> {
  const rows = await withCompanyScope(scope, (tx) => tx.unsafe<Row[]>(
    `${SELECT} where e.company_id = $1 order by e.created_at desc limit 50`, [scope.companyId],
  ));
  return rows.map(toDTO);
}

export async function getEdit(scope: CompanyScope, id: string): Promise<VideoEditDTO | null> {
  if (!UUID.test(id)) return null;
  const [row] = await withCompanyScope(scope, (tx) => tx.unsafe<Row[]>(
    `${SELECT} where e.company_id = $1 and e.id = $2`, [scope.companyId, id],
  ));
  return row ? toDTO(row) : null;
}

/**
 * Hears a recording and plans its edit. Takes as long as the recording takes
 * to transcribe - well under a minute for a few minutes of speech.
 */
export async function createEdit(
  scope: CompanyScope,
  input: { fileId: string; doctorName: string; doctorTitle?: string | null },
): Promise<VideoEditDTO> {
  const doctorName = input.doctorName?.trim();
  if (!doctorName) throw new VideoEditRejected("Type the doctor's name as it should appear on screen.");
  if (!UUID.test(input.fileId)) throw new VideoEditRejected('That recording is not in this workspace.');

  const source = await readFile(scope, input.fileId);
  if (!source.file.mimeType.startsWith('video/')) throw new VideoEditRejected('Choose a video recording.');

  const [created] = await withCompanyScope(scope, (tx) => tx<{ id: string }[]>`
    insert into video_edits (company_id, source_file_id, doctor_name, doctor_title, created_by)
    values (${scope.companyId}, ${input.fileId}, ${doctorName.slice(0, 120)},
            ${input.doctorTitle?.trim().slice(0, 120) || null}, ${scope.userId})
    returning id
  `);
  const id = created!.id;
  const fail = async (message: string) => {
    await withCompanyScope(scope, (tx) => tx`
      update video_edits set status = 'failed', error_message = ${message}, updated_at = now()
       where id = ${id} and company_id = ${scope.companyId}
    `);
  };

  try {
    const extension = source.filename.split('.').pop()?.toLowerCase() || 'mp4';
    const heard = await withTempFile(source.body, extension, async (path) => {
      const meta = await readVideoMetadata(path);
      if (meta.durationSeconds > MAX_SECONDS) return { meta, words: null as Word[] | null, tooLong: true };
      const audio = await extractAudio(path, meta);
      return { meta, words: audio ? await transcribeWords(audio, 'recording') : null, tooLong: false };
    });
    if (heard.tooLong) {
      await fail(`Recordings up to ${MAX_SECONDS / 60} minutes can be edited here.`);
      return (await getEdit(scope, id))!;
    }
    if (!heard.words || heard.words.length === 0) {
      await fail('No speech could be heard in this recording.');
      return (await getEdit(scope, id))!;
    }

    const [rules, profile] = await Promise.all([
      rulesForBrief(scope, { brand: null, market: null, format: 'video' }),
      companyProfile(scope),
    ]);
    const refs = rules.map((r, i) => ({ ref: `R${i + 1}`, rule: r.rule }));
    const planned = await brain().planVideoEdit({
      doctorName, category: profile.category, words: heard.words, rules: refs,
    });

    // Footage for each block's visual, from the company's own library.
    const byRef = new Map(refs.map((r) => [r.ref, r.rule]));
    const blocks = await Promise.all(planned.blocks.map(async (b): Promise<EditBlock> => {
      const hit = b.visuals
        ? (await searchAssets(scope, b.visuals, 12).catch(() => []))
            .find((h) => h.mimeType.startsWith('video/') && h.fileId !== input.fileId)
        : undefined;
      return {
        heading: b.heading, bullets: b.bullets, from: b.from, to: b.to, visuals: b.visuals,
        footage: hit ? { fileId: hit.fileId, fileName: hit.fileName } : null,
        concern: b.concern,
        rules: b.ruleRefs.map((r) => byRef.get(r)).filter((r): r is string => Boolean(r)),
      };
    }));
    const plan: EditPlan = { title: planned.title, cuts: planned.cuts, blocks };

    await withCompanyScope(scope, (tx) => tx`
      update video_edits
         set status = 'planned', transcript = ${tx.json(heard.words)}, plan = ${tx.json(plan)},
             duration_seconds = ${heard.meta.durationSeconds}, updated_at = now()
       where id = ${id} and company_id = ${scope.companyId}
    `);
  } catch (error) {
    await fail(error instanceof Error ? error.message.slice(0, 300) : 'The recording could not be planned.');
  }
  return (await getEdit(scope, id))!;
}

/** A person's changes to the plan. Times stay inside the recording. */
export async function updatePlan(scope: CompanyScope, id: string, plan: EditPlan): Promise<VideoEditDTO> {
  const edit = await getEdit(scope, id);
  if (!edit) throw new VideoEditRejected('That edit is not in this workspace.');
  if (edit.status !== 'planned' && edit.status !== 'ready' && edit.status !== 'failed') {
    throw new VideoEditRejected('This edit is being made; change it once it is done.');
  }
  const end = edit.durationSeconds ?? 0;
  const span = <T extends { from: number; to: number }>(x: T) => {
    const from = Math.max(0, Math.min(Number(x.from) || 0, end));
    const to = Math.max(0, Math.min(Number(x.to) || 0, end));
    return to > from ? { ...x, from, to } : null;
  };
  const clean: EditPlan = {
    title: String(plan.title ?? '').trim().slice(0, 120),
    cuts: (plan.cuts ?? []).map(span).filter((c): c is NonNullable<typeof c> => c !== null)
      .map((c) => ({ from: c.from, to: c.to, reason: String(c.reason ?? '').slice(0, 120) })),
    blocks: (plan.blocks ?? []).map(span)
      .filter((b): b is NonNullable<typeof b> => b !== null && Boolean(String(b.heading ?? '').trim()))
      .map((b) => ({
        heading: String(b.heading).trim().slice(0, 80),
        bullets: (Array.isArray(b.bullets) ? b.bullets : []).map((x) => String(x).trim().slice(0, 90)).filter(Boolean).slice(0, 5),
        from: b.from,
        to: b.to,
        visuals: String(b.visuals ?? '').trim().slice(0, 200),
        footage: b.footage && UUID.test(b.footage.fileId) ? { fileId: b.footage.fileId, fileName: String(b.footage.fileName ?? '') } : null,
        concern: b.concern ?? null,
        rules: Array.isArray(b.rules) ? b.rules : [],
      })),
  };
  if (!clean.title) throw new VideoEditRejected('The film needs a title.');
  await withCompanyScope(scope, (tx) => tx`
    update video_edits set plan = ${tx.json(clean)}, status = 'planned', updated_at = now()
     where id = ${id} and company_id = ${scope.companyId}
  `);
  return (await getEdit(scope, id))!;
}

/** A person has read the plan. It is made on the next pass. */
export async function approveEdit(scope: CompanyScope, id: string): Promise<VideoEditDTO> {
  const edit = await getEdit(scope, id);
  if (!edit?.plan) throw new VideoEditRejected('That edit has no plan to approve.');
  if (edit.status !== 'planned' && edit.status !== 'ready' && edit.status !== 'failed') {
    throw new VideoEditRejected('This edit is already being made.');
  }
  await withCompanyScope(scope, (tx) => tx`
    update video_edits set status = 'approved', error_message = null, attempts = 0, updated_at = now()
     where id = ${id} and company_id = ${scope.companyId}
  `);
  return (await getEdit(scope, id))!;
}

// --- making the film -----------------------------------------------------------

/** Makes one approved film. */
export async function renderEdit(scope: CompanyScope, id: string): Promise<void> {
  const [row] = await withCompanyScope(scope, (tx) => tx<{
    source_file_id: string; doctor_name: string; doctor_title: string | null; plan: EditPlan; company: string;
  }[]>`
    select e.source_file_id, e.doctor_name, e.doctor_title, e.plan, c.name as company
      from video_edits e join companies c on c.id = e.company_id
     where e.id = ${id} and e.company_id = ${scope.companyId}
  `);
  if (!row?.plan) throw new VideoEditRejected('That edit has no plan.');

  const template = await getTemplate(scope);
  const source = await readFile(scope, row.source_file_id);
  const logo = template.logoFileId ? await readFile(scope, template.logoFileId).then((f) => f.body).catch(() => null) : null;
  // B-roll opens a block and gives way to the doctor again.
  const broll = [];
  for (const b of row.plan.blocks) {
    if (!b.footage) continue;
    const footage = await readFile(scope, b.footage.fileId).catch(() => null);
    if (footage) {
      broll.push({ from: b.from, to: Math.min(b.to, b.from + BROLL_SECONDS), footage: footage.body, extension: footage.filename.split('.').pop() || 'mp4' });
    }
  }

  const film = await renderFilm({
    source: source.body,
    sourceExtension: source.filename.split('.').pop()?.toLowerCase() || 'mp4',
    style: { background: template.background, accent: template.accent, ink: template.ink },
    logo,
    companyName: row.company,
    doctorName: row.doctor_name,
    doctorTitle: row.doctor_title,
    title: row.plan.title,
    cuts: row.plan.cuts,
    blocks: row.plan.blocks.map((b) => ({ heading: b.heading, bullets: b.bullets, from: b.from, to: b.to })),
    broll,
    introSeconds: template.introSeconds,
    // Only the hospital's own wording: CIP never writes a disclaimer.
    disclaimer: template.disclaimerText ? { text: template.disclaimerText, seconds: template.disclaimerSeconds } : null,
    endScreen: { text: template.endScreenText, seconds: template.outroSeconds },
  });

  const key = videoEditKeyFor(scope.companyId, id);
  await driveStorage().put(key, film.bytes, 'video/mp4');
  await withCompanyScope(scope, (tx) => tx`
    update video_edits set status = 'ready', output_path = ${key}, error_message = null, updated_at = now()
     where id = ${id} and company_id = ${scope.companyId}
  `);
}

/** The finished film. */
export async function readFilm(scope: CompanyScope, id: string): Promise<{ bytes: Buffer; name: string } | null> {
  if (!UUID.test(id)) return null;
  const [row] = await withCompanyScope(scope, (tx) => tx<{ output_path: string | null; plan: EditPlan | null }[]>`
    select output_path, plan from video_edits where id = ${id} and company_id = ${scope.companyId} and status = 'ready'
  `);
  if (!row?.output_path) return null;
  const name = `${(row.plan?.title || 'film').replace(/[^\w\- ]+/g, '').trim().slice(0, 60) || 'film'}.mp4`;
  return { bytes: await driveStorage().get(row.output_path), name };
}

/**
 * Makes the oldest approved film, for the pump. One a pass: a film takes
 * minutes, and a pass has five.
 */
export async function renderApprovedEdits(options: { outOfTime: () => boolean }): Promise<number> {
  if (options.outOfTime()) return 0;
  const sql = adminSql();
  let claim: { id: string; company_id: string; user_id: string | null } | undefined;
  try {
    [claim] = await sql<{ id: string; company_id: string; user_id: string | null }[]>`
      update video_edits e
         set status = 'rendering', attempts = attempts + 1, updated_at = now()
       where e.id = (
         select id from video_edits
          where status = 'approved' or (status = 'rendering' and updated_at < now() - interval '20 minutes' and attempts < 3)
          order by updated_at
          for update skip locked
          limit 1)
      returning e.id, e.company_id, e.created_by as user_id
    `;
  } finally {
    await sql.end();
  }
  if (!claim) return 0;
  const scope: CompanyScope = { companyId: claim.company_id, userId: claim.user_id ?? '00000000-0000-0000-0000-000000000000', role: 'owner' };
  try {
    await renderEdit(scope, claim.id);
    return 1;
  } catch (error) {
    await withCompanyScope(scope, (tx) => tx`
      update video_edits set status = 'failed', updated_at = now(),
             error_message = ${error instanceof Error ? error.message.slice(0, 300) : 'The film could not be made.'}
       where id = ${claim!.id} and company_id = ${scope.companyId}
    `);
    return 0;
  }
}

/** The recordings a film can be made from: the company's videos, newest first. */
export async function listRecordings(scope: CompanyScope): Promise<{ id: string; name: string; sizeBytes: number; createdAt: string }[]> {
  const rows = await withCompanyScope(scope, (tx) => tx<{ id: string; name: string; file_size: string; created_at: Date }[]>`
    select id, name, file_size, created_at from drive_files
     where company_id = ${scope.companyId} and archived_at is null and bytes_retained
       and mime_type like 'video/%'
     order by created_at desc
     limit 200
  `);
  return rows.map((r) => ({ id: r.id, name: r.name, sizeBytes: Number(r.file_size), createdAt: r.created_at.toISOString() }));
}
