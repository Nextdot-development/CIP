import 'server-only';

/**
 * What can be ingested from a Team, and how.
 *
 * The same question 0009's types.ts answers for Google, with one difference
 * that removes most of the work: Microsoft stores Office documents as real
 * files. A Word document in a Team is a .docx the moment you download it,
 * where a Google Doc is not a file at all until it has been exported. So there
 * is no export table here and no exportMime — there is only "can the pipeline
 * read this", and the answer comes from the type Graph reports or, when that
 * is vague, from the extension.
 *
 * Everything the extractor cannot read is recorded as unsupported with a
 * reason. Nothing is quietly marked synced when it was not.
 */

/** The extensions a synced item can end up stored as. */
export type TeamsFileType =
  | 'pdf' | 'docx' | 'txt' | 'csv' | 'md'
  | 'png' | 'jpg' | 'webp' | 'gif'
  | 'mp4' | 'mov' | 'webm';

export type SupportedPlan =
  | { supported: true; fileType: TeamsFileType }
  | { supported: false; reason: string };

/** Types Graph reports for files the pipeline already reads. */
const DIRECT_TYPES: Record<string, TeamsFileType> = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'application/csv': 'csv',
  'text/markdown': 'md',

  // Looked at rather than read. A Team's Files tab is mostly artwork, and a
  // packshot says more about how a brand looks than any document does.
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',

  // Watched, and listened to.
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
};

/**
 * Office types CIP cannot read yet, named so the reason is useful.
 *
 * A Team is full of these and "application/vnd.openxmlformats-officedocument.
 * spreadsheetml.sheet is not a type CIP can read yet" tells a marketer
 * nothing. Saying "Excel" does.
 */
const OFFICE_NAMES: Record<string, string> = {
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'Excel',
  'application/vnd.ms-excel': 'Excel',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'PowerPoint',
  'application/vnd.ms-powerpoint': 'PowerPoint',
  'application/msword': 'older Word',
  'application/vnd.ms-outlook': 'Outlook',
  'application/onenote': 'OneNote',
};

/** Extensions worth trusting when Graph reports a vague type. */
const BY_EXTENSION: Record<string, TeamsFileType> = {
  pdf: 'pdf', docx: 'docx', txt: 'txt', csv: 'csv', md: 'md',
  png: 'png', jpg: 'jpg', jpeg: 'jpg', webp: 'webp', gif: 'gif',
  mp4: 'mp4', mov: 'mov', webm: 'webm',
};

export function planFor(mimeType: string, name: string): SupportedPlan {
  const direct = DIRECT_TYPES[mimeType];
  if (direct) return { supported: true, fileType: direct };

  // SharePoint reports a great many files as a generic stream, especially
  // anything uploaded by a sync client rather than through the browser. The
  // extension is checked before giving up, or a folder of PDFs uploaded from
  // somebody's desktop reads as unsupported.
  const extension = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  const byExtension = BY_EXTENSION[extension];
  if (byExtension) return { supported: true, fileType: byExtension };

  const office = OFFICE_NAMES[mimeType];
  if (office) return { supported: false, reason: `${office} files cannot be read yet.` };

  return { supported: false, reason: `${mimeType} is not a document type CIP can read yet.` };
}

/** The mime type a stored file should carry once downloaded. */
export function storedMimeFor(fileType: TeamsFileType): string {
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
 * SharePoint names are arbitrary text. They never reach a filesystem path —
 * storage keys are built from UUIDs — but this name is displayed and searched,
 * so it is cleaned rather than trusted on the grounds that it cannot do harm.
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

export class MicrosoftNotConnected extends Error {
  constructor(message = 'No Microsoft Teams workspace is connected.') {
    super(message);
    this.name = 'MicrosoftNotConnected';
  }
}

/**
 * The deployment's Entra application has not been granted what it needs.
 *
 * Distinct from "not connected": the company has chosen a team and CIP simply
 * is not allowed to read it. Only an administrator can fix that, and telling
 * somebody to reconnect would send them round a loop that cannot end.
 */
export class MicrosoftNeedsAdminConsent extends Error {
  constructor(
    message = 'CIP has not been granted access to this Microsoft 365 tenant. An administrator must approve it.',
  ) {
    super(message);
    this.name = 'MicrosoftNeedsAdminConsent';
  }
}
