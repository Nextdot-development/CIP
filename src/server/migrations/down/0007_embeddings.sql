-- Undo 0007. The extension itself is left installed: other things may come to
-- depend on it, and dropping an extension is not ours to do on the way back.
drop table if exists drive_file_embeddings;

drop index if exists drive_file_chunks_embed_queue_idx;

alter table drive_file_chunks
  drop column if exists embedding_attempts,
  drop column if exists embedding_error,
  drop column if exists next_embedding_attempt_at;

alter role cip_app set search_path = public;

-- The database-level setting goes back too, under the same guard as the one
-- that set it: a role that could not set it cannot reset it either.
do $$
begin
  execute format('alter database %I set search_path = public', current_database());
exception
  when insufficient_privilege then null;
end $$;
