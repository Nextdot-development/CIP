-- Undo 0030. Every rule loaded from the QC document goes with it: without a
-- rule_code there is nothing to load them by, and without a severity they would
-- all come back as hard requirements, which is how "tiger imagery is approved"
-- would start failing creatives.
delete from compliance_rules where rule_code is not null;

drop index if exists compliance_rules_code_idx;
drop index if exists compliance_rules_product_idx;

alter table compliance_rules
  drop column if exists rule_code,
  drop column if exists rule_type,
  drop column if exists severity,
  drop column if exists domain,
  drop column if exists product,
  drop column if exists rationale,
  drop column if exists allowed,
  drop column if exists prohibited,
  drop column if exists human_review;
