// A move/delete that the server answers with NO: find out why before undoing the change.
// A message that is already gone is "done"; a "try again later" answer waits; only a real refusal
// reverts the change (Gmail-like cases).
import { afterEach, describe, expect, it } from 'vitest';
import type { ApplyActionRes } from '../../src/shared/ipc';
import { createHarness, waitFor, waitForInboxCursors, type Harness } from '../fakes/engineHarness';
import { rawMessage, startFakeImap, type FakeImapServer } from '../fakes/fakeImapServer';

let server: FakeImapServer | null = null;
const harnesses: Harness[] = [];

afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.cleanup();
  await server?.close().catch(() => undefined);
  server = null;
});

const seed = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    raw: rawMessage({ subject: `Msg ${i + 1}`, messageId: `<refused-${i + 1}@fake.test>` }),
  }));

async function boot() {
  server = await startFakeImap({ inbox: seed(4), gmailLayout: true });
  const h = await createHarness(server);
  harnesses.push(h);
  const acc = await h.addAccount();
  await waitFor('inbox synced', () => h.inboxMessages(acc.id).length === 4);
  await waitForInboxCursors(h, [acc.id]);
  await waitFor('trash row', () => h.engine.ctx.folders.rowByRole(acc.id, 'trash'));
  await h.engine.actions.drain();
  return { h, srv: server!, acc };
}

const apply = (h: Harness, messageIds: number[], action: object) =>
  h.engine.handle('messages.apply', { messageIds, action }) as Promise<ApplyActionRes>;
const byTitle = (h: Harness, accountId: string, subject: string) =>
  h.inboxMessages(accountId).find((m) => m.subject === subject)!;
const subjects = (srv: FakeImapServer, path: string) =>
  srv
    .mailbox(path)
    .messages.map((m) => /Subject: (.*)\r?\n/.exec(String(m.raw))?.[1] ?? '?')
    .sort();
/** Take a message out of a mailbox without telling the client (another client expunged it). */
const vanish = (srv: FakeImapServer, path: string, uids: number[]) => () => {
  const box = srv.mailbox(path);
  for (const u of uids) {
    const i = box.messages.findIndex((m) => m.uid === u);
    if (i >= 0) box.messages.splice(i, 1);
  }
};
const trashOf = (h: Harness, accountId: string) => h.folderByRole(accountId, 'trash');
const del = (h: Harness, ids: number[], accountId: string) =>
  apply(h, ids, { type: 'move', destFolderId: trashOf(h, accountId).id });

describe('refused moves and deletes', () => {
  it('a message that another client expunged in the meantime counts as done, not as a refusal', async () => {
    const { h, srv, acc } = await boot();
    const m1 = byTitle(h, acc.id, 'Msg 1');
    srv.rejectNext(['UID MOVE'], { before: vanish(srv, 'INBOX', [m1.uid]) });
    h.events.length = 0;
    await del(h, [m1.id], acc.id);
    await waitFor('queue empty', () => h.engine.actions.count(acc.id) === 0);
    expect(h.eventsOfType('action:failed')).toEqual([]);
    expect(h.engine.ctx.messages.row(m1.id)).toBeFalsy();
    expect(subjects(srv, 'Trash')).toEqual([]);
  });

  it('one gone message in a batch does not stop the others', async () => {
    const { h, srv, acc } = await boot();
    const [m1, m2, m3] = ['Msg 1', 'Msg 2', 'Msg 3'].map((s) => byTitle(h, acc.id, s));
    srv.rejectNext(['UID MOVE'], { before: vanish(srv, 'INBOX', [m2!.uid]) });
    h.events.length = 0;
    await del(h, [m1!.id, m2!.id, m3!.id], acc.id);
    await waitFor('queue empty', () => h.engine.actions.count(acc.id) === 0);
    await h.engine.actions.drain();
    expect(h.eventsOfType('action:failed')).toEqual([]);
    expect(subjects(srv, 'Trash')).toEqual(['Msg 1', 'Msg 3']);
    expect(h.engine.ctx.messages.row(m2!.id)).toBeFalsy();
  });

  it('deleting the same message twice quickly moves it once and reports nothing', async () => {
    const { h, srv, acc } = await boot();
    const m1 = byTitle(h, acc.id, 'Msg 1');
    h.events.length = 0;
    await Promise.all([del(h, [m1.id], acc.id), del(h, [m1.id], acc.id)]);
    await waitFor('queue empty', () => h.engine.actions.count(acc.id) === 0);
    await h.engine.actions.drain();
    expect(h.eventsOfType('action:failed')).toEqual([]);
    expect(subjects(srv, 'Trash')).toEqual(['Msg 1']);
    expect(subjects(srv, 'INBOX')).not.toContain('Msg 1');
  });

  it('a delete sent right after the connection dropped still lands in Trash', async () => {
    const { h, srv, acc } = await boot();
    const m1 = byTitle(h, acc.id, 'Msg 1');
    h.events.length = 0;
    srv.dropConnections();
    await del(h, [m1.id], acc.id);
    await waitFor('moved', () => subjects(srv, 'Trash').includes('Msg 1'), 20_000);
    await waitFor('queue empty', () => h.engine.actions.count(acc.id) === 0);
    expect(h.eventsOfType('action:failed')).toEqual([]);
  });

  it('a "try again later" answer keeps the change instead of undoing it', async () => {
    const { h, srv, acc } = await boot();
    const m1 = byTitle(h, acc.id, 'Msg 1');
    srv.rejectNext(['UID MOVE'], { code: 'UNAVAILABLE', text: 'Temporary System Error' });
    h.events.length = 0;
    await del(h, [m1.id], acc.id);
    await waitFor('attempted', () =>
      (h.engine.ctx.db.prepare('SELECT attempts FROM pending_op').all() as { attempts: number }[]).some(
        (r) => r.attempts > 0,
      ),
    );
    expect(h.eventsOfType('action:failed')).toEqual([]);
    expect(h.engine.actions.count(acc.id)).toBe(1);
    expect(h.engine.ctx.messages.row(m1.id)!.folder_id).toBe(trashOf(h, acc.id).id); // still shown as deleted
  });

  it('a missing target folder (TRYCREATE) is created and the move is sent again', async () => {
    const { h, srv, acc } = await boot();
    const m1 = byTitle(h, acc.id, 'Msg 1');
    srv.rejectNext(['UID MOVE'], { code: 'TRYCREATE', text: 'No such mailbox' });
    h.events.length = 0;
    await del(h, [m1.id], acc.id);
    await waitFor('queue empty', () => h.engine.actions.count(acc.id) === 0);
    expect(h.eventsOfType('action:failed')).toEqual([]);
    expect(subjects(srv, 'Trash')).toEqual(['Msg 1']);
  });

  it('a real refusal undoes the delete, says "delete" and carries what the server said', async () => {
    const { h, srv, acc } = await boot();
    const m1 = byTitle(h, acc.id, 'Msg 1');
    srv.rejectNext(['UID MOVE'], { times: 10, code: 'NOPERM', text: 'Permission denied' });
    h.events.length = 0;
    await del(h, [m1.id], acc.id);
    await waitFor('failure', () => h.eventsOfType('action:failed').length > 0);
    const f = h.eventsOfType('action:failed')[0]!;
    expect(f.kind).toBe('delete');
    expect(f.error.retryable).toBe(false);
    expect(f.error.message).toContain('Permission denied');
    expect(h.engine.ctx.messages.row(m1.id)!.folder_id).toBe(h.folderByRole(acc.id, 'inbox').id);
    expect(h.engine.actions.count(acc.id)).toBe(0);
    expect(subjects(srv, 'INBOX')).toContain('Msg 1');
  });
});
