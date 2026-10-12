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
