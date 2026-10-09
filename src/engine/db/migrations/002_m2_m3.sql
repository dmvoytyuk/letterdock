-- 002: account badge, outbox details for undo-send / retry, local draft state, picked files.
ALTER TABLE account ADD COLUMN badge TEXT;

ALTER TABLE outbox ADD COLUMN subject TEXT NOT NULL DEFAULT '';
ALTER TABLE outbox ADD COLUMN send_after INTEGER NOT NULL DEFAULT 0;   -- epoch ms: not before this
ALTER TABLE outbox ADD COLUMN meta_json TEXT;                          -- SendReq + reply info (restore on undo)

-- One row per compose session that was saved or sent. Keeps reply headers and the server draft.
CREATE TABLE draft_state (
  draft_id         TEXT PRIMARY KEY,
  account_id       TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  mode             TEXT NOT NULL,
  source_message_pk INTEGER,
  in_reply_to      TEXT,
  references_h     TEXT,
  message_id       TEXT NOT NULL,        -- stable Message-ID of this draft / outgoing message
  content_json     TEXT,                 -- last saved SendReq (local copy; survives a crash)
  server_folder_id INTEGER,              -- Drafts folder holding the server copy
  updated_at       INTEGER NOT NULL
);

-- Attachments chosen for composing (copied into the data dir). Tokens never expose paths.
CREATE TABLE compose_file (
  token        TEXT PRIMARY KEY,
  path         TEXT NOT NULL,
  filename     TEXT NOT NULL,
  size         INTEGER NOT NULL,
  content_type TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);
