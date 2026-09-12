-- Undo 0022. A day to make nothing for becomes a day like any other, which is
-- how it was before and how it was wrong.
update content_calendar set kind = 'public_holiday' where kind = 'restricted';

alter table content_calendar
  drop constraint if exists content_calendar_kind_check;

alter table content_calendar
  add constraint content_calendar_kind_check
  check (kind in ('public_holiday', 'observance', 'season', 'campaign'));
