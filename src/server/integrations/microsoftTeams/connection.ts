import 'server-only';
import { withCompanyScope } from '../../db';
import type { CompanyScope } from '../../db';
import { microsoftGraph } from './index';
import { MicrosoftGraphError } from './client';
import { MicrosoftNeedsAdminConsent, MicrosoftNotConnected } from './types';

/**
 * The connected Team, and what a person is allowed to know about it.
 *
 * Much smaller than the Google Drive equivalent, and the reason is the whole
 * point of choosing app-only: there is no per-company token to store, refresh,
 * encrypt or expire. CIP reads as itself, with a permission an administrator
 * granted once, so this module holds a choice of team and nothing secret.
 */

export type ConnectionStatus = 'connected' | 'needs_admin_consent' | 'disconnected';

/**
 * What the browser is allowed to see.
 *
 * No tenant secret, no token, no site URL. The team's name because a person
 * needs to recognise what is connected, and its id because the UI selects
 * against it.
 */
export type MicrosoftConnectionDTO = {
  status: ConnectionStatus;
  /** Whether this deployment has an Entra application at all. */
  configured: boolean;
  teamId: string | null;
  teamName: string | null;
  driveName: string | null;
  connectedAt: string | null;
  lastSyncAt: string | null;
  lastSyncError: string | null;
  /** Whether a sync has ever completed, so the UI can say "never synced". */
  everSynced: boolean;
};

type Row = {
  id: string;
  status: ConnectionStatus;
  team_id: string | null;
  team_name: string | null;
  drive_id: string | null;
  drive_name: string | null;
  delta_link: string | null;
  connected_at: Date | null;
  last_sync_at: Date | null;
  last_sync_error: string | null;
};

async function row(scope: CompanyScope): Promise<Row | null> {
  return withCompanyScope(scope, async (tx) => {
    const rows = await tx<Row[]>`
      select id, status, team_id, team_name, drive_id, drive_name, delta_link,
             connected_at, last_sync_at, last_sync_error
        from microsoft_connections
       where company_id = ${scope.companyId}
       limit 1
    `;
    return rows[0] ?? null;
  });
}

function toDTO(connection: Row | null): MicrosoftConnectionDTO {
  const api = microsoftGraph();
  if (!connection) {
    return {
      status: 'disconnected',
      configured: api.configured,
      teamId: null,
      teamName: null,
      driveName: null,
      connectedAt: null,
      lastSyncAt: null,
      lastSyncError: null,
      everSynced: false,
    };
  }

  return {
    status: connection.status,
    configured: api.configured,
    teamId: connection.team_id,
    teamName: connection.team_name,
    driveName: connection.drive_name,
    connectedAt: connection.connected_at?.toISOString() ?? null,
    lastSyncAt: connection.last_sync_at?.toISOString() ?? null,
    lastSyncError: connection.last_sync_error,
    everSynced: connection.last_sync_at !== null,
  };
}

export async function getConnection(scope: CompanyScope): Promise<MicrosoftConnectionDTO> {
  return toDTO(await row(scope));
}

/**
 * The teams this deployment can see, for somebody to choose from.
 *
 * Reached through the connection module rather than the client directly so
 * that a tenant CIP has not been granted access to reports the same
 * needs-admin-consent failure here as it would during a sync, instead of an
 * empty list that looks like "you have no teams".
 */
export async function listTeams(scope: CompanyScope): Promise<{ id: string; name: string; description: string | null }[]> {
  void scope;
  const api = microsoftGraph();
  if (!api.configured) {
    throw new MicrosoftNeedsAdminConsent('Microsoft Teams is not configured for this deployment.');
  }

  try {
    const token = await api.token();
    return await api.listTeams(token.accessToken);
  } catch (error) {
    if (error instanceof MicrosoftGraphError && error.kind === 'needs_admin_consent') {
      throw new MicrosoftNeedsAdminConsent();
    }
    throw error;
  }
}

/**
 * Chooses the team to read, and confirms CIP can actually read it.
 *
 * The drive is resolved now rather than at the first sync, so somebody
 * choosing a team they cannot see is told immediately instead of finding out
 * from a failed sync an hour later.
 *
 * Changing the team clears the delta link: a token is a position in one
 * drive's history and means nothing in another's.
 */
export async function setTeam(scope: CompanyScope, teamId: string): Promise<MicrosoftConnectionDTO> {
  const api = microsoftGraph();
  if (!api.configured) {
    throw new MicrosoftNeedsAdminConsent('Microsoft Teams is not configured for this deployment.');
  }

  let teamName = teamId;
  let drive: { id: string; name: string };
  try {
    const token = await api.token();
    const teams = await api.listTeams(token.accessToken);
    const chosen = teams.find((team) => team.id === teamId);
    if (!chosen) {
      throw new MicrosoftGraphError('permanent', 'That team is not one CIP can see.');
    }
    teamName = chosen.name;
    drive = await api.getTeamDrive(token.accessToken, teamId);
  } catch (error) {
    if (error instanceof MicrosoftGraphError && error.kind === 'needs_admin_consent') {
      await markNeedsAdminConsent(scope, error.message);
      throw new MicrosoftNeedsAdminConsent();
    }
    throw error;
  }

  await withCompanyScope(scope, async (tx) => {
    await tx`
      insert into microsoft_connections
        (company_id, tenant_id, team_id, team_name, drive_id, drive_name,
         delta_link, status, connected_by, connected_at)
      values
        (${scope.companyId}, ${api.tenantId}, ${teamId}, ${teamName}, ${drive.id}, ${drive.name},
         null, 'connected', ${scope.userId}, now())
      on conflict (company_id) do update
         set tenant_id    = excluded.tenant_id,
             team_id      = excluded.team_id,
             team_name    = excluded.team_name,
             drive_id     = excluded.drive_id,
             drive_name   = excluded.drive_name,
             -- A new team is a new history. Keeping the old position would
             -- ask Microsoft what has changed in a drive it no longer names.
             delta_link   = null,
             status       = 'connected',
             connected_by = excluded.connected_by,
             connected_at = now(),
             last_sync_error = null,
             updated_at   = now()
    `;
  });

  return toDTO(await row(scope));
}

export async function disconnect(scope: CompanyScope): Promise<MicrosoftConnectionDTO> {
  await withCompanyScope(scope, async (tx) => {
    await tx`
      update microsoft_connections
         set status = 'disconnected', team_id = null, team_name = null,
             drive_id = null, drive_name = null, delta_link = null,
             last_sync_error = null, updated_at = now()
       where company_id = ${scope.companyId}
    `;
  });
  return toDTO(await row(scope));
}

export async function markNeedsAdminConsent(scope: CompanyScope, reason?: string): Promise<void> {
  await withCompanyScope(scope, async (tx) => {
    await tx`
      update microsoft_connections
         set status = 'needs_admin_consent',
             last_sync_error = ${reason ?? 'An administrator must grant CIP access.'},
             updated_at = now()
       where company_id = ${scope.companyId}
    `;
  });
}

export type ActiveConnection = {
  id: string;
  accessToken: string;
  driveId: string;
  deltaLink: string | null;
};

/**
 * The connection a sync needs, with a token good to use.
 *
 * A token is minted here rather than stored: it lasts an hour, the client
 * caches it for that hour, and nothing about it is per-company. There is no
 * refresh path because there is nothing to refresh.
 */
export async function requireConnected(scope: CompanyScope): Promise<ActiveConnection> {
  const connection = await row(scope);
  if (!connection || connection.status === 'disconnected') throw new MicrosoftNotConnected();
  if (connection.status === 'needs_admin_consent') throw new MicrosoftNeedsAdminConsent();
  if (!connection.drive_id) throw new MicrosoftNotConnected('Choose a team before syncing.');

  try {
    const token = await microsoftGraph().token();
    return {
      id: connection.id,
      accessToken: token.accessToken,
      driveId: connection.drive_id,
      deltaLink: connection.delta_link,
    };
  } catch (error) {
    if (error instanceof MicrosoftGraphError && error.kind === 'needs_admin_consent') {
      await markNeedsAdminConsent(scope, error.message);
      throw new MicrosoftNeedsAdminConsent();
    }
    throw error;
  }
}

export type SyncedTeamsFileDTO = {
  id: string;
  name: string;
  path: string | null;
  state: string;
  reason: string | null;
  fileId: string | null;
  syncedAt: string | null;
};

/** What was seen in the connected team, newest first. Never an external id. */
export async function listSyncedFiles(
  scope: CompanyScope,
  limit = 100,
): Promise<SyncedTeamsFileDTO[]> {
  return withCompanyScope(scope, async (tx) => {
    const rows = await tx<
      {
        id: string; name: string; external_path: string | null; state: string;
        reason: string | null; file_id: string | null; synced_at: Date | null;
      }[]
    >`
      select id, name, external_path, state, reason, file_id, synced_at
        from microsoft_files
       where company_id = ${scope.companyId}
       order by coalesce(synced_at, created_at) desc
       limit ${Math.min(Math.max(limit, 1), 500)}
    `;

    return rows.map((file) => ({
      id: file.id,
      name: file.name,
      path: file.external_path,
      state: file.state,
      reason: file.reason,
      fileId: file.file_id,
      syncedAt: file.synced_at?.toISOString() ?? null,
    }));
  });
}
