import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import ffmpeg from 'ffmpeg-static';
import { checkpointsFor, readVideoMetadata, tempArtefactsRemaining, withTempFile } from '../src/server/brain/media';
import { videoContactSheet } from '../src/server/brain/contactSheet';

/**
 * Checking a video before it goes out.
 *
 * A real video, made by the same bundled ffmpeg the product uses, so nothing
 * here depends on a file in the repository or an ffmpeg on the machine. What is
 * under test is that a film becomes one sheet of its frames, in order, with the
 * end card on it - and that none of that needs ffprobe, which is not bundled.
 */

const run = promisify(execFile);
let workdir: string;
let upright: Buffer;

before(async () => {
  assert.ok(ffmpeg, 'ffmpeg-static has no binary for this platform');
  workdir = mkdtempSync(join(tmpdir(), 'cip-video-test-'));
  const out = join(workdir, 'upright.mp4');
  // Nine seconds, portrait like a reel, no audio.
  await run(ffmpeg!, [
    '-f', 'lavfi', '-i', 'testsrc=duration=9:size=320x568:rate=10',
    '-pix_fmt', 'yuv420p', '-y', out,
  ], { timeout: 60_000 });
  upright = readFileSync(out);
});

after(() => {
  rmSync(workdir, { recursive: true, force: true });
});

describe('where a video is looked at', () => {
  it('looks at the end card, not only the middle', () => {
    const at = checkpointsFor(30);
    assert.equal(at.length, 6);
    assert.ok(at[0]! <= 1, 'the first frame is near the start');
    assert.ok(30 - at.at(-1)! <= 0.5, 'the last frame is half a second from the end');
    assert.deepEqual([...at].sort((a, b) => a - b), at, 'in order');
  });

  it('does not sample a short bumper six times over', () => {
    assert.equal(checkpointsFor(5).length, 2);
    assert.equal(checkpointsFor(2).length, 1);
  });

  it('has nothing to look at in a video with no length', () => {
    assert.deepEqual(checkpointsFor(0), []);
    assert.deepEqual(checkpointsFor(Number.NaN), []);
  });
});

describe('reading a video without ffprobe', () => {
  it('gets the length and size from ffmpeg alone', async () => {
    const saved = process.env.CIP_FFPROBE_PATH;
    process.env.CIP_FFPROBE_PATH = join(workdir, 'no-such-ffprobe');
    try {
      const metadata = await withTempFile(upright, 'mp4', (path) => readVideoMetadata(path));
      assert.ok(Math.abs(metadata.durationSeconds - 9) < 0.2, `duration ${metadata.durationSeconds}`);
      assert.equal(metadata.width, 320);
      assert.equal(metadata.height, 568);
      assert.equal(metadata.hasAudio, false);
    } finally {
      if (saved === undefined) delete process.env.CIP_FFPROBE_PATH;
      else process.env.CIP_FFPROBE_PATH = saved;
    }
  });
});

describe('a video becomes one sheet of its frames', () => {
  it('lays the frames out in order, three across for an upright video', async () => {
    const before = await tempArtefactsRemaining();
    const sheet = await videoContactSheet(upright, 'mp4');

    assert.equal(sheet.mimeType, 'image/jpeg');
    assert.equal(sheet.bytes[0], 0xff);
    assert.equal(sheet.bytes[1], 0xd8);
    assert.equal(sheet.sequence.at.length, 3);
    assert.equal(sheet.sequence.columns, 3);
    assert.ok(sheet.sequence.at.at(-1)! >= 8, 'the end card is on it');
    assert.equal(await tempArtefactsRemaining(), before, 'nothing left behind in the temp directory');
  });

  it('says plainly when a file is not a video', async () => {
    await assert.rejects(
      videoContactSheet(Buffer.from('this is not a video at all'), 'mp4'),
      /could not be read|could not take/,
    );
  });
});
