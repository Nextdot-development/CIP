-- ===========================================================================
-- 0013 — reading a file we are not allowed to keep
--
-- India.pdf and nigeria.pdf are 52.84 MB. The object store caps a single
-- object at 50 MB and that cap cannot be raised on this plan, so the bytes
-- cannot be kept. But keeping them was never the point: what CIP needs from a
-- deck of Instagram posts is the posts, and those are a few kilobytes of text
-- and a rendered page per page.
--
-- So a file can now be read without being retained. The row exists, the
-- understanding exists, the posts and facts and their provenance exist — only
-- the original is absent, and the row says so rather than pointing at a
-- storage key that was never written.
--
-- storage_path becomes nullable for exactly that case. Every retained file
-- still has one, and the unique constraint still holds, because Postgres does
-- not consider two nulls equal.
-- ===========================================================================

alter table drive_files alter column storage_path drop not null;

-- Whether the original bytes are in the object store.
--
-- False means CIP read the file and kept what it learned. A download of the
-- original is not possible; re-reading it means fetching it from the source
-- again, which is why this is only ever set for a file that has one.
alter table drive_files add column if not exists bytes_retained boolean not null default true;

-- A retained file must know where its bytes are; one we did not keep must not
-- claim to. Stated as a constraint so the two columns cannot drift apart.
alter table drive_files drop constraint if exists drive_files_retained_has_path;
alter table drive_files add constraint drive_files_retained_has_path
  check ((bytes_retained and storage_path is not null)
      or (not bytes_retained and storage_path is null));

create index if not exists drive_files_unretained_idx
  on drive_files (company_id) where not bytes_retained;
