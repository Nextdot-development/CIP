-- ===========================================================================
-- 0025 — market intelligence, and asking the Brain a question
--
-- Two Phase 2 modules from the guidebook.
--
-- Market intelligence is read, not observed. A market report says "Officer's
-- Choice held 12.5% of North India in FY24"; nothing about that accumulates
-- from packshots the way a brand's look does. So a report is registered as a
-- source, the Brain reads it, and what it finds is kept as signals - each one
-- carrying the exact words of the report it came from. A signal without its
-- quote cannot be checked, and a number nobody can check is the thing a market
-- intelligence screen must never show.
--
-- market_sources is the queue and the record: which files are market data,
-- how far reading them got, and what went wrong if it did not.
--
-- market_signals are the findings. A person can remove one; a removed signal
-- stays removed when the report is read again, because that was a decision
-- about what CIP believes and it outlives the reading that produced it.
--
-- chat_threads and chat_messages are conversations with the Brain. A thread
-- belongs to the person who had it - colleagues share a company, not each
-- other's questions. An answer keeps the sources it cited, so what it relied on
-- can be read back later exactly as it was shown.
-- ===========================================================================

create table market_sources (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  file_id    uuid not null,

  status text not null default 'pending'
    check (status in ('pending', 'reading', 'ready', 'failed', 'no_text')),
  attempts int not null default 0,
  signals  int not null default 0,

  -- What the report is about, in a sentence, and why reading it failed.
  summary       text,
  error_message text,

  claimed_at timestamptz,
  read_at    timestamptz,
  provider   text,
  model      text,

  added_by   uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (id, company_id),
  -- A file is market data once, however many ways it arrived.
  unique (company_id, file_id),
  foreign key (file_id, company_id) references drive_files (id, company_id) on delete cascade
);

create index market_sources_queue_idx
  on market_sources (status, created_at) where status in ('pending', 'reading');

create table market_signals (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  source_id  uuid not null,
  file_id    uuid not null,

  kind text not null
    check (kind in ('share', 'growth', 'price', 'distribution', 'consumer',
                    'competitor_move', 'regulation', 'trend', 'other')),

  -- Who it is about: one of the house's own brands, a competitor, or the
  -- category as a whole. Whether a name is the house's is decided against the
  -- roster, not taken from the model.
  subject      text not null,
  subject_type text not null check (subject_type in ('own_brand', 'competitor', 'category')),

  market   text,
  category text,
  metric   text,
  value    numeric,
  unit     text,
  period   text,

  statement text not null,
  -- The report's own words. Checked against the text before it is stored.
  excerpt   text not null,

  status text not null default 'active' check (status in ('active', 'rejected')),
  rejected_by uuid references users(id) on delete set null,
  rejected_at timestamptz,

  created_at timestamptz not null default now(),

  unique (id, company_id),
  foreign key (source_id, company_id) references market_sources (id, company_id) on delete cascade,
  foreign key (file_id, company_id) references drive_files (id, company_id) on delete cascade
);

-- The same finding from the same report once, so reading it twice adds nothing.
create unique index market_signals_identity_idx
  on market_signals (company_id, file_id, statement);

create index market_signals_lookup_idx
  on market_signals (company_id, status, market, kind);

create table chat_threads (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  user_id    uuid not null references users(id) on delete cascade,

  -- The brand the conversation is about, when it is about one.
  brand text,
  title text not null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (id, company_id)
);

create index chat_threads_user_idx on chat_threads (company_id, user_id, updated_at desc);

create table chat_messages (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  thread_id  uuid not null,

  role    text not null check (role in ('user', 'assistant')),
  content text not null,

  -- The sources an answer cited, as they were shown.
  sources    jsonb  not null default '[]'::jsonb,
  follow_ups text[] not null default '{}',
  -- Null for a question; for an answer, whether it cited anything at all.
  grounded boolean,

  provider text,
  model    text,

  created_at timestamptz not null default now(),

  unique (id, company_id),
  foreign key (thread_id, company_id) references chat_threads (id, company_id) on delete cascade
);

create index chat_messages_thread_idx on chat_messages (company_id, thread_id, created_at);

alter table market_sources enable row level security;
alter table market_sources force  row level security;
create policy cip_company_isolation on market_sources
  using (company_id = cip_current_company()) with check (company_id = cip_current_company());

alter table market_signals enable row level security;
alter table market_signals force  row level security;
create policy cip_company_isolation on market_signals
  using (company_id = cip_current_company()) with check (company_id = cip_current_company());

alter table chat_threads enable row level security;
alter table chat_threads force  row level security;
create policy cip_company_isolation on chat_threads
  using (company_id = cip_current_company()) with check (company_id = cip_current_company());

alter table chat_messages enable row level security;
alter table chat_messages force  row level security;
create policy cip_company_isolation on chat_messages
  using (company_id = cip_current_company()) with check (company_id = cip_current_company());

grant select, insert, update, delete on market_sources to cip_app;
grant select, insert, update, delete on market_signals to cip_app;
grant select, insert, update, delete on chat_threads   to cip_app;
grant select, insert, update, delete on chat_messages  to cip_app;
