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
import { keptLength, keptSpans, toFilmSpan, toFilmTime } from '../src/server/video/timeline';

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
      points: [
        { text: 'Tremor is shaking of the hands', from: 6, to: 10, concern: null, ruleRefs: [] },
        { text: 'Tremor is always cured', from: 10, to: 11.5, concern: 'Promises a cure', ruleRefs: ['R1'] },
      ],
      broll: [{ query: 'hands shaking close-up', from: 8, to: 10 }],
    };
    await adminSql`
      insert into compliance_rules (company_id, category, requirement, rule, source, format)
      values (${nh.companyId}, 'claim', 'forbidden', 'Do not claim a treatment cures a disease.', 'manual', 'all')
    `;

    const planned = await video.createEdit(nh, { fileId, doctorName: 'Dr. A. Kumar', doctorTitle: 'Neurology' });
    assert.equal(planned.status, 'planned', planned.error ?? '');
    assert.equal(planned.plan!.title, 'Understanding essential tremor');
    const risky = planned.plan!.points.find((p) => p.concern)!;
    assert.match(risky.rules[0]!, /cures a disease/, 'the concern names the rule it may break');
    assert.equal(planned.plan!.broll[0]!.fileId, null, 'no footage in the library: said, not invented');

    // Nothing is made before a person approves it.
    assert.equal(await video.renderApprovedEdits({ outOfTime: () => false }), 0);

    // The person removes the risky point and approves.
    const edited = await video.updatePlan(nh, planned.id, { ...planned.plan!, points: planned.plan!.points.filter((p) => !p.concern) });
    assert.equal(edited.plan!.points.length, 1);
    await video.approveEdit(nh, planned.id);
    assert.equal(await video.renderApprovedEdits({ outOfTime: () => false }), 1);

    const done = (await video.getEdit(nh, planned.id))!;
    assert.equal(done.status, 'ready', done.error ?? '');
    const film = (await video.readFilm(nh, planned.id))!;
    assert.ok(film.bytes.length > 10_000);
    assert.equal(film.name, 'Understanding essential tremor.mp4');

    // 2.5 s intro + 9 s of recording (3 cut) + 3 s end screen: no disclaimer was supplied, so none is invented.
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
    fake.videoPlan = { title: 'Short talk', cuts: [], points: [], broll: [] };
    const planned = await video.createEdit(nh, { fileId, doctorName: 'Dr. B' });
    await video.approveEdit(nh, planned.id);
    await video.renderApprovedEdits({ outOfTime: () => false });
    const film = (await video.readFilm(nh, planned.id))!;
    const out = join(workdir, 'film2.mp4');
    writeFileSync(out, film.bytes);
    const { readVideoMetadata } = await import('../src/server/brain/media');
    // 2.5 intro + 12 recording + 3 disclaimer + 3 end.
    assert.ok(Math.abs((await readVideoMetadata(out)).durationSeconds - 20.5) < 0.4);
  });

  it('refuses what is not a recording, and a film with no doctor named', async () => {
    const text = await drive.uploadFile(nh, { folderId: null, filename: 'notes.txt', mimeType: 'text/plain', body: Buffer.from('notes') });
    await assert.rejects(() => video.createEdit(nh, { fileId: text.id, doctorName: 'Dr. C' }), /video recording/);
    await assert.rejects(() => video.createEdit(nh, { fileId, doctorName: '  ' }), /doctor's name/);
  });
});
