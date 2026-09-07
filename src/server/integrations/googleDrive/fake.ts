import 'server-only';
import { DRIVE_SCOPE, GoogleDriveError, PAGE_SIZE } from './client';
import type { FilePage, GoogleDriveApi, GoogleFile, TokenSet } from './client';

/**
 * A Google Drive that lives in memory.
 *
 * Tests drive the sync through this: files can be added, edited and trashed,
 * and the sync must notice each. It paginates for real at the same page size
 * as the API, because "handles pagination" is a claim worth testing rather
 * than asserting.
 *
 * No network, no Google account, no OAuth client. Nothing here pretends a real
 * connection succeeded — the real client refuses when it has no credentials.
 */
export class FakeGoogleDrive implements GoogleDriveApi {
  readonly configured = true;

  /** Contents by folder id. */
  private folders = new Map<string, Map<string, GoogleFile>>();
  private contents = new Map<string, Buffer>();

  /** Set by tests to make the next call fail in a particular way. */
  failNext: GoogleDriveError | null = null;
  /**
   * File ids whose download or export fails.
   *
   * Separate from failNext because "one file in the folder is unreadable" is a
   * different situation from "the listing failed", and the sync is meant to
   * survive the first while abandoning the second.
   */
  failFetchFor = new Set<string>();
  /** Counts calls, so a test can prove a page was actually fetched. */
  listCalls = 0;
  downloadCalls = 0;
  exportCalls = 0;
  refreshCalls = 0;
  /** When true, refresh() rejects as though the grant had been revoked. */
  refreshRevoked = false;

  put(
    folderId: string,
    file: Partial<GoogleFile> & { id: string; name: string; mimeType: string },
    body: Buffer | string = 'content',
  ): GoogleFile {
    const folder = this.folders.get(folderId) ?? new Map<string, GoogleFile>();
    const full: GoogleFile = {
      id: file.id,
      name: file.name,
      mimeType: file.mimeType,
      modifiedTime: file.modifiedTime ?? new Date().toISOString(),
      md5Checksum: file.md5Checksum ?? null,
      size: file.size ?? (typeof body === 'string' ? body.length : body.byteLength),
      trashed: file.trashed ?? false,
    };
    folder.set(file.id, full);
    this.folders.set(folderId, folder);
    this.contents.set(file.id, typeof body === 'string' ? Buffer.from(body, 'utf8') : body);
    return full;
  }

  /** Edits a file the way a person would: new content, new modifiedTime. */
  edit(folderId: string, fileId: string, body: string): void {
    const file = this.folders.get(folderId)?.get(fileId);
    if (!file) throw new Error(`no such fake file: ${fileId}`);
    file.modifiedTime = new Date(Date.now() + 60_000).toISOString();
    file.md5Checksum = file.md5Checksum ? `${file.md5Checksum}-edited` : null;
    file.size = body.length;
    this.contents.set(fileId, Buffer.from(body, 'utf8'));
  }

  trash(folderId: string, fileId: string): void {
    const file = this.folders.get(folderId)?.get(fileId);
    if (file) file.trashed = true;
  }

  /** Removes a file outright, as though it had been deleted or moved away. */
  remove(folderId: string, fileId: string): void {
    this.folders.get(folderId)?.delete(fileId);
  }

  reset(): void {
    this.folders.clear();
    this.contents.clear();
    this.failNext = null;
    this.failFetchFor.clear();
    this.listCalls = 0;
    this.downloadCalls = 0;
    this.exportCalls = 0;
    this.refreshCalls = 0;
    this.refreshRevoked = false;
  }

  private checkFetch(fileId: string): void {
    if (this.failFetchFor.has(fileId)) {
      throw new GoogleDriveError('permanent', 'That file is no longer available.');
    }
  }

  private check(): void {
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = null;
      throw error;
    }
  }

  async exchangeCode(): Promise<TokenSet> {
    this.check();
    return {
      accessToken: 'fake-access-token',
      refreshToken: 'fake-refresh-token',
      expiresAt: new Date(Date.now() + 3600_000),
      scope: DRIVE_SCOPE,
      accountEmail: 'connected@example.test',
    };
  }

  async refresh(): Promise<TokenSet> {
    this.refreshCalls += 1;
    this.check();
    if (this.refreshRevoked) {
      throw new GoogleDriveError('needs_reauth', 'The grant was revoked.');
    }
    return {
      accessToken: `fake-access-token-${this.refreshCalls}`,
      refreshToken: null,
      expiresAt: new Date(Date.now() + 3600_000),
      scope: DRIVE_SCOPE,
      accountEmail: 'connected@example.test',
    };
  }

  async listFolder(_accessToken: string, folderId: string, pageToken: string | null): Promise<FilePage> {
    this.listCalls += 1;
    this.check();

    const all = [...(this.folders.get(folderId)?.values() ?? [])];
    const offset = pageToken ? Number(pageToken) : 0;
    const page = all.slice(offset, offset + PAGE_SIZE);
    const next = offset + PAGE_SIZE < all.length ? String(offset + PAGE_SIZE) : null;

    // Copies, so a test mutating the fake later cannot retroactively change
    // what a previous page appeared to contain.
    return { files: page.map((f) => ({ ...f })), nextPageToken: next };
  }

  async getFile(_accessToken: string, fileId: string): Promise<GoogleFile> {
    this.check();
    for (const folder of this.folders.values()) {
      const file = folder.get(fileId);
      if (file) return { ...file };
    }
    // Folders themselves are addressable too, so a folder id can be confirmed.
    if (this.folders.has(fileId)) {
      return {
        id: fileId,
        name: `Folder ${fileId}`,
        mimeType: 'application/vnd.google-apps.folder',
        modifiedTime: null,
        md5Checksum: null,
        size: null,
        trashed: false,
      };
    }
    throw new GoogleDriveError('permanent', 'That file or folder is no longer available in Google Drive.');
  }

  async download(_accessToken: string, fileId: string): Promise<Buffer> {
    this.downloadCalls += 1;
    this.check();
    this.checkFetch(fileId);
    const body = this.contents.get(fileId);
    if (!body) throw new GoogleDriveError('permanent', 'That file is no longer available.');
    return body;
  }

  async exportFile(_accessToken: string, fileId: string): Promise<Buffer> {
    this.exportCalls += 1;
    this.check();
    this.checkFetch(fileId);
    const body = this.contents.get(fileId);
    if (!body) throw new GoogleDriveError('permanent', 'That file is no longer available.');
    return body;
  }
}
