import 'server-only';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { withCompanyScope } from '../../db';
import type { CompanyScope } from '../../db';
import { decryptSecret, encryptSecret } from '../crypto';
import { DRIVE_SCOPE, GoogleDriveError } from './client';
import type { GoogleDriveApi, TokenSet } from './client';
import { googleDrive } from './index';
import { GoogleDriveNeedsReauth, GoogleDriveNotConnected } from './types';

/**
 * The connection between a company and a Google Drive folder.
 *
 * Every function takes a CompanyScope and no company parameter, so there is no
 * argument a request could fill in to reach another company's connection.
 * Tokens are encrypted before they are written and decrypted only in the
 * moment they are used; they are absent from the DTO by construction rather
 * than stripped from it.
 */

export type ConnectionStatus = 'connected' | 'needs_reauth' | 'disconnected';

/**
 * What a caller may see.
 *
 * No tokens, no company id, no folder path — the folder id is included because
 * it is Google's own identifier for something the company chose, and the UI
 * needs it to show what is connected. It grants nothing without a token.
 */
export type GoogleDriveConnectionDTO = {
  status: ConnectionStatus;
  accountEmail: string | null;
  folderId: string | null;
  folderName: string | null;
  connectedAt: string | null;
  lastSyncAt: string | null;
  lastSyncError: string | null;
  syncing: boolean;
  /** Counts by state, so the UI can say what happened without a second call. */
  files: { synced: number; pending: number; unsupported: number; trashed: number; failed: number };
  /** False when the server has no OAuth client configured at all. */
  providerConfigured: boolean;
};

type ConnectionRow = {
  id: string;
  google_account_email: string | null;
  folder_id: string | null;
  folder_name: string | null;
  access_token_encrypted: string | null;
  refresh_token_encrypted: string | null;
  token_expires_at: Date | null;
  granted_scope: string | null;
  status: ConnectionStatus;
  connected_at: Date | null;
  last_sync_at: Date | null;
  last_sync_error: string | null;
  sync_claimed_until: Date | null;
};

export class GoogleDriveRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoogleDriveRejected';
  }
}

// --- the OAuth state parameter ----------------------------------------------

/**
 * The state parameter, signed.
 *
 * It ties the callback to the session that started it. Without this, a link
 * could make somebody's browser complete an OAuth flow the attacker began,
 * attaching the attacker's Google Drive to the victim's company — which would
 * be a way to get CIP to ingest documents nobody at that company chose.
 *
 * It carries the company and user it was issued for, and the callback refuses
 * any state that does not match the session presenting it.
 */
export function issueOAuthState(scope: CompanyScope): string {
  const payload = JSON.stringify({
    c: scope.companyId,
    u: scope.userId,
    n: randomBytes(12).toString('base64url'),
    t: Date.now(),
  });
  const encoded = Buffer.from(payload, 'utf8').toString('base64url');
  return `${encoded}.${signState(encoded)}`;
}

export function verifyOAuthState(state: string, scope: CompanyScope): boolean {
  const [encoded, signature] = state.split('.');
  if (!encoded || !signature) return false;

  const expected = signState(encoded);
  const given = Buffer.from(signature, 'utf8');
  const want = Buffer.from(expected, 'utf8');
  if (given.length !== want.length || !timingSafeEqual(given, want)) return false;

  let parsed: { c?: unknown; u?: unknown; t?: unknown };
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as typeof parsed;
  } catch {
    return false;
  }

  // Ten minutes is long enough to click through a consent screen and short
  // enough that a state left in a browser history is useless.
  if (typeof parsed.t !== 'number' || Date.now() - parsed.t > 10 * 60 * 1000) return false;

  return parsed.c === scope.companyId && parsed.u === scope.userId;
}

function signState(encoded: string): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET is not set.');
  return createHmac('sha256', Buffer.from(secret, 'utf8')).update(encoded).digest('base64url');
}

// --- reading the connection -------------------------------------------------

async function row(scope: CompanyScope): Promise<ConnectionRow | null> {
  return withCompanyScope(scope, async (tx) => {
    const rows = await tx<ConnectionRow[]>`
      select id, google_account_email, folder_id, folder_name,
             access_token_encrypted, refresh_token_encrypted, token_expires_at,
             granted_scope, status, connected_at, last_sync_at, last_sync_error,
             sync_claimed_until
        from google_drive_connections
       limit 1
    `;
    return rows[0] ?? null;
  });
}

export async function getConnection(scope: CompanyScope): Promise<GoogleDriveConnectionDTO> {
  const connection = await row(scope);
  const providerConfigured = googleDrive().configured;

  const counts = await withCompanyScope(scope, async (tx) =>
    tx<{ state: string; n: number }[]>`
      select state, count(*)::int as n from google_drive_files group by state
    `,
  );

  const files = { synced: 0, pending: 0, unsupported: 0, trashed: 0, failed: 0 };
  for (const entry of counts) {
    if (entry.state in files) files[entry.state as keyof typeof files] = entry.n;
  }

  if (!connection) {
    return {
      status: 'disconnected',
      accountEmail: null,
      folderId: null,
      folderName: null,
      connectedAt: null,
      lastSyncAt: null,
      lastSyncError: null,
      syncing: false,
      files,
      providerConfigured,
    };
  }

  return {
    status: connection.status,
    accountEmail: connection.google_account_email,
    folderId: connection.folder_id,
    folderName: connection.folder_name,
    connectedAt: connection.connected_at?.toISOString() ?? null,
    lastSyncAt: connection.last_sync_at?.toISOString() ?? null,
    lastSyncError: connection.last_sync_error,
    syncing:
      connection.sync_claimed_until !== null && connection.sync_claimed_until.getTime() > Date.now(),
    files,
    providerConfigured,
  };
}

// --- connecting and disconnecting -------------------------------------------

/**
 * Stores the tokens from a completed OAuth exchange.
 *
 * Replaces whatever was there: reconnecting is how somebody fixes a revoked
 * grant, and a second row would leave the old tokens lying around.
 */
export async function saveTokens(scope: CompanyScope, tokens: TokenSet): Promise<void> {
  if (tokens.scope && !tokens.scope.includes(DRIVE_SCOPE)) {
    throw new GoogleDriveRejected(
      'CIP needs read-only access to your Drive. Approve that permission and try again.',
    );
  }

  await withCompanyScope(scope, async (tx) => {
    await tx`
      insert into google_drive_connections
        (company_id, google_account_email, access_token_encrypted, refresh_token_encrypted,
         token_expires_at, granted_scope, status, connected_by, connected_at, updated_at)
      values
        (${scope.companyId}, ${tokens.accountEmail},
         ${encryptSecret(tokens.accessToken)},
         ${tokens.refreshToken ? encryptSecret(tokens.refreshToken) : null},
         ${tokens.expiresAt}, ${tokens.scope}, 'connected', ${scope.userId}, now(), now())
      on conflict (company_id) do update
         set google_account_email    = excluded.google_account_email,
             access_token_encrypted  = excluded.access_token_encrypted,
             -- Google only reissues a refresh token on first consent, so keep
             -- the stored one when this exchange did not bring a new one.
             refresh_token_encrypted = coalesce(excluded.refresh_token_encrypted,
                                                google_drive_connections.refresh_token_encrypted),
             token_expires_at        = excluded.token_expires_at,
             granted_scope           = excluded.granted_scope,
             status                  = 'connected',
             connected_by            = excluded.connected_by,
             connected_at            = now(),
             last_sync_error         = null,
             updated_at              = now()
    `;
  });
}

/** Chooses which folder to read. Confirms it exists and is readable first. */
export async function setFolder(scope: CompanyScope, folderId: string): Promise<GoogleDriveConnectionDTO> {
  const trimmed = folderId.trim();
  if (!/^[A-Za-z0-9_-]{10,200}$/.test(trimmed)) {
    throw new GoogleDriveRejected(
      'That does not look like a folder id. Open the folder in Google Drive and copy the id from the address bar.',
    );
  }

  const connection = await requireConnected(scope);
  const api = googleDrive();

  // Proves the connected account can actually read it, so a typo is caught now
  // rather than becoming a sync that finds nothing and cannot say why.
  let name: string;
  try {
    const folder = await api.getFile(connection.accessToken, trimmed);
    if (folder.mimeType !== 'application/vnd.google-apps.folder') {
      throw new GoogleDriveRejected('That id is a file, not a folder.');
    }
    name = folder.name;
  } catch (error) {
    if (error instanceof GoogleDriveRejected) throw error;
    if (error instanceof GoogleDriveError && error.kind === 'needs_reauth') {
      await markNeedsReauth(scope);
      throw new GoogleDriveNeedsReauth();
    }
    throw new GoogleDriveRejected('That folder could not be opened with the connected account.');
  }

  await withCompanyScope(scope, async (tx) => {
    await tx`
      update google_drive_connections
         set folder_id = ${trimmed}, folder_name = ${name},
             last_sync_error = null, updated_at = now()
    `;
  });

  return getConnection(scope);
}

/**
 * Forgets the tokens.
 *
 * The synced knowledge is left alone: documents already extracted are the
 * company's, and disconnecting an integration is not a request to destroy
 * them. The bookkeeping rows stay too, so the audit trail survives.
 */
export async function disconnect(scope: CompanyScope): Promise<GoogleDriveConnectionDTO> {
  await withCompanyScope(scope, async (tx) => {
    await tx`
      update google_drive_connections
         set status = 'disconnected',
             access_token_encrypted = null,
             refresh_token_encrypted = null,
             token_expires_at = null,
             granted_scope = null,
             sync_claimed_until = null,
             updated_at = now()
    `;
  });
  return getConnection(scope);
}

export async function markNeedsReauth(scope: CompanyScope, reason?: string): Promise<void> {
  await withCompanyScope(scope, async (tx) => {
    await tx`
      update google_drive_connections
         set status = 'needs_reauth',
             access_token_encrypted = null,
             token_expires_at = null,
             last_sync_error = ${reason ?? 'Google Drive access expired. Reconnect to continue.'},
             sync_claimed_until = null,
             updated_at = now()
    `;
  });
}

// --- tokens -----------------------------------------------------------------

export type ActiveConnection = {
  id: string;
  accessToken: string;
  folderId: string | null;
};

/**
 * A usable access token, refreshing it if it is about to expire.
 *
 * The refresh happens here rather than at the call site so every caller gets
 * the same behaviour, and so a revoked grant turns into needs_reauth in one
 * place instead of being handled three different ways.
 */
export async function requireConnected(scope: CompanyScope): Promise<ActiveConnection> {
  const connection = await row(scope);
  if (!connection || connection.status === 'disconnected') throw new GoogleDriveNotConnected();
  if (connection.status === 'needs_reauth') throw new GoogleDriveNeedsReauth();

  const expiresSoon =
    connection.token_expires_at === null ||
    connection.token_expires_at.getTime() - Date.now() < 60_000;

  if (!expiresSoon && connection.access_token_encrypted) {
    return {
      id: connection.id,
      accessToken: decryptSecret(connection.access_token_encrypted),
      folderId: connection.folder_id,
    };
  }

  if (!connection.refresh_token_encrypted) {
    await markNeedsReauth(scope);
    throw new GoogleDriveNeedsReauth();
  }

  const api: GoogleDriveApi = googleDrive();
  let refreshed: TokenSet;
  try {
    refreshed = await api.refresh(decryptSecret(connection.refresh_token_encrypted));
  } catch (error) {
    if (error instanceof GoogleDriveError && error.kind === 'needs_reauth') {
      await markNeedsReauth(scope);
      throw new GoogleDriveNeedsReauth();
    }
    throw error;
  }

  await withCompanyScope(scope, async (tx) => {
    await tx`
      update google_drive_connections
         set access_token_encrypted = ${encryptSecret(refreshed.accessToken)},
             refresh_token_encrypted = coalesce(
               ${refreshed.refreshToken ? encryptSecret(refreshed.refreshToken) : null},
               refresh_token_encrypted),
             token_expires_at = ${refreshed.expiresAt},
             status = 'connected',
             updated_at = now()
    `;
  });

  return { id: connection.id, accessToken: refreshed.accessToken, folderId: connection.folder_id };
}

/** One synced file as the UI sees it. No storage path, no company id. */
export type SyncedFileDTO = {
  id: string;
  name: string;
  state: string;
  reason: string | null;
  /** The CIP file it became, so the UI can link to it. Null if not ingested. */
  fileId: string | null;
  externalMime: string;
  syncedAt: string | null;
  lastSeenAt: string | null;
};

/**
 * What the last sync found, newest first.
 *
 * Includes the files that were skipped and why. A file that could not be read
 * is shown as unsupported rather than left out, so nobody is left believing a
 * document was ingested when it was not.
 *
 * The external Google id is deliberately absent: it is not needed to render
 * anything, and it is the one field that would let somebody compare notes
 * across companies about which documents exist.
 */
export async function listSyncedFiles(
  scope: CompanyScope,
  options: { limit?: number } = {},
): Promise<SyncedFileDTO[]> {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);

  const rows = await withCompanyScope(scope, async (tx) =>
    tx<
      {
        id: string;
        name: string;
        state: string;
        reason: string | null;
        file_id: string | null;
        external_mime: string;
        synced_at: Date | null;
        last_seen_at: Date | null;
      }[]
    >`
      select id, name, state, reason, file_id, external_mime, synced_at, last_seen_at
        from google_drive_files
       order by updated_at desc
       limit ${limit}
    `,
  );

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    state: row.state,
    reason: row.reason,
    fileId: row.file_id,
    externalMime: row.external_mime,
    syncedAt: row.synced_at?.toISOString() ?? null,
    lastSeenAt: row.last_seen_at?.toISOString() ?? null,
  }));
}
