-- The accuracy test set: creatives whose right answer a person has said.
--
-- "Is the checker any good?" had no answer but a feeling. A reviewer now marks
-- a checked creative as one that should pass or should be flagged, and the
-- whole set can be checked again at any time - after a rule changes, after a
-- prompt changes - and scored against what the person said.
--
--   qc_benchmarks         one creative (one page of it) and its right answer
--   qc_benchmark_runs     one checking of the whole set
--   qc_benchmark_results  what each creative got in a run, and whether it
--                         matched

create table if not exists qc_benchmarks (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references companies(id) on delete cascade,
  file_id           uuid not null references drive_files(id) on delete cascade,
  page              integer not null default 1 check (page >= 1),
  brand             text,
  market            text,
  expected          text not null check (expected in ('pass', 'flag')),
  -- For a creative that should be flagged: the rules it breaks, as the person
  -- confirmed them. A run that flags it for something else is not right.
  expected_rule_ids uuid[] not null default '{}',
  note              text,
  added_by          uuid references users(id) on delete set null,
  created_at        timestamptz not null default now(),
  unique (company_id, file_id, page)
);

create table if not exists qc_benchmark_runs (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references companies(id) on delete cascade,
  started_by  uuid references users(id) on delete set null,
  total       integer not null,
  created_at  timestamptz not null default now()
);

create table if not exists qc_benchmark_results (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references companies(id) on delete cascade,
  run_id           uuid not null references qc_benchmark_runs(id) on delete cascade,
  benchmark_id     uuid not null references qc_benchmarks(id) on delete cascade,
  expected         text not null check (expected in ('pass', 'flag')),
  got              text not null check (got in ('pass', 'flag', 'error')),
  correct          boolean not null,
  check_id         uuid references creative_checks(id) on delete set null,
  -- Rules the person said it breaks that this run did not flag.
  missed_rule_ids  uuid[] not null default '{}',
  -- What this run flagged that the person did not: the false alarms.
  extra_flags      text[] not null default '{}',
  error_message    text,
  created_at       timestamptz not null default now(),
  unique (run_id, benchmark_id)
);

create index if not exists qc_benchmark_results_run_idx on qc_benchmark_results (company_id, run_id);

alter table qc_benchmarks enable row level security;
alter table qc_benchmarks force  row level security;
create policy cip_company_isolation on qc_benchmarks
  using (company_id = cip_current_company())
  with check (company_id = cip_current_company());

alter table qc_benchmark_runs enable row level security;
alter table qc_benchmark_runs force  row level security;
create policy cip_company_isolation on qc_benchmark_runs
  using (company_id = cip_current_company())
  with check (company_id = cip_current_company());

alter table qc_benchmark_results enable row level security;
alter table qc_benchmark_results force  row level security;
create policy cip_company_isolation on qc_benchmark_results
  using (company_id = cip_current_company())
  with check (company_id = cip_current_company());

grant select, insert, update, delete on qc_benchmarks        to cip_app;
grant select, insert, update, delete on qc_benchmark_runs    to cip_app;
grant select, insert, update, delete on qc_benchmark_results to cip_app;
