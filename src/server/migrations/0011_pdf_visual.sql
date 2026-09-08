-- ===========================================================================
-- 0011 — reading a PDF by looking at it
--
-- The text extractor reads a PDF's text layer. A screenshot has none: an
-- Instagram page exported to PDF is a picture of a post, so everything
-- downstream saw an empty document and a company's most brand-defining assets
-- contributed nothing to its Brand DNA.
--
-- Two tables, and no third copy of anything that already exists:
--
--   pdf_page_understanding   what one rendered page shows
--   pdf_post                 one post found on a page
--
-- The file-level verdict still lives in asset_understanding, which gains a
-- 'pdf_visual' kind, so retrieval, the planner and the Brain UI keep working
-- through the same rows they already read. Facts still land in
-- brand_dna_facts with brand_dna_evidence behind them — that table gains the
-- page number and the kind of source, because "which page of which PDF" is
-- exactly the provenance a visual claim needs and a file id alone cannot say.
--
-- Isolation is unchanged in shape: company_id on the row, composite foreign
-- keys so a page cannot belong to one company while its file belongs to
-- another, and RLS with FORCE.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- A PDF understood visually is a distinct kind of understanding, and worth
-- distinguishing: it costs a vision call per page, and it is the only kind
-- whose claims carry a page number.
-- ---------------------------------------------------------------------------
alter table asset_understanding drop constraint if exists asset_understanding_kind_check;
alter table asset_understanding add constraint asset_understanding_kind_check
  check (kind in ('image', 'video', 'document', 'pdf_visual'));

-- ---------------------------------------------------------------------------
-- Where a fact was seen, not merely which file it came from.
--
-- source_type separates a claim read from a text layer from one seen in a
-- rendered page, so a reader can tell an assertion the document made from an
-- observation about how it looks.
-- ---------------------------------------------------------------------------
alter table brand_dna_evidence add column if not exists page_number int;
alter table brand_dna_evidence add column if not exists source_type text;

-- ---------------------------------------------------------------------------
-- What one rendered page shows.
-- ---------------------------------------------------------------------------
create table pdf_page_understanding (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  file_id    uuid not null,
  -- The file-level row this page belongs to, so deleting one understanding
  -- takes its pages with it rather than leaving them orphaned.
  understanding_id uuid not null,

  page_number int not null check (page_number >= 1),

  -- The rendered page, in the same private bucket as every other asset. Null
  -- until it is rendered, and for a page deliberately not rendered.
  image_path   text,
  image_width  int,
  image_height int,
  image_bytes  bigint,

  -- What the deterministic pass found before any model was involved.
  has_text_layer boolean not null default false,
  page_text      text,

  status text not null default 'pending'
    check (status in ('pending', 'ready', 'skipped', 'failed')),

  provider text,
  model    text,

  summary    text  not null default '',
  structured jsonb not null default '{}'::jsonb,

  posts_detected int not null default 0,

  error_code    text,
  error_message text,

  duration_ms   int,
  input_tokens  int,
  output_tokens int,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (id, company_id),
  -- Re-running a document must land on the same rows rather than duplicating
  -- them. This is what makes reprocessing idempotent.
  unique (company_id, file_id, page_number),

  foreign key (file_id, company_id)
    references drive_files (id, company_id) on delete cascade,
  foreign key (understanding_id, company_id)
    references asset_understanding (id, company_id) on delete cascade
);

create index pdf_page_understanding_file_idx
  on pdf_page_understanding (company_id, file_id, page_number);
create index pdf_page_understanding_status_idx
  on pdf_page_understanding (company_id, status);

-- ---------------------------------------------------------------------------
-- One post found on a page.
--
-- A page can hold several posts, and collapsing them into one blob per page
-- would lose the thing that makes these files worth reading: each post is a
-- separate creative decision, with its own caption, format and call to action.
--
-- Structured columns carry what is queried or filtered — the country the post
-- belongs to above all, because these files arrive one per country and their
-- facts must not silently merge. Everything whose shape varies by post
-- (hashtags, palette, typography, composition) stays in jsonb.
-- ---------------------------------------------------------------------------
create table pdf_post (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  file_id    uuid not null,
  page_id    uuid not null,

  page_number int not null check (page_number >= 1),
  -- Position on the page, top-left first. Stable enough to reprocess onto.
  post_index  int not null check (post_index >= 0),

  -- Read from the page when it is shown there, never inferred from the
  -- filename: a caption in Hindi does not make a post Indian.
  country text,
  account text,
  posted_on text,

  caption      text,
  headline     text,
  visible_text text,

  -- One readable sentence. This is what gets embedded, so a later request can
  -- retrieve the post by what it was about.
  summary text not null default '',

  structured jsonb not null default '{}'::jsonb,

  -- How sure the model was that this is a distinct post, said plainly rather
  -- than assumed. Low-confidence segmentation is still recorded; it is simply
  -- weaker evidence.
  confidence numeric(3, 2) not null default 0
    check (confidence >= 0 and confidence <= 1),

  embed_model text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (id, company_id),
  unique (company_id, file_id, page_number, post_index),

  foreign key (file_id, company_id)
    references drive_files (id, company_id) on delete cascade,
  foreign key (page_id, company_id)
    references pdf_page_understanding (id, company_id) on delete cascade
);

create index pdf_post_file_idx    on pdf_post (company_id, file_id, page_number, post_index);
create index pdf_post_country_idx on pdf_post (company_id, country);

-- Vector columns only where pgvector is installed, exactly as in 0010. Without
-- it a post is still stored, still readable and still evidence; only "find me
-- a post like this one" is unavailable.
do $$
begin
  if exists (select 1 from pg_type where typname = 'vector') then
    execute 'alter table pdf_post add column embedding extensions.vector(1536)';
    execute 'create index pdf_post_embedding_idx on pdf_post
               using hnsw (embedding extensions.vector_cosine_ops)';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Row-level security, forced.
-- ---------------------------------------------------------------------------
alter table pdf_page_understanding enable row level security;
alter table pdf_page_understanding force  row level security;
create policy cip_company_isolation on pdf_page_understanding
  using (company_id = cip_current_company()) with check (company_id = cip_current_company());

alter table pdf_post enable row level security;
alter table pdf_post force  row level security;
create policy cip_company_isolation on pdf_post
  using (company_id = cip_current_company()) with check (company_id = cip_current_company());

grant select, insert, update, delete on pdf_page_understanding to cip_app;
grant select, insert, update, delete on pdf_post              to cip_app;
