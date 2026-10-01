import 'server-only';

/**
 * Microsoft Graph, behind an interface.
 *
 * The interface exists for the same reason the Google Drive one does: so the
 * sync logic can be tested without a network, a secret or a Microsoft tenant,
 * and so nothing above this directory talks HTTP to Microsoft. The real client
 * and the fake are interchangeable.
 *
 * PRIVACY: this sends Microsoft their own identifiers — a team id, a drive id,
 * an item id — and nothing of ours. No company id, no CIP file id, no storage
 * path. The access token travels in an Authorization header and is never
 * logged, never placed in a URL, and never returned to a caller.
 */

/**
 * The application permissions CIP asks an administrator for.
 *
 * Two, not one, and the pair is not obvious:
 *
 * - Sites.Read.All reads the document library behind a team's Files tab. Graph
 *   has no "one team's files" permission, so this is the floor for reading a
 *   team at all. Files.Read.All would also work and is wider.
 * - Group.Read.All finds the teams in the first place. A team is a Microsoft
 *   365 group, and listing groups is a directory read, which Sites.Read.All
 *   does not cover. Granting only Sites.Read.All leaves CIP able to read a
 *   team's files and unable to discover that the team exists — the list comes
 *   back 403 Authorization_RequestDenied, with a token that plainly carries
 *   Sites.Read.All, which reads as "the consent did not work" and is not that.
 *
 * Directory.Read.All also covers the second and is wider; Group.Read.All is
 * the smaller of the two.
 */
export const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';
export const REQUIRED_PERMISSIONS = ['Sites.Read.All', 'Group.Read.All'] as const;

export type Team = {
  id: string;
  name: string;
  description: string | null;
};

export type TeamDrive = {
  id: string;
  name: string;
};

/**
 * One item from a delta page.
 *
 * `deleted` is how Graph reports a removal: the item comes back with almost
 * nothing on it except its id and a deleted facet, which is why every other
 * field here is nullable. A delta page is not a listing of what exists, it is
 * a list of what changed, and a removal is a change.
 */
export type DeltaItem = {
  id: string;
  name: string;
  /** Null for a folder, and for a deleted item. */
  mimeType: string | null;
  /** True when this item is a folder rather than a file. */
  isFolder: boolean;
  deleted: boolean;
  eTag: string | null;
  /** Moves only when the content changes; eTag moves on a rename too. */
  cTag: string | null;
  lastModified: string | null;
  size: number | null;
  /** The folder path inside the drive, as Graph reports it, or null. */
  path: string | null;
};

/**
 * One page of a delta walk.
 *
 * Exactly one of nextLink and deltaLink is set. nextLink means there are more
 * pages of this walk; deltaLink means the walk is finished and this is the
 * token to present next time to be told only what has changed since.
 */
export type DeltaPage = {
  items: DeltaItem[];
  nextLink: string | null;
  deltaLink: string | null;
};

export type GraphToken = {
  accessToken: string;
  expiresAt: Date;
};

/** Why a Graph call failed, and what the caller should do about it. */
export type GraphFailureKind = 'needs_admin_consent' | 'rate_limited' | 'transient' | 'permanent';

export class MicrosoftGraphError extends Error {
  readonly kind: GraphFailureKind;
  readonly retryAfterSeconds: number | null;

  constructor(kind: GraphFailureKind, message: string, retryAfterSeconds: number | null = null) {
    super(message);
    this.name = 'MicrosoftGraphError';
    this.kind = kind;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * A file larger than CIP will fetch.
 *
 * Separate from a failure: the item is fine and Microsoft is fine, CIP simply
 * will not pull a two-gigabyte video through a worker. Reported as its own
 * state so a person sees "too large" rather than "sync failed".
 */
export class MicrosoftGraphTooLarge extends Error {
  readonly bytes: number;
  readonly limit: number;

  constructor(bytes: number, limit: number) {
    super(`That file is ${Math.round(bytes / 1024 / 1024)} MB; CIP reads up to ${Math.round(limit / 1024 / 1024)} MB.`);
    this.name = 'MicrosoftGraphTooLarge';
    this.bytes = bytes;
    this.limit = limit;
  }
}

export function maxDownloadBytes(): number {
  const configured = Number(process.env.CIP_MS_MAX_DOWNLOAD_BYTES);
  return Number.isFinite(configured) && configured > 0 ? configured : 200 * 1024 * 1024;
}

export interface MicrosoftGraphApi {
  readonly configured: boolean;
  /** The tenant this deployment is configured against, for display. */
  readonly tenantId: string | null;
  /** An app-only access token. Cached by the implementation until it expires. */
  token(): Promise<GraphToken>;
  /** The teams CIP can see, so somebody can choose one. */
  listTeams(accessToken: string): Promise<Team[]>;
  /** The document library behind a team's Files tab. */
  getTeamDrive(accessToken: string, teamId: string): Promise<TeamDrive>;
  /**
   * One page of a delta walk.
   *
   * `link` is null to start a fresh walk of everything, or a nextLink or
   * deltaLink handed back by a previous call. The caller never builds these.
   */
  delta(accessToken: string, driveId: string, link: string | null): Promise<DeltaPage>;
  /** Downloads one item's bytes. */
  download(accessToken: string, driveId: string, itemId: string): Promise<Buffer>;
}

const GRAPH = 'https://graph.microsoft.com/v1.0';
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_ATTEMPTS = 4;
/** Graph's cap for a delta page; asking for more is ignored. */
export const PAGE_SIZE = 200;

function envTenant(): string | null {
  return process.env.MS_TENANT_ID?.trim() || null;
}

/**
 * Turns a Graph response into a failure a caller can act on.
 *
 * The distinction that matters is 403 from everything else. A 403 here is
 * almost never transient — it means the Entra application was never granted
 * what it needs, or the grant was withdrawn — and retrying four times with
 * backoff only delays telling somebody that an administrator has to act.
 */
async function classify(response: Response): Promise<MicrosoftGraphError> {
  const retryAfter = Number(response.headers.get('retry-after'));
  const retryAfterSeconds = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null;

  // The body is read for its code, never for its message: Graph error text can
  // quote a file name or a site path, which belongs to the company and not in
  // a CIP log line or an API response.
  let code = '';
  try {
    const body = (await response.json()) as { error?: { code?: unknown } };
    if (typeof body?.error?.code === 'string') code = body.error.code;
  } catch {
    /* not JSON, or empty; the status alone decides */
  }

  if (response.status === 401 || response.status === 403) {
    return new MicrosoftGraphError(
      'needs_admin_consent',
      'CIP is not allowed to read this Microsoft 365 tenant. An administrator must grant it access.',
    );
  }
  if (response.status === 429) {
    return new MicrosoftGraphError('rate_limited', 'Microsoft is rate limiting CIP.', retryAfterSeconds);
  }
  if (response.status >= 500) {
    return new MicrosoftGraphError('transient', 'Microsoft Graph is unavailable.', retryAfterSeconds);
  }
  if (code === 'resyncRequired') {
    // Graph expires a delta link eventually, and says so with this code. Not a
    // failure: the walk simply starts again from nothing.
    return new MicrosoftGraphError('permanent', 'resyncRequired');
  }
  return new MicrosoftGraphError('permanent', `Microsoft Graph refused the request (${response.status}).`);
}

async function backoff(attempt: number, retryAfterSeconds: number | null): Promise<void> {
  const seconds = retryAfterSeconds ?? Math.min(2 ** attempt, 30);
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

export class MicrosoftGraphClient implements MicrosoftGraphApi {
  readonly configured: boolean;
  readonly tenantId: string | null;

  private readonly clientId: string;
  private readonly clientSecret: string;
  private cached: GraphToken | null = null;

  constructor(tenantId: string | null, clientId: string, clientSecret: string) {
    this.tenantId = tenantId;
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.configured = Boolean(tenantId && clientId && clientSecret);
  }

  private requireConfigured(): void {
    if (!this.configured) {
      throw new MicrosoftGraphError(
        'permanent',
        'Microsoft Teams is not configured for this deployment.',
      );
    }
  }

  async token(): Promise<GraphToken> {
    this.requireConfigured();

    // Reused until it is nearly spent. Graph tokens last an hour and a sync
    // asks for one per claimed connection; minting a fresh one per call would
    // be a token request per file.
    if (this.cached && this.cached.expiresAt.getTime() - Date.now() > 60_000) return this.cached;

    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      scope: GRAPH_SCOPE,
      grant_type: 'client_credentials',
    });

    const response = await fetch(
      `https://login.microsoftonline.com/${encodeURIComponent(this.tenantId!)}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );

    if (!response.ok) {
      // A token endpoint refusing client credentials means the application
      // registration is wrong — wrong secret, wrong tenant, secret expired.
      // None of that is retryable and all of it needs an administrator.
      throw new MicrosoftGraphError(
        'needs_admin_consent',
        'CIP could not sign in to Microsoft. Check the application registration.',
      );
    }

    const json = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) {
      throw new MicrosoftGraphError('transient', 'Microsoft returned no access token.');
    }

    this.cached = {
      accessToken: json.access_token,
      expiresAt: new Date(Date.now() + (json.expires_in ?? 3600) * 1000),
    };
    return this.cached;
  }

  /** One Graph call, retried on the failures that are worth retrying. */
  private async call(accessToken: string, url: string): Promise<Response> {
    let lastError: MicrosoftGraphError | null = null;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      let response: Response;
      try {
        response = await fetch(url, {
          headers: { authorization: `Bearer ${accessToken}` },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch {
        // The class name only, never the message: a fetch error can carry the
        // URL, which names somebody's site.
        lastError = new MicrosoftGraphError('transient', 'Microsoft Graph could not be reached.');
        await backoff(attempt, null);
        continue;
      }

      if (response.ok) return response;

      const failure = await classify(response);
      if (failure.kind === 'permanent' || failure.kind === 'needs_admin_consent') throw failure;
      lastError = failure;
      await backoff(attempt, failure.retryAfterSeconds);
    }

    throw lastError ?? new MicrosoftGraphError('transient', 'Microsoft Graph could not be reached.');
  }

  async listTeams(accessToken: string): Promise<Team[]> {
    this.requireConfigured();

    // Groups with the Team resource provisioned. Asking /teams app-only
    // returns every team in the tenant only with extra permission; filtering
    // groups by resourceProvisioningOptions is the documented way to get the
    // same list with what CIP already has.
    const url =
      `${GRAPH}/groups?$filter=${encodeURIComponent("resourceProvisioningOptions/Any(x:x eq 'Team')")}` +
      `&$select=id,displayName,description&$top=999`;

    const response = await this.call(accessToken, url);
    const json = (await response.json()) as {
      value?: { id?: string; displayName?: string; description?: string | null }[];
    };

    return (json.value ?? [])
      .filter((group): group is { id: string; displayName: string; description: string | null } =>
        typeof group.id === 'string' && typeof group.displayName === 'string')
      .map((group) => ({ id: group.id, name: group.displayName, description: group.description ?? null }));
  }

  async getTeamDrive(accessToken: string, teamId: string): Promise<TeamDrive> {
    this.requireConfigured();

    const response = await this.call(accessToken, `${GRAPH}/groups/${encodeURIComponent(teamId)}/drive?$select=id,name`);
    const json = (await response.json()) as { id?: string; name?: string };
    if (!json.id) {
      throw new MicrosoftGraphError('permanent', 'That team has no files library CIP can read.');
    }
    return { id: json.id, name: json.name ?? 'Documents' };
  }

  async delta(accessToken: string, driveId: string, link: string | null): Promise<DeltaPage> {
    this.requireConfigured();

    // A link handed back by Graph is used verbatim. Rebuilding one from its
    // parts is how a delta walk silently starts over: the token is opaque and
    // carries state CIP has no business parsing.
    const url = link ?? `${GRAPH}/drives/${encodeURIComponent(driveId)}/root/delta?$top=${PAGE_SIZE}`;

    const response = await this.call(accessToken, url);
    const json = (await response.json()) as {
      value?: unknown[];
      '@odata.nextLink'?: string;
      '@odata.deltaLink'?: string;
    };

    const items: DeltaItem[] = [];
    for (const raw of json.value ?? []) {
      const item = raw as {
        id?: string;
        name?: string;
        eTag?: string;
        cTag?: string;
        size?: number;
        lastModifiedDateTime?: string;
        file?: { mimeType?: string };
        folder?: unknown;
        deleted?: unknown;
        parentReference?: { path?: string };
      };
      if (typeof item.id !== 'string') continue;

      items.push({
        id: item.id,
        name: typeof item.name === 'string' ? item.name : 'Untitled',
        mimeType: item.file?.mimeType ?? null,
        isFolder: item.folder !== undefined,
        deleted: item.deleted !== undefined,
        eTag: item.eTag ?? null,
        cTag: item.cTag ?? null,
        lastModified: item.lastModifiedDateTime ?? null,
        size: typeof item.size === 'number' ? item.size : null,
        path: item.parentReference?.path ?? null,
      });
    }

    return {
      items,
      nextLink: json['@odata.nextLink'] ?? null,
      deltaLink: json['@odata.deltaLink'] ?? null,
    };
  }

  async download(accessToken: string, driveId: string, itemId: string): Promise<Buffer> {
    this.requireConfigured();

    const url = `${GRAPH}/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}/content`;
    const response = await this.call(accessToken, url);

    // Checked before the body is read, so an enormous file is refused rather
    // than pulled into memory and then refused.
    const limit = maxDownloadBytes();
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > limit) {
      throw new MicrosoftGraphTooLarge(declared, limit);
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    // And again afterwards: a chunked response declares no length, so the
    // header check above passes for a file of any size at all.
    if (bytes.byteLength > limit) throw new MicrosoftGraphTooLarge(bytes.byteLength, limit);

    return bytes;
  }
}

export function microsoftGraphFromEnv(): MicrosoftGraphApi {
  return new MicrosoftGraphClient(
    envTenant(),
    process.env.MS_CLIENT_ID?.trim() ?? '',
    process.env.MS_CLIENT_SECRET?.trim() ?? '',
  );
}
