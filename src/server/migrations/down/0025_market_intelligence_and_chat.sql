-- Undo 0025. Every conversation, every market signal and the record of which
-- files were market data go. The files themselves stay in the Drive.
drop table if exists chat_messages;
drop table if exists chat_threads;
drop table if exists market_signals;
drop table if exists market_sources;
