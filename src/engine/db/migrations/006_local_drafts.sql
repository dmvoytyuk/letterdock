-- 006: drafts show up in the local Drafts folder at once; the server copy follows in the background.
--   message.draft_sync           : upload state of a draft row ('saving' | 'queued' | 'failed'); NULL = on the server
--   draft_state.local_message_pk : the row in the Drafts folder that shows this draft
--   draft_state.server_dirty     : 1 while the server copy is older than the local text
--   draft_state.rev              : counts saves, so a finished upload knows if a newer save came in meanwhile
ALTER TABLE message ADD COLUMN draft_sync TEXT;
ALTER TABLE draft_state ADD COLUMN local_message_pk INTEGER;
ALTER TABLE draft_state ADD COLUMN server_dirty INTEGER NOT NULL DEFAULT 0;
ALTER TABLE draft_state ADD COLUMN rev INTEGER NOT NULL DEFAULT 0;
