/**
 * Time in a recording, before and after its fumbles are cut out.
 *
 * Everything the plan says is in the recording's own time: the doctor began a
 * point at 41.2 seconds. Once two fumbles before it are cut, that moment is
 * earlier in the film. These turn one into the other.
 */

export type Span = { from: number; to: number };

/** The parts of a recording that stay, in order, once the cuts are taken out. */
export function keptSpans(duration: number, cuts: readonly Span[]): Span[] {
  const sorted = cuts
    .map((c) => ({ from: Math.max(0, c.from), to: Math.min(duration, c.to) }))
    .filter((c) => c.to > c.from)
    .sort((a, b) => a.from - b.from);

  // Overlapping or touching cuts are one cut.
  const merged: Span[] = [];
  for (const cut of sorted) {
    const last = merged.at(-1);
    if (last && cut.from <= last.to) last.to = Math.max(last.to, cut.to);
    else merged.push({ ...cut });
  }

  const kept: Span[] = [];
  let at = 0;
  for (const cut of merged) {
    if (cut.from > at) kept.push({ from: at, to: cut.from });
    at = cut.to;
  }
  if (at < duration) kept.push({ from: at, to: duration });
  // A sliver under a tenth of a second is a flash of picture, not a shot.
  return kept.filter((s) => s.to - s.from >= 0.1);
}

/** How long the film is once cut. */
export function keptLength(kept: readonly Span[]): number {
  return kept.reduce((n, s) => n + (s.to - s.from), 0);
}

/**
 * Where a moment of the recording lands in the cut film. A moment inside a cut
 * lands where the cut closes; one after the end, at the end.
 */
export function toFilmTime(t: number, kept: readonly Span[]): number {
  let film = 0;
  for (const span of kept) {
    if (t < span.from) return film;
    if (t <= span.to) return film + (t - span.from);
    film += span.to - span.from;
  }
  return film;
}

/**
 * A span of the recording as a span of the film, or null when nothing of it
 * survives the cuts.
 */
export function toFilmSpan(span: Span, kept: readonly Span[]): Span | null {
  const from = toFilmTime(span.from, kept);
  const to = toFilmTime(span.to, kept);
  return to - from >= 0.5 ? { from, to } : null;
}

/** A pause longer than this is cut down; the doctor keeps a short breath either side. */
export const LONGEST_PAUSE = 0.45;
const BREATH = 0.12;

/**
 * The doctor's pauses, as cuts: each silence in the sound longer than
 * LONGEST_PAUSE, cut so a breath is kept after the last word and before the
 * next. A silence a word starts inside is left alone - nothing said is cut.
 * Without the sound's silences, the gaps between the words stand in.
 */
export function pauseCuts(
  silences: readonly Span[] | null,
  words: readonly { from: number; to: number }[],
  longest = LONGEST_PAUSE,
): (Span & { reason: string })[] {
  const quiet = silences ?? words.slice(1).map((w, i) => ({ from: words[i]!.to, to: w.from }));
  const cuts: (Span & { reason: string })[] = [];
  for (const q of quiet) {
    const length = q.to - q.from;
    if (length <= longest) continue;
    const from = q.from + BREATH;
    const to = q.to - BREATH;
    if (to - from < 0.15) continue;
    if (words.some((w) => w.from > from && w.from < to)) continue;
    cuts.push({ from, to, reason: `Pause (${length.toFixed(1)} s)` });
  }
  return cuts;
}

/** "um", "uh", "er", "erm", "ah", "aa", "hmm" - the sounds between words, not words. */
const FILLER = /^(u+h+|u+m+|e+r+m*|a+h+|a{2,}h*|h+m+|m{2,})$/;
const bare = (w: string) => w.toLowerCase().replace(/[^a-z']/g, '');

/**
 * Fillers and stumbles, as cuts: each filler sound, from where the word
 * before it ends to where the next begins, and the first of a word said
 * twice running ("the the"). Speech-recognition times for a filler are rough
 * - often no length at all - so its cut is bounded by its neighbours, never
 * reaching into them.
 */
export function fillerCuts(words: readonly { w: string; from: number; to: number }[]): (Span & { reason: string })[] {
  const cuts: (Span & { reason: string })[] = [];
  const isFiller = (i: number) => FILLER.test(bare(words[i]?.w ?? ''));
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (isFiller(i)) {
      let p = i - 1;
      while (p >= 0 && isFiller(p)) p--;
      let n = i + 1;
      while (n < words.length && isFiller(n)) n++;
      const prevEnd = p >= 0 ? words[p]!.to : 0;
      const nextStart = n < words.length ? words[n]!.from : w.to + 0.3;
      const from = Math.max(prevEnd + 0.05, w.to > w.from ? w.from - 0.1 : prevEnd + 0.05);
      const to = nextStart - 0.03;
      if (to - from >= 0.08) cuts.push({ from, to, reason: `"${bare(w.w)}"` });
      i = n - 1;
      continue;
    }
    const next = words[i + 1];
    if (next && bare(w.w) && bare(w.w) === bare(next.w) && next.from - w.to < 0.6) {
      cuts.push({ from: w.from, to: next.from, reason: `Repeated "${bare(w.w)}"` });
    }
  }
  return cuts;
}

/** Cuts that touch or overlap become one, their reasons together. */
export function mergeCuts<T extends Span & { reason: string }>(cuts: readonly T[]): (Span & { reason: string })[] {
  const merged: (Span & { reason: string })[] = [];
  for (const c of [...cuts].sort((a, b) => a.from - b.from)) {
    const last = merged.at(-1);
    if (last && c.from <= last.to + 0.02) {
      last.to = Math.max(last.to, c.to);
      if (!last.reason.includes(c.reason)) last.reason = `${last.reason}, ${c.reason}`;
    } else {
      merged.push({ from: c.from, to: c.to, reason: c.reason });
    }
  }
  return merged;
}

/**
 * Retakes, as cuts: a run of words said again a few seconds later - the
 * doctor starting a sentence over. The earlier take goes, up to where the
 * later one begins; the last take is the one kept. Fillers are ignored
 * when comparing, so "the uh the baby" still matches "the baby".
 */
export function retakeCuts(words: readonly { w: string; from: number; to: number }[]): (Span & { reason: string })[] {
  const said = words
    .map((w) => ({ t: bare(w.w), from: w.from }))
    .filter((w) => w.t && !FILLER.test(w.t));
  const cuts: (Span & { reason: string })[] = [];
  for (let i = 0; i < said.length; i++) {
    for (let j = i + 2; j < said.length && said[j]!.from - said[i]!.from <= 10; j++) {
      let n = 0;
      while (i + n < j && j + n < said.length && said[i + n]!.t === said[j + n]!.t) n++;
      const chars = said.slice(i, i + n).reduce((c, w) => c + w.t.length, 0);
      if (n >= 3 || (n === 2 && chars >= 8)) {
        cuts.push({ from: said[i]!.from, to: said[j]!.from, reason: 'Retake' });
        i = j - 1;
        break;
      }
    }
  }
  return cuts;
}

/**
 * Each cut's edges moved to the quietest moment close by - inward only, so a
 * cut can shrink into the quiet but never grow into the word either side of
 * it. `loudness` is the sound's level in steps of `step` seconds. The start
 * of the recording and its end stay put.
 */
export function snapCuts<T extends Span>(cuts: readonly T[], loudness: ArrayLike<number>, step: number, duration: number): T[] {
  const quietest = (lo: number, hi: number, fallback: number) => {
    const a = Math.max(0, Math.floor(lo / step));
    const b = Math.min(loudness.length - 1, Math.ceil(hi / step));
    if (b <= a) return fallback;
    let best = a;
    for (let k = a; k <= b; k++) if (loudness[k]! < loudness[best]!) best = k;
    return (best + 0.5) * step;
  };
  return cuts.map((c) => {
    const from = c.from <= 0.01 ? c.from : quietest(c.from, c.from + 0.1, c.from);
    const to = c.to >= duration - 0.01 ? c.to : quietest(c.to - 0.1, c.to, c.to);
    return to > from ? { ...c, from, to } : c;
  });
}

/**
 * The captions, as an .srt: what the doctor says, fillers left out, timed to
 * the finished film - after `offset` seconds of opening, with the cuts taken
 * out. A caption is at most one line of 42 characters and five seconds, and
 * breaks at the end of a sentence or a pause.
 */
export function captionsSrt(words: readonly { w: string; from: number; to: number }[], kept: readonly Span[], offset: number): string {
  const heard = words
    .filter((w) => !FILLER.test(bare(w.w)))
    // A word mostly inside a cut is not in the film; one only clipped by it is.
    .filter((w) => {
      const end = Math.max(w.to, w.from + 0.05);
      const inFilm = kept.reduce((n, k) => n + Math.max(0, Math.min(end, k.to) - Math.max(w.from, k.from)), 0);
      return inFilm >= (end - w.from) * 0.5;
    })
    .map((w) => ({ w: w.w.trim(), from: toFilmTime(w.from, kept), to: toFilmTime(Math.max(w.to, w.from + 0.05), kept) }))
    .filter((w) => Boolean(w.w));
  const cues: { from: number; to: number; text: string; closed: boolean }[] = [];
  for (const word of heard) {
    const from = word.from + offset;
    const to = word.to + offset;
    const last = cues.at(-1);
    if (last && !last.closed && last.text.length + 1 + word.w.length <= 42 && to - last.from <= 5 && from - last.to <= 0.8) {
      last.to = to;
      last.text = `${last.text} ${word.w}`;
      last.closed = /[.!?]$/.test(word.w);
    } else {
      cues.push({ from, to, text: word.w, closed: /[.!?]$/.test(word.w) });
    }
  }
  const stamp = (t: number) => {
    const ms = Math.max(0, Math.round(t * 1000));
    const p = (n: number, w = 2) => String(n).padStart(w, '0');
    return `${p(Math.floor(ms / 3_600_000))}:${p(Math.floor(ms / 60_000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
  };
  return cues.map((c, i) => `${i + 1}\n${stamp(c.from)} --> ${stamp(Math.max(c.to, c.from + 0.8))}\n${c.text}\n`).join('\n');
}
