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
 * The moments to look at when checking a video before it goes out.
 *
 * Not the same as the understanding sample, which skips the last few seconds
 * because videos so often close on black. A check cannot skip them: the end
 * card is where the packshot, the logo and very often the statutory warning
 * are, and a check that never looked at it would call a compliant film
 * non-compliant. So the last moment is half a second from the end.
 *
 * One frame per three seconds, up to the limit, so a five-second bumper is not
 * sampled six times over.
 */
export function checkpointsFor(
  durationSeconds: number,
  most = BRAIN_LIMITS.maxVideoFrames,
): number[] {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return [];
  const count = Math.max(1, Math.min(most, Math.ceil(durationSeconds / 3)));
  if (count === 1) return [durationSeconds / 2];

  const first = Math.min(1, durationSeconds * 0.05);
  const last = Math.max(first, durationSeconds - Math.min(0.5, durationSeconds * 0.05));
  return Array.from({ length: count }, (_, i) => first + ((last - first) * i) / (count - 1));
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
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

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
    if (!response.ok) return null;
    const text = (await response.text()).trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
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
