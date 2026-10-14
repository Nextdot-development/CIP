import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import ffmpeg from 'ffmpeg-static';
import postgres from 'postgres';
import { startTestDatabase } from './harness';
import type { TestDb } from './harness';
import { fillerCuts, keptLength, keptSpans, mergeCuts, pauseCuts, toFilmSpan, toFilmTime } from '../src/server/video/timeline';
import { parseGivenPlan, readSpan } from '../src/server/video/givenPlan';

/**
 * The Video Studio: a doctor's recording into a film in the house template.
 *
 * Run against the fake Brain and a fake ear, on a recording ffmpeg makes here.
 * What is under test is the machinery: times survive the cuts, nothing is made
 * before a person approves it, a key point that may break a rule says so, and
 * one company never sees another's films.
 */

const run = promisify(execFile);
let db: TestDb;
let adminSql: postgres.Sql;
let storageDir: string;
let workdir: string;
type Scope = { companyId: string; userId: string; role: 'owner' };
let nh: Scope;
let mm: Scope;
let drive: typeof import('../src/server/drive/service');
let video: typeof import('../src/server/video/edit');
let fake: import('../src/server/brain/providers').FakeBrainProvider;

before(async () => {
  assert.ok(ffmpeg, 'ffmpeg-static has no binary for this platform');
  db = await startTestDatabase();
  storageDir = mkdtempSync(join(tmpdir(), 'cip-video-store-'));
  workdir = mkdtempSync(join(tmpdir(), 'cip-video-edit-'));
  process.env.DATABASE_ADMIN_URL = db.adminUrl;
  process.env.CIP_APP_DB_PASSWORD = db.appPassword;
  process.env.SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.CIP_SEED_PASSWORD = 'cip-demo-password';
  process.env.CIP_STORAGE_DIR = storageDir;
  process.env.CIP_FORCE_LOCAL_STORAGE = 'true';
  process.env.CIP_FORCE_FAKE_BRAIN = 'true';
  process.env.CIP_FORCE_FAKE_PROVIDERS = 'true';

  const { migrate } = await import('../src/server/migrate');
  await migrate(() => {}, { skip: db.skipMigrations });
  const { seed } = await import('../src/server/seed');
  await seed(() => {});
  process.env.DATABASE_URL = db.appUrl;

  drive = await import('../src/server/drive/service');
  video = await import('../src/server/video/edit');
  const providers = await import('../src/server/brain/providers');
  const { FakeBrainProvider } = await import('../src/server/brain/providers/fake');
  fake = new FakeBrainProvider();
  providers.__setBrain(fake);
  const words = await import('../src/server/video/words');
  // A doctor saying twelve words, one a second, the third and fourth a fumble.
  words.__setTranscriber(async () =>
    'Hello I I um tremor is a shaking of the hands mostly'.split(' ').map((w, i) => ({ w, from: i, to: i + 0.8 })),
  );

  adminSql = postgres(db.adminUrl, { onnotice: () => {} });
  const rows = await adminSql<{ slug: string; company_id: string; user_id: string }[]>`
    select c.slug, c.id as company_id, u.id as user_id
      from companies c join memberships m on m.company_id = c.id join users u on u.id = m.user_id
     where u.email in ('rahul@narayanahealth.test', 'sneha@magicmoments.test')
  `;
  const n = rows.find((r) => r.slug === 'narayana-health')!;
  const m = rows.find((r) => r.slug === 'magic-moments')!;
  nh = { companyId: n.company_id, userId: n.user_id, role: 'owner' };
  mm = { companyId: m.company_id, userId: m.user_id, role: 'owner' };
}, { timeout: 180_000 });

after(async () => {
  await adminSql?.end();
  await db?.stop();
  rmSync(storageDir, { recursive: true, force: true });
  rmSync(workdir, { recursive: true, force: true });
});

describe('time before and after the cuts', () => {
  it('keeps what is not cut, and moves later moments earlier', () => {
    const kept = keptSpans(12, [{ from: 2, to: 4 }, { from: 3.5, to: 5 }]);
    assert.deepEqual(kept, [{ from: 0, to: 2 }, { from: 5, to: 12 }]);
    assert.equal(keptLength(kept), 9);
    assert.equal(toFilmTime(1, kept), 1);
    assert.equal(toFilmTime(3, kept), 2, 'a moment inside a cut lands where the cut closes');
    assert.equal(toFilmTime(8, kept), 5);
    assert.deepEqual(toFilmSpan({ from: 6, to: 9 }, kept), { from: 3, to: 6 });
    assert.equal(toFilmSpan({ from: 2.5, to: 4.5 }, kept), null, 'nothing of a span inside a cut survives');
  });

  it("cuts the doctor's pauses down to a breath, and never a word", () => {
    const words = [{ from: 0, to: 0.5 }, { from: 0.7, to: 1.2 }, { from: 3.2, to: 3.6 }, { from: 4.0, to: 4.4 }];
    // From the sound: a 1.6 s silence, a short one, and one a word starts inside (misheard as quiet).
    const cuts = pauseCuts([{ from: 1.4, to: 3.0 }, { from: 3.6, to: 3.9 }, { from: 0.4, to: 1.0 }], words);
    assert.equal(cuts.length, 1);
    assert.ok(Math.abs(cuts[0]!.from - 1.52) < 1e-9 && Math.abs(cuts[0]!.to - 2.88) < 1e-9);
    assert.match(cuts[0]!.reason, /Pause \(1\.6 s\)/);
    // With no sound to go on, the gaps between the words stand in.
    assert.equal(pauseCuts(null, words).length, 1);
  });

  it('cuts "er"s and words said twice, without reaching into the words around them', () => {
    const words = [
      { w: 'Week', from: 8.08, to: 8.52 }, { w: 'er,', from: 8.92, to: 9.36 }, { w: 'our', from: 9.36, to: 9.46 },
      { w: 'And', from: 12.2, to: 12.7 }, { w: 'er', from: 13.0, to: 13.0 }, { w: 'my', from: 13.0, to: 13.14 },
      { w: 'the', from: 14.0, to: 14.2 }, { w: 'the', from: 14.3, to: 14.5 }, { w: 'mothers', from: 14.5, to: 15.0 },
    ];
    const cuts = fillerCuts(words);
    assert.equal(cuts.length, 3);
    assert.ok(cuts[0]!.from >= 8.57 && cuts[0]!.to <= 9.36, 'between "Week" and "our"');
    assert.ok(cuts[1]!.from >= 12.7 && cuts[1]!.to <= 13.0, 'a filler with no length is cut between its neighbours');
    assert.deepEqual([cuts[2]!.from, cuts[2]!.to, cuts[2]!.reason], [14.0, 14.3, 'Repeated "the"']);
    assert.equal(mergeCuts([{ from: 1, to: 2, reason: 'a' }, { from: 1.5, to: 3, reason: 'b' }])[0]!.to, 3);
  });
});

describe('a plan a person wrote', () => {
  it('reads the OST sheet word for word', () => {
    const blocks = parseGivenPlan([
      '| Timecode / Section | On-Screen Text (OST – Pointer Format) | Visuals / B-roll Suggestions |',
      '|---|---|---|',
      '| 00:00–00:20 | • **Congenital heart disease in children**<br>• Present at birth<br>• Often treatable | Child with parent, ward |',
      '| Closing | • **Early checks matter**<br>• Ask your paediatrician | — |',
    ].join('\n'));
    assert.deepEqual(blocks, [
      { heading: 'Congenital heart disease in children', bullets: ['Present at birth', 'Often treatable'], visuals: 'Child with parent, ward', from: 0, to: 20 },
      { heading: 'Early checks matter', bullets: ['Ask your paediatrician'], visuals: '', from: null, to: null },
    ]);
  });

  it('reads plain text, a block a paragraph', () => {
    const blocks = parseGivenPlan('[01:05–01:30] Warning signs\n• Breathlessness\n• Blue lips\nVisuals: infant feeding\n\nWhen to see a doctor\n- Poor weight gain');
    assert.deepEqual(blocks, [
      { heading: 'Warning signs', bullets: ['Breathlessness', 'Blue lips'], visuals: 'infant feeding', from: 65, to: 90 },
      { heading: 'When to see a doctor', bullets: ['Poor weight gain'], visuals: '', from: null, to: null },
    ]);
    assert.equal(readSpan('Intro'), null);
    assert.deepEqual(readSpan('0:10 - 0:25'), { from: 10, to: 25 });
  });
});

describe('a recording into a film', () => {
  let fileId: string;

  before(async () => {
    const path = join(workdir, 'doctor.mp4');
    await run(ffmpeg!, ['-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25:duration=12', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=12',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-y', path], { timeout: 60_000 });
    const file = await drive.uploadFile(nh, { folderId: null, filename: 'doctor.mp4', mimeType: 'video/mp4', body: readFileSync(path) });
    fileId = file.id;
  });

  it('plans the edit, waits for a person, then makes the film', async () => {
    fake.videoPlan = {
      title: 'Understanding essential tremor',
      cuts: [{ from: 1, to: 4, reason: 'Repeated "I", "um"' }],
      blocks: [
        { heading: 'What essential tremor is', bullets: ['Shaking of the hands', 'Mostly in the hands'], from: 6, to: 10, visuals: 'hands shaking close-up', concern: null, ruleRefs: [] },
        { heading: 'Outlook', bullets: ['Tremor is always cured'], from: 10, to: 11.5, visuals: '', concern: 'Promises a cure', ruleRefs: ['R1'] },
      ],
    };
    await adminSql`
      insert into compliance_rules (company_id, category, requirement, rule, source, format)
      values (${nh.companyId}, 'claim', 'forbidden', 'Do not claim a treatment cures a disease.', 'manual', 'all')
    `;

    const planned = await video.createEdit(nh, { fileId, doctorName: 'Dr. A. Kumar', doctorTitle: 'Neurology' });
    assert.equal(planned.status, 'planned', planned.error ?? '');
    assert.equal(planned.plan!.title, 'Understanding essential tremor');
    const risky = planned.plan!.blocks.find((b) => b.concern)!;
    assert.match(risky.rules[0]!, /cures a disease/, 'the concern names the rule it may break');
    assert.equal(planned.plan!.blocks[0]!.footage, null, 'no footage in the library: said, not invented');

    // The house's OST sheet: one table, three columns, a bold heading first, a bullet a line.
    const sheet = video.ostTable(planned.plan!);
    assert.ok(
      sheet.startsWith('| Timecode / Section | On-Screen Text (OST – Pointer Format) | Visuals / B-roll Suggestions |\n|---|---|---|\n'),
      sheet,
    );
    assert.match(sheet, /\| 00:06–00:10 \| • \*\*What essential tremor is\*\*<br>• Shaking of the hands<br>• Mostly in the hands \| hands shaking close-up \|/);

    // Nothing is made before a person approves it.
    assert.equal(await video.renderApprovedEdits({ outOfTime: () => false }), 0);

    // The person removes the risky point. The block left wants b-roll and has
    // none, so it is asked about before anything is made.
    const edited = await video.updatePlan(nh, planned.id, { ...planned.plan!, blocks: planned.plan!.blocks.filter((b) => !b.concern) });
    assert.equal(edited.plan!.blocks.length, 1);
    await assert.rejects(() => video.approveEdit(nh, planned.id), /waiting for b-roll/);
    const answered = await video.updatePlan(nh, planned.id, {
      ...edited.plan!, blocks: edited.plan!.blocks.map((b) => ({ ...b, brollSkipped: true })),
    });
    assert.equal(answered.plan!.blocks[0]!.brollSkipped, true);
    await video.approveEdit(nh, planned.id);
    assert.equal(await video.renderApprovedEdits({ outOfTime: () => false }), 1);

    const done = (await video.getEdit(nh, planned.id))!;
    assert.equal(done.status, 'ready', done.error ?? '');
    const film = (await video.readFilm(nh, planned.id))!;
    assert.ok(film.bytes.length > 10_000);
    assert.equal(film.name, 'Understanding essential tremor.mp4');

    // The 2.5 s opening card + 9 s of recording (3 cut) + a 3 s drawn end screen.
    const out = join(workdir, 'film.mp4');
    writeFileSync(out, film.bytes);
    const { readVideoMetadata } = await import('../src/server/brain/media');
    const meta = await readVideoMetadata(out);
    assert.ok(Math.abs(meta.durationSeconds - 14.5) < 0.4, `film was ${meta.durationSeconds}s`);

    // Another company sees none of it.
    assert.equal(await video.getEdit(mm, planned.id), null);
    assert.equal(await video.readFilm(mm, planned.id), null);
    assert.deepEqual(await video.listEdits(mm), []);
  });

  it('puts the hospital\'s own disclaimer in, in its own words', async () => {
    await video.saveTemplate(nh, { disclaimerText: 'For information only. Consult your doctor.', disclaimerSeconds: 3 });
    fake.videoPlan = { title: 'Short talk', cuts: [], blocks: [] };
    const planned = await video.createEdit(nh, { fileId, doctorName: 'Dr. B' });
    await video.approveEdit(nh, planned.id);
    await video.renderApprovedEdits({ outOfTime: () => false });
    const film = (await video.readFilm(nh, planned.id))!;
    const out = join(workdir, 'film2.mp4');
    writeFileSync(out, film.bytes);
    const { readVideoMetadata } = await import('../src/server/brain/media');
    // Opening card 2.5 + the disclaimer card 3 + 12 of recording, less the repeated "I" and the "um" (about 2 s), + 3 end.
    const seconds = (await readVideoMetadata(out)).durationSeconds;
    assert.ok(Math.abs(seconds - 18.45) < 0.4, `film was ${seconds}s`);
  });

  it("puts a supplied plan on screen as written, with the footage given and the hospital's end screen", async () => {
    const clip = async (name: string, seconds: number, audio: boolean) => {
      const path = join(workdir, name);
      await run(ffmpeg!, ['-f', 'lavfi', '-i', `color=c=green:size=640x360:rate=25:duration=${seconds}`,
        ...(audio ? ['-f', 'lavfi', '-i', `sine=frequency=500:duration=${seconds}`, '-c:a', 'aac'] : []),
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-shortest', '-y', path], { timeout: 60_000 });
      return drive.uploadFile(nh, { folderId: null, filename: name, mimeType: 'video/mp4', body: readFileSync(path) });
    };
    const broll = await clip('ward.mp4', 4, true);
    const end = await clip('end-screen.mp4', 2, false);
    await video.saveTemplate(nh, { endVideoFileId: end.id, logoCorner: 'top-left', tagline: 'Take Care' });
    const t = await video.getTemplate(nh);
    assert.equal(t.endVideoFileId, end.id);
    assert.equal(t.logoCorner, 'top-left');

    fake.videoPlan = null;
    const given = [
      '| Timecode / Section | On-Screen Text | Visuals |',
      '|---|---|---|',
      '| 00:05–00:09 | • **What is a tremor?**<br>• An involuntary shake | Hospital ward |',
      '| Closing | • **When to see a doctor**<br>• If it gets worse | — |',
    ].join('\n');
    const planned = await video.createEdit(nh, {
      fileId, doctorName: 'Dr. D', hospitalLine: 'Narayana Health City | Bengaluru', givenPlan: given, brollIds: [broll.id],
    });
    assert.equal(planned.status, 'planned', planned.error ?? '');
    assert.equal(planned.givenPlan, true);
    assert.equal(planned.hospitalLine, 'Narayana Health City | Bengaluru');
    // Blocks run in time order; the one without a time was placed by the planner.
    const first = planned.plan!.blocks.find((b) => b.heading === 'What is a tremor?');
    const second = planned.plan!.blocks.find((b) => b.heading === 'When to see a doctor');
    assert.ok(first && second);
    assert.deepEqual(first!.bullets, ['An involuntary shake']);
    assert.deepEqual([first!.from, first!.to], [5, 9], 'a time that was given is kept');
    assert.equal(first!.footage?.fileId, broll.id, 'the footage given goes to the block that wants it');
    assert.equal(second!.footage, null);

    await video.approveEdit(nh, planned.id);
    assert.equal(await video.renderApprovedEdits({ outOfTime: () => false }), 1);
    const done = (await video.getEdit(nh, planned.id))!;
    assert.equal(done.status, 'ready', done.error ?? '');
    const out = join(workdir, 'film3.mp4');
    writeFileSync(out, (await video.readFilm(nh, planned.id))!.bytes);
    const { readVideoMetadata } = await import('../src/server/brain/media');
    const meta = await readVideoMetadata(out);
    // Opening 2.5 + disclaimer 3 + 12 s of recording less the stumble (about 2 s) + the hospital's own 2 s end screen, silence added under it.
    assert.ok(Math.abs(meta.durationSeconds - 17.45) < 0.4, `film was ${meta.durationSeconds}s`);
    assert.ok(meta.hasAudio);
  });

  it('makes the film straight away when asked, but never past a block that may break a rule', async () => {
    fake.videoPlan = null;
    const clean = await video.createEdit(nh, {
      fileId, doctorName: 'Dr. F', givenPlan: 'Tremor basics\n• A shake of the hands', autoMake: true,
    });
    assert.equal(clean.status, 'approved', clean.error ?? '');
    assert.equal(await video.renderApprovedEdits({ outOfTime: () => false }), 1);
    assert.equal((await video.getEdit(nh, clean.id))!.status, 'ready');

    fake.videoPlan = {
      title: 'Risky', cuts: [],
      blocks: [{ heading: 'Cure', bullets: ['Always cured'], from: 6, to: 10, visuals: '', concern: 'Promises a cure', ruleRefs: [] }],
    };
    const risky = await video.createEdit(nh, { fileId, doctorName: 'Dr. G', autoMake: true });
    assert.equal(risky.status, 'planned');
    assert.match(risky.error ?? '', /may break a rule/);
  });

  it("reads an editor's brief: trims, name plate, title, b-roll and description, and only the brief's own words", async () => {
    fake.videoPlan = null;
    const text = [
      'Raw File', 'Start – 0:01 (We are celebrating...)', 'Dr H. Rao', 'Consultant - Neurology',
      '0:05 – 0:07 (slide 1)', ' B-roll', 'Title – Tremor Awareness Week',
      '0:08 – 0:10', 'Get Help From', 'Neurologist', 'End – 0:11',
      'discription(Dr H. Rao on tremor.)',
    ].join('\n');
    fake.editBrief = {
      start: 1, end: 11, doctorName: 'Dr H. Rao', doctorTitle: 'Consultant - Neurology', hospitalLine: null,
      title: 'Tremor Awareness Week', description: 'Dr H. Rao on tremor.',
      blocks: [
        { heading: 'Get Help From', bullets: ['Neurologist'], from: 8, to: 10, visuals: '' },
        { heading: 'Tremor is always curable', bullets: [], from: null, to: null, visuals: '' },
      ],
      broll: [{ from: 5, to: 7, note: 'slide 1\n B-roll' }],
    };
    const planned = await video.createEdit(nh, { fileId, givenPlan: text, autoMake: true });
    assert.equal(planned.doctorName, 'Dr H. Rao', 'the name plate comes from the brief');
    assert.equal(planned.doctorTitle, 'Consultant - Neurology');
    assert.equal(planned.status, 'planned', 'it stops to ask for the b-roll the brief wants');
    assert.match(planned.error ?? '', /asks for b-roll/);
    const plan = planned.plan!;
    assert.equal(plan.title, 'Tremor Awareness Week');
    assert.equal(plan.description, 'Dr H. Rao on tremor.');
    // The brief's trims, with the repeated "I" joined to the first and the "um" cut between its neighbours.
    assert.deepEqual(plan.cuts.map((c) => [c.from, c.to]), [[0, 2], [2.9, 3.97], [11, 12]]);
    assert.deepEqual(plan.blocks.map((b) => b.heading), ['', 'Tremor Awareness Week', 'Get Help From'],
      'a line the model offered that is not in the brief never reaches the screen');
    const slot = plan.blocks[0]!;
    assert.deepEqual([slot.from, slot.to, slot.visuals, slot.brollWanted], [5, 7, 'slide 1', true]);

    // Answer the question, and it is made.
    await video.updatePlan(nh, planned.id, { ...plan, blocks: plan.blocks.map((b) => (b.heading ? b : { ...b, brollSkipped: true })) });
    await video.approveEdit(nh, planned.id);
    assert.equal(await video.renderApprovedEdits({ outOfTime: () => false }), 1);
    assert.equal((await video.getEdit(nh, planned.id))!.status, 'ready');
    fake.editBrief = null;
  });

  it('with "no b-roll", asks for none and makes the film straight away', async () => {
    fake.videoPlan = null;
    const planned = await video.createEdit(nh, {
      fileId, doctorName: 'Dr. N', givenPlan: 'Tremor basics\n• A shake of the hands\nVisuals: hands close-up', autoMake: true, noBroll: true,
    });
    assert.equal(planned.status, 'approved', planned.error ?? '');
    assert.equal(planned.plan!.blocks[0]!.brollSkipped, true);
    assert.equal(await video.renderApprovedEdits({ outOfTime: () => false }), 1);
  });

  it('shows each point when the doctor says it', () => {
    const words = 'babies may have poor feeding and they fail to gain weight over time'.split(' ').map((w, i) => ({ w, from: i, to: i + 0.8 }));
    const at = video.whenSaid(words, { from: 0, to: 12, bullets: ['Poor feeding', 'Failure to gain weight', 'Bluish lips'] });
    assert.deepEqual(at, [3, 7, null], 'heard where said; a point not heard is left to be spread');
  });

  it("refuses the hospital's end screen as the recording", async () => {
    const t = await video.getTemplate(nh);
    assert.ok(t.endVideoFileId);
    await assert.rejects(() => video.createEdit(nh, { fileId: t.endVideoFileId!, doctorName: 'Dr. H' }), /end screen/);
    assert.ok(!(await video.listRecordings(nh)).some((r) => r.id === t.endVideoFileId), 'not offered as a recording either');
  });

  it('refuses a plan it cannot read, and footage from another workspace', async () => {
    await assert.rejects(() => video.createEdit(nh, { fileId, doctorName: 'Dr. E', givenPlan: '| a |\n| b |' }), /could not be read/);
    await assert.rejects(() => video.createEdit(nh, { fileId, doctorName: 'Dr. E', brollIds: ['00000000-0000-0000-0000-000000000001'] }), /footage/);
  });

  it('refuses what is not a recording, and a film with no doctor named', async () => {
    const text = await drive.uploadFile(nh, { folderId: null, filename: 'notes.txt', mimeType: 'text/plain', body: Buffer.from('notes') });
    await assert.rejects(() => video.createEdit(nh, { fileId: text.id, doctorName: 'Dr. C' }), /video recording/);
    await assert.rejects(() => video.createEdit(nh, { fileId, doctorName: '  ' }), /doctor's name/);
  });
});
