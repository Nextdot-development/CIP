-- Undo 0016. Facts lose the brand they were about and merge back together;
-- where two brands held the same claim, one row survives.
drop index if exists brand_dna_facts_identity_idx;
delete from brand_dna_facts a
 using brand_dna_facts b
 where a.company_id = b.company_id and a.section = b.section
   and a.attribute = b.attribute and a.value = b.value and a.id > b.id;
alter table brand_dna_facts drop column if exists brand;
alter table brand_dna_facts add constraint brand_dna_facts_company_id_section_attribute_value_key
  unique (company_id, section, attribute, value);
drop table if exists company_brands;
