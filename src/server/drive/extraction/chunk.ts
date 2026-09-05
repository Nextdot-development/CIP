import 'server-only';

/**
 * Splitting extracted text into retrievable pieces.
 *
 * Deterministic and model-agnostic on purpose: the same text always produces
 * the same chunks, and nothing here knows or cares which embedding model comes
 * later. Sizes are in characters rather than tokens because a token count is
 * only meaningful once a tokeniser is chosen.
 *
 * Every chunk records exact offsets into the extraction content, so a chunk can
 * always be traced back to the text it came from — and the text can be
 * re-chunked later from the stored extraction, without re-reading the file,
 * by bumping CHUNKER_VERSION.
 */

export const CHUNKER_VERSION = '1';

const TARGET_CHARS = 1000;
const MAX_CHARS = 1400;
/** Carried from the end of one chunk into the start of the next. */
const OVERLAP_CHARS = 200;
/** Below this a trailing fragment is folded back into the previous chunk. */
const MIN_TAIL_CHARS = 120;
/**
 * The largest a single atom may be. A chunk is an atom plus the overlap
 * carried in front of it, so the atom budget has to leave room for that or a
 * wall of unbroken text would produce chunks over MAX_CHARS.
 */
const MAX_ATOM_CHARS = MAX_CHARS - OVERLAP_CHARS;

export type Chunk = {
  ordinal: number;
  content: string;
  charStart: number;
  charEnd: number;
  tokenEstimate: number;
  heading: string | null;
};

/** A paragraph, or a piece of one that was too long to keep whole. */
type Atom = { start: number; end: number };

const NL = String.fromCharCode(10);

export function chunkText(text: string): Chunk[] {
  if (text.trim().length === 0) return [];

  const atoms = atomise(text);
  if (atoms.length === 0) return [];

  const chunks: Chunk[] = [];
  let startIdx: number | null = null;
  let endIdx = 0;
  /** Where the next chunk should begin, so it overlaps this one. */
  let carryStart: number | null = null;

  const emit = () => {
    if (startIdx === null || endIdx <= startIdx) return;
    const content = text.slice(startIdx, endIdx).trim();
    if (content.length > 0) {
      chunks.push({
        ordinal: chunks.length,
        content,
        charStart: startIdx,
        charEnd: endIdx,
        tokenEstimate: Math.ceil(content.length / 4),
        heading: headingBefore(text, startIdx),
      });
    }
    carryStart = overlapBoundary(text, startIdx, endIdx);
    startIdx = null;
  };

  /** Start a chunk at the carried overlap when there is one ahead of this atom. */
  const openAt = (atomStart: number): number =>
    carryStart !== null && carryStart < atomStart ? carryStart : atomStart;

  for (const atom of atoms) {
    if (startIdx === null) {
      startIdx = openAt(atom.start);
      // An atom that nearly fills the budget cannot also carry overlap.
      if (atom.end - startIdx > MAX_CHARS) startIdx = atom.start;
      endIdx = startIdx;
    }

    // Adding this atom would overflow, so close what we have first.
    if (endIdx > startIdx && atom.end - startIdx > MAX_CHARS) {
      emit();
      startIdx = openAt(atom.start);
      // The overlap plus this atom can still overflow; the atom alone never
      // does, because atomise caps them.
      if (atom.end - startIdx > MAX_CHARS) startIdx = atom.start;
      endIdx = startIdx;
    }

    endIdx = atom.end;
    if (endIdx - startIdx >= TARGET_CHARS) emit();
  }

  emit();

  // A very short final chunk reads as an orphan; fold it into its predecessor.
  if (chunks.length > 1) {
    const last = chunks[chunks.length - 1]!;
    if (last.content.length < MIN_TAIL_CHARS) {
      const previous = chunks[chunks.length - 2]!;
      previous.charEnd = last.charEnd;
      previous.content = text.slice(previous.charStart, previous.charEnd).trim();
      previous.tokenEstimate = Math.ceil(previous.content.length / 4);
      chunks.pop();
    }
  }

  return chunks;
}

/**
 * Where the next chunk starts so that it overlaps this one.
 *
 * Overlap has to be measured in characters, not whole paragraphs: real
 * documents have paragraphs longer than the overlap budget, and carrying only
 * whole ones would mean no overlap at all in exactly the common case. The
 * boundary is nudged forward to the start of a word so a chunk never opens
 * mid-word.
 */
function overlapBoundary(text: string, start: number, end: number): number {
  const desired = Math.max(start + 1, end - OVERLAP_CHARS);
  let i = desired;
  while (i < end && !isSpace(text[i]!)) i += 1;
  while (i < end && isSpace(text[i]!)) i += 1;
  return i < end ? i : desired;
}

function isSpace(ch: string): boolean {
  return ch === ' ' || ch === NL || ch === String.fromCharCode(9) || ch === String.fromCharCode(13);
}

/**
 * Paragraphs first. Anything still over MAX_CHARS is cut at sentence
 * boundaries, and anything still too long after that is cut on length.
 */
function atomise(text: string): Atom[] {
  const atoms: Atom[] = [];
  const paragraphBreak = NL + NL;

  let cursor = 0;
  while (cursor < text.length) {
    let end = text.indexOf(paragraphBreak, cursor);
    if (end === -1) end = text.length;
    if (end > cursor) atoms.push(...split({ start: cursor, end }, text));
    cursor = end + paragraphBreak.length;
  }

  return atoms.filter((a) => text.slice(a.start, a.end).trim().length > 0);
}

function split(atom: Atom, text: string): Atom[] {
  if (atom.end - atom.start <= MAX_ATOM_CHARS) return [atom];

  const pieces: Atom[] = [];
  let start = atom.start;

  while (start < atom.end) {
    const hardEnd = Math.min(start + MAX_ATOM_CHARS, atom.end);
    if (hardEnd === atom.end) {
      pieces.push({ start, end: hardEnd });
      break;
    }

    // Prefer a sentence end, then any whitespace, then give up and cut.
    const window = text.slice(start, hardEnd);
    let cut = lastIndexOfAny(window, ['. ', '? ', '! ', '.' + NL, '?' + NL, '!' + NL]);
    if (cut < MAX_ATOM_CHARS / 2) cut = window.lastIndexOf(' ');
    const end = cut > 0 ? start + cut + 1 : hardEnd;

    pieces.push({ start, end });
    start = end;
  }

  return pieces;
}

function lastIndexOfAny(haystack: string, needles: string[]): number {
  let best = -1;
  for (const needle of needles) {
    const at = haystack.lastIndexOf(needle);
    if (at > best) best = at + needle.length - 1;
  }
  return best;
}

/**
 * The nearest line above the chunk that reads like a heading: short, and not
 * ending in sentence punctuation. Wrong sometimes, deterministic always, and
 * only ever used as a label.
 */
function headingBefore(text: string, offset: number): string | null {
  const before = text.slice(Math.max(0, offset - 2000), offset);
  const lines = before.split(NL).map((l) => l.trim()).filter(Boolean);

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!;
    if (line.length > 0 && line.length <= 80 && !/[.!?,;:]$/.test(line)) return line;
  }
  return null;
}
