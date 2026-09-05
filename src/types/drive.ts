import type { FileKind } from '@/lib/fileTypes';

/** What the Drive endpoints send the browser. No storage keys ever leave the server. */

export type ProcessingStatus = 'pending' | 'processing' | 'processed' | 'failed';

export type DriveFolderDTO = {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type DriveFileDTO = {
  id: string;
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
