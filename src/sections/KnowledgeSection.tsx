'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, EmptyState, Pill } from '@/components/ui/Bits';
import { Icon } from '@/components/ui/Icon';
import { useToast } from '@/context/toast';
import { relativeDay } from '@/lib/format';
import type { GoogleDriveConnectionDTO, SyncedFileDTO } from '@/types/integrations';

/**
 * Knowledge settings — the connected Google Drive.
 *
 * The Company Drive is unchanged and lives where it always did. This is the
 * second source: a folder somebody has granted CIP read-only access to, whose
 * documents flow into the same Knowledge Layer.
 *
 * Nothing here filters by company. It cannot see another company's connection
 * because the endpoints only ever answer for the session's own.
 */
export function KnowledgeSection({
  connection: initial,
  initialFiles,
  outcome = null,
  /** Reserved for a standalone rendering; Teach supplies its own heading. */
  embedded: _embedded = false,
}: {
  connection: GoogleDriveConnectionDTO;
  initialFiles: SyncedFileDTO[];
  outcome?: string | null;
  embedded?: boolean;
}) {
  const { note } = useToast();
  const [connection, setConnection] = useState(initial);
  const [files, setFiles] = useState(initialFiles);
  const [folderInput, setFolderInput] = useState('');
  /**
   * Whether the person has asked to change an already-chosen folder.
   *
   * Separate from folderInput, because the form was shown on
   * `connection.folderId === null` alone: once a folder was chosen the input
   * was no longer rendered, so Change folder set a value into a field that was
   * not on the page and the button did visibly nothing.
   */
  const [changing, setChanging] = useState(false);
  const [busy, setBusy] = useState<'folder' | 'share' | 'sync' | 'disconnect' | null>(null);
  const [shareInput, setShareInput] = useState('');

  // The callback comes back with an outcome in the URL. Said once, then the
  // parameter is cleared so a refresh does not repeat it.
  useEffect(() => {
    if (!outcome) return;
    const message = OUTCOMES[outcome];
    if (message) note(message);
    window.history.replaceState(null, '', '/teach');
  }, [note, outcome]);

  const refresh = useCallback(async () => {
    const [status, listing] = await Promise.all([
      fetch('/api/integrations/google-drive', { cache: 'no-store' }),
      fetch('/api/integrations/google-drive/files', { cache: 'no-store' }),
    ]);
    if (status.ok) {
      const data = (await status.json()) as { connection: GoogleDriveConnectionDTO };
      setConnection(data.connection);
    }
    if (listing.ok) {
      const data = (await listing.json()) as { files: SyncedFileDTO[] };
      setFiles(data.files);
    }
  }, []);

  const post = useCallback(
    async (path: string, body?: unknown) => {
      const res = await fetch(path, {
        method: 'POST',
        ...(body === undefined
          ? {}
          : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      });
      if (!res.ok) {
        const problem = (await res.json().catch(() => null)) as { message?: string } | null;
        note(problem?.message ?? 'That did not work. Try again in a moment.');
        return null;
      }
      return res.json() as Promise<Record<string, unknown>>;
    },
    [note],
  );

  // A folder shared with CIP's service account: nobody signs in.
  const connectShared = useCallback(async (link: string) => {
    setBusy('share');
    try {
      const result = await post('/api/integrations/google-drive/share', { folder: link.trim() });
      if (result) {
        setShareInput('');
        setFolderInput('');
        note('Folder connected. Sync when you are ready.');
        await refresh();
      }
    } finally {
      setBusy(null);
    }
  }, [note, post, refresh]);

  const chooseFolder = useCallback(async () => {
    // Read by the service account, a new folder is one shared with it.
    if (connection.authKind === 'service_account') {
      await connectShared(folderInput);
      return;
    }
    setBusy('folder');
    try {
      const result = await post('/api/integrations/google-drive/folder', {
        folderId: folderInput.trim(),
      });
      if (result) {
        setFolderInput('');
        setChanging(false);
        note('Folder saved. Sync when you are ready.');
        await refresh();
      }
    } finally {
      setBusy(null);
    }
  }, [connection.authKind, connectShared, folderInput, note, post, refresh]);

  const syncNow = useCallback(async () => {
    setBusy('sync');
    try {
      const result = await post('/api/integrations/google-drive/sync');
      if (result) {
        // Counted from whatever came back, rather than asserted about it. The
        // reply was cast and then read five fields deep: anything else on the
        // wire - a proxy's page, an older route - threw inside this handler,
        // which swallowed it, so "Sync now" looked like it had quietly done
        // nothing. A sync that worked and says so badly is still a sync.
        const o = (result.outcome ?? {}) as Partial<
          Record<'added' | 'updated' | 'unchanged' | 'unsupported' | 'removed', number>
        >;
        const count = (value: number | undefined): number => (typeof value === 'number' ? value : 0);

        note(
          `Synced — ${count(o.added)} new, ${count(o.updated)} updated, ${count(o.unchanged)} unchanged` +
            (count(o.unsupported) > 0 ? `, ${count(o.unsupported)} could not be read` : '') +
            (count(o.removed) > 0 ? `, ${count(o.removed)} removed` : ''),
        );
        await refresh();
      }
    } finally {
      setBusy(null);
    }
  }, [note, post, refresh]);

  const disconnect = useCallback(async () => {
    setBusy('disconnect');
    try {
      const result = await post('/api/integrations/google-drive/disconnect');
      if (result) {
        note('Disconnected. The documents already brought in are still here.');
        await refresh();
      }
    } finally {
      setBusy(null);
    }
  }, [note, post, refresh]);

  if (!connection.providerConfigured) {
    return (
      <Card title="Connected Google Drive">
        <div className="notice">
          <Icon name="alert" size={15} />
          <span>
            <b className="strong">Google Drive is not configured on this server.</b> Nobody can
            connect a Drive until an OAuth client is set up.
          </span>
        </div>
      </Card>
    );
  }

  return (
    <>
      <Card
        title="Connected Google Drive"
        action={<Pill tone={TONE[connection.status]}>{LABEL[connection.status]}</Pill>}
      >
        {connection.status !== 'connected' && connection.serviceAccountEmail && (
          <SharePanel
            email={connection.serviceAccountEmail}
            value={shareInput}
            onChange={setShareInput}
            busy={busy === 'share'}
            disabled={busy !== null}
            onConnect={() => void connectShared(shareInput)}
          />
        )}

        {connection.status === 'disconnected' && !connection.serviceAccountEmail && (
          <div className="stack">
            <p className="small muted">
              Connect a Google account and choose one folder. CIP reads it — nothing else, and
              never writes. Documents in it join the same Knowledge Layer as your uploads.
            </p>
            <a className="btn btn-primary" href="/api/integrations/google-drive/connect">
              <Icon name="link" size={15} /> Connect Google Drive
            </a>
          </div>
        )}

        {connection.status === 'needs_reauth' && !connection.serviceAccountEmail && (
          <div className="stack">
            <div className="notice">
              <Icon name="alert" size={15} />
              <span>
                <b className="strong">Google access has expired.</b>{' '}
                {connection.lastSyncError ?? 'Reconnect to keep syncing.'}
              </span>
            </div>
            <a className="btn btn-primary" href="/api/integrations/google-drive/connect">
              <Icon name="link" size={15} /> Reconnect
            </a>
          </div>
        )}

        {connection.status === 'connected' && (
          <div className="stack">
            <dl className="conn-facts">
              <div>
                <dt>Account</dt>
                <dd>{connection.accountEmail ?? 'Connected'}</dd>
              </div>
              <div>
                <dt>Folder</dt>
                <dd>{connection.folderName ?? <span className="muted">Not chosen yet</span>}</dd>
              </div>
              <div>
                <dt>Last sync</dt>
                <dd>
                  {connection.lastSyncAt ? relativeDay(connection.lastSyncAt) : <span className="muted">Never</span>}
                </dd>
              </div>
              <div>
                <dt>Documents</dt>
                <dd>
                  {connection.files.synced} in your Knowledge Layer
                  {connection.files.unsupported > 0 && `, ${connection.files.unsupported} skipped`}
                </dd>
              </div>
            </dl>

            {connection.lastSyncError && (
              <p className="small" style={{ color: 'var(--stop-700)' }}>{connection.lastSyncError}</p>
            )}

            {connection.folderId === null || changing ? (
              <div className="stack">
                <label className="field">
                  <span className="field-label">Folder link</span>
                  <input
                    className="field-input"
                    value={folderInput}
                    placeholder="Paste the folder link from Google Drive"
                    onChange={(e) => setFolderInput(e.target.value)}
                  />
                  <span className="small muted">
                    Open the folder in Drive and copy the address. The id on its own works too.
                  </span>
                </label>
                <div className="row-gap">
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={busy !== null}
                    onClick={() => void chooseFolder()}
                  >
                    {busy === 'folder' ? 'Checking...' : 'Use this folder'}
                  </button>
                  {changing && (
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={busy !== null}
                      onClick={() => {
                        setChanging(false);
                        setFolderInput('');
                      }}
                    >
                      Cancel
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <div className="row-gap">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy !== null || connection.syncing}
                  onClick={() => void syncNow()}
                >
                  {busy === 'sync' || connection.syncing ? 'Syncing...' : 'Sync now'}
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={busy !== null}
                  onClick={() => {
                    // Opened empty rather than prefilled with the current id.
                    // What goes in here is a link somebody pastes, and a bare
                    // id sitting in the box looks like something to edit.
                    setFolderInput('');
                    setChanging(true);
                  }}
                >
                  Change folder
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={busy !== null}
                  onClick={() => void disconnect()}
                >
                  Disconnect
                </button>
              </div>
            )}
          </div>
        )}
      </Card>

      {files.length > 0 && (
        <Card title="What the last sync found">
          {files.map((file) => (
            <div className="gen-row" key={file.id}>
              <span className="gen-thumb">
                <Icon name="doc" size={16} />
              </span>
              <span className="stack grow">
                <span className="gen-prompt">{file.name}</span>
                {file.reason && <span className="small muted">{file.reason}</span>}

                {/* Both numbers, so "too large" is checkable rather than taken
                    on trust. */}
                {file.state === 'too_large' && file.sizeBytes !== null && (
                  <span className="small muted">
                    Measured {megabytes(file.sizeBytes)}
                    {file.limitBytes !== null ? ` · maximum ${megabytes(file.limitBytes)}` : ''}
                  </span>
                )}

                {file.progress && (
                  <span className="small muted">
                    {file.progress.pages !== null
                      ? `${file.progress.pagesUnderstood}/${file.progress.pages} page(s) understood` +
                        (file.progress.posts ? ` · ${file.progress.posts} post(s)` : '')
                      : file.progress.status === 'ready'
                        ? 'Read and understood'
                        : 'Waiting for the worker'}
                    {file.progress.retained ? '' : ' · read without keeping the original'}
                  </span>
                )}

                {file.progress?.error && (
                  <span className="small" style={{ color: 'var(--danger, #c33)' }}>
                    {file.progress.error}
                  </span>
                )}
              </span>

              {/* Once a file is ours, how far it has got is the honest headline;
                  the sync state only matters while it is not. */}
              {file.progress ? (
                <Pill tone={PROGRESS_TONE[file.progress.status] ?? 'neutral'}>
                  {PROGRESS_LABEL[file.progress.status] ?? file.progress.status}
                </Pill>
              ) : (
                <Pill tone={FILE_TONE[file.state] ?? 'neutral'}>
                  {FILE_LABEL[file.state] ?? file.state}
                </Pill>
              )}
            </div>
          ))}
        </Card>
      )}

      {connection.status === 'connected' && connection.folderId && files.length === 0 && (
        <EmptyState
          icon="folder"
          title="Nothing synced yet"
          copy="Press Sync now to bring documents from the connected folder into your Knowledge Layer."
        />
      )}
    </>
  );
}

const TONE: Record<string, 'ok' | 'warn' | 'stop' | 'neutral'> = {
  connected: 'ok',
  needs_reauth: 'warn',
  disconnected: 'neutral',
};

const LABEL: Record<string, string> = {
  connected: 'Connected',
  needs_reauth: 'Needs reconnecting',
  disconnected: 'Not connected',
};

/**
 * What to call a file, and what colour to say it in.
 *
 * `synced` used to read "In your Knowledge Layer", which was a claim about the
 * pipeline made by the step before it. A file is copied in, then read, then
 * understood, and the first of those finishing says nothing about the other
 * two — a PDF nothing had opened sat there looking finished. So the sync state
 * only decides the label when the file never became a CIP file at all;
 * otherwise its actual progress does.
 */
const FILE_TONE: Record<string, 'ok' | 'warn' | 'stop' | 'neutral'> = {
  synced: 'ok',
  pending: 'warn',
  unsupported: 'neutral',
  trashed: 'neutral',
  too_large: 'warn',
  failed: 'stop',
};

const FILE_LABEL: Record<string, string> = {
  synced: 'Synced',
  pending: 'Waiting',
  unsupported: 'Could not be read',
  trashed: 'Removed in Drive',
  too_large: 'Too large',
  failed: 'Did not sync',
};

const PROGRESS_TONE: Record<string, 'ok' | 'warn' | 'stop' | 'neutral'> = {
  queued: 'warn',
  processing: 'warn',
  ready: 'ok',
  failed: 'stop',
};

const PROGRESS_LABEL: Record<string, string> = {
  queued: 'Queued',
  processing: 'Reading…',
  ready: 'In your Knowledge Layer',
  failed: 'Could not be read',
};

function megabytes(bytes: number | null): string | null {
  if (bytes === null) return null;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

const OUTCOMES: Record<string, string> = {
  connected: 'Google Drive connected. Choose a folder to sync.',
  declined: 'Google Drive was not connected.',
  invalid: 'That sign-in did not complete. Try again.',
  state: 'That sign-in did not match this session, so it was refused.',
  failed: 'Google would not complete the connection. Try again.',
};

/**
 * Connecting by sharing: the folder is shared with CIP's own address, the way
 * it would be with a colleague, and its link pasted here. No sign-in, and so
 * nothing that expires every week or works only for listed testers.
 */
function SharePanel({
  email, value, onChange, busy, disabled, onConnect,
}: {
  email: string;
  value: string;
  onChange: (value: string) => void;
  busy: boolean;
  disabled: boolean;
  onConnect: () => void;
}) {
  const { note } = useToast();
  return (
    <div className="stack">
      <p className="small">
        <b className="strong">1.</b> In Google Drive, open the folder, click <b>Share</b>, and add this
        address as a <b>Viewer</b>:
      </p>
      <div className="row-gap" style={{ alignItems: 'center' }}>
        <code className="share-email">{email}</code>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => {
            void navigator.clipboard?.writeText(email).then(
              () => note('Address copied'),
              () => note('Copy it from the box'),
            );
          }}
        >
          Copy
        </button>
      </div>
      <label className="field">
        <span className="field-label"><b className="strong">2.</b> Paste the folder link</span>
        <input
          className="field-input"
          value={value}
          placeholder="https://drive.google.com/drive/folders/…"
          onChange={(e) => onChange(e.target.value)}
        />
      </label>
      <button type="button" className="btn btn-primary" disabled={disabled || !value.trim()} onClick={onConnect}>
        <Icon name="link" size={15} /> {busy ? 'Checking...' : 'Connect folder'}
      </button>
      <p className="small muted">CIP only reads the folder. Remove the share in Drive and it stops.</p>
    </div>
  );
}
