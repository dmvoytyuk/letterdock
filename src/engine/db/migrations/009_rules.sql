-- 009: rules (DESIGN-SPEC 3.12). They run on this PC only and change nothing on the server except
-- through the normal actions (move, mark read, flag), which follow the offline queue.
--   rules.move_folder_id / move_folder_path : the target folder by id AND path (the path finds it
--     again after the folder row was rebuilt; a rename refreshes the path). No foreign key: a
--     deleted folder switches the rule off and sets `warning`.
CREATE TABLE rules (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT NOT NULL,
  enabled          INTEGER NOT NULL DEFAULT 1,
  account_id       TEXT REFERENCES account(id) ON DELETE CASCADE,
  position         INTEGER NOT NULL,
  match_mode       TEXT NOT NULL DEFAULT 'all' CHECK (match_mode IN ('all','any')),
  conditions_json  TEXT NOT NULL,
  move_folder_id   INTEGER,
  move_folder_path TEXT,
  mark_read        INTEGER NOT NULL DEFAULT 0,
  flag             INTEGER NOT NULL DEFAULT 0,
  delete_to_trash  INTEGER NOT NULL DEFAULT 0,
  stop             INTEGER NOT NULL DEFAULT 0,
  run_on           TEXT NOT NULL DEFAULT 'inbox' CHECK (run_on IN ('inbox','anyFolder')),
  warning          TEXT,
  created_at       INTEGER NOT NULL
);
CREATE INDEX idx_rules_position ON rules(position);

-- The last 50 things rules did. One entry = one rule on one message, or on many (Run now, bursts).
CREATE TABLE rule_activity (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            INTEGER NOT NULL,
  rule_id       INTEGER,
  rule_name     TEXT NOT NULL,
  account_id    TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  count         INTEGER NOT NULL DEFAULT 0,
  subject       TEXT,
  sender        TEXT,
  summary       TEXT NOT NULL,
  undo_json     TEXT NOT NULL DEFAULT '[]',
  undone        INTEGER NOT NULL DEFAULT 0,
  run_now       INTEGER NOT NULL DEFAULT 0,
  kind          TEXT NOT NULL DEFAULT 'change' CHECK (kind IN ('change','warning'))
);
CREATE INDEX idx_rule_activity_rule ON rule_activity(rule_id, ts);

-- 1 once the rules have looked at a message that just arrived (each message is looked at once).
ALTER TABLE message ADD COLUMN rules_done INTEGER NOT NULL DEFAULT 0;
