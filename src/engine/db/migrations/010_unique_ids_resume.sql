-- 010: ids that are never reused, "Same time" and a mid-retry send that survives a restart.
--   outbox.id / scheduled_send.id : AUTOINCREMENT. With a plain INTEGER PRIMARY KEY, SQLite hands out
--     max(id)+1, so cancelling the newest row made the next message reuse its id (the UI keys toasts
--     and rows by that id). sqlite_sequence keeps the highest id ever used.
--   draft_state.paused_send_at    : the time a scheduled message had before "Edit" turned it back into
--     a draft (shown as "Same time" in the compose window).
--   scheduled_send.resume_attempts / resume_error : how often the Outbox already tried to send this
--     message, and why it failed, when the app stopped. The Outbox row is made again after a restart
--     (it may have gone out already: the Sent folder is checked first); these two keep its history.
CREATE TABLE outbox_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  raw_path TEXT NOT NULL,
  created_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT, state TEXT NOT NULL DEFAULT 'queued',
  subject TEXT NOT NULL DEFAULT '',
  send_after INTEGER NOT NULL DEFAULT 0,
  meta_json TEXT
);
INSERT INTO outbox_new (id, account_id, raw_path, created_at, attempts, last_error, state, subject, send_after, meta_json)
  SELECT id, account_id, raw_path, created_at, attempts, last_error, state, subject, send_after, meta_json FROM outbox;
DROP TABLE outbox;
ALTER TABLE outbox_new RENAME TO outbox;

CREATE TABLE scheduled_send_new (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id      TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  draft_id        TEXT NOT NULL,
  subject         TEXT NOT NULL DEFAULT '',
  to_json         TEXT NOT NULL DEFAULT '[]',
  cc_json         TEXT NOT NULL DEFAULT '[]',
  snippet         TEXT NOT NULL DEFAULT '',
  has_attachments INTEGER NOT NULL DEFAULT 0,
  send_at         INTEGER NOT NULL,
  created_at      INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','sending','held','failed')),
  last_error      TEXT,
  attempt         INTEGER NOT NULL DEFAULT 0,
  raw_path        TEXT NOT NULL DEFAULT '',
  meta_json       TEXT NOT NULL,
  message_id      TEXT NOT NULL,
  outbox_id       INTEGER,
  sending_since   INTEGER,
  resume_attempts INTEGER NOT NULL DEFAULT 0,
  resume_error    TEXT
);
INSERT INTO scheduled_send_new (id, account_id, draft_id, subject, to_json, cc_json, snippet, has_attachments,
    send_at, created_at, status, last_error, attempt, raw_path, meta_json, message_id, outbox_id, sending_since)
  SELECT id, account_id, draft_id, subject, to_json, cc_json, snippet, has_attachments,
    send_at, created_at, status, last_error, attempt, raw_path, meta_json, message_id, outbox_id, sending_since
  FROM scheduled_send;
DROP TABLE scheduled_send;
ALTER TABLE scheduled_send_new RENAME TO scheduled_send;
CREATE INDEX idx_sched_due ON scheduled_send(status, send_at);

ALTER TABLE draft_state ADD COLUMN paused_send_at INTEGER;
