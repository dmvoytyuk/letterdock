-- 013: seven light features (DESIGN-SPEC 3.13): snooze, pin, mute, unsubscribe memory.
-- Only nullable / default-0 columns: SQLite adds them without rewriting the table. The two partial
-- indexes hold rows only while a message is snoozed or pinned, so they cost nothing otherwise.
ALTER TABLE message ADD COLUMN pinned_at INTEGER;
ALTER TABLE message ADD COLUMN muted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE message ADD COLUMN snoozed_until INTEGER;
ALTER TABLE message ADD COLUMN snooze_returned_at INTEGER;
CREATE INDEX idx_msg_snoozed ON message(account_id, snoozed_until) WHERE snoozed_until IS NOT NULL;
CREATE INDEX idx_msg_pinned ON message(folder_id, pinned_at) WHERE pinned_at IS NOT NULL;
CREATE INDEX idx_msg_returned ON message(account_id, snooze_returned_at) WHERE snooze_returned_at IS NOT NULL;

-- Muted conversations. thread_key is message.thread_id.
CREATE TABLE muted_threads (
  account_id   TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  thread_key   TEXT NOT NULL,
  muted_at     INTEGER NOT NULL,
  last_hit_at  INTEGER NOT NULL,
  PRIMARY KEY (account_id, thread_key)
) WITHOUT ROWID;

-- Lists the user unsubscribed from (the last 2000 are kept). list_key = List-Id, else sender address.
CREATE TABLE unsubscribed (
  account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  list_key   TEXT NOT NULL,
  sender     TEXT NOT NULL,
  list_name  TEXT,
  method     TEXT NOT NULL CHECK (method IN ('one-click','mailto','page')),
  at         INTEGER NOT NULL,
  PRIMARY KEY (account_id, list_key)
) WITHOUT ROWID;
CREATE INDEX idx_unsubscribed_at ON unsubscribed(at);

-- Unsubscribe headers of an opened message, read once when its body is downloaded.
ALTER TABLE body ADD COLUMN list_headers TEXT;
