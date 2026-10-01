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
  /** How it reads: as a person who signed in, or as CIP's service account. */
  authKind: 'oauth' | 'service_account' | null;
  /** The address to share a folder with, when CIP has a service account. */
  serviceAccountEmail: string | null;
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

export type MicrosoftStatus = 'connected' | 'needs_admin_consent' | 'disconnected';

/**
 * The connected Microsoft Team.
 *
 * Shorter than the Google one, and for the same reason the server type is: CIP
 * reads a Team as itself, with a permission an administrator granted once, so
 * there is no account, no token and no expiry to show.
 */
export type MicrosoftConnectionDTO = {
  status: MicrosoftStatus;
  /** Whether this deployment has an Entra application at all. */
  configured: boolean;
  teamId: string | null;
  teamName: string | null;
  driveName: string | null;
  connectedAt: string | null;
  lastSyncAt: string | null;
  lastSyncError: string | null;
  everSynced: boolean;
};

export type MicrosoftTeamDTO = {
  id: string;
  name: string;
  description: string | null;
};

export type SyncedTeamsFileDTO = {
  id: string;
  name: string;
  /** The folder inside the Team, as Microsoft reports it. */
  path: string | null;
  /** What the sync did: synced, unsupported, failed, trashed. */
  state: string;
  reason: string | null;
  fileId: string | null;
  syncedAt: string | null;
};

/**
 * A folder somebody can choose, and where it lives.
 *
 * `where` is what makes the list pickable: a company has "Assets" in My Drive,
 * "Assets" in a shared drive and "Assets" somebody shared with them, and the
 * name alone cannot tell them apart.
 */
export type PickableFolderDTO = {
  id: string;
  name: string;
  where: 'my_drive' | 'shared_drive' | 'shared_with_me';
  driveName: string | null;
};
