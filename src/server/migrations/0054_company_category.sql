-- What kind of company a workspace is, and where its logo goes.
--
-- CIP was built for a spirits company, and in places it said so in its own
-- words: no "Drink Responsibly" in a generated picture, no post on a dry day,
-- never promise the effects of drinking. A hospital needs the same machinery
-- with its own words - no promised cure, a medical disclaimer set at layout,
-- health days rather than dry days. The category decides which.
--
--   category     alcohol | healthcare | general
--   logo_corner  where the approved logo is placed on a picture CIP makes,
--                or null to place none (a brand whose rule is not known yet)

alter table companies
  add column if not exists category text not null default 'general'
    check (category in ('alcohol', 'healthcare', 'general')),
  add column if not exists logo_corner text
    check (logo_corner in ('top-left', 'top-right', 'bottom-left', 'bottom-right'));

update companies set category = 'alcohol'
 where category = 'general' and industry ~* '(spirit|alcohol|liquor|brew|wine|beer)';
update companies set category = 'healthcare'
 where category = 'general' and industry ~* '(health|hospital|pharma|medical|clinic)';

-- Radico's own rule (RADICO-GLOBAL-002-IMG): the logo sits top-right on an image.
update companies set logo_corner = 'top-right' where slug = 'radico-khaitan' and logo_corner is null;
