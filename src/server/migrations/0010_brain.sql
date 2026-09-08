-- ===========================================================================
-- 0010 — CIP Brain
--
-- What a company's own assets mean, what that adds up to as a brand, and what
-- the system has learned from the generations it has produced.
--
-- Three ideas, kept apart on purpose:
--
--   asset_understanding   what one asset is, from looking at it
--   brand_dna_facts       what many assets add up to, with evidence
--   brain_lessons         what feedback taught us, scoped to a context
--
-- Nothing here is a single JSON blob of "intelligence". Structured columns
-- carry what is queried, ranked or filtered; jsonb carries only the parts whose
-- shape genuinely varies by asset kind.
--
-- Every learned claim keeps its provenance. A fact knows which assets produced
-- it, how many, and how confident it is, so "prefers dark backgrounds" can
-- always be traced back to the images it came from rather than just asserted.
--
-- Isolation is the same shape as every company-owned table since 0003:
-- company_id on the row, composite foreign keys so a child cannot belong to one
-- company while its parent belongs to another, and RLS with FORCE.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- What one asset is.
-- ---------------------------------------------------------------------------
create table asset_understanding (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  file_id    uuid not null,

  kind text not null check (kind in ('image', 'video', 'document')),

  provider text not null,
  model    text not null,

  -- One sentence a person could read. Also what gets embedded.
  summary text not null default '',
  -- The parts whose shape depends on the asset kind: palettes and composition
  -- for an image, shots and pacing for a video. Read often, queried rarely.
  structured jsonb not null default '{}'::jsonb,
  -- Text found inside the asset: words on a poster, a caption burned into a
  -- frame. Separate because it is searched directly.
  extracted_text text,

  -- Vector of the summary, in the same space as Phase 4's chunk vectors, so
  -- retrieval reuses the existing embedder rather than inventing a second one.
  -- Added below, because it only exists where pgvector does.
  embed_model text,

  -- The bytes this understanding was derived from. An asset whose content has
  -- not changed is never analysed again, however many times it is synced.
  content_hash text not null,

  status text not null default 'pending'
    check (status in ('pending', 'processing', 'ready', 'failed', 'unsupported')),
  attempts        int not null default 0 check (attempts >= 0),
  error_code      text,
  error_message   text,
  next_attempt_at timestamptz,

  -- Observability: safe metadata only, never content.
  duration_ms   int,
  input_tokens  int,
  output_tokens int,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (id, company_id),
  -- One understanding per asset per content hash. Re-analysing changed bytes
  -- adds a row; re-syncing unchanged bytes does nothing at all.
  unique (file_id, content_hash),

  foreign key (file_id, company_id) references drive_files (id, company_id) on delete cascade
);

create index asset_understanding_company_idx on asset_understanding (company_id, kind, status);
create index asset_understanding_file_idx    on asset_understanding (company_id, file_id);

-- The work queue: unfinished rows whose backoff has elapsed.
create index asset_understanding_queue_idx
  on asset_understanding (status, next_attempt_at)
  where status in ('pending', 'processing');

-- Similarity search needs pgvector, which not every environment has: the
-- embedded PostgreSQL the offline tests run against does not ship it. The
-- Brain works without it — assets are still understood, Brand DNA is still
-- derived, lessons are still learned — and only "find me something similar"
-- is unavailable, which retrieval checks for rather than assuming.
do $$
begin
  if exists (select 1 from pg_type where typname = 'vector') then
    execute 'alter table asset_understanding add column embedding extensions.vector(1536)';
    execute 'create index asset_understanding_hnsw on asset_understanding '
         || 'using hnsw (embedding extensions.vector_cosine_ops) with (m = 16, ef_construction = 64)';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- What many assets add up to.
--
-- A fact is a single claim about the brand: one colour, one rule, one habit.
-- Rows rather than a document, so confidence and evidence live per claim and
-- one asset can never quietly become a company-wide rule.
-- ---------------------------------------------------------------------------
create table brand_dna_facts (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,

  section text not null check (section in ('visual', 'video', 'content', 'rules')),
  -- Machine-readable slot: dominant_colour, shot_type, tone, and so on.
  attribute text not null,
  -- The claim itself: #1B1B1B, close-up, warm and unhurried.
  value text not null,

  -- How this came to be known. The difference between "37 assets show this"
  -- and "a model thought so" matters, and collapsing them would be dishonest.
  kind text not null check (kind in ('observed', 'derived', 'preference', 'inference', 'hypothesis')),

  confidence     numeric(4, 3) not null check (confidence >= 0 and confidence <= 1),
  evidence_count int not null default 0 check (evidence_count >= 0),

  status text not null default 'active' check (status in ('active', 'superseded', 'rejected')),

  first_seen_at timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  unique (id, company_id),
  -- One row per claim. Seeing it again raises the evidence count rather than
  -- adding a duplicate.
  unique (company_id, section, attribute, value)
);

create index brand_dna_facts_lookup_idx
  on brand_dna_facts (company_id, section, status, confidence desc);

-- Which assets, generations or feedback produced a fact. This is what makes
-- "why does the Brain believe this?" answerable.
create table brand_dna_evidence (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  fact_id    uuid not null,

  -- Whichever of these applies, depending on where the evidence came from.
  file_id       uuid,
  generation_id uuid,
  feedback_id   uuid,

  note       text,
  created_at timestamptz not null default now(),

  unique (id, company_id),
  foreign key (fact_id, company_id) references brand_dna_facts (id, company_id) on delete cascade,
  foreign key (file_id, company_id) references drive_files (id, company_id) on delete cascade
);

create index brand_dna_evidence_fact_idx on brand_dna_evidence (company_id, fact_id);

-- ---------------------------------------------------------------------------
-- What the Brain decided for one generation, kept so the decision is auditable.
-- ---------------------------------------------------------------------------
create table generation_briefs (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references companies(id) on delete cascade,
  generation_id uuid,

  requested_by uuid references users(id),
  -- What the person actually typed. Company-confidential; never logged.
  request_text text not null,

  task_type text not null,
  platform  text,
  campaign  text,
  product   text,

  -- The brief handed to the generator, and the prompt built from it.
  brief             jsonb not null default '{}'::jsonb,
  generation_prompt text,

  -- What the brief was built from, so a decision traces back to its sources.
  reference_file_ids uuid[] not null default '{}',
  memory_ids         uuid[] not null default '{}',
  lesson_ids         uuid[] not null default '{}',

  confidence numeric(4, 3) not null default 0 check (confidence >= 0 and confidence <= 1),
  -- Set when the Brain could not safely proceed and asked instead.
  clarification_question text,

  created_at timestamptz not null default now(),

  unique (id, company_id),
  foreign key (generation_id, company_id)
    references media_generations (id, company_id) on delete cascade
);

create index generation_briefs_company_idx    on generation_briefs (company_id, created_at desc);
create index generation_briefs_generation_idx on generation_briefs (company_id, generation_id);

-- ---------------------------------------------------------------------------
-- What the person thought of the result.
-- ---------------------------------------------------------------------------
create table generation_feedback (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references companies(id) on delete cascade,
  generation_id uuid not null,
  given_by      uuid references users(id),

  score   int not null check (score between 0 and 10),
  comment text,

  -- Whether the learning pipeline has already looked at this. Set once, so a
  -- replayed worker cannot count the same feedback towards a lesson twice.
  analysed_at timestamptz,

  created_at timestamptz not null default now(),

  unique (id, company_id),
  -- One score per person per generation. Changing your mind updates the row.
  unique (generation_id, given_by),

  foreign key (generation_id, company_id)
    references media_generations (id, company_id) on delete cascade
);

create index generation_feedback_company_idx  on generation_feedback (company_id, created_at desc);
create index generation_feedback_pending_idx  on generation_feedback (analysed_at)
  where analysed_at is null;

-- ---------------------------------------------------------------------------
-- What feedback taught us, scoped, so a campaign-specific preference never
-- becomes a company-wide rule.
-- ---------------------------------------------------------------------------
create table brain_lessons (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,

  -- The context this applies to. Null means "any". A lesson learned about
  -- Instagram images for one campaign must not be applied to every video.
  task_type text,
  platform  text,
  campaign  text,
  product   text,

  polarity  text not null check (polarity in ('prefer', 'avoid')),
  statement text not null,

  status text not null default 'candidate'
    check (status in ('candidate', 'confirmed', 'rejected', 'superseded')),

  evidence_count int not null default 1 check (evidence_count >= 0),
  confidence     numeric(4, 3) not null default 0 check (confidence >= 0 and confidence <= 1),

  embed_model text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (id, company_id)
);

-- The same instruction in the same context is one lesson gathering evidence,
-- not many lessons saying the same thing. A unique constraint cannot express
-- this because the scope columns are nullable and NULL never equals NULL, so
-- the uniqueness is over a normalised form of the scope instead.
create unique index brain_lessons_identity_idx on brain_lessons (
  company_id,
  polarity,
  statement,
  coalesce(task_type, ''),
  coalesce(platform, ''),
  coalesce(campaign, ''),
  coalesce(product, '')
);

create index brain_lessons_lookup_idx
  on brain_lessons (company_id, status, task_type, confidence desc);

do $$
begin
  if exists (select 1 from pg_type where typname = 'vector') then
    execute 'alter table brain_lessons add column embedding extensions.vector(1536)';
    execute 'create index brain_lessons_hnsw on brain_lessons '
         || 'using hnsw (embedding extensions.vector_cosine_ops) with (m = 16, ef_construction = 64)';
  end if;
end $$;

-- Which feedback supports a lesson. Evidence count is derived from these
-- rather than incremented blindly.
create table brain_lesson_evidence (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references companies(id) on delete cascade,
  lesson_id   uuid not null,
  feedback_id uuid not null,

  created_at timestamptz not null default now(),

  unique (id, company_id),
  unique (lesson_id, feedback_id),

  foreign key (lesson_id, company_id)   references brain_lessons (id, company_id) on delete cascade,
  foreign key (feedback_id, company_id) references generation_feedback (id, company_id) on delete cascade
);

create index brain_lesson_evidence_lesson_idx on brain_lesson_evidence (company_id, lesson_id);

-- ---------------------------------------------------------------------------
-- Row-level security, forced, on every table above.
-- ---------------------------------------------------------------------------
alter table asset_understanding enable row level security;
alter table asset_understanding force  row level security;
create policy cip_company_isolation on asset_understanding
  using (company_id = cip_current_company()) with check (company_id = cip_current_company());

alter table brand_dna_facts enable row level security;
alter table brand_dna_facts force  row level security;
create policy cip_company_isolation on brand_dna_facts
  using (company_id = cip_current_company()) with check (company_id = cip_current_company());

alter table brand_dna_evidence enable row level security;
alter table brand_dna_evidence force  row level security;
create policy cip_company_isolation on brand_dna_evidence
  using (company_id = cip_current_company()) with check (company_id = cip_current_company());

alter table generation_briefs enable row level security;
alter table generation_briefs force  row level security;
create policy cip_company_isolation on generation_briefs
  using (company_id = cip_current_company()) with check (company_id = cip_current_company());

alter table generation_feedback enable row level security;
alter table generation_feedback force  row level security;
create policy cip_company_isolation on generation_feedback
  using (company_id = cip_current_company()) with check (company_id = cip_current_company());

alter table brain_lessons enable row level security;
alter table brain_lessons force  row level security;
create policy cip_company_isolation on brain_lessons
  using (company_id = cip_current_company()) with check (company_id = cip_current_company());

alter table brain_lesson_evidence enable row level security;
alter table brain_lesson_evidence force  row level security;
create policy cip_company_isolation on brain_lesson_evidence
  using (company_id = cip_current_company()) with check (company_id = cip_current_company());

grant select, insert, update, delete on asset_understanding   to cip_app;
grant select, insert, update, delete on brand_dna_facts       to cip_app;
grant select, insert, update, delete on brand_dna_evidence    to cip_app;
grant select, insert, update, delete on generation_briefs     to cip_app;
grant select, insert, update, delete on generation_feedback   to cip_app;
grant select, insert, update, delete on brain_lessons         to cip_app;
grant select, insert, update, delete on brain_lesson_evidence to cip_app;
