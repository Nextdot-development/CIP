-- Undo 0024. Every check, every flag and every compliance rule goes. Facts a
-- reviewer rejected through a dispute stay rejected: that was a person's
-- decision about what CIP believes, and it outlives the screen they made it on.
drop table if exists check_flags;
drop table if exists creative_checks;
drop table if exists compliance_rules;
