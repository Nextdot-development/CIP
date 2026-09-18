-- Undo 0029. The table holds nothing but a note of what the map was drawn
-- from; without it every company's relations are simply rebuilt once.
drop table if exists brand_relation_state;
