-- Undo 0010. Children first: each carries a composite foreign key to its
-- parent, so dropping the parent first would fail.
--
-- This destroys learned memory, which is the point of a rollback — but it is
-- worth saying plainly that it cannot be recovered by re-running the migration.
-- The assets it was derived from survive; the understanding does not.
drop table if exists brain_lesson_evidence;
drop table if exists brain_lessons;
drop table if exists generation_feedback;
drop table if exists generation_briefs;
drop table if exists brand_dna_evidence;
drop table if exists brand_dna_facts;
drop table if exists asset_understanding;
