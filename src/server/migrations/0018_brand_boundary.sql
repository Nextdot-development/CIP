-- ===========================================================================
-- 0018 — the brand boundary, everywhere a brief is built from
--
-- Brand DNA facts learned to stay on their own brand in 0016. Nothing else
-- did. Asked to make something for 8PM, CIP still built the brief from:
--
--   · lessons learned from Magic Moments feedback, because a lesson has a
--     task type, a platform, a campaign and a product, and no brand at all;
--   · reference images retrieved by meaning across the whole company, so a
--     request mentioning honey pulled four Whytehall Honey files into an 8PM
--     brief and handed them to the generator;
--   · rated past work from whichever brand happened to be rated.
--
-- Each of those is a different brand's voice arriving in a brief that was
-- supposed to be about one brand, which is exactly what a roster exists to
-- prevent. Radico's own document says it plainly: do not let all the brands
-- collapse into the same vocabulary.
--
-- Two columns close it.
--
-- A file gets a brand because a reference image has to be filterable before it
-- is handed to a generator, and the facts derived from it are not enough —
-- the file itself is what gets attached. It is derived from the filename
-- against the company's roster and its aliases, so it is a suggestion that can
-- be corrected, exactly like the market beside it.
--
-- A lesson gets a brand because feedback is about a particular piece of work,
-- and the brief that produced that work knows which brand it was for.
--
-- Null keeps meaning "belongs to the house". A rule that applies to everything
-- the company makes reaches every brand, and a company with no roster has null
-- everywhere and behaves exactly as it did before.
-- ===========================================================================

alter table drive_files
  add column if not exists brand text;

comment on column drive_files.brand is
  'Which brand this file is about. Null means it is not about one in particular.';

-- Finding one brand's files is the whole point, so it is indexed for it.
create index if not exists drive_files_brand_idx
  on drive_files (company_id, brand)
  where archived_at is null and brand is not null;

alter table brain_lessons
  add column if not exists brand text;

comment on column brain_lessons.brand is
  'The brand whose feedback taught this. Null means it applies to every brand.';

create index if not exists brain_lessons_brand_idx
  on brain_lessons (company_id, brand, status);

-- The brand joins the identity of a lesson, for the same reason it joined the
-- identity of a fact in 0016: "keep the product prominent" is a different
-- lesson about Whytehall than it is about Magic Moments, and one row for both
-- would let one brand's feedback confirm the other's.
--
-- Normalised rather than nullable, because NULL never equals NULL and a
-- unique constraint over nullable columns does not constrain anything.
drop index if exists brain_lessons_identity_idx;

create unique index brain_lessons_identity_idx on brain_lessons (
  company_id,
  polarity,
  statement,
  coalesce(task_type, ''),
  coalesce(platform, ''),
  coalesce(campaign, ''),
  coalesce(product, ''),
  coalesce(brand, '')
);
