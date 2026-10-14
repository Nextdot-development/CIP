-- The opening card of a film: the logo alone on white, as the hospital's
-- published films open. Its own logo, because the opening shows the parent
-- brand while the corner badge may carry a co-brand (Narayana Health | SRCC).
alter table video_templates
  add column if not exists intro_logo_file_id uuid references drive_files(id) on delete set null;
