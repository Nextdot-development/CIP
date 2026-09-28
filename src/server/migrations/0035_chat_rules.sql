-- Rules somebody states in a chat, held on the answer until they decide.
--
-- "The black Magic Moments logo is approved too" is a brand rule, said in
-- passing to the Brain. It was answered and then forgotten, and the checker
-- went on flagging the black logo. Now the Brain proposes it back, beside the
-- answer, in the person's own words - and it becomes a rule only when that
-- person keeps it. What was proposed and what was decided are kept on the
-- message, so the conversation shows where each rule came from.
--
-- Each entry: brand, market, kind, statement, allowed, prohibited, quote,
-- status ('proposed' | 'added' | 'dismissed') and, once added, the rule's id.
alter table chat_messages
  add column if not exists proposed_rules jsonb not null default '[]'::jsonb;
