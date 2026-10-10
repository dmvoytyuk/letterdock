import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrate } from '../../src/engine/db/connection';
import { MIGRATIONS } from '../../src/engine/db/migrations';

describe('migration 013 (light features)', () => {
  it('upgrades a database with mail in it and leaves every message unpinned, unmuted and visible', () => {
    const before = MIGRATIONS.filter((m) => m.version < 13);
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db, before);
    db.exec(`INSERT INTO account (id,email,display_name,provider,auth_type,imap_host,imap_port,imap_security,smtp_host,smtp_port,smtp_security,username,created_at)
             VALUES ('a','a@x.com','A','generic','password','h',993,'ssl','h',465,'ssl','a',1);
             INSERT INTO folder (id,account_id,path,name,role) VALUES (1,'a','INBOX','INBOX','inbox');
             INSERT INTO message (account_id,folder_id,uid,subject,date_ms,internal_ms) VALUES ('a',1,1,'old mail',5,5);
             INSERT INTO body (message_pk,text_plain,html,fetched_at,size_bytes) VALUES (1,'t',NULL,1,1);`);
    expect(db.pragma('user_version', { simple: true })).toBe(12);

    expect(migrate(db)).toBe(MIGRATIONS.length);
    const m = db.prepare('SELECT pinned_at, muted, snoozed_until, snooze_returned_at FROM message').get();
    expect(m).toEqual({ pinned_at: null, muted: 0, snoozed_until: null, snooze_returned_at: null });
    expect(db.prepare('SELECT list_headers FROM body').get()).toEqual({ list_headers: null });
    expect(db.prepare('SELECT COUNT(*) AS n FROM muted_threads').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM unsubscribed').get()).toEqual({ n: 0 });
  });

  it('removing an account removes its mute and unsubscribe records', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db);
    db.exec(`INSERT INTO account (id,email,display_name,provider,auth_type,imap_host,imap_port,imap_security,smtp_host,smtp_port,smtp_security,username,created_at)
             VALUES ('a','a@x.com','A','generic','password','h',993,'ssl','h',465,'ssl','a',1);
             INSERT INTO muted_threads VALUES ('a','t:1',1,1);
             INSERT INTO unsubscribed VALUES ('a','list','s@x.com',NULL,'page',1);`);
    db.prepare("DELETE FROM account WHERE id = 'a'").run();
    expect(db.prepare('SELECT COUNT(*) AS n FROM muted_threads').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM unsubscribed').get()).toEqual({ n: 0 });
  });

  it('the partial indexes only hold snoozed / pinned rows', () => {
    const db = new Database(':memory:');
    migrate(db);
    const sql = (n: string) => (db.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(n) as { sql: string }).sql;
    expect(sql('idx_msg_snoozed')).toMatch(/WHERE snoozed_until IS NOT NULL/);
    expect(sql('idx_msg_pinned')).toMatch(/WHERE pinned_at IS NOT NULL/);
  });
});
