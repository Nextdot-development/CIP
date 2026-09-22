-- What the checker worked out for itself, and how sure it was.
--
-- A creative arrives with nobody having said which brand it is for, and which
-- rules apply depends entirely on that: 8PM Honey's prohibition on bees is not
-- Royal Ranthambore's approval of tigers. With no brand named, only the
-- thirteen house-wide rules were ever fetched, while the picker offered "Let
-- CIP work it out" for something CIP did not do.
--
-- It does now, and what it decided is kept beside the verdict. A reviewer
-- reading "no problems found" is entitled to know that the check was run as
-- 8PM because a bottle in the corner said so, and how sure of that the Brain
-- was. A verdict against the wrong brand's rules is worse than no verdict, and
-- the only defence against one is being able to see which brand was used.
alter table creative_checks
  add column if not exists detected_product text,
  add column if not exists detected_confidence real,
  add column if not exists detected_evidence text;
