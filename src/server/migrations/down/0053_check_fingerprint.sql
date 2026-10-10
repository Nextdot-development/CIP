-- Undo 0053. Every check is asked of the model again.
drop index if exists creative_checks_fingerprint_idx;
alter table creative_checks drop column if exists fingerprint;
