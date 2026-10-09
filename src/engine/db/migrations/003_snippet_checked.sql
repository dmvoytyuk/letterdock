-- 003: remember rows whose list snippet was already tried by the background backfill, so a message
-- without any text part (or one that failed for good) is not asked for again and again.
ALTER TABLE message ADD COLUMN snippet_checked INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_msg_snippet_todo ON message(folder_id, date_ms DESC) WHERE snippet = '' AND snippet_checked = 0 AND body_state = 'none';
