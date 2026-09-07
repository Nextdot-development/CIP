-- ===========================================================================
-- 0008 — Media generation
--
-- A record of every image and video this company asked a provider to make,
-- and where the bytes landed.
--
-- The generation row is the unit of work and the unit of provenance: it holds
-- what was asked for, which provider and model answered, what it cost, and how
-- it ended. Assets hang off it because one generation can return more than one
-- file, and because a row that has completed must still be able to say which
-- object belongs to it.
--
-- Isolation is the same shape as every company-owned table since 0003:
-- company_id on the row, a composite foreign key so an asset cannot belong to
-- one company while its generation belongs to another, and RLS with FORCE.
-- ===========================================================================

create table media_generations (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references companies(id) on delete cascade,
  created_by  uuid not null references users(id),

  type        text not null check (type in ('image', 'video')),
  provider    text not null,
  model       text not null,

  -- The prompt is company-confidential. It lives here because the feature
  -- cannot work without it, and it is never written to a log.
  prompt      text not null check (length(prompt) between 1 and 4000),

  status      text not null default 'queued'
                check (status in ('queued', 'processing', 'completed', 'failed', 'cancelled')),

  -- What was asked for and what came back, both provider-neutral. Never a
  -- credential, never a raw provider payload, never a storage path.
  input_metadata  jsonb not null default '{}'::jsonb,
  output_metadata jsonb not null default '{}'::jsonb,

  -- Where the primary asset sits. Duplicated from the asset row so the common
  -- read does not need a join; the assets table stays authoritative.
  storage_bucket   text,
  storage_path     text,

  width            int,
  height           int,
  duration_seconds numeric(6, 2),

  -- Normalised, never the provider's own wording: PROVIDER_NOT_CONFIGURED,
  -- INVALID_REQUEST, RATE_LIMITED, PROVIDER_TIMEOUT, PROVIDER_ERROR,
  -- STORAGE_ERROR, GENERATION_FAILED, CANCELLED.
  error_code    text,
  error_message text,

  -- The provider's handle on an asynchronous job, so a restarted worker can
  -- find work it already paid for instead of starting again.
  provider_job_id text,

  attempts        int not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz,

  -- Usage, for cost tracking. Nullable throughout: a provider that does not
  -- report a number leaves it null rather than having one invented for it.
  provider_request_id text,
  input_units         int,
  output_units        int,
  estimated_cost      numeric(12, 6),
  cost_currency       text,

  -- Supplied by the caller so a retried HTTP request cannot buy the same
  -- image twice. Optional, because most callers will not bother.
  idempotency_key text check (idempotency_key is null or length(idempotency_key) between 8 and 200),

  created_at   timestamptz not null default now(),
  started_at   timestamptz,
  completed_at timestamptz,

  unique (id, company_id),

  -- A finished generation must say where its bytes are, and an unfinished one
  -- must not pretend to. Enforced here rather than in the service so a bug in
  -- one code path cannot leave a row that lies about itself.
  constraint media_generations_completed_has_output
    check (status <> 'completed' or storage_path is not null),
  constraint media_generations_failed_has_reason
    check (status <> 'failed' or error_code is not null)
);

-- Idempotency is per company: two companies may use the same key without
-- colliding, and one company cannot spend twice on the same key.
create unique index media_generations_idempotency_idx
  on media_generations (company_id, idempotency_key)
  where idempotency_key is not null;

-- The history list: newest first, within one company.
create index media_generations_company_idx
  on media_generations (company_id, created_at desc);

-- The worker queue. Partial, because only unfinished rows are ever claimed.
create index media_generations_queue_idx
  on media_generations (status, next_attempt_at)
  where status in ('queued', 'processing');

create table media_generation_assets (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references companies(id) on delete cascade,
  generation_id uuid not null,

  storage_bucket   text not null,
  storage_path     text not null,
  mime_type        text not null,
  file_size        int  not null check (file_size >= 0),
  width            int,
  height           int,
  duration_seconds numeric(6, 2),

  ordinal    int not null check (ordinal >= 0),
  created_at timestamptz not null default now(),

  unique (id, company_id),
  -- Re-running a generation must not stack duplicate assets at the same slot.
  unique (generation_id, ordinal),

  -- The composite key: an asset cannot belong to one company while its
  -- generation belongs to another. Cross-company parentage is unrepresentable.
  foreign key (generation_id, company_id)
    references media_generations (id, company_id) on delete cascade
);

create index media_generation_assets_generation_idx
  on media_generation_assets (company_id, generation_id, ordinal);

alter table media_generations enable row level security;
alter table media_generations force  row level security;
create policy cip_company_isolation on media_generations
  using (company_id = cip_current_company())
  with check (company_id = cip_current_company());

alter table media_generation_assets enable row level security;
alter table media_generation_assets force  row level security;
create policy cip_company_isolation on media_generation_assets
  using (company_id = cip_current_company())
  with check (company_id = cip_current_company());

grant select, insert, update, delete on media_generations       to cip_app;
grant select, insert, update, delete on media_generation_assets to cip_app;
