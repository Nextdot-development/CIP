-- A short weekly note on what the watched companies filed.
--
-- Filings were fetched and read, and sat as a list of PDFs. Once a week CIP
-- now writes what they said - who launched what, whose results moved - in a
-- handful of plain lines a marketing team will actually read.

create table if not exists market_digests (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references companies(id) on delete cascade,
  period_start timestamptz not null,
  period_end   timestamptz not null,
  headline     text not null,
  -- [{ company, point, fileId }]
  points       jsonb not null default '[]',
  filings      integer not null,
  created_at   timestamptz not null default now()
);

create index if not exists market_digests_company_idx on market_digests (company_id, created_at desc);

alter table market_digests enable row level security;
alter table market_digests force  row level security;
create policy cip_company_isolation on market_digests
  using (company_id = cip_current_company())
  with check (company_id = cip_current_company());

grant select, insert, update, delete on market_digests to cip_app;
