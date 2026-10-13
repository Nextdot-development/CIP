import 'server-only';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readVideoMetadata, runFfmpeg } from '../brain/media';
import { fullCard, lowerThird, ostPanel } from './cards';
import type { CardStyle } from './cards';
import { keptLength, keptSpans, toFilmSpan } from './timeline';
import type { Span } from './timeline';

/**
 * The film, made with ffmpeg: the recording with its fumbles cut, the title
 * card and the on-screen text laid over it, b-roll cut in where the plan says,
 * between the house intro and the disclaimer and end screen.
 *
 * Every frame of the template is fixed and drawn by CIP. Nothing an image or
 * video model made goes into it.
 */

export type RenderInput = {
  source: Buffer;
  sourceExtension: string;
  style: CardStyle;
  logo: Buffer | null;
  companyName: string;
  doctorName: string;
  doctorTitle: string | null;
  title: string;
  cuts: Span[];
  /** The on-screen text, block by block, in the recording's own time. */
  blocks: { heading: string; bullets: string[]; from: number; to: number }[];
  broll: { from: number; to: number; footage: Buffer; extension: string }[];
  introSeconds: number;
  disclaimer: { text: string; seconds: number } | null;
  endScreen: { text: string | null; seconds: number };
};

const FPS = 30;
/** How long the title card stays up at the start of the film. */
const TITLE_SECONDS = 5;

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

export async function renderFilm(input: RenderInput): Promise<{ bytes: Buffer; seconds: number }> {
  const dir = await mkdtemp(join(tmpdir(), 'cip-film-'));
  try {
    const sourcePath = join(dir, `source.${input.sourceExtension}`);
    await writeFile(sourcePath, input.source);
    const meta = await readVideoMetadata(sourcePath);
    // The film keeps the recording's shape, capped at 1080 on its short side.
    const scale = Math.min(1, 1080 / Math.min(meta.width ?? 1280, meta.height ?? 720));
    const size = { width: even((meta.width ?? 1280) * scale), height: even((meta.height ?? 720) * scale) };

    // 1. The recording, cut, with its lower thirds and b-roll.
    const kept = keptSpans(meta.durationSeconds, input.cuts);
    const filmSeconds = keptLength(kept);
    const inputs: string[] = ['-i', sourcePath];
    let nextInput = 1;
    const graph: string[] = [];

    kept.forEach((span, i) => {
      graph.push(
        `[0:v]trim=start=${span.from.toFixed(3)}:end=${span.to.toFixed(3)},setpts=PTS-STARTPTS,` +
          `scale=${size.width}:${size.height}:force_original_aspect_ratio=decrease,` +
          `pad=${size.width}:${size.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${FPS}[v${i}]`,
      );
      graph.push(
        meta.hasAudio
          ? `[0:a]atrim=start=${span.from.toFixed(3)}:end=${span.to.toFixed(3)},asetpts=PTS-STARTPTS,aresample=48000[a${i}]`
          : `anullsrc=r=48000:cl=stereo,atrim=duration=${(span.to - span.from).toFixed(3)}[a${i}]`,
      );
    });
    graph.push(`${kept.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=${kept.length}:v=1:a=1[base][audio]`);
    let current = 'base';

    // B-roll over the picture; the doctor's voice carries on underneath.
    for (const [j, b] of input.broll.entries()) {
      const at = toFilmSpan(b, kept);
      if (!at) continue;
      const path = join(dir, `broll${j}.${b.extension}`);
      await writeFile(path, b.footage);
      inputs.push('-i', path);
      const n = nextInput++;
      graph.push(
        `[${n}:v]scale=${size.width}:${size.height}:force_original_aspect_ratio=increase,crop=${size.width}:${size.height},` +
          `setsar=1,fps=${FPS},trim=duration=${(at.to - at.from).toFixed(3)},setpts=PTS-STARTPTS+${at.from.toFixed(3)}/TB[b${j}]`,
      );
      graph.push(`[${current}][b${j}]overlay=enable='between(t,${at.from.toFixed(3)},${at.to.toFixed(3)})':eof_action=pass[o${n}]`);
      current = `o${n}`;
    }

    // The title card, then each key point, while it is being said.
    const thirds: { png: Buffer; from: number; to: number }[] = [
      {
        png: lowerThird(size, input.style, input.title, [input.doctorName, input.doctorTitle].filter(Boolean).join(' · ')),
        from: 0,
        to: Math.min(TITLE_SECONDS, filmSeconds),
      },
    ];
    for (const block of input.blocks) {
      const at = toFilmSpan(block, kept);
      if (!at) continue;
      // Never on top of the title card: a block said under it waits for it to
      // clear, if there is still time to read it.
      const from = Math.max(at.from, TITLE_SECONDS);
      if (at.to - from >= 2) thirds.push({ png: ostPanel(size, input.style, block.heading, block.bullets), from, to: at.to });
    }
    for (const [k, third] of thirds.entries()) {
      const path = join(dir, `third${k}.png`);
      await writeFile(path, third.png);
      inputs.push('-loop', '1', '-t', filmSeconds.toFixed(3), '-i', path);
      const n = nextInput++;
      graph.push(`[${current}][${n}:v]overlay=0:0:enable='between(t,${third.from.toFixed(3)},${third.to.toFixed(3)})':shortest=1[o${n}]`);
      current = `o${n}`;
    }
    graph.push(`[${current}]format=yuv420p[film]`);

    const mainPath = join(dir, 'main.mp4');
    await runFfmpeg(
      [...inputs, '-filter_complex', graph.join(';'), '-map', '[film]', '-map', '[audio]',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2',
        '-movflags', '+faststart', '-y', mainPath],
      Math.max(240_000, filmSeconds * 4_000),
    );

    // 2. The fixed frames: intro, disclaimer, end screen.
    const still = async (name: string, png: Buffer, seconds: number) => {
      const image = join(dir, `${name}.png`);
      const clip = join(dir, `${name}.mp4`);
      await writeFile(image, png);
      await runFfmpeg(
        ['-loop', '1', '-t', seconds.toFixed(2), '-i', image, '-f', 'lavfi', '-t', seconds.toFixed(2), '-i', 'anullsrc=r=48000:cl=stereo',
          '-vf', `scale=${size.width}:${size.height},setsar=1,fps=${FPS},format=yuv420p`,
          '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-shortest', '-y', clip],
        120_000,
      );
      return clip;
    };
    const parts: string[] = [];
    parts.push(await still('intro', await fullCard(size, input.style, { logo: input.logo, heading: input.logo ? null : input.companyName }), input.introSeconds));
    parts.push(mainPath);
    if (input.disclaimer) {
      parts.push(await still('disclaimer', await fullCard(size, input.style, { body: input.disclaimer.text }), input.disclaimer.seconds));
    }
    parts.push(await still('end', await fullCard(size, input.style, { logo: input.logo, heading: input.logo ? null : input.companyName, body: input.endScreen.text }), input.endScreen.seconds));

    // 3. One film.
    const outPath = join(dir, 'film.mp4');
    const joinGraph =
      parts.map((_, i) => `[${i}:v]scale=${size.width}:${size.height},setsar=1,fps=${FPS},format=yuv420p[v${i}];[${i}:a]aresample=48000,aformat=channel_layouts=stereo[a${i}]`).join(';') +
      `;${parts.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=${parts.length}:v=1:a=1[v][a]`;
    await runFfmpeg(
      [...parts.flatMap((p) => ['-i', p]), '-filter_complex', joinGraph, '-map', '[v]', '-map', '[a]',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', '-y', outPath],
      Math.max(240_000, filmSeconds * 4_000),
    );

    const seconds = input.introSeconds + filmSeconds + (input.disclaimer?.seconds ?? 0) + input.endScreen.seconds;
    return { bytes: await readFile(outPath), seconds };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
