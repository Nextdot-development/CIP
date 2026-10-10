-- What CIP spends on AI, one row a call.
--
-- Only understanding a file and reading a PDF page kept their token counts;
-- a check, a chat answer, a brief and a picture left no trace, so nobody could
-- say where the money went. Every call to a model is now recorded here, with
-- what it cost at the published price.

create table if not exists ai_usage (
  id                uuid primary key default gen_random_uuid(),
  -- What it was for: the name the call goes by (creative_check, asset_analysis,
  -- image_generation, ...).
  feature           text not null,
  model             text not null,
  input_tokens      integer not null default 0,
  -- Input the provider had already seen and charged a tenth for.
  cached_tokens     integer not null default 0,
  output_tokens     integer not null default 0,
  -- Of the output, how much went on reasoning rather than the answer.
  reasoning_tokens  integer not null default 0,
  cost_usd          numeric(12, 6) not null default 0,
  created_at        timestamptz not null default now()
);

create index if not exists ai_usage_created_idx on ai_usage (created_at desc);
revoke all on ai_usage from public;
