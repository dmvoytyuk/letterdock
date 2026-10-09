// syncDays changes (widen / narrow) and the body cache cap, against the fake IMAP server.
import { afterEach, describe, expect, it } from 'vitest';
import type { MessageBody } from '../../src/shared/ipc';
import { isWidenPending } from '../../src/engine/imap/history';
import { createHarness, waitFor, waitForInboxCursors, type Harness } from '../fakes/engineHarness';
import { rawMessage, startFakeImap, type FakeImapServer } from '../fakes/fakeImapServer';

let server: FakeImapServer | null = null;
let h: Harness | null = null;

afterEach(async () => {
  await h?.cleanup();
  await server?.close().catch(() => undefined);
  h = server = null;
});

const DAY = 86_400_000;
const aged = (days: number, subject: string) => ({
  raw: rawMessage({ subject, date: new Date(Date.now() - days * DAY) }),
  internaldate: new Date(Date.now() - days * DAY),
});

describe('syncDays changes', () => {
  it('widening fetches older headers; narrowing removes them from this PC only', async () => {
    server = await startFakeImap({
      inbox: [aged(200, 'Old 200'), aged(50, 'Mid 50'), aged(5, 'New 5')],
    });
    h = await createHarness(server);
    const a = await h.addAccount({ syncDays: 30 });
    await waitFor('first sync', () => h!.inboxMessages(a.id).length === 1);
    await waitForInboxCursors(h, [a.id]);
    const inboxId = h.folderByRole(a.id, 'inbox').id;

    // Wider: 400 days brings back both older messages.
    await h.engine.handle('accounts.update', { accountId: a.id, patch: { syncDays: 400 } });
    await waitFor('three messages', () => h!.inboxMessages(a.id).length === 3);
    // No wait for the widening to finish: narrowing right away must be safe (see the next test).
    expect(h.inboxMessages(a.id).map((m) => m.subject).sort()).toEqual([
      'Mid 50',
      'New 5',
      'Old 200',
    ]);

    // Open the oldest one so it has a cached body, then narrow.
    const old = h.inboxMessages(a.id).find((m) => m.subject === 'Old 200')!;
    await h.engine.handle('messages.get', { messageId: old.id });
    expect(h.engine.ctx.messages.getBody(old.id)).not.toBeNull();
    const before = h.events.length;

    await h.engine.handle('accounts.update', { accountId: a.id, patch: { syncDays: 10 } });
    h.engine.ctx.hub.flush();
    expect(h.inboxMessages(a.id).map((m) => m.subject)).toEqual(['New 5']);
    const removed = h.events
      .slice(before)
      .flatMap((e) => (e.type === 'messages:changed' ? e.removed : []));
    expect(removed).toHaveLength(2);
    expect(removed).toContain(old.id);
    expect(h.engine.ctx.messages.getBody(old.id)).toBeNull();
    expect(h.engine.ctx.messages.row(old.id)).toBeNull();
    // The server still has all three messages.
    expect(server.mailbox('INBOX').messages).toHaveLength(3);
    // "Load older" can bring them back again.
    expect(h.engine.ctx.folders.syncState(inboxId)!.historyComplete).toBe(false);
    const res = (await h.engine.handle('sync.loadOlder', { folderId: inboxId })) as {
      fetched: number;
    };
    expect(res.fetched).toBe(2);
  });

  it('narrowing while a widening is still running wins: nothing comes back, cursor stays right', async () => {
    server = await startFakeImap({
      inbox: [aged(200, 'Old 200'), aged(50, 'Mid 50'), aged(5, 'New 5')],
    });
    h = await createHarness(server);
    const a = await h.addAccount({ syncDays: 30 });
    await waitFor('first sync', () => h!.inboxMessages(a.id).length === 1);
    await waitForInboxCursors(h, [a.id]);
    const inboxId = h.folderByRole(a.id, 'inbox').id;

    // Widen, and narrow as soon as the first older row shows up (the widening is still busy).
    await h.engine.handle('accounts.update', { accountId: a.id, patch: { syncDays: 400 } });
    await waitFor('older rows arriving', () => h!.inboxMessages(a.id).length >= 2);
    await h.engine.handle('accounts.update', { accountId: a.id, patch: { syncDays: 10 } });
    await new Promise((r) => setTimeout(r, 500));

    expect(isWidenPending(h.engine.ctx, a.id)).toBe(false);
    expect(h.inboxMessages(a.id).map((m) => m.subject)).toEqual(['New 5']);
    const st = h.engine.ctx.folders.syncState(inboxId)!;
    expect(st.historyComplete).toBe(false);
    // The cursor is where the narrowed window ends, so "load older" still finds the two messages.
    const res = (await h.engine.handle('sync.loadOlder', { folderId: inboxId })) as { fetched: number };
    expect(res.fetched).toBe(2);
  });

  it('keeps contacts learned from removed mail', async () => {
    server = await startFakeImap({ inbox: [aged(200, 'Old 200'), aged(5, 'New 5')] });
    h = await createHarness(server);
    const a = await h.addAccount({ syncDays: 400 });
    await waitFor('both messages', () => h!.inboxMessages(a.id).length === 2);
    await waitForInboxCursors(h, [a.id]);
    const count = () =>
      (h!.engine.ctx.db.prepare('SELECT COUNT(*) AS n FROM contact').get() as { n: number }).n;
    const before = count();
    await h.engine.handle('accounts.update', { accountId: a.id, patch: { syncDays: 10 } });
    expect(h.inboxMessages(a.id)).toHaveLength(1);
    expect(count()).toBe(before);
  });
});

describe('body cache cap (maxBodyCacheMB)', () => {
  it('removes the least recently opened bodies, keeps headers, and they download again', async () => {
    server = await startFakeImap({
      inbox: [aged(3, 'A'), aged(2, 'B'), aged(1, 'C')],
    });
    h = await createHarness(server);
    const a = await h.addAccount({ syncDays: 30 });
    await waitFor('three messages', () => h!.inboxMessages(a.id).length === 3);
    const msgs = h.inboxMessages(a.id);
    const byName = (n: string) => msgs.find((m) => m.subject === n)!;
    let t = 1_000_000;
    h.engine.ctx.now = () => (t += 1000);
    for (const n of ['A', 'B', 'C']) {
      await h.engine.handle('messages.get', { messageId: byName(n).id });
    }
    // Open A again: B is now the least recently opened.
    await h.engine.handle('messages.get', { messageId: byName('A').id });
    // Pretend every body is 600 KB and set a 1 MB cap: only one fits under 90% of it.
    h.engine.ctx.db.prepare('UPDATE body SET size_bytes = ?').run(600 * 1024);
    h.settings.maxBodyCacheMB = 1;
    await h.engine.applySettings();

    expect(h.engine.ctx.messages.getBody(byName('B').id)).toBeNull();
    expect(h.engine.ctx.messages.getBody(byName('C').id)).toBeNull();
    expect(h.engine.ctx.messages.getBody(byName('A').id)).not.toBeNull();
    expect(h.engine.ctx.messages.row(byName('B').id)!.body_state).toBe('none');
    const again = (await h.engine.handle('messages.get', {
      messageId: byName('B').id,
    })) as MessageBody;
    expect(again.header.subject).toBe('B');
    expect(h.engine.ctx.messages.getBody(byName('B').id)).not.toBeNull();
  });
});
