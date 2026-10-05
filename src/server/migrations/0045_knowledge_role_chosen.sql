-- Whether a person chose what a file is for.
--
-- CIP now recognises a book when it reads one and files it as reference. A
-- person can always say otherwise, and once they have, nothing CIP works out
-- for itself - a book it thinks it sees, a market folder the file sits in -
-- changes it back.
alter table drive_files
  add column if not exists knowledge_role_chosen boolean not null default false;
