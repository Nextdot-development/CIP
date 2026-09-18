import type { FileKind } from '@/lib/fileTypes';

/** What the Drive endpoints send the browser. No storage keys ever leave the server. */

/** What the Brain made of a file. */
export type UnderstandingStatus = 'pending' | 'processing' | 'ready' | 'failed' | 'unsupported';

export type ProcessingStatus = 'pending' | 'processing' | 'processed' | 'failed';

/**
 * Where a file came from. Uploaded by hand, or synced from a connected Google
 * Drive. Safe to show: it names the integration, never the account or folder.
 */
export type DriveSourceType = 'cip_drive' | 'google_drive';

export type DriveFolderDTO = {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type DriveFileDTO = {
  id: string;
  /**
   * Set on an upload whose bytes were already in this company's Drive.
   *
   * The file is stored all the same — the same picture under two names in two
   * folders is an ordinary thing to want. It is said so a person knows, and so
   * nobody wonders why the Brain only read it once. Absent everywhere else,
   * because it describes what an upload did rather than what the file is.
   */
  alreadyPresent?: boolean;
  /** The display name, which a rename changes. */
  name: string;
  /** What the file was called when it was uploaded. Never changes. */
  originalFilename: string;
  /** The extension we store and trust, e.g. "pdf". Set at upload, immutable. */
  fileType: string;
  mimeType: string;
  kind: FileKind;
  fileSize: number;
  previewable: boolean;
  createdAt: string;
  updatedAt: string;
  /** Who uploaded it. Null once that user is deleted. */
  uploadedBy: { id: string; name: string } | null;
  /** Reserved for the Brand Brain. Always 'pending' in Phase 2. */
  processingStatus: ProcessingStatus;
  /**
   * How far the Brain got with this file, if it has looked at it.
   *
   * Separate from processingStatus, which is only about pulling text out. An
   * image or a video is never extracted as text and so sits at `pending` for
   * ever; whether CIP understands it is this.
   */
  understanding: { status: UnderstandingStatus; kind: string } | null;
  /**
   * Which market this file's knowledge belongs to, if anyone has said.
   *
   * Suggested from the filename where that is unambiguous, and correctable —
   * it decides which briefs draw on this file, so a wrong guess should be
   * visible rather than silent.
   */
  market: string | null;
  sourceType: DriveSourceType;
};

/**
 * storage_path is deliberately absent from every DTO. It is an internal
 * pointer into a private bucket; a client has no use for it and exposing it
 * would widen the surface for nothing.
 */

export type BreadcrumbDTO = { id: string | null; name: string };

export type DriveListingDTO = {
  folder: { id: string; name: string; parentId: string | null } | null;
  breadcrumbs: BreadcrumbDTO[];
  folders: DriveFolderDTO[];
  files: DriveFileDTO[];
};

export type DriveSearchResultDTO = {
  query: string;
  files: (DriveFileDTO & { folderId: string | null; folderName: string | null })[];
  folders: DriveFolderDTO[];
};

/** What the extraction endpoint returns. Chunks are summarised, not dumped. */
export type ExtractionDTO = {
  fileId: string;
  kind: 'text' | 'ocr' | 'transcript' | 'caption';
  extractor: string;
  extractorVersion: string;
  /** The full length, even when `content` below was shortened for transport. */
  contentChars: number;
  content: string;
  contentTruncated: boolean;
  pageCount: number | null;
  warnings: string[];
  chunkCount: number;
  chunkerVersion: string | null;
  createdAt: string;
};

/**
 * One passage matched by meaning.
 *
 * Deliberately absent: company_id, storage_path, and the vector itself. The
 * offsets are what let a caller show the passage in context, and what will let
 * Phase 5 cite a source rather than paraphrase one.
 */
export type SemanticHitDTO = {
  sourceType: DriveSourceType;
  chunkId: string;
  fileId: string;
  fileName: string;
  fileType: string;
  folderId: string | null;
  folderName: string | null;
  heading: string | null;
  ordinal: number;
  charStart: number;
  charEnd: number;
  snippet: string;
  /** 1 - cosine distance, so higher is a better match. */
  score: number;
};

export type SemanticSearchDTO = {
  query: string;
  model: string;
  hits: SemanticHitDTO[];
};
