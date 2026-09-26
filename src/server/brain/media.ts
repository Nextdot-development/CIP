import 'server-only';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import bundledFfmpeg from 'ffmpeg-static';
import { BRAIN_LIMITS, BrainFailed } from './providers/types';

/**
 * Getting something analysable out of a video.
 *
 * A video is far too large to hand to a vision model whole, and doing so would
 * be both ruinously expensive and mostly redundant — consecutive frames say
 * almost the same thing. So a video becomes: its metadata, a bounded sample of
 * frames spread across its length, and a transcript of its audio when there is
 * any. That sample is what gets analysed.
 *
 * ffmpeg does the work. The one bundled with the app is used unless another is
 * named: Vercel has none on PATH, and neither did the laptop the worker runs
 * on, so every video that arrived after the last machine that happened to
 * have one was refused with "ffmpeg is not available".
 */

const run = promisify(execFile);

export type VideoMetadata = {
  durationSeconds: number;
  width: number | null;
  height: number | null;
  hasAudio: boolean;
};

export type SampledFrame = { bytes: Buffer; mimeType: string; atSeconds: number };

/** Whether ffmpeg is usable. Asked once: it cannot change while we run. */
let ffmpegChecked: boolean | null = null;

export async function ffmpegAvailable(): Promise<boolean> {
  if (ffmpegChecked !== null) return ffmpegChecked;
  try {
    await run(ffmpegPath(), ['-version'], { timeout: 10_000 });
    ffmpegChecked = true;
  } catch {
    ffmpegChecked = false;
  }
  return ffmpegChecked;
}

function ffmpegPath(): string {
  return process.env.CIP_FFMPEG_PATH ?? bundledFfmpeg ?? 'ffmpeg';
}

function ffprobePath(): string {
  return process.env.CIP_FFPROBE_PATH ?? 'ffprobe';
}

/**
 * Everything ffmpeg can tell us without decoding the whole file.
 *
 * Cheap, and worth having even when frame sampling later fails: duration and
 * dimensions are real facts about the asset.
 */
export async function readVideoMetadata(path: string): Promise<VideoMetadata> {
  let stdout: string;
  try {
    ({ stdout } = await run(
      ffprobePath(),
      [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-show_entries', 'stream=width,height,codec_type',
        '-of', 'json',
        path,
      ],
      { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 },
    ));
  } catch {
    // No ffprobe is bundled, only ffmpeg - and ffmpeg can say the same things.
    const fallback = await probeWithFfmpeg(path);
    if (fallback) return fallback;
    throw new BrainFailed('UNSUPPORTED_ASSET', 'permanent', 'That video could not be read.');
  }

  let parsed: {
    format?: { duration?: string };
    streams?: { width?: number; height?: number; codec_type?: string }[];
  };
  try {
    parsed = JSON.parse(stdout) as typeof parsed;
  } catch {
    throw new BrainFailed('UNSUPPORTED_ASSET', 'permanent', 'That video could not be read.');
  }

  const streams = parsed.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video');
  const duration = Number(parsed.format?.duration);

  return {
    durationSeconds: Number.isFinite(duration) && duration > 0 ? duration : 0,
    width: video?.width ?? null,
    height: video?.height ?? null,
    hasAudio: streams.some((s) => s.codec_type === 'audio'),
  };
}

/**
 * What `ffmpeg -i` prints about a file, read the way ffprobe would report it.
 *
 * With no output named, ffmpeg describes its input on stderr and exits with an
 * error. That description is all that is wanted here, so the error is expected
 * and its stderr is the answer.
 */
async function probeWithFfmpeg(path: string): Promise<VideoMetadata | null> {
  let stderr = '';
  try {
    ({ stderr } = await run(ffmpegPath(), ['-hide_banner', '-i', path], {
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
    }));
  } catch (error) {
    stderr = String((error as { stderr?: unknown }).stderr ?? '');
  }

  const clock = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  if (!clock) return null;
  const duration = Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3]);

  // "Video: h264 (High) (avc1 / 0x31637661), yuv420p, 1080x1920 [SAR 1:1 ...]".
  // Two or more digits either side of the x, so the codec tag's "0x3163..." is
  // not read as a size.
  const size = /Stream #[^\n]*Video:[^\n]*?\b(\d{2,5})x(\d{2,5})\b/.exec(stderr);

  return {
    durationSeconds: Number.isFinite(duration) && duration > 0 ? duration : 0,
    width: size ? Number(size[1]) : null,
    height: size ? Number(size[2]) : null,
    hasAudio: /Stream #[^\n]*Audio:/.test(stderr),
  };
}

/**
 * One frame, as a JPEG, from a moment in the video.
 *
 * Null rather than an error when that moment will not decode: a caller asking
 * for six frames is better served by five than by nothing.
 */
export async function frameAt(
  path: string,
  atSeconds: number,
  maxEdge = 1024,
): Promise<SampledFrame | null> {
  const workspace = await mkdtemp(join(tmpdir(), 'cip-frames-'));
  const output = join(workspace, 'frame.jpg');
  try {
    await run(
      ffmpegPath(),
      [
        // Seeking before the input is the fast path: ffmpeg jumps rather
        // than decoding everything up to that point.
        '-ss', Math.max(0, atSeconds).toFixed(3),
        '-i', path,
        '-frames:v', '1',
        // Long edge capped: a vision model gains nothing past its own limit,
        // and the bytes are what cost money.
        '-vf', `scale=${maxEdge}:${maxEdge}:force_original_aspect_ratio=decrease`,
        '-q:v', '4',
        '-y', output,
      ],
      { timeout: 60_000 },
    );
    return { bytes: await readFile(output), mimeType: 'image/jpeg', atSeconds };
  } catch {
    return null;
  } finally {
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Where the shots change, in seconds.
 *
 * ffmpeg scores how different each frame is from the one before, and a score
 * past the threshold is a cut. That is a full decode, so it is done at a
 * thumbnail's size: a cut is as visible at 320 pixels as at 1920, and the
 * difference in time is the difference between seconds and a minute.
 *
 * Twice, because there are two kinds of change. A hard cut - and a one-second
 * flash between two shots - shows between one frame and the next. A dissolve,
 * a push-in or a morph does not: each frame is nearly its neighbour, so no
 * threshold that ignores noise ever fires. On a real 20-second Whytehall film
 * frame-to-frame found one change where there were six. Comparing frames half
 * a second apart turns a slow change into a step and found all six.
 *
 * An empty list is a real answer - one continuous shot - not a failure.
 */
export async function sceneCuts(path: string, threshold = 0.3): Promise<number[]> {
  const [hard, gradual] = await Promise.all([
    changesAt(path, `scale=320:-2,select='gt(scene,${threshold})',showinfo`),
    changesAt(path, `fps=2,scale=320:-2,select='gt(scene,${threshold})',showinfo`),
  ]);

  // Both passes see a hard cut, a moment apart. One change is one change.
  return [...hard, ...gradual]
    .sort((a, b) => a - b)
    .filter((at, i, all) => i === 0 || at - all[i - 1]! >= 0.4);
}

async function changesAt(path: string, filter: string): Promise<number[]> {
  let stderr = '';
  try {
    ({ stderr } = await run(
      ffmpegPath(),
      ['-hide_banner', '-nostats', '-i', path, '-an', '-vf', filter, '-f', 'null', '-'],
      { timeout: 180_000, maxBuffer: 16 * 1024 * 1024 },
    ));
  } catch (error) {
    stderr = String((error as { stderr?: unknown }).stderr ?? '');
  }

  const found: number[] = [];
  for (const match of stderr.matchAll(/pts_time:\s*([0-9.]+)/g)) {
    const at = Number(match[1]);
    if (Number.isFinite(at)) found.push(at);
  }
  return found;
}

/** Which frames go on a check's sheet, and whether every shot made it. */
export type ShotPlan = {
  at: number[];
  shots: number;
  /** False when there were more shots than room, and some short ones are not shown. */
  complete: boolean;
};

/** Seconds of one shot that a single frame is taken to stand for. */
const SECONDS_PER_FRAME = 4;

/**
 * The moments to look at when checking a video, one shot at a time.
 *
 * Every shot gets a frame, however short, because the shot that breaks a rule
 * is often the short one: a second of a bottle nobody approved between two long
 * lifestyle shots. Each frame is from the middle of its shot rather than its
 * start, so it is not a half-dissolved transition or a line of text still being
 * typed on. A long shot gets more than one, since things change inside a shot
 * too - a line of copy appears, a warning fades in.
 *
 * The end card is always there, half a second from the end: the packshot, the
 * logo and very often the statutory warning are on it.
 *
 * When there are more frames than room, the first and last are kept and the
 * rest are thinned evenly, and the plan says so.
 */
export function framesForShots(
  durationSeconds: number,
  cuts: number[],
  most = BRAIN_LIMITS.maxCheckFrames,
): ShotPlan {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return { at: [], shots: 0, complete: true };
  }

  // Cuts in the first or last fraction of a second are fades from and to
  // black, and two cuts closer than that are one transition scored twice.
  const inside = [...cuts]
    .filter((c) => Number.isFinite(c) && c > 0.2 && c < durationSeconds - 0.2)
    .sort((a, b) => a - b)
    .filter((c, i, all) => i === 0 || c - all[i - 1]! >= 0.4);

  const bounds = [0, ...inside, durationSeconds];
  const perShot: number[][] = [];
  for (let i = 0; i < bounds.length - 1; i += 1) {
    const start = bounds[i]!;
    const length = bounds[i + 1]! - start;
    const count = Math.max(1, Math.round(length / SECONDS_PER_FRAME));
    perShot.push(Array.from({ length: count }, (_, k) => start + (length * (k + 0.5)) / count));
  }

  // Not when the last shot is short enough that its own frame is already the
  // end card - two copies of the same logo waste a place on the sheet.
  const endCard = durationSeconds - Math.min(0.5, durationSeconds * 0.05);
  let at = perShot.flat();
  if (!at.some((t) => Math.abs(t - endCard) < 1.25)) at.push(endCard);
  at = at.sort((a, b) => a - b).filter((t, i, all) => i === 0 || t - all[i - 1]! >= 0.4);

  let complete = true;
  if (at.length > most) {
    const first = at[0]!;
    const last = at.at(-1)!;
    const middle = at.slice(1, -1);
    const room = Math.max(0, most - 2);
    const kept = Array.from({ length: room }, (_, i) =>
      middle[Math.floor(((i + 0.5) * middle.length) / room)]!,
    );
    at = [first, ...kept, last];
    // Every shot is still shown only if each one kept at least one frame.
    complete = perShot.every((frames) => frames.some((t) => at.includes(t)));
  }

  return { at, shots: perShot.length, complete };
}

/** What was heard on a video's soundtrack, or why nothing was. */
export type Heard =
  | { status: 'heard'; text: string }
  | { status: 'nothing_said' }
  | { status: 'no_audio' }
  | { status: 'failed' };

/** The longest transcript kept. An advert's voiceover is far shorter. */
const MAX_HEARD_CHARS = 4_000;

/**
 * The soundtrack, in words, keeping "nothing was said" apart from "could not
 * be heard".
 *
 * `transcribe` answers null for both, which is fine for describing an asset
 * and wrong for checking one: a reviewer told "nothing is said in this video"
 * will stop listening for the disclaimer that the transcription simply failed
 * to catch.
 */
export async function hear(path: string, metadata: VideoMetadata, filename: string): Promise<Heard> {
  if (!metadata.hasAudio) return { status: 'no_audio' };
  const audio = await extractAudio(path, metadata);
  if (!audio) return { status: 'failed' };
  const outcome = await transcribeOutcome(audio, filename);
  if (outcome === 'failed') return { status: 'failed' };
  if (outcome === null) return { status: 'nothing_said' };
  return { status: 'heard', text: outcome.slice(0, MAX_HEARD_CHARS) };
}

/**
 * Frames spread evenly across the video.
 *
 * Evenly rather than at scene changes: scene detection costs a full decode and,
 * for the questions being asked here — what does this look like, how is it shot,
 * how does it move — a spread across the whole thing answers them better than a
 * cluster around wherever the cuts happen to be.
 *
 * The first and last moments are skipped: videos very often open and close on
 * black, and a black frame analysed as a brand asset is worse than no frame.
 */
export async function sampleFrames(
  path: string,
  metadata: VideoMetadata,
  maxFrames = BRAIN_LIMITS.maxVideoFrames,
): Promise<SampledFrame[]> {
  if (metadata.durationSeconds <= 0) return [];

  const count = Math.max(1, Math.min(maxFrames, Math.ceil(metadata.durationSeconds / 2)));
  const usable = metadata.durationSeconds * 0.9;
  const offset = metadata.durationSeconds * 0.05;

  const timestamps = Array.from({ length: count }, (_, i) =>
    count === 1 ? metadata.durationSeconds / 2 : offset + (usable * i) / (count - 1),
  );

  const frames: SampledFrame[] = [];
  for (const atSeconds of timestamps) {
    // One unreadable timestamp must not lose the whole video. A partial
    // sample still describes it; no frames at all is reported by the caller.
    const frame = await frameAt(path, atSeconds);
    if (frame) frames.push(frame);
  }
  return frames;
}

/**
 * The audio, as a compact mono file a transcription model will accept.
 *
 * Returns null when the video has no audio track, which is common for social
 * cuts and is not a failure.
 */
export async function extractAudio(path: string, metadata: VideoMetadata): Promise<Buffer | null> {
  if (!metadata.hasAudio) return null;

  const workspace = await mkdtemp(join(tmpdir(), 'cip-audio-'));
  const output = join(workspace, 'audio.mp3');
  try {
    await run(
      ffmpegPath(),
      [
        '-i', path,
        '-vn',
        '-ac', '1',
        '-ar', '16000',
        '-b:a', '64k',
        '-y', output,
      ],
      { timeout: 180_000 },
    );
    return await readFile(output);
  } catch {
    return null;
  } finally {
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Transcribes audio with OpenAI.
 *
 * Deliberately not part of the BrainProvider interface: it is a different
 * capability with a different model, and folding it in would oblige every
 * provider to implement speech recognition to be usable at all.
 *
 * Returns null rather than throwing when it cannot transcribe — a video is
 * still worth understanding from its frames alone.
 */
export async function transcribe(audio: Buffer, filename: string): Promise<string | null> {
  const outcome = await transcribeOutcome(audio, filename);
  return outcome === 'failed' ? null : outcome;
}

/** The words, null when there were none, or 'failed' when nobody could tell. */
async function transcribeOutcome(audio: Buffer, filename: string): Promise<string | null | 'failed'> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return 'failed';

  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(audio)], { type: 'audio/mpeg' }), `${filename}.mp3`);
  form.append('model', process.env.CIP_BRAIN_TRANSCRIBE_MODEL ?? 'gpt-4o-mini-transcribe');
  form.append('response_format', 'text');

  try {
    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(BRAIN_LIMITS.requestTimeoutMs),
    });
    if (!response.ok) return 'failed';
    const text = (await response.text()).trim();
    return text.length > 0 ? text : null;
  } catch {
    return 'failed';
  }
}

/**
 * Puts bytes on disk so ffmpeg can seek through them, and cleans up after.
 *
 * ffmpeg needs a real file: it seeks, and a stream would force a full decode
 * from the start for every frame.
 */
export async function withTempFile<T>(
  bytes: Buffer,
  extension: string,
  fn: (path: string) => Promise<T>,
): Promise<T> {
  const workspace = await mkdtemp(join(tmpdir(), 'cip-media-'));
  const path = join(workspace, `asset.${extension.replace(/[^a-z0-9]/gi, '') || 'bin'}`);
  try {
    await writeFile(path, bytes);
    return await fn(path);
  } finally {
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
}

/** Used by tests to confirm nothing is left behind in the temp directory. */
export async function tempArtefactsRemaining(): Promise<number> {
  const entries = await readdir(tmpdir()).catch(() => [] as string[]);
  return entries.filter((name) => name.startsWith('cip-frames-') || name.startsWith('cip-audio-') || name.startsWith('cip-media-')).length;
}
