-- 007: conversations (DESIGN-SPEC 3.10).
--   message.thread_id    : conversation id. Gmail: "g:<account>:<X-GM-THRID>". Others: "t:<random>".
--                          Existing rows start as their own conversation ("m:<id>"); a background pass joins them.
--   message.subject_norm : subject without Re:/Fwd:/AW:/SV: prefixes, folded (only for the "same subject" fallback)
--   thread_mid           : every Message-ID seen in a Message-ID / In-Reply-To / References header, with the
--                          conversation it belongs to. A parent that arrives late finds its children here.
ALTER TABLE message ADD COLUMN thread_id TEXT;
ALTER TABLE message ADD COLUMN subject_norm TEXT;
UPDATE message SET thread_id = 'm:' || id;
CREATE INDEX idx_msg_thread_id ON message(account_id, thread_id, date_ms);
CREATE INDEX idx_msg_subject_norm ON message(account_id, subject_norm, date_ms);

CREATE TABLE thread_mid (
  account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  mid        TEXT NOT NULL,
  thread_id  TEXT NOT NULL,
  PRIMARY KEY (account_id, mid)
) WITHOUT ROWID;
CREATE INDEX idx_thread_mid_thread ON thread_mid(account_id, thread_id);
