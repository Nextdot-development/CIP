import 'server-only';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readVideoMetadata, runFfmpeg } from '../brain/media';
import { disclaimerBand, houseEndCard, housePanel, logoBadge, namePlate } from './cards';
import type { HouseColours } from './cards';
import { keptLength, keptSpans, toFilmSpan } from './timeline';
import type { Span } from './timeline';

/**
 * The film, made with ffmpeg to the hospital's own template ("Video Template
 * NH 2026"):
 *
 *   - it opens on the doctor: no logo or title card first;
 *   - the name plate introduces the doctor, and the disclaimer follows it at
 *     the foot of the frame;
 *   - each block of on-screen text splits the frame: the doctor on the left
 *     half, the blue panel on the right (a strip across a vertical film);
 *   - the logo sits in its corner throughout a horizontal film, and only on
 *     the end frame of a vertical one;
 *   - it closes on the hospital's own end screen.
 *
 * Every frame of the template is fixed and drawn by CIP or supplied by the
 * hospital. Nothing an image or video model made goes into it.
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
  /** The on-screen text, block by block, in the recording's own time. */
  blocks: { heading: string; bullets: string[]; from: number; to: number }[];
  broll: { from: number; to: number; footage: Buffer; extension: string }[];
  disclaimer: { text: string; seconds: number } | null;
  /** The hospital's own end screens, one per shape; one not given is drawn. */
  endScreen: {
    horizontal: { bytes: Buffer; extension: string } | null;
    vertical: { bytes: Buffer; extension: string } | null;
    tagline: string | null;
    seconds: number;
  };
};

const FPS = 30;
/** The name plate is up from half a second in until here; the disclaimer follows it. */
const INTRO_SECONDS = 6;

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
const t3 = (n: number) => n.toFixed(3);

export async function renderFilm(input: RenderInput): Promise<{ bytes: Buffer; seconds: number }> {
  const dir = await mkdtemp(join(tmpdir(), 'cip-film-'));
  try {
    const sourcePath = join(dir, `source.${input.sourceExtension}`);
    await writeFile(sourcePath, input.source);
    const meta = await readVideoMetadata(sourcePath);
    // The film keeps the recording's shape, capped at 1080 on its short side.
    const scale = Math.min(1, 1080 / Math.min(meta.width ?? 1920, meta.height ?? 1080));
    const size = { width: even((meta.width ?? 1920) * scale), height: even((meta.height ?? 1080) * scale) };
    const vertical = size.height > size.width;

    const kept = keptSpans(meta.durationSeconds, input.cuts);
    const filmSeconds = keptLength(kept);
    const inputs: string[] = ['-i', sourcePath];
    let nextInput = 1;
    const graph: string[] = [];
    const still = async (name: string, png: Buffer) => {
      const path = join(dir, `${name}.png`);
      await writeFile(path, png);
      inputs.push('-loop', '1', '-t', t3(filmSeconds), '-i', path);
      return nextInput++;
    };

    // 1. The recording, with its fumbles cut.
    kept.forEach((span, i) => {
      graph.push(
        `[0:v]trim=start=${t3(span.from)}:end=${t3(span.to)},setpts=PTS-STARTPTS,` +
          `scale=${size.width}:${size.height}:force_original_aspect_ratio=decrease,` +
          `pad=${size.width}:${size.height}:(ow-iw)/2:(oh-ih)/2:color=white,setsar=1,fps=${FPS}[v${i}]`,
      );
      graph.push(
        meta.hasAudio
          ? `[0:a]atrim=start=${t3(span.from)}:end=${t3(span.to)},asetpts=PTS-STARTPTS,aresample=48000[a${i}]`
          : `anullsrc=r=48000:cl=stereo,atrim=duration=${t3(span.to - span.from)}[a${i}]`,
      );
    });
    graph.push(`${kept.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=${kept.length}:v=1:a=1[base][audio]`);
    let current = 'base';

    // 2. B-roll over the picture; the doctor's voice carries on underneath.
    for (const [j, b] of input.broll.entries()) {
      const at = toFilmSpan(b, kept);
      if (!at) continue;
      const path = join(dir, `broll${j}.${b.extension}`);
      await writeFile(path, b.footage);
      inputs.push('-i', path);
      const n = nextInput++;
      graph.push(
        `[${n}:v]scale=${size.width}:${size.height}:force_original_aspect_ratio=increase,crop=${size.width}:${size.height},` +
          `setsar=1,fps=${FPS},trim=duration=${t3(at.to - at.from)},setpts=PTS-STARTPTS+${t3(at.from)}/TB[b${j}]`,
      );
      graph.push(`[${current}][b${j}]overlay=enable='between(t,${t3(at.from)},${t3(at.to)})':eof_action=pass[o${n}]`);
      current = `o${n}`;
    }

    // 3. On-screen text. Never under the introduction: a block said during it
    //    waits for it to clear, if there is still time to read it.
    const blocks = input.blocks
      .map((b) => ({ ...b, at: toFilmSpan(b, kept) }))
      .filter((b): b is typeof b & { at: Span } => b.at !== null)
      .map((b) => ({ ...b, from: Math.max(b.at.from, INTRO_SECONDS), to: b.at.to }))
      .filter((b) => b.to - b.from >= 2);

    if (blocks.length > 0 && !vertical) {
      // The split screen: the middle of the frame moved to the left half, the
      // right half under the panel. Built once, shown only while a block is up.
      graph.push(`[${current}]split=2[full][half]`);
      graph.push(
        `[half]crop=${size.width / 2}:${size.height}:${size.width / 4}:0,` +
          `pad=${size.width}:${size.height}:0:0:color=white[split0]`,
      );
      let split = 'split0';
      for (const [k, b] of blocks.entries()) {
        const n = await still(`panel${k}`, housePanel(size, input.colours, b.heading, b.bullets));
        graph.push(`[${split}][${n}:v]overlay=0:0:enable='between(t,${t3(b.from)},${t3(b.to)})':shortest=1[split${k + 1}]`);
        split = `split${k + 1}`;
      }
      const when = blocks.map((b) => `between(t,${t3(b.from)},${t3(b.to)})`).join('+');
      graph.push(`[full][${split}]overlay=0:0:enable='${when}'[o_split]`);
      current = 'o_split';
    } else {
      for (const [k, b] of blocks.entries()) {
        const n = await still(`panel${k}`, housePanel(size, input.colours, b.heading, b.bullets));
        graph.push(`[${current}][${n}:v]overlay=0:0:enable='between(t,${t3(b.from)},${t3(b.to)})':shortest=1[o${n}]`);
        current = `o${n}`;
      }
    }

    // 4. The name plate, then the disclaimer straight after it.
    const plate = await still('plate', namePlate(size, input.colours, input.doctorName, input.doctorTitle, input.hospitalLine));
    graph.push(`[${current}][${plate}:v]overlay=0:0:enable='between(t,0.5,${t3(Math.min(INTRO_SECONDS, filmSeconds))})':shortest=1[o_plate]`);
    current = 'o_plate';
    if (input.disclaimer) {
      const from = Math.min(INTRO_SECONDS, Math.max(0, filmSeconds - input.disclaimer.seconds));
      const band = await still('disclaimer', disclaimerBand(size, input.disclaimer.text));
      graph.push(`[${current}][${band}:v]overlay=0:0:enable='between(t,${t3(from)},${t3(from + input.disclaimer.seconds)})':shortest=1[o_disc]`);
      current = 'o_disc';
    }

    // 5. The logo in its corner, throughout - on a horizontal film only.
    if (input.logo && !vertical) {
      const badge = await still('logo', await logoBadge(size, input.logo, input.logoCorner));
      graph.push(`[${current}][${badge}:v]overlay=0:0:shortest=1[o_logo]`);
      current = 'o_logo';
    }
    graph.push(`[${current}]format=yuv420p[film]`);

    const mainPath = join(dir, 'main.mp4');
    await runFfmpeg(
      [...inputs, '-filter_complex', graph.join(';'), '-map', '[film]', '-map', '[audio]',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2',
        '-t', t3(filmSeconds), '-movflags', '+faststart', '-y', mainPath],
      Math.max(240_000, filmSeconds * 5_000),
    );

    // 6. The end screen: the hospital's own, or drawn.
    let endPath: string;
    let endSeconds = input.endScreen.seconds;
    const endVideo = vertical ? input.endScreen.vertical : input.endScreen.horizontal;
    if (endVideo) {
      endPath = join(dir, `end.${endVideo.extension}`);
      await writeFile(endPath, endVideo.bytes);
      endSeconds = (await readVideoMetadata(endPath)).durationSeconds || endSeconds;
    } else {
      const image = join(dir, 'end.png');
      endPath = join(dir, 'end-card.mp4');
      await writeFile(image, await houseEndCard(size, input.colours, input.logo, input.endScreen.tagline, input.companyName));
      await runFfmpeg(
        ['-loop', '1', '-t', endSeconds.toFixed(2), '-i', image, '-f', 'lavfi', '-t', endSeconds.toFixed(2), '-i', 'anullsrc=r=48000:cl=stereo',
          '-vf', `scale=${size.width}:${size.height},setsar=1,fps=${FPS},format=yuv420p`,
          '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-shortest', '-y', endPath],
        120_000,
      );
    }

    // 7. One film. An end screen with no sound is given silence to join on.
    const endMeta = await readVideoMetadata(endPath);
    const outPath = join(dir, 'film.mp4');
    const endAudio = endMeta.hasAudio
      ? `[1:a]aresample=48000,aformat=channel_layouts=stereo[a1]`
      : `anullsrc=r=48000:cl=stereo,atrim=duration=${t3(endMeta.durationSeconds || endSeconds)}[a1]`;
    const joinGraph =
      `[0:v]scale=${size.width}:${size.height},setsar=1,fps=${FPS},format=yuv420p[v0];` +
      `[0:a]aresample=48000,aformat=channel_layouts=stereo[a0];` +
      `[1:v]scale=${size.width}:${size.height}:force_original_aspect_ratio=decrease,pad=${size.width}:${size.height}:(ow-iw)/2:(oh-ih)/2:color=white,` +
      `setsar=1,fps=${FPS},format=yuv420p[v1];${endAudio};` +
      `[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]`;
    await runFfmpeg(
      ['-i', mainPath, '-i', endPath, '-filter_complex', joinGraph, '-map', '[v]', '-map', '[a]',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', '-y', outPath],
      Math.max(240_000, filmSeconds * 5_000),
    );

    return { bytes: await readFile(outPath), seconds: filmSeconds + (endMeta.durationSeconds || endSeconds) };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
