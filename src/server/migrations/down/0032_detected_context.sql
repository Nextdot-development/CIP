-- Undo 0032. The check keeps its brand; what is lost is the note of whether a
-- person chose it or the Brain read it off the creative.
alter table creative_checks
  drop column if exists detected_product,
  drop column if exists detected_confidence,
  drop column if exists detected_evidence;
