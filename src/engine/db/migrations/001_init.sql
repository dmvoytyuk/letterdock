-- 001_init.sql  (ARCHITECTURE.md section 4)
CREATE TABLE account (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  color         TEXT,
  provider      TEXT NOT NULL,
  auth_type     TEXT NOT NULL CHECK (auth_type IN ('password','oauth2')),
  oauth_provider TEXT,
  imap_host     TEXT NOT NULL, imap_port INTEGER NOT NULL,
  imap_security TEXT NOT NULL CHECK (imap_security IN ('ssl','starttls')),
  smtp_host     TEXT NOT NULL, smtp_port INTEGER NOT NULL,
  smtp_security TEXT NOT NULL CHECK (smtp_security IN ('ssl','starttls')),
  username      TEXT NOT NULL,
  sync_days     INTEGER NOT NULL DEFAULT 90,
  signature     TEXT,
  enabled       INTEGER NOT NULL DEFAULT 1,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);
-- NO secrets here. Secrets live in secrets.bin keyed by account.id.

CREATE TABLE folder (
  id            INTEGER PRIMARY KEY,
  account_id    TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  path          TEXT NOT NULL,
  delimiter     TEXT,
  name          TEXT NOT NULL,
  role          TEXT,
  subscribed    INTEGER NOT NULL DEFAULT 1,
  selectable    INTEGER NOT NULL DEFAULT 1,
  uidvalidity   INTEGER,
  uidnext       INTEGER,
  highestmodseq TEXT,
  last_sync_at  INTEGER,
  total_count   INTEGER NOT NULL DEFAULT 0,
  unread_count  INTEGER NOT NULL DEFAULT 0,
  server_exists INTEGER,                          -- EXISTS at last sync; catches bare expunges
  oldest_synced_uid INTEGER,
  history_complete  INTEGER NOT NULL DEFAULT 0,   -- 1 once load-older reached UID 1
  UNIQUE(account_id, path)
);

CREATE TABLE message (
  id            INTEGER PRIMARY KEY,
  account_id    TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  folder_id     INTEGER NOT NULL REFERENCES folder(id) ON DELETE CASCADE,
  uid           INTEGER NOT NULL,
  message_id    TEXT,
  in_reply_to   TEXT,
  references_h  TEXT,
  thread_key    TEXT,
  subject       TEXT NOT NULL DEFAULT '',
  from_name     TEXT, from_addr TEXT,
  to_json       TEXT NOT NULL DEFAULT '[]',
  cc_json       TEXT NOT NULL DEFAULT '[]',
  bcc_json      TEXT NOT NULL DEFAULT '[]',
  reply_to_json TEXT NOT NULL DEFAULT '[]',
  date_ms       INTEGER NOT NULL,
  internal_ms   INTEGER NOT NULL,
  size          INTEGER,
  snippet       TEXT NOT NULL DEFAULT '',
  flag_seen     INTEGER NOT NULL DEFAULT 0,
  flag_flagged  INTEGER NOT NULL DEFAULT 0,
  flag_answered INTEGER NOT NULL DEFAULT 0,
  flag_draft    INTEGER NOT NULL DEFAULT 0,
  flag_deleted  INTEGER NOT NULL DEFAULT 0,
  keywords_json TEXT NOT NULL DEFAULT '[]',
  modseq        TEXT,
  has_attachments INTEGER NOT NULL DEFAULT 0,
  body_state    TEXT NOT NULL DEFAULT 'none' CHECK (body_state IN ('none','cached')),
  UNIQUE(folder_id, uid)
);
CREATE INDEX idx_msg_folder_date  ON message(folder_id, date_ms DESC, id DESC);
CREATE INDEX idx_msg_date         ON message(date_ms DESC, id DESC);
CREATE INDEX idx_msg_account_date ON message(account_id, date_ms DESC);
CREATE INDEX idx_msg_unread       ON message(flag_seen, date_ms DESC);
CREATE INDEX idx_msg_msgid        ON message(message_id);
CREATE INDEX idx_msg_thread       ON message(thread_key);

CREATE TABLE body (
  message_pk    INTEGER PRIMARY KEY REFERENCES message(id) ON DELETE CASCADE,
  text_plain    TEXT,
  html          TEXT,
  fetched_at    INTEGER NOT NULL,
  size_bytes    INTEGER NOT NULL
);

CREATE TABLE attachment (
  id            INTEGER PRIMARY KEY,
  message_pk    INTEGER NOT NULL REFERENCES message(id) ON DELETE CASCADE,
  part_id       TEXT NOT NULL,                -- index into mailparser's attachments array
  filename      TEXT, content_type TEXT, size INTEGER,
  content_id    TEXT, inline INTEGER NOT NULL DEFAULT 0,
  cached_path   TEXT
);
CREATE INDEX idx_att_msg ON attachment(message_pk);

-- Deviation from section 4: a regular (non-contentless) FTS5 table. Simpler to maintain
-- (the doc lists this as the accepted fallback). rowid == message.id.
CREATE VIRTUAL TABLE message_fts USING fts5(
  subject, from_text, to_text, snippet, body_text,
  tokenize='unicode61 remove_diacritics 2', prefix='2 3 4'
);

CREATE TABLE pending_op (
  id INTEGER PRIMARY KEY, account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT
);

CREATE TABLE outbox (
  id INTEGER PRIMARY KEY, account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  raw_path TEXT NOT NULL,
  created_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT, state TEXT NOT NULL DEFAULT 'queued'
);

CREATE TABLE image_allow (
  address TEXT PRIMARY KEY
);

CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT);
