-- How a Drive connection reads: as a person who signed in, or as CIP's own
-- service account that a folder has been shared with.
--
-- A person's sign-in, through an OAuth app still in Google's testing mode,
-- expires every seven days and only works for the handful of accounts listed
-- as testers - which is how a company's sync stopped for a fortnight while the
-- one person who could reconnect it was on leave. A service account needs
-- neither: somebody shares the folder with its address, as they would with a
-- colleague, and it reads that folder until the share is taken away.
alter table google_drive_connections
  add column if not exists auth_kind text not null default 'oauth'
    check (auth_kind in ('oauth', 'service_account'));
