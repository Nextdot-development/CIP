-- Whether a feed has fetched everything in its first window.
--
-- A feed fetches a few filings a look, and the first look reaches back four
-- months. Narrowing to the last fortnight after that first look left the rest
-- of those four months unfetched for good: Radico's July results were behind
-- three newer filings and never came. A feed now looks back the full window
-- until a look finds nothing left waiting.
alter table market_feeds
  add column if not exists caught_up boolean not null default false;
