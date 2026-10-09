-- 008: send later (DESIGN-SPEC 3.11). Scheduled mail lives on this PC only: the finished message
-- (From, signature, quoted text and attachments frozen) is a file in <data>/scheduled/<id>.eml.
--   status 'scheduled' : waits for send_at
--   status 'sending'   : handed to the Outbox (outbox_id) at sending_since; checked against the Sent
--                        folder by Message-ID after a crash
--   status 'held'      : more than 24 hours late, needs a decision
--   status 'failed'    : could not be handed over (kept so the user can send or delete it)
CREATE TABLE scheduled_send (
  id              INTEGER PRIMARY KEY,
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
  sending_since   INTEGER
);
CREATE INDEX idx_sched_due ON scheduled_send(status, send_at);
