/**
 * What the Drive accepts.
 *
 * Shared by the browser and the server on purpose: the upload button and the
 * upload route must agree on the list, and the server treats this as the
 * authority regardless of what the browser sent.
 */

export type FileKind = 'document' | 'spreadsheet' | 'presentation' | 'image' | 'video' | 'audio' | 'data';

export type FileTypeSpec = {
  extension: string;
  mimeTypes: string[];
  kind: FileKind;
  label: string;
  /** Can the browser show it inline, without downloading? */
  previewable: boolean;
};

export const ACCEPTED_TYPES: FileTypeSpec[] = [
  { extension: 'pdf',  mimeTypes: ['application/pdf'], kind: 'document', label: 'PDF', previewable: true },
  { extension: 'doc',  mimeTypes: ['application/msword'], kind: 'document', label: 'Word', previewable: false },
  { extension: 'docx', mimeTypes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'], kind: 'document', label: 'Word', previewable: false },
  { extension: 'xls',  mimeTypes: ['application/vnd.ms-excel'], kind: 'spreadsheet', label: 'Excel', previewable: false },
  { extension: 'xlsx', mimeTypes: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'], kind: 'spreadsheet', label: 'Excel', previewable: false },
  { extension: 'ppt',  mimeTypes: ['application/vnd.ms-powerpoint'], kind: 'presentation', label: 'PowerPoint', previewable: false },
  { extension: 'pptx', mimeTypes: ['application/vnd.openxmlformats-officedocument.presentationml.presentation'], kind: 'presentation', label: 'PowerPoint', previewable: false },
  { extension: 'csv',  mimeTypes: ['text/csv', 'application/csv'], kind: 'data', label: 'CSV', previewable: true },
  { extension: 'txt',  mimeTypes: ['text/plain'], kind: 'document', label: 'Text', previewable: true },
  { extension: 'jpg',  mimeTypes: ['image/jpeg'], kind: 'image', label: 'JPEG', previewable: true },
  { extension: 'jpeg', mimeTypes: ['image/jpeg'], kind: 'image', label: 'JPEG', previewable: true },
  { extension: 'png',  mimeTypes: ['image/png'], kind: 'image', label: 'PNG', previewable: true },
  { extension: 'webp', mimeTypes: ['image/webp'], kind: 'image', label: 'WebP', previewable: true },
  { extension: 'svg',  mimeTypes: ['image/svg+xml'], kind: 'image', label: 'SVG', previewable: false },
  { extension: 'mp4',  mimeTypes: ['video/mp4'], kind: 'video', label: 'MP4', previewable: true },
  { extension: 'mov',  mimeTypes: ['video/quicktime'], kind: 'video', label: 'MOV', previewable: true },
  { extension: 'mp3',  mimeTypes: ['audio/mpeg', 'audio/mp3'], kind: 'audio', label: 'MP3', previewable: true },
  { extension: 'wav',  mimeTypes: ['audio/wav', 'audio/x-wav', 'audio/wave'], kind: 'audio', label: 'WAV', previewable: true },
];

/**
 * The largest file the Drive accepts.
 *
 * A memory bound: an upload is held whole while it is written to the bucket.
 * What happens afterwards does not scale with it — a PDF is rendered a page at
 * a time under its own budgets — so this only has to be small enough that one
 * upload cannot exhaust the process.
 *
 * 50 MB was too tight in practice: real decks arrive at 52 MB. This file is
 * imported by the browser as well as the server, so the value is a constant
 * rather than read from the environment; the Google Drive path has its own
 * configurable ceiling for the same reason it has its own memory profile.
 */
export const MAX_FILE_BYTES = 128 * 1024 * 1024;

/** The same number, for a sentence a person reads. */
export function maxFileSizeLabel(): string {
  return `${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB`;
}

/**
 * The types the Knowledge Layer reads today. Everything else is stored and
 * listed normally; it is simply not extracted yet, and the UI says so rather
 * than leaving it looking stuck in a queue.
 *
 * src/server/drive/extraction asserts its registry matches this exactly.
 */
export const EXTRACTABLE_FILE_TYPES = ['pdf', 'docx', 'txt', 'csv'] as const;

export function isExtractable(fileType: string): boolean {
  return (EXTRACTABLE_FILE_TYPES as readonly string[]).includes(fileType.toLowerCase());
}

const BY_EXTENSION = new Map(ACCEPTED_TYPES.map((t) => [t.extension, t]));

export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot > 0 ? filename.slice(dot + 1).toLowerCase() : '';
}

export function specFor(filename: string): FileTypeSpec | null {
  return BY_EXTENSION.get(extensionOf(filename)) ?? null;
}

/** The `accept` attribute for the file picker. */
export const ACCEPT_ATTRIBUTE = ACCEPTED_TYPES.map((t) => `.${t.extension}`).join(',');

/**
 * SVG is previewable in principle and dangerous in practice: it can carry
 * script that would run against our own origin. It is always downloaded, and
 * every download is sent with Content-Disposition: attachment.
 */
export function canPreviewInline(spec: FileTypeSpec): boolean {
  return spec.previewable && spec.extension !== 'svg';
}

/**
 * Strips anything that could climb out of a folder or confuse a filesystem.
 * The stored name is only ever a display name — the object key is a UUID.
 */
export function sanitiseFilename(raw: string): string {
  // Both slash flavours: a browser on Windows can send a full path.
  const SEPARATORS = ['/', String.fromCharCode(92)];
  let base = raw;
  for (const sep of SEPARATORS) {
    const at = base.lastIndexOf(sep);
    if (at >= 0) base = base.slice(at + 1);
  }

  // Drop control characters by code point, so no escape sequence is involved.
  const printable = Array.from(base)
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code >= 32 && code !== 127;
    })
    .join('');

  const cleaned = printable
    .replace(/[<>:"|?*]/g, '')
    .replace(/[ 	]+/g, ' ')
    .trim();
  return cleaned.slice(0, 255) || 'untitled';
}

export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
