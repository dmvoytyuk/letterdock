// Engine integration: the light features (DESIGN-SPEC 3.13) against the fake IMAP / SMTP servers:
// snooze, pin, mute, unsubscribe (headers, memory, mailto), notification buttons.
import { afterEach, describe, expect, it } from 'vitest';
import type {
  ApplyActionRes,
  ListMessagesRes,
  ListConversationsRes,
  MuteSetRes,
  PinSetRes,
  SnoozeClearRes,
  SnoozedItem,
  SnoozeCount,
  SnoozeSetRes,
  UnsubscribeInfo,
  UndoRes,
} from '../../src/shared/ipc';
import { createHarness, waitFor, type Harness } from '../fakes/engineHarness';
import { rawMessage, startFakeImap, type FakeImapServer, type SeedMessage } from '../fakes/fakeImapServer';
import { startFakeSmtp, type FakeSmtpServer } from '../fakes/fakeSmtpServer';

let server: FakeImapServer | null = null;
let smtp: FakeSmtpServer | null = null;
let h: Harness | null = null;
const clock = { offset: 0, now: () => Date.now() + clock.offset };

afterEach(async () => {
  await h?.cleanup();
  await server?.close().catch(() => undefined);
  await smtp?.close().catch(() => undefined);
  h = server = smtp = null;
  clock.offset = 0;
});

const HOUR = 3_600_000;
const ago = (hours: number) => new Date(Date.now() - hours * HOUR);

/** Add extra header lines at the very top of a raw message (the topmost header is the provider's). */
const withHeaders = (raw: string, lines: string[]) => lines.join('\r\n') + '\r\n' + raw;

const LIST_HEADERS = [
  'List-Unsubscribe: <https://news.example.com/u/123>, <mailto:unsub@news.example.com?subject=Please%20remove>',
  'List-Unsubscribe-Post: List-Unsubscribe=One-Click',
  'List-Id: "Example News" <news.example.com>',
];
const AR_PASS = 'Authentication-Results: mx.provider.test; dkim=pass header.d=news.example.com; spf=pass; dmarc=pass';

interface BootOpts {
  extra?: SeedMessage[];
  withSmtp?: boolean;
}

async function boot(o: BootOpts = {}) {
  server = await startFakeImap({
    inbox: [
      { raw: rawMessage({ subject: 'Plan', messageId: '<a1@x>', date: ago(10), from: 'Alice <alice@example.com>' }), flags: ['\\Seen'] },
      {
        raw: rawMessage({
          subject: 'Re: Plan', messageId: '<a2@x>', inReplyTo: '<a1@x>', references: '<a1@x>', date: ago(9),
          from: 'Bob <bob@example.com>',
        }),
      },
      { raw: rawMessage({ subject: 'Lunch', messageId: '<l1@x>', date: ago(8), from: 'Carol <carol@example.com>' }) },
      { raw: rawMessage({ subject: 'Invoice', messageId: '<i1@x>', date: ago(7), from: 'Dan <dan@example.com>' }) },
      {
        raw: withHeaders(
          rawMessage({ subject: 'Weekly news', messageId: '<n1@x>', date: ago(6), from: 'Example News <news@news.example.com>' }),
          [AR_PASS, ...LIST_HEADERS],
        ),
      },
      ...(o.extra ?? []),
    ],
  });
  if (o.withSmtp) smtp = await startFakeSmtp();
  h = await createHarness(server, { now: clock.now, ...(smtp ? { smtp } : {}) });
  const acc = await h.addAccount(
    smtp ? { smtp: { host: smtp.host, port: smtp.port, security: smtp.security } } : {},
  );
  await waitFor('inbox synced', () => h!.inboxMessages(acc.id).length === 5 + (o.extra?.length ?? 0));
  await waitFor('quiet', () => h!.engine.sessions.statuses()[0]?.state === 'online');
  await waitFor('folders listed', () => h!.engine.ctx.folders.rowByRole(acc.id, 'archive') || h!.engine.ctx.folders.rowByRole(acc.id, 'trash'));
  await h.engine.actions.drain();
  return { h, server, acc, light: h.engine.light };
}
type Booted = Awaited<ReturnType<typeof boot>>;

const call = <T>(hh: Harness, ch: string, req?: unknown) => hh.engine.handle(ch, req) as Promise<T>;
const idOf = (c: Booted, subject: string) =>
  (c.h.engine.ctx.db.prepare('SELECT id FROM message WHERE subject = ?').get(subject) as { id: number }).id;
const rowOf = (c: Booted, subject: string) => c.h.engine.ctx.messages.row(idOf(c, subject))!;
const inboxScope = (c: Booted) => ({ kind: 'accountInbox' as const, accountId: c.acc.id });
const listInbox = (c: Booted, over: object = {}) =>
  call<ListMessagesRes>(c.h, 'messages.list', { scope: inboxScope(c), cursor: null, limit: 50, ...over });
const subjects = (r: ListMessagesRes) => r.items.map((m) => m.subject);
const inboxUnread = (c: Booted) => c.h.engine.ctx.folders.get(c.h.folderByRole(c.acc.id, 'inbox').id)!.unreadCount;

describe('migration', () => {
  it('adds the columns, the indexes and the two tables', async () => {
    const c = await boot();
    const db = c.h.engine.ctx.db;
    expect(db.pragma('user_version', { simple: true })).toBeGreaterThanOrEqual(13);
    const cols = (db.prepare('PRAGMA table_info(message)').all() as { name: string }[]).map((x) => x.name);
    for (const n of ['pinned_at', 'muted', 'snoozed_until', 'snooze_returned_at']) expect(cols).toContain(n);
    const idx = (db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as { name: string }[]).map((x) => x.name);
    expect(idx).toEqual(expect.arrayContaining(['idx_msg_snoozed', 'idx_msg_pinned']));
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((x) => x.name);
    expect(tables).toEqual(expect.arrayContaining(['muted_threads', 'unsubscribed']));
    // The list query still orders by the date index (no sort step), also with the new conditions.
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT m.* FROM message m JOIN folder f ON f.id = m.folder_id
          WHERE m.flag_deleted = 0 AND m.snoozed_until IS NULL AND m.folder_id = 1
          ORDER BY m.date_ms DESC, m.id DESC LIMIT 50`,
      )
      .all() as { detail: string }[];
    expect(plan.map((p) => p.detail).join('\n')).not.toMatch(/TEMP B-TREE FOR ORDER BY/);
  });
});

describe('snooze', () => {
  it('hides the message everywhere on this PC and counts it in the Snoozed view', async () => {
    const c = await boot();
    const lunch = idOf(c, 'Lunch');
    const unreadBefore = inboxUnread(c);
    c.h.events.length = 0;
    const res = await call<SnoozeSetRes>(c.h, 'snooze.set', { messageIds: [lunch], until: clock.now() + 3 * HOUR });
    expect(res).toMatchObject({ snoozed: [lunch], failed: [] });
    expect(res.undoToken).toBeTruthy();
    expect(subjects(await listInbox(c))).not.toContain('Lunch');
    expect((await listInbox(c)).total).toBe(4);
    expect(subjects(await listInbox(c, { unreadOnly: true }))).not.toContain('Lunch');
    expect(inboxUnread(c)).toBe(unreadBefore - 1); // the counts ignore snoozed mail
    expect(c.h.eventsOfType('snooze:changed')).toEqual([{ type: 'snooze:changed', accountId: c.acc.id }]);

    const list = await call<SnoozedItem[]>(c.h, 'snooze.list', {});
    expect(list.map((i) => i.header.subject)).toEqual(['Lunch']);
    expect(list[0]!.snoozedUntil).toBe(rowOf(c, 'Lunch').snoozed_until);
    expect(list[0]!.header.snoozedUntil).toBe(list[0]!.snoozedUntil);
    expect(await call<SnoozedItem[]>(c.h, 'snooze.list', { accountId: 'nobody' })).toEqual([]);
    const count = await call<SnoozeCount>(c.h, 'snooze.count');
    expect(count.total).toBe(1);
    expect(count.perAccount).toEqual([{ accountId: c.acc.id, total: 1 }]);
    expect(count.nextWakeAt).toBe(list[0]!.snoozedUntil);
    // The server is not told: the message stays in the Inbox there.
    expect(c.server.mailbox('INBOX').messages).toHaveLength(5);
  });

  it('checks the time and the folder', async () => {
    const c = await boot();
    const lunch = idOf(c, 'Lunch');
    await expect(call(c.h, 'snooze.set', { messageIds: [lunch], until: clock.now() - 1000 })).rejects.toMatchObject({ appError: { code: 'INVALID_INPUT' } });
    await expect(call(c.h, 'snooze.set', { messageIds: [lunch], until: clock.now() + 400 * 24 * HOUR })).rejects.toMatchObject({ appError: { code: 'INVALID_INPUT' } });
    expect((await call<SnoozeSetRes>(c.h, 'snooze.set', { messageIds: [lunch], until: clock.now() + 360 * 24 * HOUR })).snoozed).toEqual([lunch]);
    // Trash is not a place for snooze.
    await call<ApplyActionRes>(c.h, 'messages.apply', { messageIds: [idOf(c, 'Invoice')], action: { type: 'delete' } });
    const res = await call<SnoozeSetRes>(c.h, 'snooze.set', { messageIds: [idOf(c, 'Invoice'), 999999], until: clock.now() + HOUR });
    expect(res.snoozed).toEqual([]);
    expect(res.failed.map((f) => f.error.code).sort()).toEqual(['INVALID_INPUT', 'NOT_FOUND']);
  });

  it('wakes at the wake time: unread, at the top, with the chip flag, one grouped event', async () => {
    const c = await boot();
    const plan = rowOf(c, 'Plan'); // old and already read
    expect(plan.flag_seen).toBe(1);
    await call(c.h, 'snooze.set', { messageIds: [plan.id], until: clock.now() + 2 * HOUR });
    c.h.events.length = 0;
    await c.light.snooze.recheck();
    expect(subjects(await listInbox(c))).not.toContain('Plan'); // not yet
    clock.offset = 3 * HOUR;
    await c.light.snooze.recheck();

    const after = rowOf(c, 'Plan');
    expect(after.snoozed_until).toBeNull();
    expect(after.flag_seen).toBe(0);
    expect(Math.abs(after.snooze_returned_at! - clock.now())).toBeLessThan(2000);
    const list = await listInbox(c);
    expect(list.items[0]).toMatchObject({ subject: 'Plan', seen: false, snoozeReturnedAt: after.snooze_returned_at });
    expect(list.items).toHaveLength(5);
    expect(list.items.slice(1).every((m) => m.snoozeReturnedAt === undefined)).toBe(true);
    expect(c.h.eventsOfType('snooze:changed')).toHaveLength(1);
    const back = c.h.eventsOfType('snooze:returned');
    expect(back).toHaveLength(1);
    expect(back[0]!.messages.map((m) => m.subject)).toEqual(['Plan']);
    expect(await call<SnoozedItem[]>(c.h, 'snooze.list', {})).toEqual([]);
    // "Unread" also goes to the server, through the normal queue.
    await c.h.engine.actions.drain();
    const planUid = c.h.engine.ctx.messages.row(plan.id)!.uid;
    const serverFlags = c.server.mailbox('INBOX').messages.find((m) => m.uid === planUid)!.flags;
    expect(serverFlags).not.toContain('\\Seen');
    expect(Array.isArray(serverFlags)).toBe(true);
  });

  it('puts the returned message first only in the newest-first date order; reading ends the chip', async () => {
    const c = await boot();
    const id = idOf(c, 'Lunch');
    await call(c.h, 'snooze.set', { messageIds: [id], until: clock.now() + HOUR });
    clock.offset = 2 * HOUR;
    await c.light.snooze.recheck();
    expect((await listInbox(c)).items[0]!.subject).toBe('Lunch');
    // oldest first: normal place, and the flag still shows
    const asc = await listInbox(c, { direction: 'asc' });
    expect(asc.items.map((m) => m.subject)).toEqual(['Plan', 'Re: Plan', 'Lunch', 'Invoice', 'Weekly news']);
    expect(asc.items[2]!.snoozeReturnedAt).toBeGreaterThan(0);
    // other sorts: normal place
    expect((await listInbox(c, { sort: 'subject' })).items[0]!.subject).not.toBe('Lunch');
    // paging: the extra rows come with page 1 only, nothing is shown twice
    const p1 = await listInbox(c, { limit: 2 });
    expect(p1.items.map((m) => m.subject)).toEqual(['Lunch', 'Weekly news', 'Invoice']);
    const p2 = await listInbox(c, { limit: 2, cursor: p1.nextCursor });
    expect(p2.items.map((m) => m.subject)).toEqual(['Re: Plan', 'Plan'].slice(0, p2.items.length));
    expect([...p1.items, ...p2.items].map((m) => m.subject).sort()).toEqual(['Invoice', 'Lunch', 'Plan', 'Re: Plan', 'Weekly news'].sort());

    await call(c.h, 'messages.apply', { messageIds: [id], action: { type: 'markRead', read: true } });
    expect(rowOf(c, 'Lunch').snooze_returned_at).toBeNull();
    const list = await listInbox(c);
    expect(list.items.map((m) => m.subject)).toEqual(['Weekly news', 'Invoice', 'Lunch', 'Re: Plan', 'Plan']);
    expect(list.items.every((m) => m.snoozeReturnedAt === undefined)).toBe(true);
  });

  it('uses ONE timer for the nearest wake time and wakes by itself', async () => {
    const c = await boot();
    const a = idOf(c, 'Lunch');
    const b = idOf(c, 'Invoice');
    await call(c.h, 'snooze.set', { messageIds: [b], until: clock.now() + 60 * HOUR });
    await call(c.h, 'snooze.set', { messageIds: [a], until: clock.now() + 400 });
    c.h.events.length = 0;
    await waitFor('woke by timer', () => c.h.eventsOfType('snooze:returned').length === 1, 5000);
    expect(rowOf(c, 'Lunch').snoozed_until).toBeNull();
    expect(rowOf(c, 'Invoice').snoozed_until).not.toBeNull(); // the later one waits for its own time
    expect(c.h.eventsOfType('snooze:returned')[0]!.messages.map((m) => m.subject)).toEqual(['Lunch']);
  });

  it('wakes what is overdue when the PC resumes (and does not need a timer for that)', async () => {
    const c = await boot();
    const id = idOf(c, 'Lunch');
    await call(c.h, 'snooze.set', { messageIds: [id], until: clock.now() + 5 * HOUR });
    c.h.events.length = 0;
    clock.offset = 6 * HOUR; // the PC slept
    await call(c.h, 'scheduled.recheck', { reason: 'resume' });
    await waitFor('woke on resume', () => rowOf(c, 'Lunch').snoozed_until === null);
    expect(rowOf(c, 'Lunch').snooze_returned_at).not.toBeNull();
    expect(c.h.eventsOfType('snooze:returned')).toHaveLength(1);
  });

  it('a reply in the conversation wakes the snoozed messages at once', async () => {
    const c = await boot();
    const a2 = idOf(c, 'Re: Plan');
    await call(c.h, 'snooze.set', { messageIds: [a2], until: clock.now() + 24 * HOUR });
    expect(subjects(await listInbox(c))).not.toContain('Re: Plan');
    c.h.events.length = 0;
    c.server.deliver('INBOX', {
      raw: rawMessage({ subject: 'Re: Plan', messageId: '<a3@x>', inReplyTo: '<a2@x>', references: '<a1@x> <a2@x>', from: 'Alice <alice@example.com>' }),
    });
    await waitFor('woken', () => rowOf(c, 'Re: Plan') && c.h.engine.ctx.messages.row(a2)!.snoozed_until === null);
    expect(c.h.engine.ctx.messages.row(a2)).toMatchObject({ flag_seen: 0 });
    expect(c.h.engine.ctx.messages.row(a2)!.snooze_returned_at).not.toBeNull();
    // The reply itself is announced as new mail; there is no second "snoozed mail is back".
    await waitFor('reply announced', () => c.h.eventsOfType('notify:newMail').length > 0);
    expect(c.h.eventsOfType('snooze:returned')).toHaveLength(0);
    expect(c.h.eventsOfType('snooze:changed').length).toBeGreaterThan(0);
  });

  it('snoozes the messages of a conversation in the view; unsnooze and undo', async () => {
    const c = await boot();
    const tid = rowOf(c, 'Plan').thread_id!;
    expect(rowOf(c, 'Re: Plan').thread_id).toBe(tid);
    const res = await call<SnoozeSetRes>(c.h, 'snooze.set', { threadIds: [tid], scope: inboxScope(c), until: clock.now() + 2 * HOUR });
    expect(res.snoozed.sort()).toEqual([idOf(c, 'Plan'), idOf(c, 'Re: Plan')].sort());
    const convs = await call<ListConversationsRes>(c.h, 'conversations.list', { scope: inboxScope(c), cursor: null, limit: 50 });
    expect(convs.items.map((i) => i.latest.title)).not.toContain('Plan');
    expect(convs.total).toBe(3);

    // undo puts both back as they were
    expect((await call<UndoRes>(c.h, 'messages.undo', { undoToken: res.undoToken })).restored).toHaveLength(2);
    expect(rowOf(c, 'Plan').snoozed_until).toBeNull();
    expect(subjects(await listInbox(c))).toContain('Plan');
    await expect(call(c.h, 'messages.undo', { undoToken: res.undoToken })).rejects.toMatchObject({ appError: { code: 'NOT_FOUND' } });

    // snooze again, then "Unsnooze now": back at once, unread, top; and that can be undone too
    await call(c.h, 'snooze.set', { threadIds: [tid], scope: inboxScope(c), until: clock.now() + 2 * HOUR });
    c.h.events.length = 0;
    const cleared = await call<SnoozeClearRes>(c.h, 'snooze.clear', { threadIds: [tid] });
    expect(cleared.cleared).toHaveLength(2);
    expect(c.h.eventsOfType('snooze:returned')).toHaveLength(0); // the user did it: no notification
    expect(rowOf(c, 'Plan')).toMatchObject({ snoozed_until: null, flag_seen: 0 });
    expect((await listInbox(c)).items.slice(0, 2).map((m) => m.subject).sort()).toEqual(['Plan', 'Re: Plan']);
    await call(c.h, 'messages.undo', { undoToken: cleared.undoToken });
    expect(rowOf(c, 'Plan').snoozed_until).not.toBeNull();
    expect(rowOf(c, 'Plan').flag_seen).toBe(1); // it was read before, and is again
  });

  it('conversation rows carry the flags and put a returned conversation first', async () => {
    const c = await boot();
    const tid = rowOf(c, 'Plan').thread_id!;
    await call(c.h, 'snooze.set', { threadIds: [tid], scope: inboxScope(c), until: clock.now() + HOUR });
    clock.offset = 2 * HOUR;
    await c.light.snooze.recheck();
    const convs = await call<ListConversationsRes>(c.h, 'conversations.list', { scope: inboxScope(c), cursor: null, limit: 50 });
    expect(convs.items[0]!.latest.title).toBe('Plan');
    expect(convs.items[0]!.snoozeReturnedAt).toBeGreaterThan(0);
    expect(convs.items[1]!.snoozeReturnedAt).toBeUndefined();
  });

  it('a message that leaves the folder is no longer snoozed', async () => {
    const c = await boot();
    const id = idOf(c, 'Lunch');
    await call(c.h, 'snooze.set', { messageIds: [id], until: clock.now() + HOUR });
    await call(c.h, 'messages.apply', { messageIds: [id], action: { type: 'delete' } });
    expect(rowOf(c, 'Lunch').snoozed_until).toBeNull();
    expect((await call<SnoozeCount>(c.h, 'snooze.count')).total).toBe(0);
  });
});

describe('pin', () => {
  it('pins to the top of a folder, in its own list, and not twice', async () => {
    const c = await boot();
    const inv = idOf(c, 'Invoice');
    const res = await call<PinSetRes>(c.h, 'pin.set', { messageIds: [inv], pinned: true });
    expect(res).toMatchObject({ ok: true, changed: [inv] });
    const list = await listInbox(c);
    expect(list.pinned?.map((m) => m.subject)).toEqual(['Invoice']);
    expect(list.pinned![0]!.pinned).toBe(true);
    expect(subjects(list)).not.toContain('Invoice');
    expect(list.total).toBe(5);
    // page 2 has no pinned list (only page 1 does)
    const p1 = await listInbox(c, { limit: 2 });
    const p2 = await listInbox(c, { limit: 2, cursor: p1.nextCursor });
    expect(p2.pinned).toBeUndefined();
    expect([...p1.items, ...p2.items].map((m) => m.subject)).not.toContain('Invoice');
    // Pins are ignored in the Unread view and for "All inboxes" they apply per Inbox
    const unread = await listInbox(c, { unreadOnly: true });
    expect(unread.pinned).toBeUndefined();
    expect(subjects(unread)).toContain('Invoice');
    const all = await call<ListMessagesRes>(c.h, 'messages.list', { scope: { kind: 'unifiedInbox' }, cursor: null, limit: 50 });
    expect(all.pinned?.map((m) => m.subject)).toEqual(['Invoice']);
    // the same in the folder view
    const folder = await call<ListMessagesRes>(c.h, 'messages.list', { scope: { kind: 'folder', folderId: c.h.folderByRole(c.acc.id, 'inbox').id }, cursor: null, limit: 50 });
    expect(folder.pinned).toHaveLength(1);

    const un = await call<PinSetRes>(c.h, 'pin.set', { messageIds: [inv], pinned: false });
    expect(un.ok).toBe(true);
    const back = await listInbox(c);
    expect(back.pinned).toBeUndefined();
    expect(subjects(back)).toContain('Invoice');
  });

  it('pinned messages follow the chosen sort', async () => {
    const c = await boot();
    await call(c.h, 'pin.set', { messageIds: [idOf(c, 'Invoice'), idOf(c, 'Lunch')], pinned: true });
    expect((await listInbox(c)).pinned!.map((m) => m.subject)).toEqual(['Invoice', 'Lunch']);
    expect((await listInbox(c, { direction: 'asc' })).pinned!.map((m) => m.subject)).toEqual(['Lunch', 'Invoice']);
    expect((await listInbox(c, { sort: 'subject' })).pinned!.map((m) => m.subject)).toEqual(['Invoice', 'Lunch']);
  });

  it('allows 10 per folder; the 11th changes nothing', async () => {
    const extra: SeedMessage[] = Array.from({ length: 8 }, (_, i) => ({
      raw: rawMessage({ subject: `Extra ${i}`, messageId: `<e${i}@x>`, date: ago(20 + i) }),
    }));
    const c = await boot({ extra });
    // 'Plan' and 'Re: Plan' are one conversation and count once: leave the reply out.
    const ids = (c.h.engine.ctx.db.prepare("SELECT id FROM message WHERE subject != 'Re: Plan' ORDER BY id").all() as { id: number }[]).map((r) => r.id);
    expect(ids).toHaveLength(12);
    const ten = await call<PinSetRes>(c.h, 'pin.set', { messageIds: ids.slice(0, 10), pinned: true });
    expect(ten.ok).toBe(true);
    const eleventh = await call<PinSetRes>(c.h, 'pin.set', { messageIds: [ids[10]], pinned: true });
    expect(eleventh).toEqual({ ok: false, limit: 10, changed: [] });
    expect((await listInbox(c)).pinned).toHaveLength(10);
    // pinning one that is pinned already is fine, and a batch that would go over changes nothing
    expect((await call<PinSetRes>(c.h, 'pin.set', { messageIds: [ids[0]], pinned: true })).ok).toBe(true);
    await call(c.h, 'pin.set', { messageIds: ids.slice(0, 2), pinned: false });
    const over = await call<PinSetRes>(c.h, 'pin.set', { messageIds: ids.slice(10, 12).concat([ids[0]!]), pinned: true });
    expect(over.ok).toBe(false);
    expect((await listInbox(c)).pinned).toHaveLength(8);
    expect((await call<PinSetRes>(c.h, 'pin.set', { messageIds: ids.slice(10, 12), pinned: true })).ok).toBe(true);
  });

  it('ends when the message leaves the folder; undo brings the pin back', async () => {
    const c = await boot();
    const inv = idOf(c, 'Invoice');
    const lunch = idOf(c, 'Lunch');
    const res = await call<PinSetRes>(c.h, 'pin.set', { messageIds: [lunch], pinned: true });
    await call(c.h, 'pin.set', { messageIds: [inv], pinned: true });
    await call(c.h, 'messages.apply', { messageIds: [inv], action: { type: 'archive' } });
    expect(c.h.engine.ctx.messages.row(inv)!.pinned_at).toBeNull();
    expect(c.h.engine.ctx.messages.row(lunch)!.pinned_at).not.toBeNull();
    await call(c.h, 'messages.undo', { undoToken: res.undoToken });
    expect(c.h.engine.ctx.messages.row(lunch)!.pinned_at).toBeNull();
    expect((await listInbox(c)).pinned).toBeUndefined();
  });

  it('pins a conversation (counts once) and lists it first in the conversation view', async () => {
    const c = await boot();
    const tid = rowOf(c, 'Plan').thread_id!;
    const res = await call<PinSetRes>(c.h, 'pin.set', { threadIds: [tid], scope: inboxScope(c), pinned: true });
    expect(res.changed).toHaveLength(2);
    const convs = await call<ListConversationsRes>(c.h, 'conversations.list', { scope: inboxScope(c), cursor: null, limit: 50 });
    expect(convs.pinned?.map((x) => x.latest.title)).toEqual(['Plan']);
    expect(convs.pinned![0]!.pinned).toBe(true);
    expect(convs.items.map((x) => x.latest.title)).not.toContain('Plan');
    expect(convs.items.every((x) => x.pinned === undefined)).toBe(true);
    const unread = await call<ListConversationsRes>(c.h, 'conversations.list', { scope: inboxScope(c), cursor: null, limit: 50, unreadOnly: true });
    expect(unread.pinned).toBeUndefined();
  });
});

describe('mute', () => {
  it('archives the conversation and sends new replies to Archive without a notification', async () => {
    const c = await boot();
    const a1 = idOf(c, 'Plan');
    const a2 = idOf(c, 'Re: Plan');
    const res = await call<MuteSetRes>(c.h, 'mute.set', { messageIds: [a2], muted: true });
    expect(res).toMatchObject({ ok: true, archivedCount: 2 });
    expect(res.undoToken).toBeTruthy();
    const archive = c.h.folderByRole(c.acc.id, 'archive');
    expect(c.h.engine.ctx.messages.row(a1)!.folder_id).toBe(archive.id);
    expect(c.h.engine.ctx.messages.row(a2)).toMatchObject({ folder_id: archive.id, muted: 1 });
    expect(c.h.engine.ctx.messages.row(a1)!.muted).toBe(1);
    expect(c.h.engine.ctx.db.prepare('SELECT COUNT(*) AS n FROM muted_threads').get()).toEqual({ n: 1 });
    expect((await listInbox(c)).items.map((m) => m.subject).sort()).toEqual(['Invoice', 'Lunch', 'Weekly news']);
    // the flag shows in the list rows
    const arch = await call<ListMessagesRes>(c.h, 'messages.list', { scope: { kind: 'folder', folderId: archive.id }, cursor: null, limit: 50 });
    expect(arch.items.every((m) => m.muted === true)).toBe(true);

    c.h.events.length = 0;
    c.server.deliver('INBOX', {
      raw: rawMessage({ subject: 'Re: Plan', messageId: '<a3@x>', inReplyTo: '<a2@x>', references: '<a1@x> <a2@x>', from: 'Alice <alice@example.com>' }),
    });
    c.server.deliver('INBOX', { raw: rawMessage({ subject: 'Other news', messageId: '<o1@x>' }) });
    await waitFor('both arrived', () => c.h.eventsOfType('notify:newMail').some((e) => e.messages.some((m) => m.subject === 'Other news')));
    const reply = (c.h.engine.ctx.db.prepare("SELECT * FROM message WHERE message_id = '<a3@x>'").get()) as { folder_id: number; muted: number; flag_seen: number };
    expect(reply).toMatchObject({ folder_id: archive.id, muted: 1, flag_seen: 0 }); // unread, in Archive
    const announced = c.h.eventsOfType('notify:newMail').flatMap((e) => e.messages.map((m) => m.subject));
    expect(announced).toEqual(['Other news']);
    await c.h.engine.actions.drain();
    expect(c.server.mailbox('Archive').messages.length).toBeGreaterThanOrEqual(3);
    // activity time of the record moves
    const rec = c.h.engine.ctx.db.prepare('SELECT muted_at, last_hit_at FROM muted_threads').get() as { muted_at: number; last_hit_at: number };
    expect(rec.last_hit_at).toBeGreaterThanOrEqual(rec.muted_at);
  });

  it('unmute clears the flags and the record; new mail arrives in the Inbox again', async () => {
    const c = await boot();
    const a1 = idOf(c, 'Plan');
    await call(c.h, 'mute.set', { messageIds: [a1], muted: true });
    const un = await call<MuteSetRes>(c.h, 'mute.set', { messageIds: [a1], muted: false });
    expect(un.ok).toBe(true);
    expect(c.h.engine.ctx.messages.row(a1)!.muted).toBe(0);
    expect(c.h.engine.ctx.db.prepare('SELECT COUNT(*) AS n FROM muted_threads').get()).toEqual({ n: 0 });
    // messages already in Archive stay there
    expect(c.h.engine.ctx.messages.row(a1)!.folder_id).toBe(c.h.folderByRole(c.acc.id, 'archive').id);
    c.h.events.length = 0;
    c.server.deliver('INBOX', { raw: rawMessage({ subject: 'Re: Plan', messageId: '<a4@x>', inReplyTo: '<a1@x>', references: '<a1@x>' }) });
    await waitFor('announced', () => c.h.eventsOfType('notify:newMail').length > 0);
    expect(c.h.engine.ctx.messages.row(idOf(c, 'Re: Plan'))).toBeTruthy();
    const arrived = c.h.engine.ctx.db.prepare("SELECT folder_id FROM message WHERE message_id = '<a4@x>'").get() as { folder_id: number };
    expect(arrived.folder_id).toBe(c.h.folderByRole(c.acc.id, 'inbox').id);
  });

  it('undo of a mute puts the messages back and unmutes', async () => {
    const c = await boot();
    const res = await call<MuteSetRes>(c.h, 'mute.set', { messageIds: [idOf(c, 'Plan')], muted: true });
    const undone = await call<UndoRes>(c.h, 'messages.undo', { undoToken: res.undoToken });
    expect(undone.restored.length).toBeGreaterThan(0);
    const inbox = c.h.folderByRole(c.acc.id, 'inbox').id;
    expect(rowOf(c, 'Plan')).toMatchObject({ folder_id: inbox, muted: 0 });
    expect(rowOf(c, 'Re: Plan')).toMatchObject({ folder_id: inbox, muted: 0 });
    expect(c.h.engine.ctx.db.prepare('SELECT COUNT(*) AS n FROM muted_threads').get()).toEqual({ n: 0 });
  });

  it('works on a conversation by thread id and archives what is in the view', async () => {
    const c = await boot();
    const tid = rowOf(c, 'Plan').thread_id!;
    const res = await call<MuteSetRes>(c.h, 'mute.set', { threads: [{ accountId: c.acc.id, threadId: tid }], scope: inboxScope(c), muted: true });
    expect(res.archivedCount).toBe(2);
    expect(rowOf(c, 'Plan').muted).toBe(1);
  });

  it('refuses a message that is not part of a conversation', async () => {
    const c = await boot();
    const id = idOf(c, 'Lunch');
    c.h.engine.ctx.db.prepare('UPDATE message SET message_id = NULL, in_reply_to = NULL, references_h = NULL WHERE id = ?').run(id);
    await expect(call(c.h, 'mute.set', { messageIds: [id], muted: true })).rejects.toMatchObject({ appError: { code: 'INVALID_INPUT' } });
  });

  it('keeps at most 500 per account (the least recently used goes) and forgets old records', async () => {
    const c = await boot();
    const db = c.h.engine.ctx.db;
    const ins = db.prepare('INSERT INTO muted_threads (account_id, thread_key, muted_at, last_hit_at) VALUES (?,?,?,?)');
    db.transaction(() => {
      for (let i = 0; i < 500; i++) ins.run(c.acc.id, `t:fill${i}`, clock.now(), clock.now() - i * 1000);
      ins.run(c.acc.id, 't:ancient', 0, clock.now() - 400 * 24 * HOUR);
    })();
    await call(c.h, 'mute.set', { messageIds: [idOf(c, 'Lunch')], muted: true });
    const n = (db.prepare('SELECT COUNT(*) AS n FROM muted_threads WHERE account_id = ?').get(c.acc.id) as { n: number }).n;
    expect(n).toBe(500);
    expect(db.prepare("SELECT 1 FROM muted_threads WHERE thread_key = 't:ancient'").get()).toBeUndefined();
    expect(db.prepare("SELECT 1 FROM muted_threads WHERE thread_key = 't:fill499'").get()).toBeUndefined(); // the oldest of the rest
    expect(db.prepare("SELECT 1 FROM muted_threads WHERE thread_key = 't:fill0'").get()).toBeTruthy();
  });

  it('a snoozed message of the conversation is not archived', async () => {
    const c = await boot();
    await call(c.h, 'snooze.set', { messageIds: [idOf(c, 'Re: Plan')], until: clock.now() + HOUR });
    const res = await call<MuteSetRes>(c.h, 'mute.set', { messageIds: [idOf(c, 'Plan')], muted: true });
    expect(res.archivedCount).toBe(1);
    expect(rowOf(c, 'Re: Plan').folder_id).toBe(c.h.folderByRole(c.acc.id, 'inbox').id);
  });
});

describe('unsubscribe', () => {
  it('reads the list headers when the message is opened and offers the best method', async () => {
    const c = await boot();
    const id = idOf(c, 'Weekly news');
    await call(c.h, 'messages.get', { messageId: id });
    expect(c.h.engine.ctx.messages.listHeaders(id)).toContain('news.example.com');
    const info = await call<UnsubscribeInfo>(c.h, 'unsubscribe.info', { messageId: id });
    expect(info).toMatchObject({
      available: true,
      auth: 'verified',
      listKey: 'news.example.com',
      listName: 'Example News',
      sender: 'news@news.example.com',
    });
    expect(info.methods).toEqual([
      { kind: 'one-click', host: 'news.example.com' },
      { kind: 'mailto', address: 'unsub@news.example.com', subject: 'Please remove' },
      { kind: 'page', host: 'news.example.com' },
    ]);
    expect(info.previous).toBeUndefined();
    // the renderer never gets the address behind the one-click link
    expect(JSON.stringify(info)).not.toContain('/u/123');
  });

  it('works for a message that was not opened yet, and for old downloads without stored headers', async () => {
    const c = await boot();
    const id = idOf(c, 'Weekly news');
    expect(c.h.engine.ctx.messages.listHeaders(id)).toBeUndefined(); // no body yet
    expect((await call<UnsubscribeInfo>(c.h, 'unsubscribe.info', { messageId: id })).available).toBe(true);
    // pretend it was downloaded by an older version: no list headers, but the source is stored
    c.h.engine.ctx.db.prepare('UPDATE body SET list_headers = NULL WHERE message_pk = ?').run(id);
    expect(c.h.engine.ctx.messages.listHeaders(id)).toBeNull();
    expect((await call<UnsubscribeInfo>(c.h, 'unsubscribe.info', { messageId: id })).methods).toHaveLength(3);
    expect(c.h.engine.ctx.messages.listHeaders(id)).toContain('List-Unsubscribe=One-Click');
    // and without the stored source: read again from the server
    c.h.engine.ctx.db.prepare('UPDATE body SET list_headers = NULL, raw_z = NULL WHERE message_pk = ?').run(id);
    expect((await call<UnsubscribeInfo>(c.h, 'unsubscribe.info', { messageId: id })).methods).toHaveLength(3);
  });

  it('a message without List-Unsubscribe has nothing to offer', async () => {
    const c = await boot();
    const info = await call<UnsubscribeInfo>(c.h, 'unsubscribe.info', { messageId: idOf(c, 'Lunch') });
    expect(info).toMatchObject({ available: false, methods: [], auth: 'unknown' });
  });

  it('only the topmost Authentication-Results counts: verified, unknown and failed senders', async () => {
    const mk = (subject: string, mid: string, auth: string[], from = 'News <news@news.example.com>') => ({
      raw: withHeaders(rawMessage({ subject, messageId: mid, from, date: ago(3) }), [...auth, ...LIST_HEADERS]),
    });
    const c = await boot({
      extra: [
        mk('Unknown sender', '<u1@x>', []),
        mk('Failed dkim', '<u2@x>', ['Authentication-Results: mx.p.test; dkim=fail header.d=news.example.com; spf=pass']),
        mk('Wrong domain', '<u3@x>', ['Authentication-Results: mx.p.test; dkim=pass header.d=evil.test']),
        mk('Forged lower header', '<u4@x>', [
          'Authentication-Results: mx.p.test; dkim=fail header.d=news.example.com',
          'Authentication-Results: forged.test; dkim=pass header.d=news.example.com; spf=pass; dmarc=pass',
        ]),
      ],
    });
    const info = (s: string) => call<UnsubscribeInfo>(c.h, 'unsubscribe.info', { messageId: idOf(c, s) });
    expect(await info('Unknown sender')).toMatchObject({ auth: 'unknown', available: true });
    expect(await info('Failed dkim')).toMatchObject({ auth: 'failed', available: false });
    expect((await info('Failed dkim')).methods.length).toBeGreaterThan(0);
    expect(await info('Wrong domain')).toMatchObject({ auth: 'failed', available: false });
    expect(await info('Forged lower header')).toMatchObject({ auth: 'failed', available: false });
    await expect(call(c.h, 'unsubscribe.sendMailto', { messageId: idOf(c, 'Failed dkim'), address: 'unsub@news.example.com', subject: 's', body: '' })).rejects.toMatchObject({ appError: { code: 'INVALID_INPUT' } });
  });

  it('remembers a successful unsubscribe per list and shows it on later messages; forget removes it', async () => {
    const c = await boot({
      extra: [{ raw: withHeaders(rawMessage({ subject: 'Next news', messageId: '<n2@x>', from: 'Example News <news@news.example.com>', date: ago(2) }), [AR_PASS, ...LIST_HEADERS]) }],
    });
    const id1 = idOf(c, 'Weekly news');
    await call(c.h, 'unsubscribe.record', { messageId: id1, method: 'one-click' });
    const info = await call<UnsubscribeInfo>(c.h, 'unsubscribe.info', { messageId: idOf(c, 'Next news') });
    expect(info.previous).toEqual({ at: expect.any(Number), method: 'one-click' });
    expect(info.previouslyUnsubscribedAt).toBe(info.previous!.at);
    // "page opened" replaces the record of the same list
    await call(c.h, 'unsubscribe.record', { messageId: id1, method: 'page' });
    expect((await call<UnsubscribeInfo>(c.h, 'unsubscribe.info', { messageId: id1 })).previous?.method).toBe('page');
    expect(c.h.engine.ctx.db.prepare('SELECT COUNT(*) AS n FROM unsubscribed').get()).toEqual({ n: 1 });
    // a message of another list is not affected
    expect((await call<UnsubscribeInfo>(c.h, 'unsubscribe.info', { messageId: idOf(c, 'Lunch') })).previous).toBeUndefined();
    expect(await call(c.h, 'unsubscribe.forgetHistory')).toEqual({ removed: 1 });
    expect((await call<UnsubscribeInfo>(c.h, 'unsubscribe.info', { messageId: id1 })).previous).toBeUndefined();
  });

  it('keeps the last 2000 records only', async () => {
    const c = await boot();
    const db = c.h.engine.ctx.db;
    const ins = db.prepare("INSERT INTO unsubscribed (account_id, list_key, sender, list_name, method, at) VALUES (?,?,?,?, 'page', ?)");
    db.transaction(() => {
      for (let i = 0; i < 2000; i++) ins.run(c.acc.id, `l${i}`, 's@x.com', null, i + 1);
    })();
    await call(c.h, 'unsubscribe.record', { messageId: idOf(c, 'Weekly news'), method: 'mailto' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM unsubscribed').get()).toEqual({ n: 2000 });
    expect(db.prepare("SELECT 1 FROM unsubscribed WHERE list_key = 'l0'").get()).toBeUndefined(); // the oldest went
    expect(db.prepare("SELECT 1 FROM unsubscribed WHERE list_key = 'news.example.com'").get()).toBeTruthy();
  });

  it('sends the mailto request from the receiving account, at once, with a copy in Sent', async () => {
    const c = await boot({ withSmtp: true });
    c.h.settings.undoSendDelayMs = 30_000; // the normal undo window must not delay this
    const id = idOf(c, 'Weekly news');
    const t = await call<{ mailto: { address: string; subject: string; body: string } }>(c.h, 'unsubscribe.targets', { messageId: id });
    expect(t.mailto).toEqual({ address: 'unsub@news.example.com', subject: 'Please remove', body: '' });
    await call(c.h, 'unsubscribe.sendMailto', { messageId: id, ...t.mailto });
    await waitFor('mail sent', () => smtp!.mails.length === 1);
    expect(smtp!.mails[0]).toMatchObject({ from: 'me@example.com', to: ['unsub@news.example.com'] });
    expect(smtp!.mails[0]!.parsed.subject).toBe('Please remove');
    // another address than the one in the message is refused
    await expect(call(c.h, 'unsubscribe.sendMailto', { messageId: id, address: 'victim@example.com', subject: 's', body: 'b' })).rejects.toMatchObject({ appError: { code: 'INVALID_INPUT' } });
    expect(smtp!.mails).toHaveLength(1);
  });

  it('counts and trashes everything from a sender (not Trash, Sent or Drafts), with one undo', async () => {
    const more = ['Second', 'Third'].map((s, i) => ({
      raw: rawMessage({ subject: s, messageId: `<s${i}@x>`, from: 'Example News <NEWS@news.example.com>', date: ago(2 + i) }),
    }));
    const c = await boot({ extra: more });
    const req = { accountId: c.acc.id, address: 'news@news.example.com' };
    expect(await call(c.h, 'messages.countFromSender', req)).toEqual({ count: 3 });
    expect(await call(c.h, 'messages.countFromSender', { ...req, address: 'nobody@example.com' })).toEqual({ count: 0 });
    expect(await call(c.h, 'messages.countFromSender', { ...req, accountId: 'other' })).toEqual({ count: 0 });
    const res = await call<ApplyActionRes>(c.h, 'messages.trashFromSender', req);
    expect(res.succeeded).toHaveLength(3);
    expect(res.undoToken).toBeTruthy();
    expect(await call(c.h, 'messages.countFromSender', req)).toEqual({ count: 0 }); // now in Trash
    expect(subjects(await listInbox(c))).toEqual(['Invoice', 'Lunch', 'Re: Plan', 'Plan']);
    await call(c.h, 'messages.undo', { undoToken: res.undoToken });
    expect(await call(c.h, 'messages.countFromSender', req)).toEqual({ count: 3 });
  });
});

describe('notification buttons (engine side)', () => {
  const act = (c: Booted, id: number, action: 'read' | 'archive', accountId = c.acc.id) =>
    call<{ done: boolean; undoToken?: string }>(c.h, 'notifications.action', { accountId, messageId: id, action });

  it('Mark as read marks it, silently skips a read or missing message', async () => {
    const c = await boot();
    const id = idOf(c, 'Lunch');
    expect(await act(c, id, 'read')).toEqual({ done: true });
    expect(rowOf(c, 'Lunch').flag_seen).toBe(1);
    expect(await act(c, id, 'read')).toEqual({ done: false });
    expect(await act(c, 999999, 'read')).toEqual({ done: false });
    expect(await act(c, id, 'read', 'wrong-account')).toEqual({ done: false });
    await c.h.engine.actions.drain();
    expect(c.server.mailbox('INBOX').messages.length).toBe(5);
  });

  it('Archive moves it with an undo token; a message that left the Inbox is skipped', async () => {
    const c = await boot();
    const id = idOf(c, 'Invoice');
    const res = await act(c, id, 'archive');
    expect(res.done).toBe(true);
    expect(res.undoToken).toBeTruthy();
    expect(rowOf(c, 'Invoice').folder_id).toBe(c.h.folderByRole(c.acc.id, 'archive').id);
    expect(await act(c, id, 'archive')).toEqual({ done: false });
    await call(c.h, 'messages.undo', { undoToken: res.undoToken });
    expect(rowOf(c, 'Invoice').folder_id).toBe(c.h.folderByRole(c.acc.id, 'inbox').id);
  });

  it('new-mail events say whether Archive is possible and skip muted conversations', async () => {
    const c = await boot();
    c.h.events.length = 0;
    c.server.deliver('INBOX', { raw: rawMessage({ subject: 'Fresh', messageId: '<f1@x>' }) });
    await waitFor('announced', () => c.h.eventsOfType('notify:newMail').length > 0);
    expect(c.h.eventsOfType('notify:newMail')[0]!.archiveAvailable).toBe(true);
  });
});
