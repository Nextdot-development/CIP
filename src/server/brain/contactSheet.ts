import 'server-only';
import { BRAIN_LIMITS, BrainFailed } from './providers/types';
import type { VideoSequence } from './providers/types';
import { frameAt, framesForShots, hear, readVideoMetadata, sceneCuts, withTempFile } from './media';
import type { SampledFrame } from './media';

/**
 * A video, laid out as one picture so it can be checked as one creative.
 *
 * The checker looks at one image. Checking a video a frame at a time, the way a
 * deck is checked a page at a time, gets the answer wrong: a statutory warning
 * that appears only on the end card is missing from every other frame, and
 * five of six frames would each be failed for lacking it. A film is compliant
 * or not as a whole.
 *
 * So the frames go side by side, in order, on one sheet, and the Brain is told
 * that is what it is looking at and when each frame was taken. It can then say
 * "the warning is on the last frame only", which is a real finding, instead of
 * "there is no warning", which is not.
 *
 * Which frames: one from every shot, found by where the picture cuts, rather
 * than one every few seconds. A clock-driven sample drops whatever falls
 * between its ticks, and the shot that breaks a rule is so often the short
 * one. And the soundtrack is transcribed alongside, because an advert says
 * things as well as showing them - a voiceover claim is as much the advert as
 * a headline is.
 */

/** Between frames, so two adjacent shots cannot be read as one wide one. */
const GAP = 12;

export type ContactSheet = {
  bytes: Buffer;
  mimeType: 'image/jpeg';
  sequence: VideoSequence;
};

export async function videoContactSheet(
  bytes: Buffer,
  extension: string,
  filename = 'video',
): Promise<ContactSheet> {
  if (bytes.byteLength > BRAIN_LIMITS.maxVideoBytes) {
    throw new BrainFailed('UNSUPPORTED_ASSET', 'permanent', 'That video is too large to check.');
  }

  return withTempFile(bytes, extension, async (path) => {
    const metadata = await readVideoMetadata(path);
    if (metadata.durationSeconds > BRAIN_LIMITS.maxVideoSeconds) {
      throw new BrainFailed(
        'UNSUPPORTED_ASSET',
        'permanent',
        `That video is longer than the ${BRAIN_LIMITS.maxVideoSeconds}s CIP can check.`,
      );
    }

    // Listening and cutting are independent, so they run side by side: the
    // transcription is a network call and the cut detection is a decode.
    const [heard, cuts] = await Promise.all([
      hear(path, metadata, filename),
      sceneCuts(path),
    ]);
    const plan = framesForShots(metadata.durationSeconds, cuts);

    const frames: SampledFrame[] = [];
    for (const at of plan.at) {
      // The last moment can land past the final keyframe and decode to
      // nothing. A second earlier is still the end card.
      const frame = (await frameAt(path, at, 1280)) ?? (await frameAt(path, Math.max(0, at - 1), 1280));
      if (frame) frames.push(frame);
    }
    if (frames.length === 0) {
      throw new BrainFailed('UNSUPPORTED_ASSET', 'permanent', 'CIP could not take any frames from that video.');
    }

    return layOut(frames, {
      durationSeconds: metadata.durationSeconds,
      shots: plan.shots,
      complete: plan.complete,
      heard,
    });
  });
}

async function layOut(
  frames: SampledFrame[],
  video: Omit<VideoSequence, 'at' | 'columns'>,
): Promise<ContactSheet> {
  const { createCanvas, loadImage } = await import('@napi-rs/canvas');
  const images = await Promise.all(frames.map((f) => loadImage(f.bytes)));
  const width = images[0]!.width;
  const height = images[0]!.height;

  // Upright video (a reel, a story) is laid out wider than it is tall, and a
  // wide one taller than it is wide, so the sheet stays near square and no
  // frame is shrunk further than it has to be. Between the two widths that
  // suit it, the one that leaves fewer empty places wins: nine frames four
  // across left three blank cells and made every frame smaller for nothing.
  const n = images.length;
  const upright = height > width;
  const columns = n <= (upright ? 3 : 2) ? n : n === 4 ? 2 : fewestGaps(n, upright ? [3, 4] : [2, 3]);
  const rows = Math.ceil(n / columns);

  // As large as the vision model will look at, and never larger than the
  // frames themselves: scaling up adds pixels and no detail.
  const edge = BRAIN_LIMITS.visionEdgePixels;
  let cellWidth = Math.min(width, (edge - (columns - 1) * GAP) / columns);
  let cellHeight = (cellWidth * height) / width;
  if (rows * cellHeight + (rows - 1) * GAP > edge) {
    cellHeight = (edge - (rows - 1) * GAP) / rows;
    cellWidth = (cellHeight * width) / height;
  }
  cellWidth = Math.max(1, Math.floor(cellWidth));
  cellHeight = Math.max(1, Math.floor(cellHeight));

  const canvas = createCanvas(
    columns * cellWidth + (columns - 1) * GAP,
    rows * cellHeight + (rows - 1) * GAP,
  );
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#111111';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  images.forEach((image, index) => {
    const x = (index % columns) * (cellWidth + GAP);
    const y = Math.floor(index / columns) * (cellHeight + GAP);
    ctx.drawImage(image, x, y, cellWidth, cellHeight);
  });

  return {
    bytes: canvas.toBuffer('image/jpeg', 88),
    mimeType: 'image/jpeg',
    sequence: {
      ...video,
      at: frames.map((f) => f.atSeconds),
      columns,
    },
  };
}

/** The width that leaves the fewest empty places, the wider on a tie. */
function fewestGaps(n: number, widths: [number, number]): number {
  const gaps = (w: number) => Math.ceil(n / w) * w - n;
  return gaps(widths[0]) < gaps(widths[1]) ? widths[0] : widths[1];
}
