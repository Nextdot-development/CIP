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
  name: string;
  extension: string;
  mimeType: string;
  kind: FileKind;
  sizeBytes: number;
  previewable: boolean;
  createdAt: string;
  updatedAt: string;
  uploadedBy: string | null;
  /** Reserved for the Brand Brain. Always 'pending' in Phase 2. */
  processingStatus: ProcessingStatus;
};

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
