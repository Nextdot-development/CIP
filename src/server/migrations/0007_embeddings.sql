-- ===========================================================================
-- 0007 — Embeddings
--
-- One vector per chunk per model, so semantic search can find a passage by
-- meaning rather than by the words it happens to contain.
--
-- Nothing here generates or interprets anything. The vectors are produced by
-- the worker and compared by the database; no model reads them back.
--
-- Isolation is the same shape as every company-owned table since 0003:
-- company_id on the row, a composite foreign key so a vector cannot belong to
-- one company while its chunk belongs to another, and RLS with FORCE.
-- ===========================================================================

-- Supabase keeps extensions out of `public`. The type, the operators and the
-- index operator classes all live in that schema.
--
-- The schema already exists on a Supabase-provisioned database, so creating it
-- is a no-op there. A database made by hand — a test database, a local server —
-- gets it here rather than needing somebody to remember a manual step.
create schema if not exists extensions;

create extension if not exists vector with schema extensions;

grant usage on schema extensions to cip_app;

-- So `vector`, `<=>` and `vector_cosine_ops` resolve without qualification in
-- application queries. Without this every similarity query would have to spell
-- out OPERATOR(extensions.<=>), which is unreadable and easy to get wrong.
alter role cip_app set search_path = public, extensions;

create table drive_file_embeddings (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references companies(id) on delete cascade,
  chunk_id    uuid not null,
  -- denormalised so search can filter by file without joining back to chunks
  file_id     uuid not null,

  model       text not null,
  dimensions  int  not null check (dimensions > 0),
  embedding   extensions.vector(1536) not null,
  input_chars int  not null check (input_chars >= 0),

  created_at  timestamptz not null default now(),

  unique (id, company_id),
  -- one vector per chunk per model: a second model accumulates alongside the
  -- first rather than colliding with it, which is what makes changing model a
  -- backfill-and-flip instead of a delete-and-rebuild with a search outage
  unique (chunk_id, model),

  foreign key (chunk_id, company_id)
    references drive_file_chunks (id, company_id) on delete cascade,
  foreign key (file_id, company_id)
    references drive_files (id, company_id) on delete cascade
);

-- Retry bookkeeping belongs on the chunk: there is no embedding row until the
-- call succeeds, so failure state has nowhere else to live.
alter table drive_file_chunks
  add column embedding_attempts         int not null default 0,
  add column embedding_error            text,
  add column next_embedding_attempt_at  timestamptz;

-- The queue is an anti-join (chunks with no vector for the active model), so
-- this index serves the retry predicate rather than the join itself.
create index drive_file_chunks_embed_queue_idx
  on drive_file_chunks (embedding_attempts, next_embedding_attempt_at);

create index drive_file_embeddings_chunk_idx on drive_file_embeddings (chunk_id, model);
create index drive_file_embeddings_file_idx  on drive_file_embeddings (company_id, file_id);

-- Cosine, because it is what the model was trained for. The vectors arrive
-- normalised so inner product would rank identically, but cosine stays correct
-- the day something stores an unnormalised vector.
create index drive_file_embeddings_hnsw
  on drive_file_embeddings
  using hnsw (embedding extensions.vector_cosine_ops)
  with (m = 16, ef_construction = 64);

alter table drive_file_embeddings enable row level security;
alter table drive_file_embeddings force  row level security;
create policy cip_company_isolation on drive_file_embeddings
  using (company_id = cip_current_company())
  with check (company_id = cip_current_company());

grant select, insert, update, delete on drive_file_embeddings to cip_app;
