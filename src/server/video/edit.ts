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
import { parseGivenPlan } from './givenPlan';
import type { GivenBlock } from './givenPlan';
import type { EditBrief } from '../brain/providers/types';
import { renderFilm } from './render';
import { transcribeWords } from './words';
import type { Word } from './words';

/**
 * A doctor's recording, edited into the house template.
 *
 * planning  the words are heard and the edit is planned
 * planned   a person reads the plan - cuts, title, points, b-roll - and may change it;
 *           any block still waiting for b-roll is asked about here
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
 * the doctor says it, with what to show behind it. A block with no heading is
 * b-roll alone - a cutaway the brief asked for, with no text of its own.
 */
export type EditBlock = {
  heading: string;
  bullets: string[];
  from: number;
  to: number;
  /** The visual the plan suggests. */
  visuals: string;
  /** The footage chosen for it. */
  footage: { fileId: string; fileName: string } | null;
  /** Library footage that may fit, offered when the question is asked. */
  suggestion?: { fileId: string; fileName: string } | null;
  /** A person chose to show the doctor here instead of b-roll. */
  brollSkipped?: boolean;
  /** The person's own brief asked for b-roll here, so it is always asked about. */
  brollWanted?: boolean;
  concern: string | null;
  /** The rules the block may break, in words. */
  rules: string[];
};

export type EditPlan = {
  title: string;
  cuts: { from: number; to: number; reason: string }[];
  blocks: EditBlock[];
  /** Text to post with the film, from the person's brief. Never on screen. */
  description?: string | null;
};

/** A block that wants b-roll and has neither footage nor a person's "skip". */
export const brollAsked = (b: EditBlock) => Boolean(b.visuals.trim()) && !b.footage && !b.brollSkipped;

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
    `| ${clock(b.from)}–${clock(b.to)} | ${b.heading ? [`• **${cell(b.heading)}**`, ...b.bullets.map((x) => `• ${cell(x)}`)].join('<br>') : '—'} | ${cell(b.visuals) || '—'} |`,
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
  hospitalLine: string | null;
  /** True when a person supplied the on-screen text. */
  givenPlan: boolean;
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
  logoCorner: 'top-left' | 'top-right';
  /** The hospital's own end screens; drawn when not set. */
  endVideoFileId: string | null;
  endVideoVerticalFileId: string | null;
  /** The line on a drawn end screen, "Take Care". */
  tagline: string | null;
  /** The logo on the opening card; the corner logo when not set. */
  introLogoFileId: string | null;
};

// --- the template ------------------------------------------------------------

const DEFAULT_TEMPLATE: VideoTemplateDTO = {
  logoFileId: null, background: '#0b2a4a', accent: '#e8a33d', ink: '#ffffff',
  introSeconds: 2.5, outroSeconds: 3, endScreenText: null, disclaimerText: null, disclaimerSeconds: 4,
  logoCorner: 'top-right', endVideoFileId: null, endVideoVerticalFileId: null, tagline: null, introLogoFileId: null,
};

export async function getTemplate(scope: CompanyScope): Promise<VideoTemplateDTO> {
  const [row] = await withCompanyScope(scope, (tx) => tx<{
    logo_file_id: string | null; background: string; accent: string; ink: string; intro_seconds: string;
    outro_seconds: string; end_screen_text: string | null; disclaimer_text: string | null; disclaimer_seconds: string;
    logo_corner: 'top-left' | 'top-right'; end_video_file_id: string | null; end_video_vertical_file_id: string | null;
    tagline: string | null; intro_logo_file_id: string | null;
  }[]>`select * from video_templates where company_id = ${scope.companyId}`);
  if (!row) return { ...DEFAULT_TEMPLATE };
  return {
    logoFileId: row.logo_file_id, background: row.background, accent: row.accent, ink: row.ink,
    introSeconds: Number(row.intro_seconds), outroSeconds: Number(row.outro_seconds), endScreenText: row.end_screen_text,
    disclaimerText: row.disclaimer_text, disclaimerSeconds: Number(row.disclaimer_seconds),
    logoCorner: row.logo_corner, endVideoFileId: row.end_video_file_id,
    endVideoVerticalFileId: row.end_video_vertical_file_id, tagline: row.tagline,
    introLogoFileId: row.intro_logo_file_id,
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
  if (t.logoCorner !== 'top-left' && t.logoCorner !== 'top-right') throw new VideoEditRejected('The logo sits top-left or top-right.');
  for (const id of [t.endVideoFileId, t.endVideoVerticalFileId, t.introLogoFileId]) {
    if (id && !UUID.test(id)) throw new VideoEditRejected('That file is not in this workspace.');
  }
  await withCompanyScope(scope, (tx) => tx`
    insert into video_templates
      (company_id, logo_file_id, background, accent, ink, intro_seconds, outro_seconds,
       end_screen_text, disclaimer_text, disclaimer_seconds, logo_corner, end_video_file_id,
       end_video_vertical_file_id, tagline, intro_logo_file_id, updated_at)
    values (${scope.companyId}, ${t.logoFileId}, ${t.background}, ${t.accent}, ${t.ink},
            ${seconds(t.introSeconds, 10)}, ${seconds(t.outroSeconds, 10)},
            ${t.endScreenText?.trim().slice(0, 200) || null}, ${t.disclaimerText?.trim().slice(0, 600) || null},
            ${seconds(t.disclaimerSeconds, 15)}, ${t.logoCorner}, ${t.endVideoFileId || null},
            ${t.endVideoVerticalFileId || null}, ${t.tagline?.trim().slice(0, 60) || null}, ${t.introLogoFileId || null}, now())
    on conflict (company_id) do update set
      logo_file_id = excluded.logo_file_id, background = excluded.background, accent = excluded.accent,
      ink = excluded.ink, intro_seconds = excluded.intro_seconds, outro_seconds = excluded.outro_seconds,
      end_screen_text = excluded.end_screen_text, disclaimer_text = excluded.disclaimer_text,
      disclaimer_seconds = excluded.disclaimer_seconds, logo_corner = excluded.logo_corner,
      end_video_file_id = excluded.end_video_file_id, end_video_vertical_file_id = excluded.end_video_vertical_file_id,
      tagline = excluded.tagline, intro_logo_file_id = excluded.intro_logo_file_id, updated_at = now()
  `);
  return getTemplate(scope);
}

// --- planning ----------------------------------------------------------------

type Row = {
  id: string; source_file_id: string; source_name: string; doctor_name: string; doctor_title: string | null;
  hospital_line: string | null; given: boolean; status: VideoEditDTO['status']; plan: EditPlan | null; duration_seconds: string | null;
  error_message: string | null; created_at: Date;
};

const toDTO = (r: Row): VideoEditDTO => ({
  id: r.id, sourceFileId: r.source_file_id, sourceName: r.source_name, doctorName: r.doctor_name,
  doctorTitle: r.doctor_title, hospitalLine: r.hospital_line, givenPlan: r.given, status: r.status, plan: r.plan,
  durationSeconds: r.duration_seconds === null ? null : Number(r.duration_seconds),
  error: r.error_message, createdAt: r.created_at.toISOString(),
});

const SELECT = `select e.id, e.source_file_id, f.name as source_name, e.doctor_name, e.doctor_title,
                       e.hospital_line, e.given_plan is not null as given, e.status,
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

/** The workspace's videos among these ids, by name; anything else is refused. */
async function videosIn(scope: CompanyScope, ids: string[]): Promise<{ fileId: string; fileName: string }[]> {
  const wanted = [...new Set(ids)];
  if (wanted.length === 0) return [];
  if (wanted.some((id) => !UUID.test(id))) throw new VideoEditRejected('That footage is not in this workspace.');
  const rows = await withCompanyScope(scope, (tx) => tx<{ id: string; name: string }[]>`
    select id, name from drive_files
     where company_id = ${scope.companyId} and id = any(${wanted}) and archived_at is null
       and bytes_retained and mime_type like 'video/%'
  `);
  if (rows.length !== wanted.length) throw new VideoEditRejected('Choose video footage from this workspace.');
  const byId = new Map(rows.map((r) => [r.id, r.name]));
  return wanted.map((id) => ({ fileId: id, fileName: byId.get(id)! }));
}

/**
 * The supplied text, block for block and word for word. The planner only
 * places it: a time given is kept, one it did not find is spread across the
 * recording, and its visual stands in only where none was written.
 */
function keepGiven(
  given: GivenBlock[],
  planned: { heading: string; bullets: string[]; from: number; to: number; visuals: string; concern: string | null; ruleRefs: string[] }[],
  seconds: number,
) {
  const share = seconds / given.length;
  return given.map((g, i) => {
    const p = planned[i];
    const placed = p && p.to > p.from ? p : null;
    const from = Math.max(0, Math.min(seconds, g.from ?? placed?.from ?? i * share));
    const to = Math.max(from, Math.min(seconds, g.to ?? placed?.to ?? (i + 1) * share));
    return {
      heading: g.heading, bullets: g.bullets, from, to,
      visuals: g.visuals || p?.visuals || '',
      concern: p?.concern ?? null,
      ruleRefs: p?.ruleRefs ?? [],
    };
  });
}

/** Lower case, one kind of dash and quote, single spaces: for "is this in the brief?". */
const plain = (s: string) =>
  s.toLowerCase().replace(/[\u2010-\u2015\u2212]/g, '-').replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"')
    .replace(/\s+/g, ' ').trim();

type Brief = Omit<EditBrief, 'usage'>;

/**
 * A person's brief, in parts. The house OST table is read as it is; anything
 * else is split by the model, and every line it hands back is checked against
 * the brief - a line that is not in it, word for word, is dropped. So nothing
 * reaches the screen that the person did not write.
 */
async function readBrief(text: string): Promise<Brief> {
  const empty: Brief = {
    start: null, end: null, doctorName: null, doctorTitle: null, hospitalLine: null, title: null, description: null,
    blocks: [], broll: [],
  };
  const table = text.split('\n').filter((l) => /^\s*\|.*\|\s*$/.test(l)).length >= 2;
  if (table) return { ...empty, blocks: parseGivenPlan(text) };

  const read = await brain().readEditBrief(text).catch(() => null);
  if (!read) return { ...empty, blocks: parseGivenPlan(text) };
  const source = plain(text);
  const kept = (s: string | null) => (s && source.includes(plain(s)) ? s.trim() : null);
  return {
    start: read.start,
    end: read.end !== null && (read.start === null || read.end > read.start) ? read.end : null,
    doctorName: kept(read.doctorName)?.slice(0, 120) ?? null,
    doctorTitle: kept(read.doctorTitle)?.slice(0, 120) ?? null,
    hospitalLine: kept(read.hospitalLine)?.slice(0, 120) ?? null,
    title: kept(read.title)?.slice(0, 120) ?? null,
    description: kept(read.description)?.slice(0, 5_000) ?? null,
    blocks: read.blocks
      .map((b) => ({ ...b, heading: kept(b.heading) ?? '', bullets: b.bullets.map(kept).filter((x): x is string => x !== null) }))
      .filter((b) => b.heading)
      .map((b) => ({
        heading: b.heading.slice(0, 80), bullets: b.bullets.slice(0, 5).map((x) => x.slice(0, 90)),
        from: b.from, to: b.to !== null && b.from !== null && b.to > b.from ? b.to : null, visuals: b.visuals.slice(0, 200),
      })),
    broll: read.broll
      .filter((b) => b.from !== null && b.to !== null && b.to > b.from)
      .map((b) => ({ ...b, note: b.note.replace(/\bb-?roll\b/gi, ' ').replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200) })),
  };
}

/** How long the name plate is up; on-screen text waits for it. */
const INTRO_SECONDS = 6;

/**
 * Hears a recording and plans its edit. Takes as long as the recording takes
 * to transcribe - well under a minute for a few minutes of speech.
 *
 * givenPlan  the on-screen text a person already wrote (the OST sheet, or a
 *            block a paragraph): it goes on screen exactly as written
 * brollIds   footage the person has for it; each block takes the piece that
 *            fits it best. With none, the library is searched for a
 *            suggestion and the person is asked, block by block.
 * autoMake   make the film without stopping for review: a block with no
 *            footage keeps the doctor on screen. A block that may break a
 *            rule still stops it - that is never made without a person.
 * noBroll    no b-roll anywhere: nothing is asked, the doctor stays on screen.
 */
export async function createEdit(
  scope: CompanyScope,
  input: {
    fileId: string; doctorName?: string | null; doctorTitle?: string | null; hospitalLine?: string | null;
    givenPlan?: string | null; brollIds?: string[]; autoMake?: boolean; noBroll?: boolean;
  },
): Promise<VideoEditDTO> {
  if (!UUID.test(input.fileId)) throw new VideoEditRejected('That recording is not in this workspace.');
  const template = await getTemplate(scope);
  if (input.fileId === template.endVideoFileId || input.fileId === template.endVideoVerticalFileId) {
    throw new VideoEditRejected("That is the hospital's end screen. Choose the doctor's recording.");
  }
  const givenText = input.givenPlan?.trim().slice(0, 20_000) || null;
  const brief = givenText ? await readBrief(givenText) : null;
  if (brief && brief.blocks.length === 0 && brief.broll.length === 0 && !brief.title && brief.start === null && brief.end === null) {
    throw new VideoEditRejected('The plan could not be read. Paste the OST table, or write a block a paragraph: a heading line, then a point a line.');
  }
  // The form wins; the brief fills what the form leaves empty.
  const doctorName = input.doctorName?.trim() || brief?.doctorName || '';
  if (!doctorName) throw new VideoEditRejected("Type the doctor's name as it should appear on screen.");
  const doctorTitle = input.doctorTitle?.trim() || brief?.doctorTitle || null;
  const hospitalLine = input.hospitalLine?.trim() || brief?.hospitalLine || null;

  const source = await readFile(scope, input.fileId);
  if (!source.file.mimeType.startsWith('video/')) throw new VideoEditRejected('Choose a video recording.');
  const provided = await videosIn(scope, (input.brollIds ?? []).filter((id) => id !== input.fileId));

  const [created] = await withCompanyScope(scope, (tx) => tx<{ id: string }[]>`
    insert into video_edits (company_id, source_file_id, doctor_name, doctor_title, hospital_line, given_plan, created_by)
    values (${scope.companyId}, ${input.fileId}, ${doctorName.slice(0, 120)},
            ${doctorTitle?.slice(0, 120) || null}, ${hospitalLine?.slice(0, 120) || null},
            ${givenText}, ${scope.userId})
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
    const seconds = heard.meta.durationSeconds;
    const filmFrom = Math.min(brief?.start ?? 0, seconds);
    // The title goes up once the name plate has cleared, unless the brief places it.
    const given: GivenBlock[] = [
      ...(brief?.title && !brief.blocks.some((b) => plain(b.heading) === plain(brief.title!))
        ? [{ heading: brief.title, bullets: [], visuals: '', from: filmFrom + INTRO_SECONDS, to: filmFrom + INTRO_SECONDS + 4 }]
        : []),
      ...(brief?.blocks ?? []),
    ];
    const planned = await brain().planVideoEdit({
      doctorName, category: profile.category, words: heard.words, rules: refs,
      ...(given.length > 0 ? { given } : {}),
    });
    const placed = given.length > 0 ? keepGiven(given, planned.blocks, seconds) : brief ? [] : planned.blocks;

    const byRef = new Map(refs.map((r) => [r.ref, r.rule]));
    const blocks = placed.map((b, i): EditBlock => ({
      heading: b.heading, bullets: b.bullets, from: b.from, to: b.to, visuals: b.visuals,
      footage: null, suggestion: null, brollSkipped: false,
      brollWanted: Boolean(given[i]?.visuals),
      concern: b.concern,
      rules: b.ruleRefs.map((r) => byRef.get(r)).filter((r): r is string => Boolean(r)),
    }));
    // B-roll the brief asked for, with no text of its own.
    for (const b of brief?.broll ?? []) {
      const from = Math.min(b.from!, seconds);
      const to = Math.min(b.to!, seconds);
      if (to > from) {
        blocks.push({
          heading: '', bullets: [], from, to, visuals: b.note || 'B-roll', footage: null, suggestion: null,
          brollSkipped: false, brollWanted: true, concern: null, rules: [],
        });
      }
    }
    blocks.sort((a, b) => a.from - b.from);
    // Never the recording itself, nor the hospital's end screens.
    const notBroll = new Set([input.fileId, template.endVideoFileId, template.endVideoVerticalFileId].filter((x): x is string => Boolean(x)));
    await chooseFootage(scope, blocks, provided, notBroll);

    // A brief's own trims replace the planner's; without a brief, the fumbles go.
    const cuts = brief
      ? [
          ...(brief.start !== null && brief.start > 0 ? [{ from: 0, to: Math.min(brief.start, seconds), reason: 'Before the start in your plan' }] : []),
          ...(brief.end !== null && brief.end < seconds ? [{ from: brief.end, to: seconds, reason: 'After the end in your plan' }] : []),
        ]
      : planned.cuts;
    const plan: EditPlan = {
      title: brief?.title || planned.title || given[0]?.heading || doctorName,
      cuts, blocks, description: brief?.description ?? null,
    };
    if (input.noBroll) for (const b of blocks) if (!b.footage) b.brollSkipped = true;
    const concerns = blocks.filter((b) => b.concern).length;
    let status: VideoEditDTO['status'] = 'planned';
    let note: string | null = null;
    if (input.autoMake) {
      // Only what the person asked for is asked about; a visual CIP merely suggested is let go.
      for (const b of blocks) if (brollAsked(b) && !b.brollWanted) b.brollSkipped = true;
      const waiting = blocks.filter(brollAsked).length;
      if (concerns === 0 && waiting === 0) status = 'approved';
      else if (concerns > 0) note = `Not made yet: ${concerns === 1 ? 'one block' : `${concerns} blocks`} may break a rule. Read them, then approve.`;
      else note = `Not made yet: your plan asks for b-roll in ${waiting === 1 ? 'one place' : `${waiting} places`}. Choose or upload it below, then approve.`;
    }

    await withCompanyScope(scope, (tx) => tx`
      update video_edits
         set status = ${status}, error_message = ${note}, transcript = ${tx.json(heard.words)}, plan = ${tx.json(plan)},
             duration_seconds = ${heard.meta.durationSeconds}, updated_at = now()
       where id = ${id} and company_id = ${scope.companyId}
    `);
  } catch (error) {
    await fail(error instanceof Error ? error.message.slice(0, 300) : 'The recording could not be planned.');
  }
  return (await getEdit(scope, id))!;
}

/**
 * Footage for the blocks. Footage a person gave goes where its words fit best,
 * each piece once, and any left over fills the blocks still wanting some in
 * order. Without any, a block's library match is only offered: the person is
 * asked before anything is put over the doctor.
 */
async function chooseFootage(
  scope: CompanyScope,
  blocks: EditBlock[],
  provided: { fileId: string; fileName: string }[],
  notBroll: Set<string>,
): Promise<void> {
  if (provided.length > 0) {
    const left = new Map(provided.map((p) => [p.fileId, p]));
    for (const b of blocks) {
      if (!b.visuals.trim() || left.size === 0) continue;
      const hits = await searchAssets(scope, `${b.visuals} ${b.heading}`, 48).catch(() => []);
      const hit = hits.find((h) => left.has(h.fileId));
      if (hit) {
        b.footage = left.get(hit.fileId)!;
        left.delete(hit.fileId);
      }
    }
    for (const b of blocks) {
      if (left.size === 0) break;
      if (b.footage || !b.visuals.trim()) continue;
      const [first] = left.values();
      b.footage = first!;
      left.delete(first!.fileId);
    }
    return;
  }
  for (const b of blocks) {
    if (!b.visuals.trim()) continue;
    const hit = (await searchAssets(scope, b.visuals, 12).catch(() => []))
      .find((h) => h.mimeType.startsWith('video/') && !notBroll.has(h.fileId));
    b.suggestion = hit ? { fileId: hit.fileId, fileName: hit.fileName } : null;
  }
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
      .filter((b): b is NonNullable<typeof b> => b !== null && (Boolean(String(b.heading ?? '').trim()) || Boolean(b.footage) || Boolean(b.brollWanted)))
      .map((b) => ({
        heading: String(b.heading).trim().slice(0, 80),
        bullets: (Array.isArray(b.bullets) ? b.bullets : []).map((x) => String(x).trim().slice(0, 90)).filter(Boolean).slice(0, 5),
        from: b.from,
        to: b.to,
        visuals: String(b.visuals ?? '').trim().slice(0, 200),
        footage: b.footage && UUID.test(b.footage.fileId) ? { fileId: b.footage.fileId, fileName: String(b.footage.fileName ?? '') } : null,
        suggestion: b.suggestion && UUID.test(b.suggestion.fileId) ? { fileId: b.suggestion.fileId, fileName: String(b.suggestion.fileName ?? '') } : null,
        brollSkipped: Boolean(b.brollSkipped) && !b.footage,
        brollWanted: Boolean(b.brollWanted),
        concern: b.concern ?? null,
        rules: Array.isArray(b.rules) ? b.rules : [],
      })),
  };
  clean.description = typeof plan.description === 'string' ? plan.description.trim().slice(0, 5_000) || null : null;
  if (!clean.title) throw new VideoEditRejected('The film needs a title.');
  const footage = clean.blocks.flatMap((b) => (b.footage ? [b.footage.fileId] : []));
  const known = new Map((await videosIn(scope, footage)).map((f) => [f.fileId, f.fileName]));
  for (const b of clean.blocks) if (b.footage) b.footage.fileName = known.get(b.footage.fileId)!;
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
  const asked = edit.plan.blocks.filter(brollAsked).length;
  if (asked > 0) {
    throw new VideoEditRejected(
      `${asked === 1 ? 'One block is' : `${asked} blocks are`} waiting for b-roll: choose footage, upload some, or show the doctor instead.`,
    );
  }
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

/**
 * When the doctor says each point of a block, so it can appear then: the
 * first word of the point's own (longer) words heard inside the block, after
 * the point before it. Null where none is heard - the point is then placed
 * evenly.
 */
export function whenSaid(words: readonly Word[], block: { from: number; to: number; bullets: string[] }): (number | null)[] {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const heard = words.filter((w) => w.from >= block.from - 1 && w.from <= block.to).map((w) => ({ at: w.from, w: norm(w.w) }));
  let after = block.from - 1;
  return block.bullets.map((bullet) => {
    const keys = bullet.split(/\s+/).map(norm).filter((k) => k.length >= 4);
    const hit = heard.find((h) => h.at > after && h.w.length >= 3 && keys.some((k) => k.startsWith(h.w.slice(0, 5)) || h.w.startsWith(k.slice(0, 5))));
    if (!hit) return null;
    after = hit.at;
    return hit.at;
  });
}

/** Makes one approved film. */
export async function renderEdit(scope: CompanyScope, id: string): Promise<void> {
  const [row] = await withCompanyScope(scope, (tx) => tx<{
    source_file_id: string; doctor_name: string; doctor_title: string | null; hospital_line: string | null;
    plan: EditPlan; company: string; transcript: Word[] | null;
  }[]>`
    select e.source_file_id, e.doctor_name, e.doctor_title, e.hospital_line, e.plan, e.transcript, c.name as company
      from video_edits e join companies c on c.id = e.company_id
     where e.id = ${id} and e.company_id = ${scope.companyId}
  `);
  if (!row?.plan) throw new VideoEditRejected('That edit has no plan.');

  const template = await getTemplate(scope);
  const source = await readFile(scope, row.source_file_id);
  const logo = template.logoFileId ? await readFile(scope, template.logoFileId).then((f) => f.body).catch(() => null) : null;
  const introLogo = template.introLogoFileId
    ? await readFile(scope, template.introLogoFileId).then((f) => f.body).catch(() => logo)
    : logo;
  const endVideo = (fileId: string | null) => fileId
    ? readFile(scope, fileId)
        .then((f) => ({ bytes: f.body, extension: f.filename.split('.').pop()?.toLowerCase() || 'mp4' }))
        .catch(() => null)
    : Promise.resolve(null);
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
    // The template's brand colour carries the panels; its accent, the bar.
    colours: { blue: template.background, red: template.accent, white: template.ink },
    logo,
    logoCorner: template.logoCorner,
    companyName: row.company,
    doctorName: row.doctor_name,
    doctorTitle: row.doctor_title,
    hospitalLine: row.hospital_line,
    cuts: row.plan.cuts,
    blocks: row.plan.blocks.filter((b) => b.heading.trim()).map((b) => ({
      heading: b.heading, bullets: b.bullets, from: b.from, to: b.to, reveal: whenSaid(row.transcript ?? [], b),
    })),
    broll,
    intro: template.introSeconds > 0 ? { logo: introLogo, seconds: template.introSeconds } : null,
    // Only the hospital's own wording: CIP never writes a disclaimer.
    disclaimer: template.disclaimerText ? { text: template.disclaimerText, seconds: template.disclaimerSeconds } : null,
    endScreen: {
      horizontal: await endVideo(template.endVideoFileId),
      vertical: await endVideo(template.endVideoVerticalFileId),
      tagline: template.tagline ?? template.endScreenText,
      seconds: template.outroSeconds,
    },
  });

  const key = videoEditKeyFor(scope.companyId, id);
  await driveStorage().put(key, film.bytes, 'video/mp4');
  await withCompanyScope(scope, (tx) => tx`
    update video_edits set status = 'ready', output_path = ${key}, error_message = null, updated_at = now()
     where id = ${id} and company_id = ${scope.companyId}
  `);
}

/** Removes a film and its plan. One being made is left alone until it is done. */
export async function deleteEdit(scope: CompanyScope, id: string): Promise<void> {
  if (!UUID.test(id)) throw new VideoEditRejected('That edit is not in this workspace.');
  const [row] = await withCompanyScope(scope, (tx) => tx<{ status: VideoEditDTO['status']; output_path: string | null }[]>`
    select status, output_path from video_edits where id = ${id} and company_id = ${scope.companyId}
  `);
  if (!row) throw new VideoEditRejected('That edit is not in this workspace.');
  if (row.status === 'rendering') throw new VideoEditRejected('This film is being made. Delete it once it is done.');
  await withCompanyScope(scope, (tx) => tx`delete from video_edits where id = ${id} and company_id = ${scope.companyId}`);
  if (row.output_path) await driveStorage().remove(row.output_path).catch(() => {});
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

/**
 * The recordings a film can be made from: the company's videos, newest first.
 * The hospital's end screens are left out unless asked for - they are never a
 * recording or b-roll.
 */
export async function listRecordings(
  scope: CompanyScope,
  options: { endScreens?: boolean } = {},
): Promise<{ id: string; name: string; sizeBytes: number; createdAt: string }[]> {
  const template = options.endScreens ? null : await getTemplate(scope);
  const hidden = [template?.endVideoFileId, template?.endVideoVerticalFileId].filter((x): x is string => Boolean(x));
  const rows = await withCompanyScope(scope, (tx) => tx<{ id: string; name: string; file_size: string; created_at: Date }[]>`
    select id, name, file_size, created_at from drive_files
     where company_id = ${scope.companyId} and archived_at is null and bytes_retained
       and mime_type like 'video/%'
     order by created_at desc
     limit 200
  `);
  return rows
    .filter((r) => !hidden.includes(r.id))
    .map((r) => ({ id: r.id, name: r.name, sizeBytes: Number(r.file_size), createdAt: r.created_at.toISOString() }));
}
