-- Undo 0017. Brands lose the other names they answered to; every fact keeps
-- the brand it already has, because attribution has already happened.
alter table company_brands drop column if exists aliases;
