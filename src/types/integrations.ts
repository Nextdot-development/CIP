/**
 * What the integration endpoints send the browser.
 *
 * A deliberate mirror of the server types rather than an import: those live
 * behind `server-only`, and copying the shape keeps the browser from pulling
 * that module in. There is no token field in either, so a credential cannot
 * reach a component even by accident.
 */

export type GoogleDriveStatus = 'connected' | 'needs_reauth' | 'disconnected';

export type GoogleDriveConnectionDTO = {
  status: GoogleDriveStatus;
  accountEmail: string | null;
  folderId: string | null;
  folderName: string | null;
  connectedAt: string | null;
  lastSyncAt: string | null;
  lastSyncError: string | null;
  syncing: boolean;
  files: { synced: number; pending: number; unsupported: number; trashed: number; failed: number };
  providerConfigured: boolean;
};

export type SyncedFileDTO = {
  id: string;
  name: string;
  /** What the sync did: synced, unsupported, too_large, failed, trashed. */
  state: string;
  reason: string | null;
  fileId: string | null;
  externalMime: string;
  sizeBytes: number | null;
  /** For `too_large`: the ceiling that rejected it, next to sizeBytes. */
  limitBytes: number | null;
  syncedAt: string | null;
  lastSeenAt: string | null;
  /**
   * How far the pipeline has actually got. Null until the file is a CIP file.
   *
   * Separate from `state` because copying a file in and reading it are
   * different steps, and treating the first as the second is what made a
   * queued PDF look finished.
   */
  progress: {
    status: 'queued' | 'processing' | 'ready' | 'failed';
    retained: boolean;
    error: string | null;
    pages: number | null;
    pagesUnderstood: number | null;
    posts: number | null;
  } | null;
};
