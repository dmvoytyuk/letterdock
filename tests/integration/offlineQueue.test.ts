// Offline action queue: changes made while the account cannot reach the server stay on this PC,
// are merged, survive a restart, and are sent in order when the account is back online.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApplyActionRes } from '../../src/shared/ipc';
import { createHarness, waitFor, waitForInboxCursors, type Harness } from '../fakes/engineHarness';
import {
  rawMessage,
  startFakeImap,
  type FakeImapOptions,
  type FakeImapServer,
} from '../fakes/fakeImapServer';

let server: FakeImapServer | null = null;
const harnesses: Harness[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.cleanup();
  await server?.close().catch(() => undefined);
  server = null;
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const mid = (n: number) => `<offline-${n}@fake.test>`;
const seed = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    raw: rawMessage({ subject: `Msg ${i + 1}`, messageId: mid(i + 1) }),
  }));

async function boot(opts: FakeImapOptions = {}, hOpts: Parameters<typeof createHarness>[1] = {}) {
  server = await startFakeImap({ inbox: seed(4), ...opts });
  const h = await createHarness(server, hOpts);
  harnesses.push(h);
  const acc = await h.addAccount();
  await waitFor('inbox synced', () => h.inboxMessages(acc.id).length === 4);
  // Rows show up before the folder cursors are saved; going offline or resetting the mailbox
  // in between would interrupt the first sync and hide a UIDVALIDITY change.
  await waitForInboxCursors(h, [acc.id]);
  await waitFor('trash row', () => h.engine.ctx.folders.rowByRole(acc.id, 'trash'));
  await waitFor('projects row', () => h.engine.ctx.folders.rowByPath(acc.id, 'Projects'));
  await h.engine.actions.drain();
  return { h, server: server!, acc };
}

const apply = (h: Harness, messageIds: number[], action: object) =>
  h.engine.handle('messages.apply', { messageIds, action }) as Promise<ApplyActionRes>;
const net = (h: Harness, online: boolean) => h.engine.handle('system.networkChanged', { online });
const subj = (srv: FakeImapServer, path: string) =>
  srv
    .mailbox(path)
    .messages.map((m) => /Subject: (.*)\r?\n/.exec(String(m.raw))?.[1] ?? '?')
    .sort();
const flagsOf = (srv: FakeImapServer, path: string, subject: string) =>
  srv.mailbox(path).messages.find((m) => String(m.raw).includes(`Subject: ${subject}\r\n`))?.flags ?? [];
const byTitle = (h: Harness, accountId: string, subject: string) =>
  h.inboxMessages(accountId).find((m) => m.subject === subject)!;
const statusOf = async (h: Harness, accountId: string) =>
  ((await h.engine.handle('accounts.statuses', undefined)) as {
    accountId: string;
    state: string;
    pendingCount: number;
  }[]).find((s) => s.accountId === accountId)!;
const online = (h: Harness, accountId: string) =>
  waitFor('account online', async () => (await statusOf(h, accountId)).state === 'online');

describe('offline queue', () => {
  it('keeps changes made offline and sends them in order when the account is back', async () => {
    const { h, server: srv, acc } = await boot();
    await net(h, false);
    await waitFor('offline', async () => (await statusOf(h, acc.id)).state === 'offline');
    h.events.length = 0;

    const m1 = byTitle(h, acc.id, 'Msg 1');
    const m2 = byTitle(h, acc.id, 'Msg 2');
    const m3 = byTitle(h, acc.id, 'Msg 3');
    const m4 = byTitle(h, acc.id, 'Msg 4');
    const projects = h.folderByPath(acc.id, 'Projects');
    const trash = h.folderByRole(acc.id, 'trash');

    await apply(h, [m1.id], { type: 'markRead', read: true });
    await apply(h, [m2.id], { type: 'flag', flagged: true });
    await apply(h, [m3.id], { type: 'move', destFolderId: projects.id });
    await apply(h, [m4.id], { type: 'delete' }); // to Trash

    // Local state shows the changes at once, nothing was reverted, nothing reported as failed.
    expect(h.eventsOfType('action:failed')).toEqual([]);
    expect(h.engine.ctx.messages.row(m1.id)!.flag_seen).toBe(1);
    expect(h.folderMessages(projects.id).map((m) => m.id)).toEqual([m3.id]);
    expect(h.folderMessages(trash.id).map((m) => m.id)).toEqual([m4.id]);
    // The UI is told how many changes wait.
    expect((await statusOf(h, acc.id)).pendingCount).toBe(4);
    expect(h.eventsOfType('pending:count').at(-1)).toMatchObject({ accountId: acc.id, count: 4 });
    // The server has not seen anything.
    expect(flagsOf(srv, 'INBOX', 'Msg 1')).not.toContain('\\Seen');
    expect(subj(srv, 'INBOX')).toHaveLength(4);

    await net(h, true);
    await waitFor('queue empty', async () => (await statusOf(h, acc.id)).pendingCount === 0);
    await online(h, acc.id);
    await h.engine.actions.drain();

    expect(flagsOf(srv, 'INBOX', 'Msg 1')).toContain('\\Seen');
    expect(flagsOf(srv, 'INBOX', 'Msg 2')).toContain('\\Flagged');
    expect(subj(srv, 'Projects')).toEqual(['Msg 3']);
    expect(subj(srv, 'Trash')).toEqual(['Msg 4']);
    expect(subj(srv, 'INBOX')).toEqual(['Msg 1', 'Msg 2']);
    expect(h.eventsOfType('action:failed')).toEqual([]);
    expect(h.eventsOfType('pending:count').at(-1)).toMatchObject({ accountId: acc.id, count: 0 });
    // Moved rows got their real server uid (no placeholders left).
    expect(h.engine.ctx.messages.row(m3.id)!.uid).toBeGreaterThan(0);
    expect(h.engine.ctx.messages.row(m4.id)!.uid).toBeGreaterThan(0);
  });

  it('merges redundant changes: read then unread, move A to B to C, move away and back', async () => {
    const { h, server: srv, acc } = await boot();
    await net(h, false);
    await waitFor('offline', async () => (await statusOf(h, acc.id)).state === 'offline');

    const m1 = byTitle(h, acc.id, 'Msg 1');
    const m2 = byTitle(h, acc.id, 'Msg 2');
    const m3 = byTitle(h, acc.id, 'Msg 3');
    const inbox = h.folderByRole(acc.id, 'inbox');
    const projects = h.folderByPath(acc.id, 'Projects');
    const trash = h.folderByRole(acc.id, 'trash');
    const junk = h.folderByRole(acc.id, 'junk');

    // read then unread -> nothing
    await apply(h, [m1.id], { type: 'markRead', read: true });
    expect(h.engine.actions.count(acc.id)).toBe(1);
    await apply(h, [m1.id], { type: 'markRead', read: false });
    expect(h.engine.actions.count(acc.id)).toBe(0);

    // move to Projects, then to Trash -> one move (Inbox to Trash)
    await apply(h, [m2.id], { type: 'move', destFolderId: projects.id });
    await apply(h, [m2.id], { type: 'move', destFolderId: trash.id });
    expect(h.engine.actions.count(acc.id)).toBe(1);
    expect(h.folderMessages(trash.id).map((m) => m.id)).toEqual([m2.id]);
    expect(h.folderMessages(projects.id)).toEqual([]);

    // move away and back -> nothing, row sits in the Inbox with its old uid
    const origUid = m3.uid;
    await apply(h, [m3.id], { type: 'move', destFolderId: junk.id });
    expect(h.engine.actions.count(acc.id)).toBe(2);
    await apply(h, [m3.id], { type: 'move', destFolderId: inbox.id });
    expect(h.engine.actions.count(acc.id)).toBe(1);
    expect(h.engine.ctx.messages.row(m3.id)).toMatchObject({ folder_id: inbox.id, uid: origUid });

    await net(h, true);
    await waitFor('queue empty', async () => (await statusOf(h, acc.id)).pendingCount === 0);
    await online(h, acc.id);
    await h.engine.actions.drain();
    expect(subj(srv, 'Trash')).toEqual(['Msg 2']);
    expect(subj(srv, 'Projects')).toEqual([]);
    expect(subj(srv, 'Junk')).toEqual([]);
    expect(subj(srv, 'INBOX')).toEqual(['Msg 1', 'Msg 3', 'Msg 4']);
    expect(flagsOf(srv, 'INBOX', 'Msg 1')).not.toContain('\\Seen');
  });

  it('undo while offline cancels the waiting move', async () => {
    const { h, server: srv, acc } = await boot();
    await net(h, false);
    await waitFor('offline', async () => (await statusOf(h, acc.id)).state === 'offline');
    const m1 = byTitle(h, acc.id, 'Msg 1');
    const res = await apply(h, [m1.id], { type: 'delete' });
    expect(res.undoToken).toBeTruthy();
    expect(h.engine.actions.count(acc.id)).toBe(1);
    await h.engine.handle('messages.undo', { undoToken: res.undoToken });
    expect(h.engine.actions.count(acc.id)).toBe(0);
    expect(h.inboxMessages(acc.id).map((m) => m.id)).toContain(m1.id);
    await net(h, true);
    await online(h, acc.id);
    await h.engine.actions.drain();
    expect(subj(srv, 'INBOX')).toHaveLength(4);
    expect(subj(srv, 'Trash')).toEqual([]);
  });

  it('undo of a merged move goes back to where the user saw the message', async () => {
    const { h, server: srv, acc } = await boot();
    await net(h, false);
    await waitFor('offline', async () => (await statusOf(h, acc.id)).state === 'offline');
    const m1 = byTitle(h, acc.id, 'Msg 1');
    const projects = h.folderByPath(acc.id, 'Projects');
    const trash = h.folderByRole(acc.id, 'trash');
    await apply(h, [m1.id], { type: 'move', destFolderId: projects.id });
    const second = await apply(h, [m1.id], { type: 'move', destFolderId: trash.id });
    expect(h.engine.actions.count(acc.id)).toBe(1); // Inbox to Trash
    await h.engine.handle('messages.undo', { undoToken: second.undoToken });
    // Back in Projects (not in the Inbox): one move Inbox to Projects is waiting.
    expect(h.folderMessages(projects.id).map((m) => m.id)).toEqual([m1.id]);
    expect(h.engine.actions.count(acc.id)).toBe(1);
    await net(h, true);
    await waitFor('queue empty', () => h.engine.actions.count(acc.id) === 0);
    await online(h, acc.id);
    await h.engine.actions.drain();
    expect(subj(srv, 'Projects')).toEqual(['Msg 1']);
    expect(subj(srv, 'Trash')).toEqual([]);
  });

  it('survives an app restart in between', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'letterdock-restart-'));
    dirs.push(dir);
    const dbFile = join(dir, 'mail.db');
    const secrets = new Map<string, string>();
    const { h, server: srv, acc } = await boot({}, { dbFile, dataDir: dir, secrets });
    await net(h, false);
    await waitFor('offline', async () => (await statusOf(h, acc.id)).state === 'offline');
    const m1 = byTitle(h, acc.id, 'Msg 1');
    const m2 = byTitle(h, acc.id, 'Msg 2');
    const m3 = byTitle(h, acc.id, 'Msg 3');
    const projects = h.folderByPath(acc.id, 'Projects');
    await apply(h, [m1.id], { type: 'markRead', read: true });
    await apply(h, [m2.id], { type: 'flag', flagged: true });
    await apply(h, [m3.id], { type: 'move', destFolderId: projects.id });
    expect(h.engine.actions.count(acc.id)).toBe(3);

    // "Quit" the app.
    await h.engine.shutdown();
    harnesses.splice(harnesses.indexOf(h), 1);
    expect(flagsOf(srv, 'INBOX', 'Msg 1')).not.toContain('\\Seen');

    // "Start" it again on the same data: the queue is loaded, the account connects, the queue is sent.
    const h2 = await createHarness(srv, { dbFile, dataDir: dir, secrets });
    harnesses.push(h2);
    expect(h2.engine.actions.count(acc.id)).toBe(3);
    h2.engine.start();
    await waitFor('queue empty', () => h2.engine.actions.count(acc.id) === 0);
    await h2.engine.actions.drain();
    expect(flagsOf(srv, 'INBOX', 'Msg 1')).toContain('\\Seen');
    expect(flagsOf(srv, 'INBOX', 'Msg 2')).toContain('\\Flagged');
    expect(subj(srv, 'Projects')).toEqual(['Msg 3']);
    expect(h2.engine.ctx.messages.row(m3.id)!.uid).toBeGreaterThan(0);
    expect(h2.eventsOfType('action:failed')).toEqual([]);
  });

  it('a message deleted on the server meanwhile: the change is dropped and the row removed', async () => {
    const { h, server: srv, acc } = await boot();
    await net(h, false);
    await waitFor('offline', async () => (await statusOf(h, acc.id)).state === 'offline');
    const m1 = byTitle(h, acc.id, 'Msg 1');
    const m2 = byTitle(h, acc.id, 'Msg 2');
    const projects = h.folderByPath(acc.id, 'Projects');
    await apply(h, [m1.id], { type: 'markRead', read: true });
    await apply(h, [m2.id], { type: 'move', destFolderId: projects.id });
    h.events.length = 0;
    // Another mail program deletes both on the server.
    await srv.expunge('INBOX', m1.uid);
    await srv.expunge('INBOX', m2.uid);

    await net(h, true);
    await waitFor('queue empty', () => h.engine.actions.count(acc.id) === 0);
    await online(h, acc.id);
    await h.engine.actions.drain();
    expect(h.engine.ctx.messages.row(m1.id)).toBeNull();
    expect(h.engine.ctx.messages.row(m2.id)).toBeNull();
    expect(subj(srv, 'Projects')).toEqual([]);
    expect(h.eventsOfType('action:failed')).toEqual([]);
    const dropped = h.eventsOfType('pending:dropped');
    expect(dropped.map((d) => d.reason)).toEqual(['gone', 'gone']);
  });

  it('UIDVALIDITY changed: the message is found again by Message-ID', async () => {
    const { h, server: srv, acc } = await boot();
    await net(h, false);
    await waitFor('offline', async () => (await statusOf(h, acc.id)).state === 'offline');
    const m2 = byTitle(h, acc.id, 'Msg 2');
    const m3 = byTitle(h, acc.id, 'Msg 3');
    const projects = h.folderByPath(acc.id, 'Projects');
    await apply(h, [m2.id], { type: 'markRead', read: true });
    await apply(h, [m3.id], { type: 'move', destFolderId: projects.id });
    h.events.length = 0;
    // The server rebuilt the mailbox: new UIDVALIDITY, other uids, same messages (same Message-IDs).
    srv.resetMailbox('INBOX', [
      { raw: rawMessage({ subject: 'Msg 4', messageId: mid(4) }) },
      { raw: rawMessage({ subject: 'Msg 3', messageId: mid(3) }) },
      { raw: rawMessage({ subject: 'Msg 2', messageId: mid(2) }) },
      { raw: rawMessage({ subject: 'Msg 1', messageId: mid(1) }) },
    ]);

    await net(h, true);
    await waitFor('queue empty', () => h.engine.actions.count(acc.id) === 0);
    await online(h, acc.id);
    await h.engine.actions.drain();
    expect(flagsOf(srv, 'INBOX', 'Msg 2')).toContain('\\Seen');
    expect(subj(srv, 'Projects')).toEqual(['Msg 3']);
    expect(subj(srv, 'INBOX')).toEqual(['Msg 1', 'Msg 2', 'Msg 4']);
    expect(h.eventsOfType('pending:dropped')).toEqual([]);
    expect(h.eventsOfType('action:failed')).toEqual([]);
  });

  it('UIDVALIDITY changed and the message is not there any more: dropped with a notice', async () => {
    const { h, server: srv, acc } = await boot();
    await net(h, false);
    await waitFor('offline', async () => (await statusOf(h, acc.id)).state === 'offline');
    const m2 = byTitle(h, acc.id, 'Msg 2');
    await apply(h, [m2.id], { type: 'markRead', read: true });
    h.events.length = 0;
    srv.resetMailbox('INBOX', [{ raw: rawMessage({ subject: 'Brand new', messageId: '<new@x>' }) }]);

    await net(h, true);
    await waitFor('queue empty', () => h.engine.actions.count(acc.id) === 0);
    await online(h, acc.id);
    await h.engine.actions.drain();
    const dropped = h.eventsOfType('pending:dropped');
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toMatchObject({ accountId: acc.id, count: 1, reason: 'uidvalidity' });
    expect(h.eventsOfType('action:failed')).toEqual([]);
    expect(flagsOf(srv, 'INBOX', 'Brand new')).not.toContain('\\Seen');
  });

  it('a final refusal by the server reverts the change (and only that is reported)', async () => {
    const { h, server: srv, acc } = await boot();
    const m1 = byTitle(h, acc.id, 'Msg 1');
    srv.rejectCommands(['UID STORE']);
    h.events.length = 0;
    await apply(h, [m1.id], { type: 'markRead', read: true });
    await waitFor('failure', () => h.eventsOfType('action:failed').length > 0);
    expect(h.engine.ctx.messages.row(m1.id)!.flag_seen).toBe(0);
    expect(h.eventsOfType('action:failed')[0]!.error.retryable).toBe(false);
    expect(h.engine.actions.count(acc.id)).toBe(0);
  });

  it('a connection that breaks while sending keeps the change and sends it after the reconnect', async () => {
    const { h, server: srv, acc } = await boot();
    const m1 = byTitle(h, acc.id, 'Msg 1');
    srv.dropOnCommands(['UID STORE']); // the server hangs up when it receives the flag change
    h.events.length = 0;
    await apply(h, [m1.id], { type: 'markRead', read: true });
    await waitFor('send attempted', () =>
      (h.engine.ctx.db.prepare('SELECT attempts FROM pending_op').all() as { attempts: number }[]).some(
        (r) => r.attempts > 0,
      ),
    );
    // Not reverted, not reported: just waiting.
    expect(h.engine.ctx.messages.row(m1.id)!.flag_seen).toBe(1);
    expect(h.eventsOfType('action:failed')).toEqual([]);
    expect(h.engine.actions.count(acc.id)).toBe(1);
    srv.allowCommands();
    srv.dropConnections(); // make the idle connection notice too: the account reconnects
    await waitFor('sent after reconnect', () => h.engine.actions.count(acc.id) === 0, 20_000);
    expect(flagsOf(srv, 'INBOX', 'Msg 1')).toContain('\\Seen');
    expect(h.eventsOfType('action:failed')).toEqual([]);
  });

  it('a sync does not undo a flag change that was made offline', async () => {
    const { h, server: srv, acc } = await boot();
    const m1 = byTitle(h, acc.id, 'Msg 1');
    await net(h, false);
    await waitFor('offline', async () => (await statusOf(h, acc.id)).state === 'offline');
    await apply(h, [m1.id], { type: 'markRead', read: true });
    // Another client flags the same message on the server in the meantime.
    await srv.setFlags('INBOX', m1.uid, { add: ['\\Flagged'] });
    await net(h, true);
    await waitFor('queue empty', () => h.engine.actions.count(acc.id) === 0);
    await online(h, acc.id);
    await h.engine.sessions.get(acc.id).syncFolderById(h.folderByRole(acc.id, 'inbox').id);
    await h.engine.actions.drain();
    const row = h.engine.ctx.messages.row(m1.id)!;
    expect(row.flag_seen).toBe(1); // our change survived
    expect(row.flag_flagged).toBe(1); // the other client's change arrived
    expect(flagsOf(srv, 'INBOX', 'Msg 1')).toEqual(expect.arrayContaining(['\\Seen', '\\Flagged']));
  });

  it('removing the account clears its queue', async () => {
    const { h, acc } = await boot();
    await net(h, false);
    await waitFor('offline', async () => (await statusOf(h, acc.id)).state === 'offline');
    await apply(h, [byTitle(h, acc.id, 'Msg 1').id], { type: 'markRead', read: true });
    expect(h.engine.actions.count(acc.id)).toBe(1);
    await h.engine.handle('accounts.remove', { accountId: acc.id });
    expect(h.engine.actions.count(acc.id)).toBe(0);
    expect(h.engine.ctx.db.prepare('SELECT COUNT(*) AS n FROM pending_op').get()).toEqual({ n: 0 });
  });
});
