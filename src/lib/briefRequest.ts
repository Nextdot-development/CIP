/** One piece a client's brief asks to be made, with its size when the brief gives one. */
export type BriefDeliverable = { what: string; size?: string; ratio?: string };

/**
 * What goes in the composer for one piece of a brief: what it is, for which brand and market, and what
 * it must carry. A piece that names its brand ("A2 poster - 8PM") is for that brand alone, not every
 * brand the brief covers.
 */
export function requestFor(
  brief: { brands: string[]; market: string | null; skus: string[]; notes: string[] },
  piece: BriefDeliverable,
): string {
  const named = brief.brands.filter((b) => piece.what.toLowerCase().includes(b.toLowerCase()));
  const brands = named.length ? [] : brief.brands;
  const parts = [
    `${piece.what}${brands.length ? ` for ${brands.join(', ')}` : ''}${brief.market ? `, ${brief.market}` : ''}.`,
    piece.size ? `Size: ${piece.size}${piece.ratio ? ` (${piece.ratio})` : ''}.` : piece.ratio ? `Shape: ${piece.ratio}.` : '',
    brief.skus.length ? `Products: ${brief.skus.join('; ')}.` : '',
    brief.notes.length ? `Brief: ${brief.notes.join('. ')}.` : '',
  ];
  return parts.filter(Boolean).join(' ').replace(/\.\.+/g, '.');
}
