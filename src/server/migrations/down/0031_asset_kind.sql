-- Undo 0031. Every check goes back to being assumed a creative, which is how
-- a deck's dividers started failing for not being adverts.
alter table creative_checks drop column if exists asset_kind;
