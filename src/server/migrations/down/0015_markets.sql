-- Undo 0015. Every file goes back to belonging to no market in particular.
drop index if exists drive_files_market_idx;
alter table drive_files drop column if exists market;
