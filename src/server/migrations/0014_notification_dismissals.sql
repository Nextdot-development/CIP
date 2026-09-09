-- ===========================================================================
-- 0014 — putting a notice away
--
-- Notifications are derived, not stored: each one is worked out from the row it
-- is about, every time somebody asks. That is what stops the list claiming a
-- sync failed that has since worked, and it means most notices clear
-- themselves — a file finishes reading, a connection is reconnected, and the
-- notice is simply not produced next time.
--
-- Some never can. A generation that failed yesterday is final: it will not
-- succeed later, so its notice would sit in the list for ever and hold the
-- badge at three no matter how many times it was read. Those are the ones this
-- table is for.
--
-- Only final things are dismissible, which is why a dismissal can be permanent
-- and does not need to expire: the id names one generation or one file that
-- already reached its end state. A notice about something still true — a Drive
-- that needs reconnecting — is not dismissible at all, because putting it away
-- would hide a thing that is still wrong.
--
-- Per person, not per company: one member reading a notice does not read it
-- for everybody.
-- ===========================================================================

create table notification_dismissals (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  user_id    uuid not null references users(id) on delete cascade,

  -- The notice's own id, as the derivation produces it: `generation-<uuid>`,
  -- `unreadable-<name>`. Text rather than a foreign key because a notice can
  -- be about several different kinds of row, and the thing it names may be
  -- deleted while the dismissal is still meaningful.
  notice_id text not null,

  dismissed_at timestamptz not null default now(),

  unique (company_id, user_id, notice_id),
  unique (id, company_id)
);

create index notification_dismissals_lookup_idx
  on notification_dismissals (company_id, user_id);

alter table notification_dismissals enable row level security;
alter table notification_dismissals force  row level security;
create policy cip_company_isolation on notification_dismissals
  using (company_id = cip_current_company()) with check (company_id = cip_current_company());

grant select, insert, delete on notification_dismissals to cip_app;
