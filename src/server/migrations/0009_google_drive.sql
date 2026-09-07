-- ===========================================================================
-- 0009 — Connected Google Drive
--
-- A second knowledge source alongside the Company Drive. The Company Drive is
-- untouched: files uploaded by hand still behave exactly as they did.
--
-- The design point is that Google Drive files become ordinary drive_files rows.
-- The extraction queue claims pending rows from that table and the embedding
-- queue follows the chunks, so a synced file travels the Phase 3 and Phase 4
-- pipelines without either of them learning that Google exists. There is no
-- second extractor and no second embedder.
--
-- Isolation is the same shape as every company-owned table since 0003:
-- company_id on the row, composite foreign keys so a synced file cannot belong
-- to one company while its connection belongs to another, and RLS with FORCE.
-- ===========================================================================

-- Which source a file came from. Defaulted, so every existing row is correctly
-- labelled as a manual upload without a backfill.
alter table drive_files
  add column source_type text not null default 'cip_drive'
    check (source_type in ('cip_drive', 'google_drive'));

-- Search filters by source, and the sync walks one company's synced files.
create index drive_files_source_idx on drive_files (company_id, source_type);

-- ---------------------------------------------------------------------------
-- The connection itself: one per company.
-- ---------------------------------------------------------------------------
create table google_drive_connections (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,

  -- Google's own identifier for the account that granted access. Useful for
  -- telling somebody which account is connected; not a credential.
  google_account_email text,

  -- The folder to read. Stored as an id, not a URL: a URL is a way of naming a
  -- folder, not proof of access, and it changes shape whenever Google feels
  -- like it. Null until somebody picks one.
  folder_id   text,
  folder_name text,

  -- OAuth tokens, encrypted at rest with AES-256-GCM. The column names say
  -- "encrypted" so nobody writes a plaintext token into them by accident.
  -- These never leave the server: no API response, no log line, no DTO.
  access_token_encrypted  text,
  refresh_token_encrypted text,
  token_expires_at        timestamptz,
  -- What Google actually granted, so a downgraded scope is visible rather than
  -- discovered when a call fails.
  granted_scope text,

  status text not null default 'disconnected'
    check (status in ('connected', 'needs_reauth', 'disconnected')),

  connected_by uuid references users(id),
  connected_at timestamptz,

  last_sync_at         timestamptz,
  last_sync_started_at timestamptz,
  last_sync_error      text,
  -- Lease for the sync worker, exactly as the media queue does it.
  sync_claimed_until   timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- One connection per company. Connecting again replaces the tokens rather
  -- than accumulating a second row nobody looks at.
  unique (company_id),
  unique (id, company_id)
);

create index google_drive_connections_sync_idx
  on google_drive_connections (status, sync_claimed_until)
  where status = 'connected';

-- ---------------------------------------------------------------------------
-- One row per file seen in the connected folder.
--
-- Separate from drive_files because it holds Google's view of the file — its
-- id over there, when Google last changed it, what Google says its checksum is
-- — which is sync bookkeeping, not knowledge. drive_files stays the record of
-- what we hold; this is the record of what they have.
-- ---------------------------------------------------------------------------
create table google_drive_files (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references companies(id) on delete cascade,
  connection_id uuid not null,

  -- Google's file id. Unique per company, so the same document shared into two
  -- companies is two independent records.
  external_id text not null,

  name           text not null,
  external_mime  text not null,
  -- What we exported it as, when Google's own format is not readable. Null for
  -- a binary that needed no conversion.
  exported_mime  text,

  -- Change detection. modifiedTime moves on every edit; md5Checksum is absent
  -- for Google-native formats, which is why both are kept and either can
  -- trigger a reprocess.
  external_modified_time timestamptz,
  external_md5           text,
  external_size          bigint,

  -- The drive_files row this became, once it has been ingested. Null while a
  -- file is known but not yet fetched, or when it is unsupported.
  file_id uuid,

  state text not null default 'pending'
    check (state in ('pending', 'synced', 'unsupported', 'trashed', 'failed')),

  -- Why an unsupported or failed file was not ingested. Shown to the person,
  -- so nothing is silently skipped.
  reason text,

  -- When the sync last saw this file in the folder listing. A file that stops
  -- appearing has been removed on their side.
  last_seen_at timestamptz,
  synced_at    timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (id, company_id),
  unique (company_id, external_id),

  -- Composite keys: a synced file cannot belong to one company while its
  -- connection or its drive_files row belongs to another.
  foreign key (connection_id, company_id)
    references google_drive_connections (id, company_id) on delete cascade,
  foreign key (file_id, company_id)
    references drive_files (id, company_id) on delete set null
);

create index google_drive_files_connection_idx
  on google_drive_files (company_id, connection_id, state);
create index google_drive_files_file_idx
  on google_drive_files (company_id, file_id);

alter table google_drive_connections enable row level security;
alter table google_drive_connections force  row level security;
create policy cip_company_isolation on google_drive_connections
  using (company_id = cip_current_company())
  with check (company_id = cip_current_company());

alter table google_drive_files enable row level security;
alter table google_drive_files force  row level security;
create policy cip_company_isolation on google_drive_files
  using (company_id = cip_current_company())
  with check (company_id = cip_current_company());

grant select, insert, update, delete on google_drive_connections to cip_app;
grant select, insert, update, delete on google_drive_files       to cip_app;
