import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import ffmpeg from 'ffmpeg-static';
import {
  framesForShots,
  hear,
  readVideoMetadata,
  sceneCuts,
  tempArtefactsRemaining,
  withTempFile,
} from '../src/server/brain/media';
import { videoContactSheet } from '../src/server/brain/contactSheet';

/**
 * Checking a video before it goes out.
 *
 * Real videos, made by the same bundled ffmpeg the product uses, so nothing
 * here depends on a file in the repository or an ffmpeg on the machine. What is
 * under test is that a film is looked at one shot at a time, end card included,
 * and that "nobody could hear it" is never reported as "nothing was said".
 */

const run = promisify(execFile);
let workdir: string;
/** Three shots - red for 3s, blue for 4s, a test pattern for 5s - and a tone. */
let threeShots: Buffer;
/** One continuous shot, no sound. */
let oneShot: Buffer;

before(async () => {
  assert.ok(ffmpeg, 'ffmpeg-static has no binary for this platform');
  workdir = mkdtempSync(join(tmpdir(), 'cip-video-test-'));

  const cut = join(workdir, 'three.mp4');
  await run(ffmpeg!, [
    '-f', 'lavfi', '-i', 'color=c=red:s=320x568:d=3:r=10',
    '-f', 'lavfi', '-i', 'color=c=blue:s=320x568:d=4:r=10',
    '-f', 'lavfi', '-i', 'testsrc=s=320x568:d=5:r=10',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12',
    '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]',
    '-map', '[v]', '-map', '3:a',
    '-pix_fmt', 'yuv420p', '-shortest', '-y', cut,
  ], { timeout: 60_000 });
  threeShots = readFileSync(cut);

  const plain = join(workdir, 'one.mp4');
  await run(ffmpeg!, [
    '-f', 'lavfi', '-i', 'testsrc=duration=9:size=320x568:rate=10',
    '-pix_fmt', 'yuv420p', '-y', plain,
  ], { timeout: 60_000 });
  oneShot = readFileSync(plain);
});

after(() => {
  rmSync(workdir, { recursive: true, force: true });
});

describe('which moments of a video are looked at', () => {
  it('takes every shot, from its middle, and the end card', () => {
    const plan = framesForShots(12, [3, 7]);
    assert.equal(plan.shots, 3);
    assert.equal(plan.complete, true);
    assert.ok(plan.at.some((t) => Math.abs(t - 1.5) < 0.01), `no frame mid first shot: ${plan.at}`);
    assert.ok(plan.at.some((t) => Math.abs(t - 5) < 0.01), `no frame mid second shot: ${plan.at}`);
    assert.ok(12 - plan.at.at(-1)! <= 0.5, 'the end card is on it');
    assert.deepEqual([...plan.at].sort((a, b) => a - b), plan.at, 'in order');
  });

  it('gives a short shot its frame however short it is', () => {
    // A one-second shot between two long ones: exactly the kind a
    // clock-driven sample every few seconds would step over.
    const plan = framesForShots(20, [9, 10]);
    assert.ok(plan.at.some((t) => t > 9 && t < 10), `the 9-10s shot was skipped: ${plan.at}`);
  });

  it('does not show the end card twice when the last shot already is one', () => {
    // The Whytehall film: its last shot, 17.5s to the end, is the end card.
    const plan = framesForShots(20.1, [3, 5, 6.5, 8.5, 11, 17.5]);
    assert.equal(plan.shots, 7);
    assert.equal(plan.at.filter((t) => t > 17.5).length, 1, `end card frames: ${plan.at}`);
  });

  it('looks more than once inside a long shot', () => {
    const plan = framesForShots(20, []);
    assert.equal(plan.shots, 1);
    assert.ok(plan.at.length >= 5, `only ${plan.at.length} frames from 20 seconds`);
  });

  it('says so when there are more shots than room', () => {
    const cuts = Array.from({ length: 29 }, (_, i) => i + 1);
    const plan = framesForShots(30, cuts, 12);
    assert.equal(plan.shots, 30);
    assert.equal(plan.at.length, 12);
    assert.equal(plan.complete, false);
    assert.ok(30 - plan.at.at(-1)! <= 0.5, 'thinning never drops the end card');
  });

  it('ignores a fade at the very start or end, and one transition scored twice', () => {
    const plan = framesForShots(10, [0.1, 5, 5.2, 9.9]);
    assert.equal(plan.shots, 2);
  });

  it('has nothing to look at in a video with no length', () => {
    assert.deepEqual(framesForShots(0, []).at, []);
    assert.deepEqual(framesForShots(Number.NaN, [3]).at, []);
  });
});

describe('finding the cuts', () => {
  it('finds where the picture changes, and nowhere else', async () => {
    const cuts = await withTempFile(threeShots, 'mp4', (path) => sceneCuts(path));
    assert.equal(cuts.length, 2, `cuts found: ${cuts}`);
    assert.ok(Math.abs(cuts[0]! - 3) < 0.25 && Math.abs(cuts[1]! - 7) < 0.25, `cuts at ${cuts}`);
  });
});

describe('reading a video without ffprobe', () => {
  it('gets the length, size and sound from ffmpeg alone', async () => {
    const saved = process.env.CIP_FFPROBE_PATH;
    process.env.CIP_FFPROBE_PATH = join(workdir, 'no-such-ffprobe');
    try {
      const silent = await withTempFile(oneShot, 'mp4', (path) => readVideoMetadata(path));
      assert.ok(Math.abs(silent.durationSeconds - 9) < 0.2, `duration ${silent.durationSeconds}`);
      assert.equal(silent.width, 320);
      assert.equal(silent.height, 568);
      assert.equal(silent.hasAudio, false);

      const withSound = await withTempFile(threeShots, 'mp4', (path) => readVideoMetadata(path));
      assert.equal(withSound.hasAudio, true);
    } finally {
      if (saved === undefined) delete process.env.CIP_FFPROBE_PATH;
      else process.env.CIP_FFPROBE_PATH = saved;
    }
  });
});

describe('listening', () => {
  it('a video with no sound is "no sound", not "nothing said"', async () => {
    const heard = await withTempFile(oneShot, 'mp4', async (path) =>
      hear(path, await readVideoMetadata(path), 'one.mp4'),
    );
    assert.equal(heard.status, 'no_audio');
  });

  it('a soundtrack nobody could transcribe is a failure, never silence', async () => {
    // No key, so transcription cannot happen. A reviewer told "nothing is said"
    // would stop listening for a disclaimer that was simply never checked.
    const saved = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const heard = await withTempFile(threeShots, 'mp4', async (path) =>
        hear(path, await readVideoMetadata(path), 'three.mp4'),
      );
      assert.equal(heard.status, 'failed');
    } finally {
      if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
    }
  });
});

describe('a video becomes one sheet of its shots', () => {
  it('lays out a frame from every shot, in order, and says what was heard', async () => {
    const saved = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const before = await tempArtefactsRemaining();
    try {
      const sheet = await videoContactSheet(threeShots, 'mp4', 'three.mp4');

      assert.equal(sheet.mimeType, 'image/jpeg');
      assert.equal(sheet.bytes[0], 0xff);
      assert.equal(sheet.bytes[1], 0xd8);
      assert.equal(sheet.sequence.shots, 3);
      assert.equal(sheet.sequence.complete, true);
      assert.ok(sheet.sequence.at.some((t) => t < 3), 'the red shot');
      assert.ok(sheet.sequence.at.some((t) => t > 3 && t < 7), 'the blue shot');
      assert.ok(sheet.sequence.at.some((t) => t > 7), 'the last shot');
      assert.ok(sheet.sequence.at.at(-1)! >= 11, 'the end card');
      assert.equal(sheet.sequence.heard.status, 'failed');
      assert.equal(await tempArtefactsRemaining(), before, 'nothing left behind in the temp directory');
    } finally {
      if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
    }
  });

  it('says plainly when a file is not a video', async () => {
    await assert.rejects(
      videoContactSheet(Buffer.from('this is not a video at all'), 'mp4'),
      /could not be read|could not take/,
    );
  });
});
