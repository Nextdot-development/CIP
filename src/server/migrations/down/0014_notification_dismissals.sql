-- Undo 0014. Every notice becomes undismissed, which is the state before it.
drop table if exists notification_dismissals;
