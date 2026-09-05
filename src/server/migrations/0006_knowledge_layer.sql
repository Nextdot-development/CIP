-- ===========================================================================
-- 0006 — Knowledge Layer: extractions and chunks
--
-- Deterministic text extraction only. Nothing here embeds, classifies or
-- interprets anything; it turns a stored file into text, and that text into
-- ordered chunks with exact offsets back into the source.
--
-- Isolation follows Phase 2 exactly: company_id on every row, a composite
-- foreign key so a chunk cannot belong to one company and its extraction to
-- another, and row-level security with FORCE.
-- ===========================================================================

-- Queue bookkeeping the worker needs.
alter table drive_files
  -- when the current attempt was claimed, so a crashed worker's rows can be
  -- reclaimed rather than sitting in 'processing' for ever
  add column processing_started_at timestamptz,
  -- backoff: the worker ignores rows until this time
  add column next_attempt_at       timestamptz;

-- The queue index. Partial, because processed files are the overwhelming
-- majority once things settle and there is no reason to keep them in it.
create index drive_files_queue_idx
  on drive_files (processing_status, next_attempt_at)
  where archived_at is null and processing_status in ('pending', 'processing');

create table drive_file_extractions (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references companies(id) on delete cascade,
  file_id           uuid not null,

  -- 'text' is all Phase 3 produces. OCR, transcripts and captions land here
  -- later without a schema change.
  kind              text not null default 'text'
    check (kind in ('text', 'ocr', 'transcript', 'caption')),

  content           text not null,
  content_chars     int  not null,
  -- no language detection in Phase 3; the column is here so adding it later
  -- is not a migration
  language          text,

  extractor         text not null,
  extractor_version text not null,
  -- the file's checksum when this ran, so "has the file changed since?" is
  -- answerable without re-reading the bytes
  source_checksum   text,
  page_count        int,
  warnings          text[] not null default '{}',

  created_at        timestamptz not null default now(),

  unique (id, company_id),
  -- re-running the same extractor version on the same file is a no-op
  unique (file_id, kind, extractor_version),

  foreign key (file_id, company_id)
    references drive_files (id, company_id) on delete cascade
);

create table drive_file_chunks (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references companies(id) on delete cascade,
  file_id         uuid not null,
  extraction_id   uuid not null,

  ordinal         int  not null check (ordinal >= 0),
  content         text not null,
  -- exact offsets into the extraction content, so a chunk can always be traced
  -- back to the text it came from
  char_start      int  not null check (char_start >= 0),
  char_end        int  not null check (char_end >= char_start),
  -- chars / 4. Deliberately not a model tokeniser: that answer belongs to
  -- whichever embedding model is chosen later.
  token_estimate  int  not null,
  heading         text,
  page_from       int,
  page_to         int,
  -- bump to re-chunk from a stored extraction without re-parsing the file
  chunker_version text not null,

  created_at      timestamptz not null default now(),

  unique (id, company_id),
  unique (extraction_id, ordinal),

  foreign key (extraction_id, company_id)
    references drive_file_extractions (id, company_id) on delete cascade,
  foreign key (file_id, company_id)
    references drive_files (id, company_id) on delete cascade
);

create index drive_file_extractions_file_idx on drive_file_extractions (company_id, file_id);
create index drive_file_chunks_file_idx      on drive_file_chunks (company_id, file_id, ordinal);
create index drive_file_chunks_extraction_idx on drive_file_chunks (extraction_id, ordinal);

alter table drive_file_extractions enable row level security;
alter table drive_file_extractions force  row level security;
create policy cip_company_isolation on drive_file_extractions
  using (company_id = cip_current_company())
  with check (company_id = cip_current_company());

alter table drive_file_chunks enable row level security;
alter table drive_file_chunks force  row level security;
create policy cip_company_isolation on drive_file_chunks
  using (company_id = cip_current_company())
  with check (company_id = cip_current_company());

grant select, insert, update, delete on drive_file_extractions, drive_file_chunks to cip_app;
