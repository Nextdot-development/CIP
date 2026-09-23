-- Pictures, findable by what is in them.
--
-- Creative Search could not find a single one. Its "search by meaning" runs on
-- drive_file_chunks, and a chunk belongs to an extraction — the text pulled out
-- of a document. A photograph has no text to pull out, so no extraction, so no
-- chunk, so no vector. Measured on this database: 13,976 chunks across 58 PDFs
-- and 15 markdown files, and none at all across 431 images.
--
-- CIP knows perfectly well what is in those pictures. It looked at 422 of them
-- and wrote down what it saw — the summary, any text on the creative, the
-- products, the styling, the mood. That reading was reachable by opening the
-- file and by nothing else.
--
-- One vector per asset, not per chunk. A reading is a paragraph, and cutting a
-- paragraph into pieces to search it would lose the thing that makes it
-- findable: a creative is one idea, and "the golden Diwali banner with the
-- bottle on the right" is a description of the whole of it.
create table asset_embeddings (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references companies(id) on delete cascade,
  file_id     uuid not null,
  -- Which reading this came from, so a re-read replaces the vector rather than
  -- leaving the old description searchable for ever.
  understanding_id uuid not null,

  -- What was embedded, kept so a hit can show why it matched without another
  -- round trip, and so a wrong result can be traced to the words behind it.
  content     text not null,

  model       text not null,
  dimensions  int  not null check (dimensions > 0),
  embedding   extensions.vector(1536) not null,
  input_chars int  not null check (input_chars >= 0),

  created_at  timestamptz not null default now(),

  unique (id, company_id),
  -- One vector per asset per model. A second model accumulates alongside the
  -- first rather than colliding with it, which is what makes changing model a
  -- backfill rather than a migration.
  unique (company_id, file_id, model),
  foreign key (file_id, company_id) references drive_files (id, company_id) on delete cascade
);

-- The same index the chunk vectors use, for the same reason: cosine distance,
-- and an approximate index because an exact scan of every asset is a table scan.
create index asset_embeddings_vector_idx
  on asset_embeddings using hnsw (embedding extensions.vector_cosine_ops);

create index asset_embeddings_file_idx on asset_embeddings (company_id, file_id);

alter table asset_embeddings enable row level security;
alter table asset_embeddings force  row level security;
create policy cip_company_isolation on asset_embeddings
  using (company_id = current_setting('cip.company_id', true)::uuid)
  with check (company_id = current_setting('cip.company_id', true)::uuid);

grant select, insert, update, delete on asset_embeddings to cip_app;
