import 'server-only';
import { withCompanyScope } from './db';
import type { CompanyScope } from './db';

/**
 * Things worth telling this company about, read from what is actually true.
 *
 * Nothing here is stored or pushed. There is no notifications table and no
 * unread count kept in a column that could drift out of step with reality —
 * every item is derived from the row it is about, at the moment somebody asks.
 * A file that failed to read produces a notice while it is failed, and stops
 * producing one the moment it is retried and succeeds.
 *
 * Most notices therefore clear themselves, and the list can never claim a sync
 * failed that has since worked.
 *
 * Some cannot clear themselves. A generation that failed yesterday is final —
 * it will not succeed later — so its notice would sit there for ever and hold
 * the badge at three however many times it was read. Those, and only those,
 * can be put away; a dismissal is recorded per person against the notice's own
 * id. Anything still true is not dismissible, because hiding it would not make
 * it stop being true.
 */

export type Notice = {
  id: string;
  /** How much it matters. `problem` needs a person; `working` will resolve itself. */
  tone: 'problem' | 'attention' | 'working' | 'good';
  title: string;
  detail: string;
  /** Where to go to do something about it. */
  href: string | null;
  action: string | null;
  /**
   * Whether this one can be put away.
   *
   * True for a thing that has already finished happening — a generation that
   * failed, a file Google refused. Those are final: they will not resolve
   * themselves, so without this they would hold the badge for ever.
   *
   * False for anything still true. A Drive that needs reconnecting stops being
   * reported the moment it is reconnected, and letting somebody dismiss it
   * would hide a problem that has not gone anywhere.
   */
  dismissible: boolean;
};

export async function notifications(scope: CompanyScope): Promise<Notice[]> {
  return withCompanyScope(scope, async (tx) => {
    const notices: Notice[] = [];

    // What this person has already put away. Per person: one member reading
    // a notice does not read it for everybody.
    const dismissedRows = await tx<{ notice_id: string }[]>`
      select notice_id from notification_dismissals
       where company_id = ${scope.companyId} and user_id = ${scope.userId}
    `;
    const dismissed = new Set(dismissedRows.map((row) => row.notice_id));

    // --- the Google Drive connection ------------------------------------
    const [connection] = await tx<
      { status: string; folder_id: string | null; folder_name: string | null; last_sync_error: string | null }[]
    >`
      select status, folder_id, folder_name, last_sync_error
        from google_drive_connections where company_id = ${scope.companyId}
    `;

    if (connection?.status === 'needs_reauth') {
      notices.push({
        id: 'drive-reauth',
        tone: 'problem',
        title: 'Google Drive needs reconnecting',
        detail: connection.last_sync_error ?? 'Its access expired, so nothing new is being synced.',
        href: '/teach',
        action: 'Reconnect',
        dismissible: false,
      });
    } else if (connection?.status === 'connected' && !connection.folder_id) {
      notices.push({
        id: 'drive-no-folder',
        tone: 'attention',
        title: 'No folder chosen',
        detail: 'Google Drive is connected but no folder is being watched, so nothing syncs.',
        href: '/teach',
        action: 'Choose one',
        dismissible: false,
      });
    } else if (connection?.last_sync_error) {
      notices.push({
        id: 'drive-sync-error',
        tone: 'problem',
        title: 'The last Drive sync did not finish',
        detail: connection.last_sync_error,
        href: '/teach',
        action: 'Try again',
        dismissible: false,
      });
    }

    // --- files Google would not give us ----------------------------------
    const skipped = await tx<{ name: string; state: string; reason: string | null }[]>`
      select name, state, reason from google_drive_files
       where company_id = ${scope.companyId} and state in ('failed', 'too_large')
       order by updated_at desc limit 5
    `;

    for (const file of skipped) {
      notices.push({
        id: `drive-file-${file.name}`,
        tone: file.state === 'too_large' ? 'attention' : 'problem',
        title:
          file.state === 'too_large'
            ? `${file.name} is too large to sync`
            : `${file.name} could not be synced`,
        detail: file.reason ?? 'No reason was recorded.',
        href: '/teach',
        action: null,
        dismissible: true,
      });
    }

    // --- files we hold but could not read --------------------------------
    const unreadable = await tx<{ name: string; error: string | null }[]>`
      select f.name, coalesce(u.error_message, f.processing_error) as error
        from drive_files f
        left join lateral (
          select error_message, status from asset_understanding
           where file_id = f.id and company_id = f.company_id
           order by updated_at desc limit 1
        ) u on true
       where f.company_id = ${scope.companyId}
         and f.archived_at is null
         and (f.processing_status = 'failed' or u.status = 'failed')
       order by f.updated_at desc limit 5
    `;

    for (const file of unreadable) {
      notices.push({
        id: `unreadable-${file.name}`,
        tone: 'problem',
        title: `${file.name} could not be read`,
        detail: file.error ?? 'No reason was recorded.',
        href: '/trust',
        action: 'See the file',
        dismissible: true,
      });
    }

    // --- work still moving ------------------------------------------------
    const [pending] = await tx<{ reading: number }[]>`
      select count(*)::int as reading
        from drive_files f
        left join lateral (
          select status from asset_understanding
           where file_id = f.id and company_id = f.company_id
           order by updated_at desc limit 1
        ) u on true
       where f.company_id = ${scope.companyId}
         and f.archived_at is null
         and (u.status is null or u.status in ('pending', 'processing'))
         and f.file_type in ('pdf', 'docx', 'txt', 'csv', 'png', 'jpg', 'jpeg',
                             'webp', 'gif', 'mp4', 'mov', 'webm')
    `;

    if ((pending?.reading ?? 0) > 0) {
      notices.push({
        id: 'reading',
        tone: 'working',
        title: `Reading ${pending!.reading} file${pending!.reading === 1 ? '' : 's'}`,
        detail: 'CIP is working through them. This page will show them once they are done.',
        href: '/trust',
        action: null,
        dismissible: false,
      });
    }

    // --- generations that failed -----------------------------------------
    const failed = await tx<{ id: string; prompt: string; error_message: string | null }[]>`
      select id, prompt, error_message from media_generations
       where company_id = ${scope.companyId} and status = 'failed'
       order by created_at desc limit 3
    `;

    for (const generation of failed) {
      notices.push({
        id: `generation-${generation.id}`,
        tone: 'attention',
        title: 'Something you asked for could not be made',
        detail: `${generation.error_message ?? 'No reason was recorded.'} — “${generation.prompt.slice(0, 70)}…”`,
        href: '/ask',
        action: 'Try again',
        dismissible: true,
      });
    }

    // Anything already put away is simply not produced. A notice that is not
    // dismissible cannot have been, so the filter only ever removes final ones.
    return notices.filter((notice) => !dismissed.has(notice.id));
  });
}


/**
 * Puts one notice away for this person.
 *
 * Idempotent: pressing it twice is the same as once. Nothing checks that the
 * notice exists — it is derived, so it may already have stopped being produced
 * between the panel rendering and the click, and recording a dismissal for
 * something that is no longer reported costs a row and harms nothing.
 */
export async function dismissNotice(scope: CompanyScope, noticeId: string): Promise<void> {
  const id = noticeId.trim().slice(0, 200);
  if (id.length === 0) return;

  await withCompanyScope(scope, async (tx) => {
    await tx`
      insert into notification_dismissals (company_id, user_id, notice_id)
      values (${scope.companyId}, ${scope.userId}, ${id})
      on conflict (company_id, user_id, notice_id) do nothing
    `;
  });
}
