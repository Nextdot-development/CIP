/**
 * A plan a person wrote, read into blocks.
 *
 * Two shapes are understood. The house's OST sheet - one Markdown table,
 * "Timecode / Section | On-Screen Text | Visuals", a bold heading first in
 * each cell and a bullet a line - and plain text, a block a paragraph:
 *
 *   [00:12–00:40] Symptoms of congenital heart disease
 *   • Failure to thrive
 *   • Forehead sweating
 *   Visuals: infant feeding, close-up
 *
 * Times are kept where they are given and left null where they are not; the
 * planner places a block without one against the transcript. The words are
 * never changed: what a person wrote is what goes on screen.
 */

export type GivenBlock = {
  heading: string;
  bullets: string[];
  visuals: string;
  from: number | null;
  to: number | null;
};

/** "1:05" or "00:01:05" as seconds. */
function seconds(clock: string): number | null {
  const parts = clock.trim().split(':').map(Number);
  if (parts.length < 2 || parts.length > 3 || parts.some((p) => !Number.isFinite(p) || p < 0)) return null;
  return parts.reduce((n, p) => n * 60 + p, 0);
}

/** "00:00–00:20", "0:00 - 0:20", "[1:05-1:30]" as a span; null for a section label. */
export function readSpan(text: string): { from: number; to: number } | null {
  const m = text.match(/(\d{1,2}:\d{2}(?::\d{2})?)\s*(?:–|—|-|to)\s*(\d{1,2}:\d{2}(?::\d{2})?)/);
  if (!m) return null;
  const from = seconds(m[1]!);
  const to = seconds(m[2]!);
  return from !== null && to !== null && to > from ? { from, to } : null;
}

const clean = (line: string) =>
  line.replace(/^\s*(?:[•*\-–]|\d+[.)])\s*/, '').replace(/\*\*/g, '').replace(/^#+\s*/, '').trim();

function block(lines: string[], visuals: string, span: { from: number; to: number } | null): GivenBlock | null {
  const items = lines.map(clean).filter(Boolean);
  if (items.length === 0) return null;
  return {
    heading: items[0]!.slice(0, 80),
    bullets: items.slice(1, 6).map((b) => b.slice(0, 90)),
    visuals: visuals.trim().slice(0, 200),
    from: span?.from ?? null,
    to: span?.to ?? null,
  };
}

export function parseGivenPlan(text: string): GivenBlock[] {
  const source = text.replace(/\r\n/g, '\n').trim();
  if (!source) return [];

  // The OST sheet: rows of a pipe table, header and divider skipped.
  const rows = source.split('\n').filter((l) => /^\s*\|.*\|\s*$/.test(l));
  if (rows.length >= 2) {
    const blocks: GivenBlock[] = [];
    for (const row of rows) {
      const cells = row.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      if (cells.length < 2) continue;
      if (/^:?-{3,}:?$/.test(cells[0]!) || /timecode|on-screen text/i.test(cells.join(' '))) continue;
      const [when, ost, visuals = ''] = cells;
      const b = block(ost!.split(/<br\s*\/?>|\n/i), visuals === '—' ? '' : visuals, readSpan(when!));
      if (b) blocks.push(b);
    }
    return blocks;
  }

  // Plain text: a block a paragraph.
  return source
    .split(/\n\s*\n/)
    .map((para) => {
      const lines = para.split('\n').filter((l) => l.trim());
      let span: { from: number; to: number } | null = null;
      let visuals = '';
      const kept: string[] = [];
      for (const line of lines) {
        const v = line.match(/^\s*(?:visuals?|b-?roll)\s*:\s*(.*)$/i);
        if (v) { visuals = v[1]!; continue; }
        if (kept.length === 0) {
          const s = readSpan(line);
          if (s) {
            span = s;
            const rest = line.replace(/\[?\s*\d{1,2}:\d{2}(?::\d{2})?\s*(?:–|—|-|to)\s*\d{1,2}:\d{2}(?::\d{2})?\s*\]?\s*[:|-]?\s*/, '');
            if (rest.trim()) kept.push(rest);
            continue;
          }
        }
        kept.push(line);
      }
      return block(kept, visuals, span);
    })
    .filter((b): b is GivenBlock => b !== null);
}
