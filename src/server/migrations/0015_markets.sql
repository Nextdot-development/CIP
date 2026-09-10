-- ===========================================================================
-- 0015 — which market a file belongs to
--
-- Magic Moments' knowledge arrived as three country decks: India.pdf,
-- europe.pdf, nigeria.pdf. They are not three copies of one brand — the
-- palettes differ, the compositions differ, the calls to action differ. Asked
-- for "a Diwali post", CIP was drawing on all three at once and producing an
-- average of three markets, which is a thing no market wants.
--
-- The country is not on the pages. Every one of the 275 posts read back with
-- country null, correctly: nothing printed on a grid of thumbnails says which
-- country it is for. What does say so is the file it came from, and that is
-- knowledge the person who uploaded it has and the page does not.
--
-- So the market lives on the file. It is suggested from the filename where
-- that is unambiguous and shown in the UI where it can be corrected — a guess
-- made visible, rather than an inference made silently. Null means nobody has
-- said, which is honest and common: a logo belongs to no market.
--
-- Facts are not labelled. A fact's markets are worked out from the files that
-- evidenced it, the same way its confidence is worked out from how many there
-- were. That keeps one truth in one place: relabel a file and every fact it
-- supports moves with it.
-- ===========================================================================

alter table drive_files add column if not exists market text;

-- Only ever read alongside the company, and usually to list what markets exist.
create index if not exists drive_files_market_idx
  on drive_files (company_id, market) where archived_at is null and market is not null;
