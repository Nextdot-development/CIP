-- ===========================================================================
-- 0022 — days to make nothing for
--
-- The calendar could say "Independence Day, India, 15 August" and that is
-- exactly half of what an alcohol brand needs to know about that date. It is
-- one of three days a year when alcohol sales are banned across every state
-- and union territory in India. Republic Day and Gandhi Jayanti are the others.
--
-- A date like that is not an occasion with a creative brief. It is the
-- opposite: a day to publish nothing that shows a drink. Filing it as a public
-- holiday and letting CIP offer to make a post for it would be worse than not
-- having the date at all, because it would look like advice.
--
-- So restrictions are their own kind. Everything downstream can then treat
-- them as a warning rather than a prompt.
-- ===========================================================================

alter table content_calendar
  drop constraint if exists content_calendar_kind_check;

alter table content_calendar
  add constraint content_calendar_kind_check
  check (kind in ('public_holiday', 'observance', 'season', 'campaign', 'restricted'));

comment on column content_calendar.kind is
  'restricted = a day to publish nothing for. The others are occasions to make something for.';
