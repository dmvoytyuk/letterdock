import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { migrate, openDatabase } from '../../src/engine/db/connection';
import { MIGRATIONS } from '../../src/engine/db/migrations';
import { header, makeAccount, makeCtx } from '../helpers';

describe('migrations', () => {
  it('apply once, set user_version, are idempotent', () => {
    const db = new Database(':memory:');
    expect(migrate(db)).toBe(MIGRATIONS.length);
    expect(migrate(db)).toBe(MIGRATIONS.length);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table') ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);
    for (const t of [
      'account',
      'folder',
      'message',
      'body',
      'attachment',
      'pending_op',
      'outbox',
      'kv',
      'message_fts',
    ]) {
      expect(tables).toContain(t);
    }
  });

  it('runs later migrations on top of an existing database and rejects duplicate versions', () => {
    const db = new Database(':memory:');
    migrate(db);
    const next = [
      ...MIGRATIONS,
      { version: MIGRATIONS.length + 1, sql: 'CREATE TABLE extra (a INTEGER);' },
    ];
    expect(migrate(db, next)).toBe(MIGRATIONS.length + 1);
    expect(() => migrate(new Database(':memory:'), [MIGRATIONS[0], MIGRATIONS[0]])).toThrow(
      /Duplicate/,
    );
  });

  it('004 clears bad header-sync snippets and keeps good ones and cached bodies', () => {
    const db = new Database(':memory:');
    migrate(db, MIGRATIONS.slice(0, 3));
    db.pragma('foreign_keys = OFF');
    const ins = db.prepare(
      "INSERT INTO message (account_id,folder_id,uid,date_ms,internal_ms,snippet,body_state,snippet_checked) VALUES ('a',1,?,0,0,?,?,1)",
    );
    const bad = [
      "96 @font-face { font-family: 'Anthropic Sans'; src: url('https://x/y.woff'); }",
      "<https://claude.ai> Hi, As of April 4 we're enforcing limits",
      '96 @media only screen',
      'body { margin: 0 } Hello',
    ];
    bad.forEach((sn, i) => ins.run(i + 1, sn, 'none'));
    ins.run(10, 'Lunch on Friday? Pizza or sushi.', 'none');
    ins.run(11, '<https://claude.ai> kept because the body is cached', 'cached');
    expect(migrate(db, MIGRATIONS)).toBe(MIGRATIONS.length);
    const rows = db.prepare('SELECT uid, snippet, snippet_checked AS c FROM message ORDER BY uid').all() as {
      uid: number;
      snippet: string;
      c: number;
    }[];
    for (const r of rows.filter((x) => x.uid <= 4)) expect(r).toMatchObject({ snippet: '', c: 0 });
    expect(rows.find((r) => r.uid === 10)).toMatchObject({ snippet: 'Lunch on Friday? Pizza or sushi.', c: 1 });
    expect(rows.find((r) => r.uid === 11)!.c).toBe(1);
  });

  it('rolls back a failing migration', () => {
    const db = new Database(':memory:');
    expect(() =>
      migrate(db, [{ version: 1, sql: 'CREATE TABLE a (x); CREATE TABLE a (x);' }]),
    ).toThrow();
    expect(db.pragma('user_version', { simple: true })).toBe(0);
  });

  it('openDatabase turns on foreign keys', () => {
    const db = openDatabase(':memory:');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });
});

describe('repos', () => {
  function setup() {
    const t = makeCtx();
    t.ctx.accounts.insert(makeAccount(), 1);
    t.ctx.accounts.insert(makeAccount({ id: 'acc-2', email: 'two@example.com', sortOrder: 1 }), 2);
    for (const acc of ['acc-1', 'acc-2']) {
      t.ctx.folders.syncListed(acc, [
        {
          path: 'INBOX',
          name: 'INBOX',
          delimiter: '/',
          role: 'inbox',
          subscribed: true,
          selectable: true,
        },
        {
          path: 'Sent',
          name: 'Sent',
          delimiter: '/',
          role: 'sent',
          subscribed: true,
          selectable: true,
        },
      ]);
    }
    const inbox1 = t.ctx.folders.rowByPath('acc-1', 'INBOX')!.id;
    const sent1 = t.ctx.folders.rowByPath('acc-1', 'Sent')!.id;
    const inbox2 = t.ctx.folders.rowByPath('acc-2', 'INBOX')!.id;
    return { ...t, inbox1, sent1, inbox2 };
  }

  it('upserts headers: insert, then update flags in place', () => {
    const { ctx, inbox1 } = setup();
    const a = ctx.messages.upsertHeaders([header({ folderId: inbox1, uid: 1 })]);
    expect(a.added).toHaveLength(1);
    const b = ctx.messages.upsertHeaders([
      header({
        folderId: inbox1,
        uid: 1,
        flags: {
          seen: true,
          flagged: true,
          answered: false,
          draft: false,
          deleted: false,
          keywords: [],
        },
      }),
    ]);
    expect(b.added).toHaveLength(0);
    expect(b.updated).toEqual(a.added);
    const [h] = ctx.messages.headers(a.added);
    expect(h.seen).toBe(true);
    expect(h.flagged).toBe(true);
  });

  it('lists the unified inbox newest first with keyset paging and no gaps or repeats', () => {
    const { ctx, inbox1, inbox2 } = setup();
    ctx.messages.upsertHeaders([
      ...Array.from({ length: 7 }, (_, i) => header({ folderId: inbox1, uid: i + 1 })),
      ...Array.from({ length: 6 }, (_, i) =>
        header({
          folderId: inbox2,
          uid: i + 1,
          accountId: 'acc-2',
          dateMs: 1_000_000 + (i + 1) * 1000,
        }),
      ),
    ]);
    const seen: number[] = [];
    let cursor: { date: number; id: number } | null = null;
    for (let page = 0; page < 10; page++) {
      const r = ctx.messages.list({ scope: { kind: 'unifiedInbox' }, cursor, limit: 5 });
      seen.push(...r.items.map((m) => m.id));
      if (!r.nextCursor) break;
      cursor = r.nextCursor;
    }
    expect(seen).toHaveLength(13);
    expect(new Set(seen).size).toBe(13);
    const all = ctx.messages.headers(seen);
    for (let i = 1; i < all.length; i++)
      expect(all[i - 1].date).toBeGreaterThanOrEqual(all[i].date);
  });

  it('filters scopes: per-folder, account inbox, unread, flagged (excluding trash)', () => {
    const { ctx, inbox1, sent1, inbox2 } = setup();
    const seenFlags = {
      seen: true,
      flagged: false,
      answered: false,
      draft: false,
      deleted: false,
      keywords: [],
    };
    const flagged = { ...seenFlags, flagged: true };
    ctx.messages.upsertHeaders([
      header({ folderId: inbox1, uid: 1 }),
      header({ folderId: inbox1, uid: 2, flags: seenFlags }),
      header({ folderId: sent1, uid: 1, flags: flagged }),
      header({ folderId: inbox2, uid: 1, accountId: 'acc-2', flags: flagged }),
    ]);
    const count = (scope: Parameters<typeof ctx.messages.list>[0]['scope']) =>
      ctx.messages.list({ scope, cursor: null, limit: 50 }).items.length;
    expect(count({ kind: 'unifiedInbox' })).toBe(3);
    expect(count({ kind: 'unifiedUnread' })).toBe(1);
    expect(count({ kind: 'unifiedFlagged' })).toBe(2);
    expect(count({ kind: 'folder', folderId: sent1 })).toBe(1);
    expect(count({ kind: 'accountInbox', accountId: 'acc-2' })).toBe(1);
    expect(
      ctx.messages.list({
        scope: { kind: 'unifiedInbox' },
        cursor: null,
        limit: 50,
        unreadOnly: true,
      }).items,
    ).toHaveLength(1);
    expect(
      ctx.messages.list({ scope: { kind: 'unifiedInbox' }, cursor: null, limit: 50 }).total,
    ).toBe(3);
  });

  it('recomputes folder counts and unified unread', () => {
    const { ctx, inbox1, inbox2 } = setup();
    ctx.messages.upsertHeaders([
      header({ folderId: inbox1, uid: 1 }),
      header({ folderId: inbox1, uid: 2 }),
      header({ folderId: inbox2, uid: 1, accountId: 'acc-2' }),
    ]);
    ctx.folders.recomputeCounts(inbox1);
    ctx.folders.recomputeCounts(inbox2);
    expect(ctx.folders.counts().unifiedInboxUnread).toBe(3);
    ctx.messages.setFlagColumn(
      [
        ctx.messages.list({ scope: { kind: 'folder', folderId: inbox1 }, cursor: null, limit: 1 })
          .items[0].id,
      ],
      'flag_seen',
      true,
    );
    ctx.folders.recomputeCounts(inbox1);
    expect(ctx.folders.counts().unifiedInboxUnread).toBe(2);
  });

  it('deletes by uid and purges a folder, cleaning the search index', () => {
    const { ctx, db, inbox1 } = setup();
    const { added } = ctx.messages.upsertHeaders([
      header({ folderId: inbox1, uid: 1, subject: 'quarterly report' }),
      header({ folderId: inbox1, uid: 2 }),
    ]);
    const hits = () =>
      (
        db
          .prepare("SELECT rowid FROM message_fts WHERE message_fts MATCH 'quarterly'")
          .all() as unknown[]
      ).length;
    expect(hits()).toBe(1);
    expect(ctx.messages.deleteByUids(inbox1, [1])).toEqual([added[0]]);
    expect(hits()).toBe(0);
    expect(ctx.messages.purgeFolder(inbox1)).toEqual([added[1]]);
    expect(ctx.messages.countInFolder(inbox1)).toBe(0);
  });

  it('caches bodies, attachments and updates the search index', () => {
    const { ctx, db, inbox1 } = setup();
    const { added } = ctx.messages.upsertHeaders([header({ folderId: inbox1, uid: 1 })]);
    const id = added[0];
    ctx.messages.saveBody(
      id,
      {
        text: 'hello zebra',
        html: '<p>hello zebra</p>',
        snippet: 'hello zebra',
        ftsBodyText: 'hello zebra',
        attachments: [
          {
            partId: '0',
            filename: 'a.pdf',
            contentType: 'application/pdf',
            size: 10,
            contentId: null,
            inline: false,
          },
        ],
      },
      123,
    );
    expect(ctx.messages.getBody(id)).toEqual({ text: 'hello zebra', html: '<p>hello zebra</p>' });
    expect(ctx.messages.attachments(id)).toHaveLength(1);
    const [h] = ctx.messages.headers([id]);
    expect(h.bodyCached).toBe(true);
    expect(h.hasAttachments).toBe(true);
    expect(
      (
        db
          .prepare("SELECT rowid FROM message_fts WHERE message_fts MATCH 'zebra'")
          .all() as unknown[]
      ).length,
    ).toBe(1);
  });

  it('syncs the folder list: adds, updates roles, removes vanished folders', () => {
    const { ctx } = setup();
    const changed = ctx.folders.syncListed('acc-1', [
      {
        path: 'INBOX',
        name: 'INBOX',
        delimiter: '/',
        role: 'inbox',
        subscribed: true,
        selectable: true,
      },
      {
        path: 'Archive',
        name: 'Archive',
        delimiter: '/',
        role: 'archive',
        subscribed: true,
        selectable: true,
      },
    ]);
    expect(changed).toBe(true);
    expect(ctx.folders.list('acc-1').map((f) => f.path)).toEqual(['INBOX', 'Archive']);
    expect(
      ctx.folders.syncListed('acc-1', [
        {
          path: 'INBOX',
          name: 'INBOX',
          delimiter: '/',
          role: 'inbox',
          subscribed: true,
          selectable: true,
        },
        {
          path: 'Archive',
          name: 'Archive',
          delimiter: '/',
          role: 'archive',
          subscribed: true,
          selectable: true,
        },
      ]),
    ).toBe(false);
  });

  it('renames a folder path and its children, keeping the messages', () => {
    const { ctx, inbox1 } = setup();
    ctx.folders.syncListed('acc-1', [
      {
        path: 'INBOX',
        name: 'INBOX',
        delimiter: '/',
        role: 'inbox',
        subscribed: true,
        selectable: true,
      },
      {
        path: 'Work',
        name: 'Work',
        delimiter: '/',
        role: null,
        subscribed: true,
        selectable: true,
      },
      {
        path: 'Work/2024',
        name: '2024',
        delimiter: '/',
        role: null,
        subscribed: true,
        selectable: true,
      },
    ]);
    const work = ctx.folders.rowByPath('acc-1', 'Work')!;
    ctx.messages.upsertHeaders([header({ folderId: work.id, uid: 1 })]);
    ctx.folders.renamePath('acc-1', 'Work', 'Jobs', '/');
    expect(ctx.folders.rowByPath('acc-1', 'Jobs')!.id).toBe(work.id);
    expect(ctx.folders.rowByPath('acc-1', 'Jobs/2024')!.name).toBe('2024');
    expect(ctx.messages.countInFolder(work.id)).toBe(1);
    void inbox1;
  });

  it('removing an account cascades everything', () => {
    const { ctx, inbox1 } = setup();
    ctx.messages.upsertHeaders([header({ folderId: inbox1, uid: 1 })]);
    ctx.accounts.remove('acc-1');
    expect(ctx.folders.list('acc-1')).toHaveLength(0);
    expect(ctx.messages.countInFolder(inbox1)).toBe(0);
    expect(ctx.accounts.list().map((a) => a.id)).toEqual(['acc-2']);
  });

  it('account update persists and reorder works', () => {
    const { ctx } = setup();
    const u = ctx.accounts.update('acc-1', { displayName: 'Renamed', enabled: false });
    expect(u?.displayName).toBe('Renamed');
    expect(ctx.accounts.get('acc-1')?.enabled).toBe(false);
    ctx.accounts.reorder(['acc-2', 'acc-1']);
    expect(ctx.accounts.list().map((a) => a.id)).toEqual(['acc-2', 'acc-1']);
  });
});
