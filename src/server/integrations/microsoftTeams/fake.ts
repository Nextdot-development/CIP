import 'server-only';
import { MicrosoftGraphError, MicrosoftGraphTooLarge, PAGE_SIZE, maxDownloadBytes } from './client';
import type { DeltaItem, DeltaPage, GraphToken, MicrosoftGraphApi, Team, TeamDrive } from './client';

/**
 * A Microsoft Teams workspace that lives in memory.
 *
 * Tests drive the sync through this: files can be added, edited, renamed and
 * deleted, and the sync must notice each and treat them differently — an edit
 * is a refetch, a rename is not.
 *
 * It keeps a real change log and answers delta from it, rather than returning
 * everything every time. That matters because the entire claim of this
 * integration is "we are told only what changed", and a fake that always
 * returns everything would let a sync that ignores the delta link pass.
 *
 * No network, no tenant, no client secret. Nothing here pretends a real
 * connection succeeded — the real client refuses when it has no credentials.
 */

type Item = {
  id: string;
  name: string;
  mimeType: string;
  isFolder: boolean;
  eTag: string;
  cTag: string;
  lastModified: string;
  size: number;
  path: string | null;
  deleted: boolean;
};

export class FakeMicrosoftGraph implements MicrosoftGraphApi {
  readonly configured = true;
  tenantId: string | null = 'fake-tenant';

  /** Teams a chooser can see. */
  teams: Team[] = [{ id: 'team-1', name: 'Brand Team', description: null }];
  /** Drive id per team. */
  private drives: Map<string, TeamDrive> = new Map([
    ['team-1', { id: 'drive-1', name: 'Documents' }],
    ['team-2', { id: 'drive-2', name: 'Documents' }],
  ]);

  /** Current state of every item, by id. */
  private items = new Map<string, Item>();
  private contents = new Map<string, Buffer>();

  /**
   * The change log.
   *
   * Every mutation appends the item's id. A delta walk from a token replays
   * the log from that point, which is how Graph behaves and is what makes
   * "only what changed" testable.
   */
  private log: string[] = [];

  /** Set by tests to make the next call fail in a particular way. */
  failNext: MicrosoftGraphError | null = null;
  /**
   * Fails the next delta call only.
   *
   * Separate from failNext because a sync asks for a token before it asks for
   * a delta, so failNext is spent on the token and never reaches the call a
   * test meant to break. The Google fake splits these for the same reason: a
   * listing failing and one file failing are different situations.
   */
  failDeltaNext: MicrosoftGraphError | null = null;
  /** Item ids whose download fails, without failing the whole sync. */
  failDownloadFor = new Set<string>();
  /** Counts calls, so a test can prove how much work a sync actually did. */
  calls = { token: 0, listTeams: 0, getTeamDrive: 0, delta: 0, download: 0 };

  /** Back to an empty workspace, for a test that must start from nothing. */
  reset(): void {
    this.items.clear();
    this.contents.clear();
    this.log = [];
    this.failNext = null;
    this.failDeltaNext = null;
    this.failDownloadFor.clear();
    this.calls = { token: 0, listTeams: 0, getTeamDrive: 0, delta: 0, download: 0 };
    this.teams = [{ id: 'team-1', name: 'Brand Team', description: null }];
    this.drives = new Map([
      ['team-1', { id: 'drive-1', name: 'Documents' }],
      ['team-2', { id: 'drive-2', name: 'Documents' }],
    ]);
  }

  private take(): void {
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = null;
      throw error;
    }
  }

  async token(): Promise<GraphToken> {
    this.calls.token += 1;
    this.take();
    return { accessToken: 'fake-graph-token', expiresAt: new Date(Date.now() + 3600_000) };
  }

  async listTeams(): Promise<Team[]> {
    this.calls.listTeams += 1;
    this.take();
    return [...this.teams];
  }

  async getTeamDrive(_accessToken: string, teamId: string): Promise<TeamDrive> {
    this.calls.getTeamDrive += 1;
    this.take();
    const drive = this.drives.get(teamId);
    if (!drive) throw new MicrosoftGraphError('permanent', 'That team has no files library CIP can read.');
    return drive;
  }

  async delta(_accessToken: string, _driveId: string, link: string | null): Promise<DeltaPage> {
    this.calls.delta += 1;
    this.take();
    if (this.failDeltaNext) {
      const error = this.failDeltaNext;
      this.failDeltaNext = null;
      throw error;
    }

    // A link is "delta:<position>" or "next:<position>". Null starts a fresh
    // walk, which replays the whole log from the beginning — exactly what
    // Graph does, and what makes a first sync see everything.
    const from = link === null ? 0 : Number(link.split(':')[1] ?? 0);

    // One entry per item, latest state, in the order they last changed. Graph
    // collapses repeated changes to one item the same way.
    const seen = new Set<string>();
    const changed: string[] = [];
    for (let i = this.log.length - 1; i >= from; i -= 1) {
      const id = this.log[i]!;
      if (seen.has(id)) continue;
      seen.add(id);
      changed.unshift(id);
    }

    const page = changed.slice(0, PAGE_SIZE);
    const consumed = from + (changed.length > PAGE_SIZE ? PAGE_SIZE : changed.length);

    const items: DeltaItem[] = page.map((id) => {
      const item = this.items.get(id)!;
      return {
        id: item.id,
        name: item.name,
        mimeType: item.deleted ? null : item.mimeType,
        isFolder: item.isFolder,
        deleted: item.deleted,
        eTag: item.eTag,
        cTag: item.cTag,
        lastModified: item.lastModified,
        size: item.size,
        path: item.path,
      };
    });

    const more = changed.length > PAGE_SIZE;
    return {
      items,
      nextLink: more ? `next:${consumed}` : null,
      deltaLink: more ? null : `delta:${this.log.length}`,
    };
  }

  async download(_accessToken: string, _driveId: string, itemId: string): Promise<Buffer> {
    this.calls.download += 1;
    this.take();
    if (this.failDownloadFor.has(itemId)) {
      throw new MicrosoftGraphError('transient', 'That item could not be downloaded.');
    }
    const bytes = this.contents.get(itemId);
    if (!bytes) throw new MicrosoftGraphError('permanent', 'That item is not in the drive.');
    const limit = maxDownloadBytes();
    if (bytes.byteLength > limit) throw new MicrosoftGraphTooLarge(bytes.byteLength, limit);
    return bytes;
  }

  // ---- test helpers -------------------------------------------------------

  /** Adds a file, or replaces one of the same id. */
  addFile(input: {
    id: string;
    name: string;
    mimeType: string;
    content: Buffer | string;
    path?: string | null;
  }): void {
    const bytes = Buffer.isBuffer(input.content) ? input.content : Buffer.from(input.content);
    this.items.set(input.id, {
      id: input.id,
      name: input.name,
      mimeType: input.mimeType,
      isFolder: false,
      eTag: `etag-${input.id}-1`,
      cTag: `ctag-${input.id}-1`,
      lastModified: new Date().toISOString(),
      size: bytes.byteLength,
      path: input.path ?? '/drive/root:',
      deleted: false,
    });
    this.contents.set(input.id, bytes);
    this.log.push(input.id);
  }

  addFolder(id: string, name: string): void {
    this.items.set(id, {
      id, name, mimeType: 'application/octet-stream', isFolder: true,
      eTag: `etag-${id}-1`, cTag: `ctag-${id}-1`,
      lastModified: new Date().toISOString(), size: 0, path: '/drive/root:', deleted: false,
    });
    this.log.push(id);
  }

  /** Changes the bytes: both tags move, and the sync should refetch. */
  editFile(id: string, content: Buffer | string): void {
    const item = this.items.get(id);
    if (!item) throw new Error(`no such item ${id}`);
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const next = Number(item.cTag.split('-').pop()) + 1;
    item.cTag = `ctag-${id}-${next}`;
    item.eTag = `etag-${id}-${next}`;
    item.size = bytes.byteLength;
    item.lastModified = new Date().toISOString();
    this.contents.set(id, bytes);
    this.log.push(id);
  }

  /**
   * Renames without touching the bytes: eTag moves, cTag does not.
   *
   * The case that separates this integration from the Google one. Graph
   * reports it as a change and CIP must record the new name without
   * downloading the file again or sending it back through the pipeline.
   */
  renameFile(id: string, name: string): void {
    const item = this.items.get(id);
    if (!item) throw new Error(`no such item ${id}`);
    const next = Number(item.eTag.split('-').pop()) + 1;
    item.eTag = `etag-${id}-${next}`;
    item.name = name;
    item.lastModified = new Date().toISOString();
    this.log.push(id);
  }

  deleteFile(id: string): void {
    const item = this.items.get(id);
    if (!item) throw new Error(`no such item ${id}`);
    item.deleted = true;
    this.log.push(id);
  }
}
