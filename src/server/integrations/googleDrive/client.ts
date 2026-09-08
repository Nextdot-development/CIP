import 'server-only';

/**
 * The Google Drive API, behind an interface.
 *
 * The interface exists for the same reason the Embedder and the media
 * providers have one: so the sync logic can be tested without a network, a key
 * or a Google account, and so nothing above this directory talks HTTP to
 * Google. The real client and the fake are interchangeable.
 *
 * PRIVACY: this sends a folder id and file ids to Google — their own
 * identifiers, which they already have — and nothing of ours. No company id,
 * no CIP file id, no storage path. Tokens travel in an Authorization header
 * and are never logged, never placed in a URL, and never returned to a caller.
 */

/** Read-only. The least privilege that can list and download a folder. */
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';

export type GoogleFile = {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string | null;
  md5Checksum: string | null;
  size: number | null;
  trashed: boolean;
};

export type FilePage = {
  files: GoogleFile[];
  nextPageToken: string | null;
};

export type TokenSet = {
  accessToken: string;
  /** Absent when Google chooses not to reissue one; the stored one stands. */
  refreshToken: string | null;
  expiresAt: Date;
  scope: string | null;
  accountEmail: string | null;
};

/** Why a Google call failed, and what the caller should do about it. */
export type GoogleFailureKind = 'needs_reauth' | 'rate_limited' | 'transient' | 'permanent';

export class GoogleDriveError extends Error {
  readonly kind: GoogleFailureKind;
  readonly retryAfterSeconds: number | null;

  constructor(kind: GoogleFailureKind, message: string, retryAfterSeconds: number | null = null) {
    super(message);
    this.name = 'GoogleDriveError';
    this.kind = kind;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface GoogleDriveApi {
  readonly configured: boolean;
  /** Exchanges an authorization code for tokens. */
  exchangeCode(code: string, redirectUri: string): Promise<TokenSet>;
  /** Trades a refresh token for a fresh access token. */
  refresh(refreshToken: string): Promise<TokenSet>;
  /** One page of the folder's contents. */
  listFolder(accessToken: string, folderId: string, pageToken: string | null): Promise<FilePage>;
  /** Metadata for one file, used to confirm a folder exists and is readable. */
  getFile(accessToken: string, fileId: string): Promise<GoogleFile>;
  /** Downloads a binary file as-is. */
  download(accessToken: string, fileId: string): Promise<Buffer>;
  /** Exports a Google-native document to a format the extractor understands. */
  exportFile(accessToken: string, fileId: string, mimeType: string): Promise<Buffer>;
}

const API = 'https://www.googleapis.com/drive/v3';
const OAUTH_TOKEN = 'https://oauth2.googleapis.com/token';
const REQUEST_TIMEOUT_MS = 60_000;
/** Google's own cap; asking for more is silently reduced. */
export const PAGE_SIZE = 100;
const MAX_ATTEMPTS = 4;
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;

export class GoogleDriveClient implements GoogleDriveApi {
  readonly configured: boolean;
  private readonly clientId: string | undefined;
  private readonly clientSecret: string | undefined;

  constructor(clientId: string | undefined, clientSecret: string | undefined) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.configured = Boolean(clientId && clientSecret);
  }

  async exchangeCode(code: string, redirectUri: string): Promise<TokenSet> {
    return this.token({
      code,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    });
  }

  async refresh(refreshToken: string): Promise<TokenSet> {
    return this.token({ refresh_token: refreshToken, grant_type: 'refresh_token' });
  }

  private async token(fields: Record<string, string>): Promise<TokenSet> {
    if (!this.configured) {
      throw new GoogleDriveError('permanent', 'Google Drive is not configured.');
    }

    const body = new URLSearchParams({
      ...fields,
      client_id: this.clientId!,
      client_secret: this.clientSecret!,
    });

    const response = await this.fetchWithRetry(OAUTH_TOKEN, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });

    const payload = (await response.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
      id_token?: string;
    };

    if (!payload.access_token) {
      throw new GoogleDriveError('needs_reauth', 'Google did not return an access token.');
    }

    return {
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token ?? null,
      expiresAt: new Date(Date.now() + (payload.expires_in ?? 3600) * 1000),
      scope: payload.scope ?? null,
      accountEmail: emailFromIdToken(payload.id_token),
    };
  }

  async listFolder(accessToken: string, folderId: string, pageToken: string | null): Promise<FilePage> {
    // Trashed files are asked for deliberately: a file moved to the bin is a
    // change we need to notice, not one to hide.
    const params = new URLSearchParams({
      q: `'${escapeForQuery(folderId)}' in parents`,
      fields: 'nextPageToken, files(id, name, mimeType, modifiedTime, md5Checksum, size, trashed)',
      pageSize: String(PAGE_SIZE),
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    });
    if (pageToken) params.set('pageToken', pageToken);

    const response = await this.fetchWithRetry(`${API}/files?${params}`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });

    const payload = (await response.json()) as {
      nextPageToken?: string;
      files?: Record<string, unknown>[];
    };

    return {
      files: (payload.files ?? []).map(toGoogleFile),
      nextPageToken: payload.nextPageToken ?? null,
    };
  }

  async getFile(accessToken: string, fileId: string): Promise<GoogleFile> {
    const params = new URLSearchParams({
      fields: 'id, name, mimeType, modifiedTime, md5Checksum, size, trashed',
      supportsAllDrives: 'true',
    });

    const response = await this.fetchWithRetry(
      `${API}/files/${encodeURIComponent(fileId)}?${params}`,
      { headers: { authorization: `Bearer ${accessToken}` } },
    );

    return toGoogleFile((await response.json()) as Record<string, unknown>);
  }

  async download(accessToken: string, fileId: string): Promise<Buffer> {
    const response = await this.fetchWithRetry(
      `${API}/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`,
      { headers: { authorization: `Bearer ${accessToken}` } },
    );
    return this.readBody(response);
  }

  async exportFile(accessToken: string, fileId: string, mimeType: string): Promise<Buffer> {
    const params = new URLSearchParams({ mimeType });
    const response = await this.fetchWithRetry(
      `${API}/files/${encodeURIComponent(fileId)}/export?${params}`,
      { headers: { authorization: `Bearer ${accessToken}` } },
    );
    return this.readBody(response);
  }

  private async readBody(response: Response): Promise<Buffer> {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > MAX_DOWNLOAD_BYTES) {
      throw new GoogleDriveError('permanent', 'That file is too large to ingest.');
    }
    return bytes;
  }

  /**
   * One request, with backoff.
   *
   * Google rate limits per user and per project, and both are normal rather
   * than exceptional during a first sync of a large folder. 429 and 5xx are
   * retried with exponential backoff and jitter; 401 means the token is done
   * and no amount of retrying will help.
   */
  private async fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
    let lastError: GoogleDriveError | null = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      let response: Response;
      try {
        response = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      } catch (error) {
        const timedOut =
          error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
        lastError = new GoogleDriveError(
          'transient',
          timedOut ? 'Google Drive timed out.' : 'Google Drive could not be reached.',
        );
        await backoff(attempt, null);
        continue;
      }

      if (response.ok) return response;

      const failure = await classify(response);
      if (failure.kind === 'needs_reauth' || failure.kind === 'permanent') throw failure;

      lastError = failure;
      if (attempt === MAX_ATTEMPTS) break;
      await backoff(attempt, failure.retryAfterSeconds);
    }

    throw lastError ?? new GoogleDriveError('transient', 'Google Drive could not be reached.');
  }
}

/**
 * Turns a response into one of ours.
 *
 * The body is never read into the message: Google's errors quote file names,
 * and a file name is the customer's.
 */
async function classify(response: Response): Promise<GoogleDriveError> {
  if (response.status === 401) {
    return new GoogleDriveError('needs_reauth', 'Google Drive access has expired. Reconnect to continue.');
  }

  if (response.status === 403) {
    // 403 is overloaded: "the API is switched off", "you may not read that",
    // and "slow down" all arrive as one status. Treating them alike sent
    // somebody chasing a rate limit when the Drive API had simply never been
    // enabled, so the reason is read and each is reported for what it is.
    //
    // Only the short reason code is used. Google's human message quotes file
    // names, which are the customer's; a reason like `accessNotConfigured` is
    // operational metadata about our own project and carries none of theirs.
    const reason = await errorReason(response);

    if (reason === 'accessNotConfigured' || reason === 'SERVICE_DISABLED') {
      return new GoogleDriveError(
        'permanent',
        'The Google Drive API is not enabled for this project. Enable it in the Google Cloud console, wait a minute, and try again.',
      );
    }
    if (
      reason === 'insufficientFilePermissions' ||
      reason === 'insufficientPermissions' ||
      reason === 'forbidden'
    ) {
      return new GoogleDriveError(
        'permanent',
        'The connected Google account cannot read that folder.',
      );
    }
    if (reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded') {
      return new GoogleDriveError('rate_limited', 'Google Drive is rate limiting us.', 30);
    }

    // An unrecognised 403 is not retried. Retrying a refusal we cannot explain
    // just turns one clear failure into three slow ones.
    return new GoogleDriveError('permanent', 'Google Drive refused the request.');
  }

  if (response.status === 404) {
    return new GoogleDriveError('permanent', 'That file or folder is no longer available in Google Drive.');
  }
  if (response.status === 429) {
    const retryAfter = Number(response.headers.get('retry-after'));
    return new GoogleDriveError(
      'rate_limited',
      'Google Drive is rate limiting us.',
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
    );
  }
  if (response.status >= 500) {
    return new GoogleDriveError('transient', 'Google Drive is having trouble.');
  }
  return new GoogleDriveError('permanent', 'Google Drive refused the request.');
}

/**
 * The machine-readable reason from an error body, and nothing else.
 *
 * Google puts it in two places depending on the API surface, so both are
 * checked. The accompanying human message is deliberately not read: it can
 * quote a file name.
 */
async function errorReason(response: Response): Promise<string | null> {
  try {
    const body = (await response.clone().json()) as {
      error?: { status?: unknown; errors?: { reason?: unknown }[] };
    };
    const fromList = body.error?.errors?.[0]?.reason;
    if (typeof fromList === 'string') return fromList;
    const status = body.error?.status;
    return typeof status === 'string' ? status : null;
  } catch {
    return null;
  }
}

async function backoff(attempt: number, retryAfterSeconds: number | null): Promise<void> {
  const base = retryAfterSeconds !== null ? retryAfterSeconds * 1000 : 2 ** attempt * 250;
  // Jitter, so several files failing at once do not all come back together.
  const wait = Math.min(base + Math.random() * 250, 30_000);
  await new Promise((resolve) => setTimeout(resolve, wait));
}

function toGoogleFile(raw: Record<string, unknown>): GoogleFile {
  return {
    id: String(raw.id ?? ''),
    name: typeof raw.name === 'string' ? raw.name : 'Untitled',
    mimeType: typeof raw.mimeType === 'string' ? raw.mimeType : 'application/octet-stream',
    modifiedTime: typeof raw.modifiedTime === 'string' ? raw.modifiedTime : null,
    md5Checksum: typeof raw.md5Checksum === 'string' ? raw.md5Checksum : null,
    size: raw.size === undefined || raw.size === null ? null : Number(raw.size),
    trashed: raw.trashed === true,
  };
}

/**
 * A folder id goes into a query string, so a quote in it would change the
 * query's meaning. Google ids never contain one, which is exactly why an id
 * that does is worth refusing rather than escaping.
 */
function escapeForQuery(folderId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(folderId)) {
    throw new GoogleDriveError('permanent', 'That does not look like a Google Drive folder id.');
  }
  return folderId;
}

/**
 * The signed-in address, read from the id token without verifying it.
 *
 * Safe because it is used only as a label to show which account is connected —
 * it grants nothing. It came straight from Google's token endpoint over TLS
 * moments ago, and nothing is authorised on the strength of it.
 */
function emailFromIdToken(idToken: string | undefined): string | null {
  if (!idToken) return null;
  const payload = idToken.split('.')[1];
  if (!payload) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      email?: unknown;
    };
    return typeof decoded.email === 'string' ? decoded.email : null;
  } catch {
    return null;
  }
}

export function googleDriveClientFromEnv(): GoogleDriveClient {
  return new GoogleDriveClient(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
}
