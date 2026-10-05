-- Undo 0047. Every feed looks back its full window again.
alter table market_feeds
  drop column if exists caught_up;
