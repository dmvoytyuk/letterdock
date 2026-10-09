-- 005: local contacts index for recipient autocomplete. One row per (account, address); learned from
-- synced headers (From / To / Cc / Reply-To) and from sent mail. The search index lives in memory
-- (built from this table at start); this table is the durable copy.
CREATE TABLE contact (
  account_id    TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  address       TEXT NOT NULL,                 -- lower case
  name          TEXT,                          -- latest display name seen
  name_ms       INTEGER NOT NULL DEFAULT 0,    -- when that name was seen
  sent_count    INTEGER NOT NULL DEFAULT 0,    -- messages the user sent to this address
  recv_count    INTEGER NOT NULL DEFAULT 0,    -- messages received from / with this address
  last_sent_ms  INTEGER NOT NULL DEFAULT 0,
  last_seen_ms  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, address)
) WITHOUT ROWID;
CREATE INDEX idx_contact_address ON contact(address);

-- Addresses the user removed from the suggestions. They are never learned again from mail
-- (only an explicit send to the address brings it back).
CREATE TABLE contact_forgotten (
  address      TEXT PRIMARY KEY,
  forgotten_at INTEGER NOT NULL
);

-- Message-IDs of mail we sent ourselves and already counted, so the copy that later shows up in the
-- Sent folder is not counted twice.
CREATE TABLE contact_sent_mid (
  account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, message_id)
) WITHOUT ROWID;
