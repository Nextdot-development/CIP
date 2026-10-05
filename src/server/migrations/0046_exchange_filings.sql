-- Reports filed on the stock exchange, fetched as they are published.
--
-- Market Intelligence read only what somebody uploaded, so a quarter's results
-- reached it whenever somebody remembered to download them. A listed company
-- has to file its results, earnings call transcripts and investor
-- presentations with the exchange, where they are public. CIP now watches a
-- company's filings on NSE and fetches the ones worth reading.
--
--   market_feeds        which listed companies a company is watching
--   market_feed_items   every filing seen, fetched or skipped, so none is
--                       fetched twice and the screen can say what came in

alter table drive_files
  drop constraint if exists drive_files_source_type_check;
alter table drive_files
  add constraint drive_files_source_type_check
  check (source_type in ('cip_drive', 'google_drive', 'website', 'microsoft_teams', 'exchange_filing'));

create table if not exists market_feeds (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references companies(id) on delete cascade,
  exchange        text not null default 'nse' check (exchange in ('nse')),
  symbol          text not null,
  display_name    text not null,
  enabled         boolean not null default true,
  added_by        uuid references users(id) on delete set null,
  last_checked_at timestamptz,
  last_error      text,
  created_at      timestamptz not null default now(),
  unique (company_id, exchange, symbol)
);

create table if not exists market_feed_items (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references companies(id) on delete cascade,
  feed_id      uuid not null references market_feeds(id) on delete cascade,
  external_id  text not null,
  title        text not null,
  category     text,
  published_at timestamptz,
  url          text,
  file_id      uuid references drive_files(id) on delete set null,
  status       text not null check (status in ('fetched', 'skipped')),
  created_at   timestamptz not null default now(),
  unique (feed_id, external_id)
);

create index if not exists market_feed_items_feed_idx
  on market_feed_items (company_id, feed_id, published_at desc);

alter table market_feeds enable row level security;
alter table market_feeds force  row level security;
create policy cip_company_isolation on market_feeds
  using (company_id = cip_current_company())
  with check (company_id = cip_current_company());

alter table market_feed_items enable row level security;
alter table market_feed_items force  row level security;
create policy cip_company_isolation on market_feed_items
  using (company_id = cip_current_company())
  with check (company_id = cip_current_company());

grant select, insert, update, delete on market_feeds      to cip_app;
grant select, insert, update, delete on market_feed_items to cip_app;
