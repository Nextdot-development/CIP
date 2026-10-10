-- The same creative checked the same way is not paid for twice.
--
-- A check's fingerprint is everything its answer depends on: the file's
-- bytes, the page, the brand and market, every rule and fact it was judged
-- against, the model, and the deployed code. A check with the same
-- fingerprint gives the same answer, so a batch run again, or the accuracy
-- test set, reuses it instead of asking the model.

alter table creative_checks add column if not exists fingerprint text;

create index if not exists creative_checks_fingerprint_idx
  on creative_checks (company_id, fingerprint)
  where fingerprint is not null and status = 'ready';
