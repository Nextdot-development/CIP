-- ===========================================================================
-- 0027 — reading scanned documents
--
-- A scanned report is a PDF of pictures of pages. Text extraction reads its
-- text layer, finds none, and stores an empty extraction - so the words on
-- those pages could not be searched, asked about, or quoted by a market signal.
--
-- file_ocr is the queue and the record for reading such a file by looking at
-- it: each page is rendered and transcribed word for word by the vision model,
-- and the result is stored as an ordinary extraction of kind 'ocr', chunked and
-- embedded like any document's text. This table only says which files need
-- that, how far it got, and why it stopped if it did.
-- ===========================================================================

create table file_ocr (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  file_id    uuid not null,

  status text not null default 'pending'
    check (status in ('pending', 'reading', 'ready', 'failed', 'skipped')),

  -- Pages in the document, and pages actually transcribed.
  pages      int,
  pages_read int not null default 0,
  attempts   int not null default 0,

  error_message text,
  claimed_at    timestamptz,
  provider      text,
  model         text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (id, company_id),
  unique (company_id, file_id),
  foreign key (file_id, company_id) references drive_files (id, company_id) on delete cascade
);

create index file_ocr_queue_idx on file_ocr (status, created_at) where status in ('pending', 'reading');

alter table file_ocr enable row level security;
alter table file_ocr force  row level security;
create policy cip_company_isolation on file_ocr
  using (company_id = cip_current_company()) with check (company_id = cip_current_company());

grant select, insert, update, delete on file_ocr to cip_app;
