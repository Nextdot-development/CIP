import 'server-only';
import { recordUsage } from '../brain/usage';

/**
 * Every word of a recording, with when it starts and ends.
 *
 * Cutting a fumble needs to know where each word begins: a line-by-line
 * transcript says when a sentence started, not where the doctor tripped in
 * it. Whisper gives word times when asked.
 */

export type Word = { w: string; from: number; to: number };
export type Transcriber = (audio: Buffer, filename: string) => Promise<Word[] | null>;

const whisper: Transcriber = async (audio, filename) => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(audio)], { type: 'audio/mpeg' }), `${filename}.mp3`);
  form.append('model', 'whisper-1');
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'word');
  // Written with its fillers, so Whisper writes the doctor's "er"s and repeats
  // down too instead of tidying them away - they are what the edit cuts.
  form.append('prompt', 'Umm, so the the doctor, uh, is speaking to camera, er, about a health condition. Hmm, I I mean, ah, in English or Hinglish, in the Latin script.');
  try {
    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(240_000),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { duration?: number; words?: { word?: unknown; start?: unknown; end?: unknown }[] };
    // Whisper is billed by the minute; recorded as tokens of a thousandth of a minute.
    await recordUsage({ feature: 'video_transcript', model: 'whisper-1', inputTokens: Math.round((Number(body.duration) || 0) * 1000 / 60), outputTokens: 0 });
    return (body.words ?? [])
      .map((w) => ({ w: String(w.word ?? '').trim(), from: Number(w.start) || 0, to: Number(w.end) || 0 }))
      .filter((w) => w.w.length > 0 && w.to >= w.from);
  } catch {
    return null;
  }
};

let current: Transcriber = whisper;

export function transcribeWords(audio: Buffer, filename: string): Promise<Word[] | null> {
  return current(audio, filename);
}

/** Tests hear their own words. */
export function __setTranscriber(next: Transcriber | null): void {
  current = next ?? whisper;
}
