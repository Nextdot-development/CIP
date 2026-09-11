import 'server-only';

/**
 * What can be ingested, and how.
 *
 * Everything CIP can make sense of, which is more than it can extract text
 * from. Documents are read for their words; images are looked at, video is
 * watched, and a PDF with no text layer has its pages looked at a page at a
 * time. A sync that accepted only the text formats turned a folder of brand
 * logos into twenty-seven rows saying "not a document type CIP can read" —
 * true of the extractor, and quite wrong about CIP.
 *
 * Google's own document formats are not files at all until they are exported,
 * so each is mapped to the nearest thing the extractor already understands —
 * Docs to DOCX because the chunker uses headings, Sheets to CSV.
 *
 * Everything else is recorded as unsupported with a reason. Nothing is quietly
 * marked processed when it was not.
 */

/** The extensions a synced file can end up stored as. */
export type SyncedFileType =
  | 'pdf' | 'docx' | 'txt' | 'csv' | 'md'
  | 'png' | 'jpg' | 'webp' | 'gif'
  | 'mp4' | 'mov' | 'webm';

export type SupportedPlan =
  | { supported: true; fileType: SyncedFileType; exportMime: string | null }
  | { supported: false; reason: string };

/** Google's document types, which have to be exported before they are files. */
const GOOGLE_NATIVE: Record<string, SupportedPlan> = {
  'application/vnd.google-apps.document': {
    supported: true,
    fileType: 'docx',
    exportMime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  },
  'application/vnd.google-apps.spreadsheet': {
    supported: true,
    fileType: 'csv',
    exportMime: 'text/csv',
  },
};

/** Binary types Drive stores as-is, which need no conversion. */
const DIRECT_TYPES: Record<string, SyncedFileType> = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'text/plain': 'txt',
  'text/csv': 'csv',
  // Drive sometimes reports a CSV uploaded from a spreadsheet this way.
  'application/csv': 'csv',
  'text/markdown': 'md',

  // Looked at rather than read. A logo, a bottle shot and a packshot are most
  // of what a brand folder holds, and they say more about how a brand looks
  // than any document does.
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',

  // Watched, and listened to.
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
};

/** Extensions worth trusting when Drive reports a vague type. */
const BY_EXTENSION: Record<string, SyncedFileType> = {
  pdf: 'pdf', docx: 'docx', txt: 'txt', csv: 'csv', md: 'md',
  png: 'png', jpg: 'jpg', jpeg: 'jpg', webp: 'webp', gif: 'gif',
  mp4: 'mp4', mov: 'mov', webm: 'webm',
};

export function planFor(mimeType: string, name: string): SupportedPlan {
  const native = GOOGLE_NATIVE[mimeType];
  if (native) return native;

  const direct = DIRECT_TYPES[mimeType];
  if (direct) return { supported: true, fileType: direct, exportMime: null };

  if (mimeType === 'application/vnd.google-apps.folder') {
    return { supported: false, reason: 'Folders are not ingested; their contents are.' };
  }
  if (mimeType.startsWith('application/vnd.google-apps.')) {
    return {
      supported: false,
      reason: `Google ${mimeType.split('.').pop()} files cannot be read as documents yet.`,
    };
  }

  // Some Drives report a generic type for a file whose extension is clear.
  const extension = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  const byExtension = BY_EXTENSION[extension];
  if (byExtension) return { supported: true, fileType: byExtension, exportMime: null };

  return { supported: false, reason: `${mimeType} is not a document type CIP can read yet.` };
}

/** The mime type a stored file should carry, once exported or downloaded. */
export function storedMimeFor(fileType: SyncedFileType): string {
  switch (fileType) {
    case 'pdf':  return 'application/pdf';
    case 'docx': return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case 'csv':  return 'text/csv';
    case 'md':   return 'text/markdown';
    case 'png':  return 'image/png';
    case 'jpg':  return 'image/jpeg';
    case 'webp': return 'image/webp';
    case 'gif':  return 'image/gif';
    case 'mp4':  return 'video/mp4';
    case 'mov':  return 'video/quicktime';
    case 'webm': return 'video/webm';
    default:     return 'text/plain';
  }
}

/**
 * A name the Drive will accept, ending in the extension we stored.
 *
 * Google names are arbitrary text and can contain path separators or control
 * characters. They never reach a filesystem path — storage keys are built from
 * UUIDs — but this name is displayed and searched, so it is cleaned rather
 * than trusted on the grounds that it cannot do harm here.
 */
export function ingestedFilename(name: string, fileType: string): string {
  const cleaned = [...name]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      const separator = character === '/' || character === String.fromCharCode(92);
      return code >= 32 && code !== 127 && !separator;
    })
    .join('')
    .trim()
    .slice(0, 180);

  const base = cleaned.length > 0 ? cleaned : 'Untitled';
  return base.toLowerCase().endsWith('.' + fileType) ? base : base + '.' + fileType;
}

export class GoogleDriveNotConnected extends Error {
  constructor(message = 'No Google Drive is connected.') {
    super(message);
    this.name = 'GoogleDriveNotConnected';
  }
}

export class GoogleDriveNeedsReauth extends Error {
  constructor(message = 'Google Drive access has expired. Reconnect to continue.') {
    super(message);
    this.name = 'GoogleDriveNeedsReauth';
  }
}
