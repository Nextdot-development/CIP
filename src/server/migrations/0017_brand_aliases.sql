-- ===========================================================================
-- 0017 — the other names a brand goes by
--
-- A brand is rarely written down as its own name. Rampur's bottles arrive
-- called Asava_Bottle.png, DC_Bottle-1.png, Jugalbandi_5_Bottle.png and
-- Barrel_Blush_Set-90.jpg — every one of them a Rampur expression, not one of
-- them containing the word Rampur. Magic Moments' Jamun work is filed under
-- "Jamun". So matching a roster name against a filename or a request finds
-- nothing, and the knowledge lands attributed to nobody.
--
-- On the real library that was 697 facts — roughly half of everything CIP had
-- learnt with no brand on it — sitting in a pool that then outranked smaller
-- brands in their own briefs.
--
-- The fix is to let a brand carry the other names it answers to. They are
-- per-company, because they are facts about that company's products rather
-- than about CIP: nobody else's Asava is a Rampur.
--
-- Empty is the normal case, and a roster with no aliases behaves exactly as it
-- did before.
-- ===========================================================================

alter table company_brands
  add column if not exists aliases text[] not null default '{}';

-- Kept lower-cased and trimmed at the boundary rather than here: the constraint
-- worth enforcing in the database is that the column is a real array, and the
-- matching is done in one place in the application where the rule can be read.
comment on column company_brands.aliases is
  'Other names this brand appears under - product lines, expressions, abbreviations.';
