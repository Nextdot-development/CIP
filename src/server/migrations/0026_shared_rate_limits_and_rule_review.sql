-- ===========================================================================
-- 0026 — rate limits every server shares, and rules a person has checked
--
-- rate_limit_buckets. The limits on paid endpoints - generation, semantic
-- search, asking the Brain - used to count inside one server process. On a
-- host that runs many instances, a person got a bucket per instance and the
-- ceiling meant nothing. One row per bucket here, taken under a row lock, is
-- the same token bucket shared by every instance. It holds no company data:
-- the key names the subject, and nothing else is stored.
--
-- compliance_rules.verified_by / verified_at. Some rules were suggested by CIP
-- rather than taken from a regulation. Until a person has checked one, it can
-- raise a flag but it cannot fail a creative on its own say-so; verifying it
-- is how it earns that weight.
-- ===========================================================================

create table rate_limit_buckets (
  key         text primary key,
  tokens      double precision not null,
  refilled_at timestamptz not null default now()
);

create index rate_limit_buckets_idle_idx on rate_limit_buckets (refilled_at);

grant select, insert, update, delete on rate_limit_buckets to cip_app;

alter table compliance_rules
  add column verified_by uuid references users(id) on delete set null,
  add column verified_at timestamptz;
