-- 011: the raw message source (compressed) is kept next to the cached body, so "Save as .eml" and
--   "View source" work offline for messages that were opened before.
--   body.raw_z     : the whole RFC822 source, deflate-compressed (NULL when not stored).
--   body.raw_bytes : its stored size; counted in the body cache budget (maxBodyCacheMB).
-- It lives in the body row, so evicting a body, deleting a message, a folder purge and removing an
-- account (all ON DELETE CASCADE / DELETE FROM body) remove it together with the body.
ALTER TABLE body ADD COLUMN raw_z BLOB;
ALTER TABLE body ADD COLUMN raw_bytes INTEGER NOT NULL DEFAULT 0;
