-- ===========================================================================
-- 0029 — knowing when the brand map is already right
--
-- Relations are derived: every trait and every pair is deleted and written
-- again from the facts. The worker does this after every pass for every
-- company, and on real data it is the slowest stage it runs - to arrive, most
-- of the time, at exactly the rows already there.
--
-- One row per company says what the map was last drawn from. Timestamps alone
-- could not answer it: a fact that is deleted moves no timestamp, and the map
-- would keep a relation whose evidence is gone. So the fingerprint counts as
-- well as dates, and a deletion changes the count.
--
-- Derived state, and safe to lose: an empty table means every company's map is
-- rebuilt once, which is what happens today.
-- ===========================================================================

create table brand_relation_state (
  company_id  uuid primary key references companies(id) on delete cascade,
  fingerprint text not null,
  computed_at timestamptz not null default now()
);

alter table brand_relation_state enable row level security;
alter table brand_relation_state force  row level security;
create policy cip_company_isolation on brand_relation_state
  using (company_id = cip_current_company()) with check (company_id = cip_current_company());

grant select, insert, update, delete on brand_relation_state to cip_app;
