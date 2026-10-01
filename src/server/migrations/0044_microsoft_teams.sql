-- ===========================================================================
-- 0044 — Connected Microsoft Teams
--
-- A third knowledge source, beside the Company Drive and Google Drive. The
-- shape is deliberately the same as 0009's: a file in a Team becomes an
-- ordinary drive_files row with source_type = 'microsoft_teams', and from
-- there the extraction, understanding and embedding queues claim it exactly as
-- they claim anything else. Nothing downstream learns that Microsoft exists.
--
-- What a "Team" is, in Microsoft's terms: a team is a Microsoft 365 group,
-- the group owns a SharePoint site, and the site's default document library is
-- what people see as the Files tab. So the thing CIP actually reads is a
-- drive, reached as /groups/{teamId}/drive. The team id is kept as well as the
-- drive id because the team is what a person recognises and the drive id is
-- what the API needs.
--
-- Isolation is the same shape as every company-owned table since 0003:
-- company_id on the row, composite foreign keys so a synced file cannot belong
-- to one company while its connection belongs to another, and RLS with FORCE.
-- ===========================================================================

alter table drive_files
  drop constraint if exists drive_files_source_type_check;

alter table drive_files
  add constraint drive_files_source_type_check
  check (source_type in ('cip_drive', 'google_drive', 'website', 'microsoft_teams'));

-- ---------------------------------------------------------------------------
-- The connection itself: one per company.
-- ---------------------------------------------------------------------------
create table microsoft_connections (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,

  -- The Entra ID (Azure AD) tenant this company's Microsoft 365 lives in.
  -- Stored because one deployment of CIP may serve companies in different
  -- tenants, and a token is only ever good for one of them.
  tenant_id text,

  -- The team a person chose, and the drive it turned out to own. Ids, not
  -- URLs: a URL is a way of naming a team, not proof of access, and Microsoft
  -- rewrites them. Null until somebody picks a team.
  team_id    text,
  team_name  text,
  drive_id   text,
  drive_name text,

  -- Where the last sync got to.
  --
  -- Graph hands back a deltaLink at the end of a delta walk, and presenting it
  -- next time returns only what has changed since. That is the whole of change
  -- detection here, and it is why this integration does not keep a modified
  -- time or a checksum per file the way 0009 has to: Google must be asked for
  -- everything and told what moved by comparing, Microsoft is asked only for
  -- what moved.
  --
  -- Null means the next sync is a full one, which is also what happens when
  -- Graph expires a link and asks for a fresh walk.
  delta_link text,

  -- Credentials are deliberately absent.
  --
  -- CIP reads a Team as itself, with an application permission an administrator
  -- granted once, so there is no per-company token to hold: the client secret
  -- belongs to the deployment and lives in its environment. 0009 had to store
  -- tokens because a person's sign-in is a per-company thing, and migration
  -- 0041 records what that cost — a sync stopped for a fortnight because the
  -- one person who could reconnect it was on leave.

  status text not null default 'disconnected'
    check (status in ('connected', 'needs_admin_consent', 'disconnected')),

  connected_by uuid references users(id),
  connected_at timestamptz,

  last_sync_at         timestamptz,
  last_sync_started_at timestamptz,
  last_sync_error      text,
  -- Lease for the sync worker, exactly as the media queue and 0009 do it.
  sync_claimed_until   timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- One connection per company. Connecting again replaces the chosen team
  -- rather than accumulating a second row nobody looks at.
  unique (company_id),
  unique (id, company_id)
);

create index microsoft_connections_sync_idx
  on microsoft_connections (status, sync_claimed_until)
  where status = 'connected';

-- ---------------------------------------------------------------------------
-- One row per item seen in the connected team's files.
--
-- Separate from drive_files for the same reason 0009's table is: it holds
-- Microsoft's view of the item — its id over there, its eTag, where it sits in
-- their folder tree — which is sync bookkeeping, not knowledge.
-- ---------------------------------------------------------------------------
create table microsoft_files (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references companies(id) on delete cascade,
  connection_id uuid not null,

  -- Graph's driveItem id. Unique per company, so the same document shared into
  -- two companies is two independent records.
  external_id text not null,

  name          text not null,
  external_mime text not null,

  -- Change detection, for the cases delta alone does not settle.
  --
  -- A delta page says an item changed; it does not say whether the bytes did.
  -- Renaming a file, or moving it, is a change Graph reports and CIP must not
  -- re-download for. eTag moves on any change; cTag moves only when the
  -- content does, so cTag is what decides a refetch and eTag is what decides a
  -- rename.
  external_etag text,
  external_ctag text,
  external_modified_time timestamptz,
  external_size          bigint,

  -- The folder path inside the team, as Graph reports it. Kept so a person can
  -- see where a file came from, and so two files of the same name in different
  -- folders are tellable apart.
  external_path text,

  -- The drive_files row this became, once it has been ingested. Null while an
  -- item is known but not yet fetched, or when it is unsupported.
  file_id uuid,

  state text not null default 'pending'
    check (state in ('pending', 'synced', 'unsupported', 'trashed', 'failed')),

  -- Why an unsupported or failed item was not ingested. Shown to the person,
  -- so nothing is silently skipped.
  reason text,

  last_seen_at timestamptz,
  synced_at    timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (id, company_id),
  unique (company_id, external_id),

  foreign key (connection_id, company_id)
    references microsoft_connections (id, company_id) on delete cascade,
  foreign key (file_id, company_id)
    references drive_files (id, company_id) on delete set null
);

create index microsoft_files_connection_idx
  on microsoft_files (company_id, connection_id, state);
create index microsoft_files_file_idx
  on microsoft_files (company_id, file_id);

alter table microsoft_connections enable row level security;
alter table microsoft_connections force  row level security;
create policy cip_company_isolation on microsoft_connections
  using (company_id = cip_current_company())
  with check (company_id = cip_current_company());

alter table microsoft_files enable row level security;
alter table microsoft_files force  row level security;
create policy cip_company_isolation on microsoft_files
  using (company_id = cip_current_company())
  with check (company_id = cip_current_company());

grant select, insert, update, delete on microsoft_connections to cip_app;
grant select, insert, update, delete on microsoft_files       to cip_app;
