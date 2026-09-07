-- Undo 0008. Assets go first: they carry the composite foreign key back to
-- generations, so dropping the parent first would fail.
--
-- This leaves stored objects behind on purpose. Bytes are not this file's to
-- delete, and a migration that reached into object storage would be a
-- migration that could not be run twice. `npm run storage:gc` finds orphans.
drop table if exists media_generation_assets;
drop table if exists media_generations;
