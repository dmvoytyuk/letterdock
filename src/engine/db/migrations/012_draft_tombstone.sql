-- 012: a draft that was sent, scheduled or discarded may still have a copy in the server Drafts
--   folder (an upload was running, or the server could not be reached). The copy is deleted by
--   Message-ID as soon as it can be, even after a restart, and a copy that shows up in a sync later
--   is dropped too. The row is removed when the server confirms. A new save of a draft with the same
--   Message-ID (a cancelled schedule) removes the row too.
CREATE TABLE draft_tombstone (
  account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, message_id)
);
