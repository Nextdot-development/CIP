-- How a brand's designers lay out a post, learned from their own working
-- files: where the bottle stands and how tall, where the headline sits and
-- how it is set - typeface, size, alignment, capitals, highlight boxes - and
-- where the logo goes. A generated post is built to one of these, so it
-- follows the brand's grid rather than wherever a model put things.

create table if not exists brand_layouts (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references companies(id) on delete cascade,
  -- Null for one that holds for every brand of the company.
  brand       text,
  name        text not null,
  -- The file it was learned from, by name.
  source      text,
  -- Width over height of the post it was learned from.
  ratio       real not null,
  spec        jsonb not null,
  created_at  timestamptz not null default now(),
  unique (company_id, name)
);

create index if not exists brand_layouts_brand_idx on brand_layouts (company_id, brand);

alter table brand_layouts enable row level security;
alter table brand_layouts force  row level security;
create policy cip_company_isolation on brand_layouts
  using (company_id = cip_current_company())
  with check (company_id = cip_current_company());

grant select, insert, update, delete on brand_layouts to cip_app;
