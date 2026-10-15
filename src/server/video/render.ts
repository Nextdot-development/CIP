import 'server-only';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readVideoMetadata, runFfmpeg } from '../brain/media';
import { PANEL_LEFT, disclaimerCard, houseEndCard, housePanel, houseThumbnail, introCard, logoBadge, namePlate } from './cards';
import type { HouseColours } from './cards';
import { captionsSrt, keptLength, keptSpans, snapCuts, toFilmSpan, toFilmTime } from './timeline';
import type { Span } from './timeline';

/**
 * The film, made with ffmpeg to the hospital's own template, as its
 * published films are made:
 *
 *   1. the logo alone on white, then the disclaimer on white;
 *   2. the doctor - the name plate fading in at the start and again near the
 *      end; each block of on-screen text sliding in from the right, its points
 *      appearing one at a time as the doctor makes them. On a horizontal film
 *      the panel takes the right half and the doctor glides left to make room;
 *      on a vertical one it is a box in the lower half. The logo hangs from the
 *      top-left corner of a horizontal film throughout;
 *   3. the hospital's own end screen.
 *
 * Every frame of the template is drawn by CIP or supplied by the hospital.
 * Nothing an image or video model made goes into it.
 */

export type RenderInput = {
  source: Buffer;
  sourceExtension: string;
  colours: HouseColours;
  logo: Buffer | null;
  logoCorner: 'top-left' | 'top-right';
  companyName: string;
  doctorName: string;
  doctorTitle: string | null;
  hospitalLine: string | null;
  cuts: Span[];
  /**
   * The on-screen text, block by block, in the recording's own time. `reveal`
   * is when each point is said, so it can appear then; spread evenly when not
   * known.
   */
  blocks: { heading: string; bullets: string[]; from: number; to: number; reveal?: (number | null)[] }[];
  broll: { from: number; to: number; footage: Buffer; extension: string }[];
  /** The opening card: the logo alone. Null for none. */
  intro: { logo: Buffer | null; seconds: number } | null;
  /** The hospital's disclaimer, as a card after the opening. */
  disclaimer: { text: string; seconds: number } | null;
  /** The hospital's own end screens, one per shape; one not given is drawn. */
  endScreen: {
    horizontal: { bytes: Buffer; extension: string } | null;
    vertical: { bytes: Buffer; extension: string } | null;
    tagline: string | null;
    seconds: number;
  };
  /** 'vertical' makes a 9:16 Short from a horizontal recording, cropped to the doctor. */
  shape?: 'source' | 'vertical';
  /** A quick, small, rough cut to check before the film is made. */
  preview?: boolean;
  /** Every word with its time, for the captions. */
  words?: { w: string; from: number; to: number }[];
  /** The YouTube thumbnail, with this title. */
  thumbnail?: { title: string } | null;
};

export type RenderResult = {
  bytes: Buffer;
  /** The film's shape as made. */
  shape: 'horizontal' | 'vertical';
  seconds: number;
  /** The captions as an .srt, in the finished film's time. */
  captions: string | null;
  /** The YouTube thumbnail, 1280 x 720 PNG. */
  thumbnail: Buffer | null;
};

const FPS = 30;
/** How long a panel takes to slide in or out, and a point to fade in. */
const SLIDE = 0.5;
const FADE = 0.35;
/** The name plate's time on screen, as in the published films. */
const PLATE_SECONDS = { horizontal: 9.5, vertical: 4.5 };

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
const t3 = (n: number) => n.toFixed(3);
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * Where across the frame the doctor sits, 0 to 1: the middle of what moves.
 * A talking-head background stands still; the speaker does not.
 */
async function subjectAt(path: string, dir: string, from: number): Promise<number> {
  const W = 64;
  const H = 36;
  const raw = join(dir, 'motion.raw');
  await runFfmpeg(
    ['-ss', t3(from), '-t', '60', '-i', path, '-an', '-vf', `fps=2,scale=${W}:${H},format=gray`, '-f', 'rawvideo', '-y', raw],
    120_000,
  ).catch(() => {});
  const bytes = await readFile(raw).catch(() => Buffer.alloc(0));
  const frames = Math.floor(bytes.length / (W * H));
  if (frames < 3) return 0.5;
  const energy = new Array<number>(W).fill(0);
  for (let f = 1; f < frames; f++) {
    // The upper part of the frame: the face moves as the doctor talks; the
    // hands, lower down, wander wider than the doctor sits.
    for (let y = 0; y < Math.round(H * 0.55); y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        energy[x]! += Math.abs(bytes[f * W * H + i]! - bytes[(f - 1) * W * H + i]!);
      }
    }
  }
  const sorted = [...energy].sort((a, b) => a - b);
  const floor = sorted[Math.floor(W / 2)]!;
  let sum = 0;
  let weighted = 0;
  energy.forEach((e, x) => {
    const over = Math.max(0, e - floor);
    sum += over;
    weighted += over * (x + 0.5);
  });
  return sum > 0 ? weighted / sum / W : 0.5;
}

/**
 * The sound's loudness every 10 ms, for placing cuts in the quiet. Empty when
 * the recording has no sound.
 */
async function loudnessOf(path: string, dir: string): Promise<Float32Array> {
  const raw = join(dir, 'sound.raw');
  await runFfmpeg(['-i', path, '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', '-y', raw], 120_000).catch(() => {});
  const bytes = await readFile(raw).catch(() => Buffer.alloc(0));
  const per = 80;
  const out = new Float32Array(Math.floor(bytes.length / 2 / per));
  for (let k = 0; k < out.length; k++) {
    let sum = 0;
    for (let i = 0; i < per; i++) {
      const v = bytes.readInt16LE((k * per + i) * 2);
      sum += v * v;
    }
    out[k] = Math.sqrt(sum / per);
  }
  return out;
}

export async function renderFilm(input: RenderInput): Promise<RenderResult> {
  const dir = await mkdtemp(join(tmpdir(), 'cip-film-'));
  try {
    const sourcePath = join(dir, `source.${input.sourceExtension}`);
    await writeFile(sourcePath, input.source);
    const meta = await readVideoMetadata(sourcePath);
    const srcW = meta.width ?? 1920;
    const srcH = meta.height ?? 1080;
    let subject: number | null = null;
    const subjectX = async () => (subject ??= await subjectAt(sourcePath, dir, 0));

    // The film keeps the recording's shape, capped at 1080 on its short side -
    // or is a 1080 x 1920 Short cut from a horizontal recording. A preview is
    // a third of the size.
    const toVertical = input.shape === 'vertical' && srcW > srcH;
    const fit1080 = Math.min(1, 1080 / Math.min(srcW, srcH));
    const full = toVertical ? { width: 1080, height: 1920 } : { width: srcW * fit1080, height: srcH * fit1080 };
    const shrink = input.preview ? 360 / Math.min(full.width, full.height) : 1;
    const size = { width: even(full.width * shrink), height: even(full.height * shrink) };
    const vertical = size.height > size.width;
    const { width, height } = size;
    const x264 = input.preview ? ['-preset', 'ultrafast', '-crf', '32'] : ['-preset', 'veryfast', '-crf', '21'];

    // Every cut's edges in the quietest moment close by.
    const loudness = meta.hasAudio ? await loudnessOf(sourcePath, dir) : new Float32Array(0);
    const cuts = loudness.length ? snapCuts(input.cuts, loudness, 0.01, meta.durationSeconds) : input.cuts;
    const kept = keptSpans(meta.durationSeconds, cuts);
    const openSeconds = (input.intro?.seconds ?? 0) + (input.disclaimer?.seconds ?? 0);
    const filmSeconds = keptLength(kept);
    const plateSeconds = vertical ? PLATE_SECONDS.vertical : PLATE_SECONDS.horizontal;
    const inputs: string[] = ['-i', sourcePath];
    let nextInput = 1;
    const graph: string[] = [];
    let current = 'base';
    let label = 0;

    /** A still, on screen from `start` for `seconds`, optionally fading in and out. */
    const still = async (name: string, png: Buffer, start: number, seconds: number, fade: { in?: boolean; out?: boolean } = {}) => {
      const path = join(dir, `${name}.png`);
      await writeFile(path, png);
      inputs.push('-loop', '1', '-framerate', String(FPS), '-t', t3(seconds), '-i', path);
      const n = nextInput++;
      const fades = [
        ...(fade.in ? [`fade=t=in:st=0:d=${FADE}:alpha=1`] : []),
        ...(fade.out ? [`fade=t=out:st=${t3(Math.max(0, seconds - FADE))}:d=${FADE}:alpha=1`] : []),
      ];
      graph.push(`[${n}:v]format=rgba,${fades.length ? `${fades.join(',')},` : ''}setpts=PTS-STARTPTS+${t3(start)}/TB[s${n}]`);
      return `s${n}`;
    };
    const overlay = (stream: string, x = '0', y = '0') => {
      const out = `o${label++}`;
      graph.push(`[${current}][${stream}]overlay=x='${x}':y='${y}':eof_action=pass[${out}]`);
      current = out;
    };

    // 1. The recording, with its fumbles cut.
    let fit = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=white`;
    if (toVertical) {
      const cw = even(srcH * (9 / 16));
      const cx = even(clamp((await subjectX()) * srcW - cw / 2, 0, srcW - cw));
      fit = `crop=${cw}:${srcH}:${cx}:0,scale=${width}:${height}`;
    }
    kept.forEach((span, i) => {
      const length = span.to - span.from;
      graph.push(`[0:v]trim=start=${t3(span.from)}:end=${t3(span.to)},setpts=PTS-STARTPTS,${fit},setsar=1,fps=${FPS}[v${i}]`);
      // A few milliseconds of fade either side of every join: no click at a cut.
      graph.push(
        meta.hasAudio
          ? `[0:a]atrim=start=${t3(span.from)}:end=${t3(span.to)},asetpts=PTS-STARTPTS,aresample=48000,` +
              `afade=t=in:d=0.012,afade=t=out:st=${t3(Math.max(0, length - 0.012))}:d=0.012[a${i}]`
          : `anullsrc=r=48000:cl=stereo,atrim=duration=${t3(length)}[a${i}]`,
      );
    });
    graph.push(`${kept.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=${kept.length}:v=1:a=1[base][rawaudio]`);
    // The voice cleaned: rumble off, steady background hiss reduced, and the
    // level set to YouTube's loudness.
    graph.push(
      meta.hasAudio
        ? `[rawaudio]highpass=f=70,afftdn=nf=-25,loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000[audio]`
        : `[rawaudio]anull[audio]`,
    );

    // 2. B-roll over the picture; the doctor's voice carries on underneath.
    for (const [j, b] of input.broll.entries()) {
      const at = toFilmSpan(b, kept);
      if (!at) continue;
      const path = join(dir, `broll${j}.${b.extension}`);
      await writeFile(path, b.footage);
      inputs.push('-i', path);
      const n = nextInput++;
      graph.push(
        `[${n}:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},` +
          `setsar=1,fps=${FPS},trim=duration=${t3(at.to - at.from)},setpts=PTS-STARTPTS+${t3(at.from)}/TB[b${j}]`,
      );
      overlay(`b${j}`);
    }

    // 3. The blocks, in film time. On a vertical film they wait for the name
    //    plate, which shares their part of the frame; none overlaps the next.
    const earliest = vertical ? 0.5 + plateSeconds + 0.3 : 0.3;
    const blocks = input.blocks
      .map((b) => ({ ...b, at: toFilmSpan(b, kept) }))
      .filter((b): b is typeof b & { at: Span } => b.at !== null)
      .map((b) => ({ ...b, from: Math.max(b.at.from, earliest), to: b.at.to }))
      .sort((a, b) => a.from - b.from);
    blocks.forEach((b, i) => { if (blocks[i + 1] && b.to > blocks[i + 1]!.from) b.to = blocks[i + 1]!.from; });
    const shownBlocks = blocks.filter((b) => b.to - b.from >= 2.5);

    // A ramp in and out of each block, for the panel to ride on.
    const onScreen = shownBlocks
      .map((b) => `clip((t-${t3(b.from)})/${SLIDE},0,1)*clip((${t3(b.to)}-t)/${SLIDE},0,1)`)
      .join('+');

    // On a horizontal film the doctor moves left into the half that stays.
    if (!vertical && shownBlocks.length > 0) {
      const at = await subjectX();
      const dx = even(clamp(at * width - (PANEL_LEFT * width) / 2, 0, width * (1 - PANEL_LEFT)));
      if (dx > 4) {
        graph.push(`[${current}]pad=${width + dx}:${height}:0:0:color=white,crop=${width}:${height}:x='${dx}*(${onScreen})':y=0[shift]`);
        current = 'shift';
      }
    }

    // The panels: in from the right, the points appearing one at a time.
    const offset = vertical ? width : Math.round(width * (1 - PANEL_LEFT));
    const slideX = (b: { from: number; to: number }) =>
      `${offset}*(1-clip((t-${t3(b.from)})/${SLIDE},0,1))+${offset}*clip((t-${t3(b.to - SLIDE)})/${SLIDE},0,1)`;
    for (const [k, b] of shownBlocks.entries()) {
      const n = b.bullets.length;
      const first = b.from + SLIDE + 0.3;
      const last = b.to - SLIDE - 0.5;
      // When each point is said, kept in order, inside the block; spread evenly where not known.
      const times: number[] = [];
      for (let i = 0; i < n; i++) {
        const said = b.reveal?.[i];
        const filmAt = typeof said === 'number' ? toFilmTime(said, kept) : null;
        const spread = first + ((last - first) * 0.6 * i) / Math.max(1, n);
        times.push(clamp(filmAt ?? spread, Math.max(first, times[i - 1] ?? first), Math.max(first, last)));
      }
      const starts = [b.from, ...times];
      for (let s = 0; s <= n; s++) {
        const start = starts[s]!;
        // Each state stays until the next has faded in over it.
        const end = s < n ? Math.min(b.to, starts[s + 1]! + FADE) : b.to;
        if (end - start <= 0.05) continue;
        const stream = await still(`panel${k}-${s}`, housePanel(size, input.colours, b.heading, b.bullets, s), start, end - start, { in: s > 0 });
        overlay(stream, slideX(b));
      }
    }

    // 4. The name plate: after the doctor starts, and again before the end.
    const plate = namePlate(size, input.colours, input.doctorName, input.doctorTitle, input.hospitalLine);
    const plateTimes = [0.5];
    const lateFrom = filmSeconds - 0.5 - plateSeconds;
    const clashes = (from: number) => vertical && shownBlocks.some((b) => b.from < from + plateSeconds && b.to > from);
    if (lateFrom > 0.5 + plateSeconds * 2 + 5 && !clashes(lateFrom)) plateTimes.push(lateFrom);
    for (const [i, from] of plateTimes.entries()) {
      const seconds = Math.min(plateSeconds, filmSeconds - from);
      if (seconds > 1) overlay(await still(`plate${i}`, plate, from, seconds, { in: true, out: true }));
    }

    // 5. The logo, throughout - on a horizontal film only.
    if (input.logo && !vertical) {
      overlay(await still('logo', await logoBadge(size, input.logo, input.logoCorner), 0, filmSeconds));
    }
    graph.push(`[${current}]format=yuv420p[film]`);

    const mainPath = join(dir, 'main.mp4');
    await runFfmpeg(
      [...inputs, '-filter_complex', graph.join(';'), '-map', '[film]', '-map', '[audio]',
        '-c:v', 'libx264', ...x264, '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2',
        '-t', t3(filmSeconds), '-movflags', '+faststart', '-y', mainPath],
      Math.max(240_000, filmSeconds * 6_000),
    );

    // 6. The opening: the logo, then the disclaimer, on white.
    const cards: { png: Buffer; seconds: number }[] = [];
    if (input.intro && input.intro.seconds > 0) {
      cards.push({ png: await introCard(size, input.intro.logo, input.companyName), seconds: input.intro.seconds });
    }
    if (input.disclaimer && input.disclaimer.seconds > 0) {
      cards.push({ png: disclaimerCard(size, input.disclaimer.text), seconds: input.disclaimer.seconds });
    }
    const pieces: { path: string; seconds: number }[] = [];
    if (cards.length > 0) {
      const openPath = join(dir, 'open.mp4');
      const openInputs: string[] = [];
      for (const [i, c] of cards.entries()) {
        const path = join(dir, `open${i}.png`);
        await writeFile(path, c.png);
        openInputs.push('-loop', '1', '-framerate', String(FPS), '-t', t3(c.seconds), '-i', path);
      }
      const total = cards.reduce((n, c) => n + c.seconds, 0);
      await runFfmpeg(
        [...openInputs, '-f', 'lavfi', '-t', t3(total), '-i', 'anullsrc=r=48000:cl=stereo',
          '-filter_complex', `${cards.map((_, i) => `[${i}:v]scale=${width}:${height},setsar=1,fps=${FPS},format=yuv420p[c${i}]`).join(';')};` +
            `${cards.map((_, i) => `[c${i}]`).join('')}concat=n=${cards.length}:v=1:a=0[v]`,
          '-map', '[v]', '-map', `${cards.length}:a`, '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', '-ar', '48000', '-ac', '2',
          '-t', t3(total), '-y', openPath],
        120_000,
      );
      pieces.push({ path: openPath, seconds: total });
    }
    pieces.push({ path: mainPath, seconds: filmSeconds });

    // 7. The end screen: the hospital's own, or drawn.
    let endPath: string;
    let endSeconds = input.endScreen.seconds;
    const endVideo = vertical ? input.endScreen.vertical : input.endScreen.horizontal;
    if (endVideo) {
      endPath = join(dir, `end.${endVideo.extension}`);
      await writeFile(endPath, endVideo.bytes);
    } else {
      const image = join(dir, 'end.png');
      endPath = join(dir, 'end-card.mp4');
      await writeFile(image, await houseEndCard(size, input.colours, input.logo, input.endScreen.tagline, input.companyName));
      await runFfmpeg(
        ['-loop', '1', '-t', endSeconds.toFixed(2), '-i', image, '-f', 'lavfi', '-t', endSeconds.toFixed(2), '-i', 'anullsrc=r=48000:cl=stereo',
          '-vf', `scale=${width}:${height},setsar=1,fps=${FPS},format=yuv420p`,
          '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-shortest', '-y', endPath],
        120_000,
      );
    }
    const endMeta = await readVideoMetadata(endPath);
    endSeconds = endMeta.durationSeconds || endSeconds;
    pieces.push({ path: endPath, seconds: endSeconds });

    // 8. One film. A piece with no sound is given silence to join on.
    const outPath = join(dir, 'film.mp4');
    const joinInputs: string[] = [];
    const joinGraph: string[] = [];
    for (const [i, p] of pieces.entries()) {
      joinInputs.push('-i', p.path);
      const pm = p.path === endPath ? endMeta : await readVideoMetadata(p.path);
      joinGraph.push(
        `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=white,` +
          `setsar=1,fps=${FPS},format=yuv420p[v${i}]`,
        pm.hasAudio
          ? `[${i}:a]aresample=48000,aformat=channel_layouts=stereo[a${i}]`
          : `anullsrc=r=48000:cl=stereo,atrim=duration=${t3(p.seconds)}[a${i}]`,
      );
    }
    joinGraph.push(`${pieces.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=${pieces.length}:v=1:a=1[v][a]`);
    const total = pieces.reduce((n, p) => n + p.seconds, 0);
    await runFfmpeg(
      [...joinInputs, '-filter_complex', joinGraph.join(';'), '-map', '[v]', '-map', '[a]',
        '-c:v', 'libx264', ...x264, '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', '-y', outPath],
      Math.max(240_000, total * 5_000),
    );

    // The captions, in the finished film's time, and the thumbnail from a
    // moment of the doctor early on.
    const captions = input.words?.length ? captionsSrt(input.words, kept, openSeconds) : null;
    let thumbnail: Buffer | null = null;
    if (input.thumbnail) {
      const first = kept[0] ?? { from: 0, to: meta.durationSeconds };
      const still = join(dir, 'thumb-frame.png');
      await runFfmpeg(['-ss', t3(first.from + Math.min(2.5, (first.to - first.from) / 2)), '-i', sourcePath, '-frames:v', '1', '-update', '1', '-y', still], 60_000);
      thumbnail = await houseThumbnail({
        frame: await readFile(still), subjectX: await subjectX(), colours: input.colours, logo: input.logo,
        title: input.thumbnail.title, name: input.doctorName, designation: input.doctorTitle, hospitalLine: input.hospitalLine,
      });
    }
    return { bytes: await readFile(outPath), shape: vertical ? 'vertical' : 'horizontal', seconds: total, captions, thumbnail };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
