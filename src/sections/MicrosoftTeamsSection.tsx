'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, Pill } from '@/components/ui/Bits';
import { Icon } from '@/components/ui/Icon';
import { useToast } from '@/context/toast';
import { relativeDay } from '@/lib/format';
import type {
  MicrosoftConnectionDTO,
  MicrosoftTeamDTO,
  SyncedTeamsFileDTO,
} from '@/types/integrations';

/**
 * The connected Microsoft Team.
 *
 * Sits beside the Google Drive card because they answer the same question —
 * where else should CIP read from — and behaves differently in one way that is
 * worth showing: there is nothing to sign in to and nothing that expires. A
 * person picks a team from a list and CIP reads it until somebody says stop.
 *
 * Nothing here filters by company. It cannot see another company's connection
 * because the endpoints only ever answer for the session's own.
 */
export function MicrosoftTeamsSection({
  connection: initial,
  initialFiles,
}: {
  connection: MicrosoftConnectionDTO;
  initialFiles: SyncedTeamsFileDTO[];
}) {
  const { note } = useToast();
  const [connection, setConnection] = useState(initial);
  const [files, setFiles] = useState(initialFiles);
  const [teams, setTeams] = useState<MicrosoftTeamDTO[] | null>(null);
  const [chosen, setChosen] = useState('');
  const [busy, setBusy] = useState<'teams' | 'team' | 'sync' | 'disconnect' | null>(null);

  const refresh = useCallback(async () => {
    const [status, listing] = await Promise.all([
      fetch('/api/integrations/microsoft', { cache: 'no-store' }),
      fetch('/api/integrations/microsoft/files', { cache: 'no-store' }),
    ]);
    if (status.ok) {
      const data = (await status.json()) as { connection: MicrosoftConnectionDTO };
      setConnection(data.connection);
    }
    if (listing.ok) {
      const data = (await listing.json()) as { files: SyncedTeamsFileDTO[] };
      setFiles(data.files);
    }
  }, []);

  /** One call, with whatever the server said shown as-is. */
  const call = useCallback(
    async (path: string, body?: unknown): Promise<boolean> => {
      const response = await fetch(path, {
        method: 'POST',
        ...(body === undefined
          ? {}
          : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      });
      if (response.ok) return true;

      const data = (await response.json().catch(() => null)) as { message?: string } | null;
      // The server's wording, not ours. It already knows whether this is
      // something the person can fix or something only an administrator can.
      note(data?.message ?? 'That did not work. Try again in a moment.');
      return false;
    },
    [note],
  );

  const loadTeams = useCallback(async () => {
    setBusy('teams');
    try {
      const response = await fetch('/api/integrations/microsoft/teams', { cache: 'no-store' });
      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as { message?: string } | null;
        note(data?.message ?? 'CIP could not read the list of teams.');
        await refresh();
        return;
      }
      const data = (await response.json()) as { teams: MicrosoftTeamDTO[] };
      setTeams(data.teams);
      if (data.teams.length === 0) note('CIP cannot see any teams in this Microsoft 365 tenant.');
    } finally {
      setBusy(null);
    }
  }, [note, refresh]);

  const connect = useCallback(async () => {
    if (!chosen) return;
    setBusy('team');
    try {
      if (await call('/api/integrations/microsoft/team', { teamId: chosen })) {
        note('Connected. CIP will read this team from now on.');
        setTeams(null);
        await refresh();
      }
    } finally {
      setBusy(null);
    }
  }, [call, chosen, note, refresh]);

  const syncNow = useCallback(async () => {
    setBusy('sync');
    try {
      if (await call('/api/integrations/microsoft/sync')) note('Reading the team now.');
      await refresh();
    } finally {
      setBusy(null);
    }
  }, [call, note, refresh]);

  const disconnect = useCallback(async () => {
    setBusy('disconnect');
    try {
      if (await call('/api/integrations/microsoft/disconnect')) {
        note('Disconnected. What CIP already learned is kept.');
        await refresh();
      }
    } finally {
      setBusy(null);
    }
  }, [call, note, refresh]);

  // Files arrive through the pipeline minutes after a sync, so the card is
  // refreshed while one is in flight. Stopped once nothing is pending, rather
  // than polling a settled page for ever.
  useEffect(() => {
    if (connection.status !== 'connected') return;
    const pending = files.some((file) => file.state === 'pending');
    if (!pending) return;

    const timer = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(timer);
  }, [connection.status, files, refresh]);

  const skipped = files.filter((file) => file.state === 'unsupported' || file.state === 'failed');
  const synced = files.filter((file) => file.state === 'synced');

  return (
    <Card title="Microsoft Teams">
      <p className="small muted">Read a team&rsquo;s Files tab, and keep reading it.</p>
      {!connection.configured && (
        <div className="notice">
          <Icon name="alert" size={15} />
          <span>
            <b className="strong">Not set up on this deployment.</b> An administrator needs to
            register CIP in Microsoft Entra ID and grant it the application permissions{' '}
            <code>Sites.Read.All</code> and <code>Group.Read.All</code>.
          </span>
        </div>
      )}

      {connection.configured && connection.status === 'needs_admin_consent' && (
        <div className="notice">
          <Icon name="alert" size={15} />
          <span>
            <b className="strong">CIP has not been granted access.</b>{' '}
            {connection.lastSyncError ??
              'An administrator must approve CIP in your Microsoft 365 tenant.'}
          </span>
        </div>
      )}

      {connection.configured && connection.status !== 'connected' && (
        <div className="stack">
          <p className="small muted">
            Pick a team and CIP reads its Files tab — nothing else, and never writes. Whatever is
            in there joins the same Knowledge Layer as your uploads, and a file added or changed
            later is picked up on its own.
          </p>

          {teams === null ? (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void loadTeams()}
              disabled={busy !== null}
            >
              <Icon name="link" size={15} /> {busy === 'teams' ? 'Looking…' : 'Choose a team'}
            </button>
          ) : (
            <div className="stack">
              <label className="field">
                <span className="field-label">Team</span>
                <select
                  className="field-input"
                  value={chosen}
                  onChange={(event) => setChosen(event.target.value)}
                >
                  <option value="">Choose a team…</option>
                  {teams.map((team) => (
                    <option key={team.id} value={team.id}>{team.name}</option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void connect()}
                disabled={busy !== null || !chosen}
              >
                {busy === 'team' ? 'Connecting…' : 'Connect this team'}
              </button>
            </div>
          )}
        </div>
      )}

      {connection.status === 'connected' && (
        <div className="stack">
          <dl className="conn-facts">
            <div>
              <dt>Team</dt>
              <dd>{connection.teamName ?? 'Connected'}</dd>
            </div>
            <div>
              <dt>Library</dt>
              <dd>{connection.driveName ?? <span className="muted">Files</span>}</dd>
            </div>
            <div>
              <dt>Last read</dt>
              <dd>
                {connection.lastSyncAt
                  ? relativeDay(connection.lastSyncAt)
                  : <span className="muted">Not yet</span>}
              </dd>
            </div>
            <div>
              <dt>Documents</dt>
              <dd>
                {synced.length} in your Knowledge Layer
                {skipped.length > 0 && `, ${skipped.length} skipped`}
              </dd>
            </div>
          </dl>

          {connection.lastSyncError && (
            <p className="small" style={{ color: 'var(--stop-700)' }}>{connection.lastSyncError}</p>
          )}

          <p className="small muted">
            CIP checks for new and changed files on its own. Reading now is only for when you do
            not want to wait.
          </p>

          <div className="row" style={{ gap: 8 }}>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void syncNow()}
              disabled={busy !== null}
            >
              <Icon name="bolt" size={15} /> {busy === 'sync' ? 'Reading…' : 'Read now'}
            </button>
            <button
              type="button"
              className="btnghost"
              onClick={() => void disconnect()}
              disabled={busy !== null}
            >
              {busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}
            </button>
          </div>

          {/*
            What was skipped, and why. A Team is full of spreadsheets and decks
            CIP cannot read yet, and showing only what worked would make a team
            that taught almost nothing look like one that synced perfectly.
          */}
          {skipped.length > 0 && (
            <details className="stack">
              <summary className="small muted">{skipped.length} not read</summary>
              <ul className="plain small">
                {skipped.slice(0, 20).map((file) => (
                  <li key={file.id}>
                    <b className="strong">{file.name}</b>{' '}
                    <span className="muted">{file.reason ?? 'Not read.'}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}

          {synced.length > 0 && (
            <ul className="plain small">
              {synced.slice(0, 10).map((file) => (
                <li key={file.id}>
                  {file.name}
                  {file.path && <span className="muted"> · {file.path.replace(/^\/drive\/root:?/, '') || '/'}</span>}
                  <Pill tone="ok">read</Pill>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
}
