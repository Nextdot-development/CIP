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
  state: string;
  reason: string | null;
  fileId: string | null;
  externalMime: string;
  syncedAt: string | null;
  lastSeenAt: string | null;
};
