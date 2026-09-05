-- ===========================================================================
-- 0004 — Company Drive
--
-- Folders and files, owned by exactly one company each.
--
-- Isolation here does not rest on the policy alone. Both tables carry a
-- UNIQUE (id, company_id), and parents are referenced through a COMPOSITE
-- foreign key on (parent_id, company_id). That makes "a folder in company A
-- holding a file from company B" unrepresentable: the referential constraint
-- refuses it before any policy is consulted.
--
-- Nothing here processes a file. The processing_* columns exist so the future
-- Brand Brain ingestion pipeline has somewhere to record its progress.
-- ===========================================================================

create table drive_folders (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid        not null references companies(id) on delete cascade,
  parent_id   uuid,
  name        text        not null check (length(btrim(name)) between 1 and 200),
  created_by  uuid        references users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  archived_at timestamptz,

  -- the target the composite foreign key below points at
  unique (id, company_id),

  -- a parent must belong to the same company. Null parent_id means the root,
  -- and a partly-null composite key is not enforced, which is what we want.
  foreign key (parent_id, company_id)
    references drive_folders (id, company_id) on delete cascade
);

create table drive_files (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid        not null references companies(id) on delete cascade,
  folder_id     uuid,

  name          text        not null check (length(btrim(name)) between 1 and 255),
  -- what the person's file was called before we sanitised it
  original_name text        not null,
  extension     text        not null,
  mime_type     text        not null,
  size_bytes    bigint      not null check (size_bytes >= 0),
  checksum_sha256 text,

  -- where the bytes live. Always begins companies/<company_id>/ so a
  -- mis-scoped read is wrong in the object store too, not only in the table.
  storage_key   text        not null unique,

  created_by    uuid        references users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  archived_at   timestamptz,

  -- Reserved for the Brand Brain. Nothing writes anything but 'pending' yet.
  processing_status   text not null default 'pending'
    check (processing_status in ('pending', 'processing', 'processed', 'failed')),
  processing_attempts int  not null default 0,
  processing_error    text,
  processed_at        timestamptz,

  -- room for extracted page counts, dimensions, durations and the like
  metadata      jsonb       not null default '{}'::jsonb,

  unique (id, company_id),

  foreign key (folder_id, company_id)
    references drive_folders (id, company_id) on delete cascade
);

-- A folder cannot end up inside itself. The composite key already keeps the
-- walk inside one company, so this only has to catch loops.
create or replace function cip_drive_folder_no_cycle() returns trigger
  language plpgsql
as $$
declare
  ancestor uuid := new.parent_id;
  hops     int  := 0;
begin
  while ancestor is not null loop
    if ancestor = new.id then
      raise exception 'A folder cannot be placed inside itself';
    end if;
    hops := hops + 1;
    if hops > 64 then
      raise exception 'Folders are nested too deeply';
    end if;
    select parent_id into ancestor from drive_folders where id = ancestor;
  end loop;
  return new;
end;
$$;

create trigger drive_folders_no_cycle
  before insert or update of parent_id on drive_folders
  for each row execute function cip_drive_folder_no_cycle();

-- Two live things in the same folder cannot share a name. Archived rows are
-- excluded so deleting and re-uploading the same file works.
create unique index drive_folders_unique_name
  on drive_folders (company_id, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(btrim(name)))
  where archived_at is null;

create unique index drive_files_unique_name
  on drive_files (company_id, coalesce(folder_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(btrim(name)))
  where archived_at is null;

create index drive_folders_company_idx on drive_folders (company_id, parent_id) where archived_at is null;
create index drive_files_company_idx   on drive_files (company_id, folder_id)   where archived_at is null;
create index drive_files_name_idx      on drive_files (company_id, lower(name));
-- the queue the ingestion pipeline will read
create index drive_files_processing_idx on drive_files (company_id, processing_status) where archived_at is null;

-- Same two-layer treatment as every other company-owned table.
alter table drive_folders enable row level security;
alter table drive_folders force row level security;
create policy cip_company_isolation on drive_folders
  using (company_id = cip_current_company())
  with check (company_id = cip_current_company());

alter table drive_files enable row level security;
alter table drive_files force row level security;
create policy cip_company_isolation on drive_files
  using (company_id = cip_current_company())
  with check (company_id = cip_current_company());

grant select, insert, update, delete on drive_folders, drive_files to cip_app;
grant execute on function cip_drive_folder_no_cycle() to cip_app;
