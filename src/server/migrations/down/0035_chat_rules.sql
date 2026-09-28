-- Undo 0035. Rules already kept stay in compliance_rules; what is lost is the
-- record, on the chat, of which were proposed and what was decided.
alter table chat_messages drop column if exists proposed_rules;
