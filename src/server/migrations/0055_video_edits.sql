-- Raw talking-head footage into a finished film in the house template.
--
-- The CIS briefing's Video Pipeline: a doctor records, CIP cuts the fumbles,
-- writes the title card and the on-screen key points, finds b-roll in the
-- company's own library, checks every point against the rules, and - once a
-- person has looked at the plan - renders the film between the house intro,
-- disclaimer and end screen.
--
--   video_templates  one per company: the fixed frames around every film
--   video_edits      one per film: its transcript, the plan, and the result

create table if not exists video_templates (
  company_id      uuid primary key references companies(id) on delete cascade,
  logo_file_id    uuid references drive_files(id) on delete set null,
  -- Colours as #rrggbb.
  background      text not null default '#0b2a4a',
  accent          text not null default '#e8a33d',
  ink             text not null default '#ffffff',
  intro_seconds   numeric(4, 1) not null default 2.5,
  outro_seconds   numeric(4, 1) not null default 3,
  end_screen_text text,
  -- Supplied by the company, never written by CIP.
  disclaimer_text text,
  disclaimer_seconds numeric(4, 1) not null default 4,
  updated_at      timestamptz not null default now()
);

create table if not exists video_edits (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references companies(id) on delete cascade,
  source_file_id   uuid not null references drive_files(id) on delete cascade,
  doctor_name      text not null,
  doctor_title     text,
  status           text not null default 'planning'
                     check (status in ('planning', 'planned', 'approved', 'rendering', 'ready', 'failed')),
  -- Every word with when it was said, as Whisper heard it.
  transcript       jsonb,
  -- What to cut, the title, the key points and the b-roll. A person may edit it.
  plan             jsonb,
  duration_seconds numeric(8, 2),
  output_path      text,
  error_message    text,
  attempts         integer not null default 0,
  created_by       uuid references users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (id, company_id)
);

create index if not exists video_edits_company_idx on video_edits (company_id, created_at desc);
create index if not exists video_edits_queue_idx on video_edits (status, updated_at) where status = 'approved';

alter table video_templates enable row level security;
alter table video_templates force  row level security;
create policy cip_company_isolation on video_templates
  using (company_id = cip_current_company())
  with check (company_id = cip_current_company());

alter table video_edits enable row level security;
alter table video_edits force  row level security;
create policy cip_company_isolation on video_edits
  using (company_id = cip_current_company())
  with check (company_id = cip_current_company());

grant select, insert, update, delete on video_templates to cip_app;
grant select, insert, update, delete on video_edits     to cip_app;
