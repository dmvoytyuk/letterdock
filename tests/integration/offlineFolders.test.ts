// Offline queue, part 2 (ARCHITECTURE 5.6): folder create / rename / delete / empty, Archive without
// an Archive folder, "replied" marks, and reading a message whose move still waits. Every case that
// matters for data safety also runs with an app restart in between.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApplyActionRes, Folder, MessageBody } from '../../src/shared/ipc';
import {
  createHarness,
  waitFor,
  waitForInboxCursors,
  type Harness,
  type HarnessOptions,
} from '../fakes/engineHarness';
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

const mid = (n: number) => `<folders-${n}@fake.test>`;
const seed = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    raw: rawMessage({ subject: `Msg ${i + 1}`, messageId: mid(i + 1), text: `Body of message ${i + 1}` }),
  }));

async function boot(opts: FakeImapOptions = {}, hOpts: HarnessOptions = {}) {
  server = await startFakeImap({ inbox: seed(4), ...opts });
  const h = await createHarness(server, hOpts);
  harnesses.push(h);
  const acc = await h.addAccount();
  await waitFor('inbox synced', () => h.inboxMessages(acc.id).length === 4);
  await waitForInboxCursors(h, [acc.id]);
  await waitFor('trash row', () => h.engine.ctx.folders.rowByRole(acc.id, 'trash'));
  await waitFor('projects row', () => h.engine.ctx.folders.rowByPath(acc.id, 'Projects'));
  // Wait until every folder has had its first sync, so nothing is half done when we go offline.
  await waitFor('folders synced', () =>
    h.engine.ctx.folders
      .rowsForAccount(acc.id)
      .filter((f) => f.selectable === 1)
      .every((f) => f.uidvalidity !== null),
  );
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
const goOffline = async (h: Harness, accountId: string) => {
  await net(h, false);
  await waitFor('offline', async () => (await statusOf(h, accountId)).state === 'offline');
};
const goOnline = async (h: Harness, accountId: string) => {
  await net(h, true);
  await waitFor('queue empty', async () => (await statusOf(h, accountId)).pendingCount === 0);
  await waitFor('account online', async () => (await statusOf(h, accountId)).state === 'online');
  await h.engine.actions.drain();
};
const hasMailbox = (srv: FakeImapServer, path: string) => srv.raw.getMailbox(path) !== undefined;
const createFolder = (h: Harness, accountId: string, name: string, parentPath: string | null = null) =>
  h.engine.handle('folders.create', { accountId, parentPath, name }) as Promise<Folder>;
const renameFolder = (h: Harness, folderId: number, newName: string) =>
  h.engine.handle('folders.rename', { folderId, newName }) as Promise<Folder>;
const deleteFolder = (h: Harness, folderId: number) => h.engine.handle('folders.delete', { folderId });
const emptyFolder = (h: Harness, folderId: number) =>
  h.engine.handle('folders.empty', { folderId }) as Promise<{ deleted: number }>;
const pending = (h: Harness, accountId: string) => h.engine.actions.count(accountId);

/** "Quit" the app and start it again on the same data. */
async function restart(h: Harness, srv: FakeImapServer, dir: string, dbFile: string, secrets: Map<string, string>) {
  await h.engine.shutdown();
  harnesses.splice(harnesses.indexOf(h), 1);
  const h2 = await createHarness(srv, { dbFile, dataDir: dir, secrets });
  harnesses.push(h2);
  return h2;
}

async function persistent() {
  const dir = await mkdtemp(join(tmpdir(), 'letterdock-folders-'));
  dirs.push(dir);
  return { dir, dbFile: join(dir, 'mail.db'), secrets: new Map<string, string>() };
}

describe('folder changes made offline', () => {
  it('create, rename and delete wait in the queue and are sent in order', async () => {
    const { h, server: srv, acc } = await boot();
    await goOffline(h, acc.id);
    h.events.length = 0;

    const created = await createFolder(h, acc.id, 'Work');
    expect(created.path).toBe('Work');
    expect(h.folderByPath(acc.id, 'Work').id).toBe(created.id);
    expect(pending(h, acc.id)).toBe(1);
    expect(h.eventsOfType('folders:changed').length).toBeGreaterThan(0);

    const projects = h.folderByPath(acc.id, 'Projects');
    const renamed = await renameFolder(h, projects.id, 'Clients');
    expect(renamed.path).toBe('Clients');
    expect(renamed.id).toBe(projects.id);
    expect(pending(h, acc.id)).toBe(2);

    const junk = await createFolder(h, acc.id, 'Scratch');
    await deleteFolder(h, junk.id);
    expect(h.engine.ctx.folders.rowByPath(acc.id, 'Scratch')).toBeNull();
    expect(pending(h, acc.id)).toBe(2); // create + delete of a local-only folder cancel out

    expect(hasMailbox(srv, 'Work')).toBe(false);
    expect(hasMailbox(srv, 'Projects')).toBe(true);

    await goOnline(h, acc.id);
    expect(hasMailbox(srv, 'Work')).toBe(true);
    expect(hasMailbox(srv, 'Clients')).toBe(true);
    expect(hasMailbox(srv, 'Projects')).toBe(false);
    expect(hasMailbox(srv, 'Scratch')).toBe(false);
    expect(h.folderByPath(acc.id, 'Clients').id).toBe(projects.id);
    expect(h.engine.ctx.folders.rowByPath(acc.id, 'Projects')).toBeNull();
    expect(h.eventsOfType('folder:conflict')).toEqual([]);
  });

  it('create then rename sends one create with the final name; rename and back sends nothing', async () => {
    const { h, server: srv, acc } = await boot();
    await goOffline(h, acc.id);
    const f = await createFolder(h, acc.id, 'Draft name');
    await renameFolder(h, f.id, 'Final name');
    expect(pending(h, acc.id)).toBe(1);
    const projects = h.folderByPath(acc.id, 'Projects');
    await renameFolder(h, projects.id, 'Other');
    expect(pending(h, acc.id)).toBe(2);
    await renameFolder(h, projects.id, 'Projects');
    expect(pending(h, acc.id)).toBe(1);

    await goOnline(h, acc.id);
    expect(hasMailbox(srv, 'Final name')).toBe(true);
    expect(hasMailbox(srv, 'Draft name')).toBe(false);
    expect(hasMailbox(srv, 'Projects')).toBe(true);
    expect(hasMailbox(srv, 'Other')).toBe(false);
  });

  it('create then delete sends nothing at all', async () => {
    const { h, server: srv, acc } = await boot();
    await goOffline(h, acc.id);
    const f = await createFolder(h, acc.id, 'Gone soon');
    await deleteFolder(h, f.id);
    expect(pending(h, acc.id)).toBe(0);
    await goOnline(h, acc.id);
    expect(hasMailbox(srv, 'Gone soon')).toBe(false);
    expect(h.engine.ctx.folders.rowByPath(acc.id, 'Gone soon')).toBeNull();
  });

  it('a nested folder under a folder that is still local is created after its parent', async () => {
    const { h, server: srv, acc } = await boot();
    await goOffline(h, acc.id);
    const parent = await createFolder(h, acc.id, 'Parent');
    await createFolder(h, acc.id, 'Child', 'Parent');
    await renameFolder(h, parent.id, 'Renamed');
    expect(h.engine.ctx.folders.rowByPath(acc.id, 'Renamed/Child')).not.toBeNull();
    expect(pending(h, acc.id)).toBe(2);
    await goOnline(h, acc.id);
    expect(hasMailbox(srv, 'Renamed')).toBe(true);
    expect(hasMailbox(srv, 'Renamed/Child')).toBe(true);
    expect(hasMailbox(srv, 'Parent')).toBe(false);
  });

  it('a local-only folder is not synced and a folder refresh keeps all waiting changes', async () => {
    const { h, server: srv, acc } = await boot();
    // Online, but nothing is sent: the queue is stopped. A refresh must not undo the local changes.
    h.engine.actions.stop();
    const local = await createFolder(h, acc.id, 'Local only');
    const projects = h.folderByPath(acc.id, 'Projects');
    await renameFolder(h, projects.id, 'Renamed');
    const doomed = await createFolder(h, acc.id, 'Doomed');
    // Make a server folder and delete it locally.
    await srv.withClient((c) => c.mailboxCreate('Old stuff'));
    await h.engine.sessions.get(acc.id).discoverFolders();
    const old = h.folderByPath(acc.id, 'Old stuff');
    await deleteFolder(h, old.id);
    await h.engine.sessions.get(acc.id).syncAll();
    await h.engine.sessions.get(acc.id).discoverFolders();
    expect(h.folderByPath(acc.id, 'Local only').id).toBe(local.id);
    expect(h.folderByPath(acc.id, 'Renamed').id).toBe(projects.id);
    expect(h.engine.ctx.folders.rowByPath(acc.id, 'Projects')).toBeNull();
    expect(h.engine.ctx.folders.rowByPath(acc.id, 'Old stuff')).toBeNull();
    expect(h.folderByPath(acc.id, 'Doomed').id).toBe(doomed.id);
    expect(hasMailbox(srv, 'Local only')).toBe(false);
  });

  it('moves to a folder that is only local wait for its create and use the real path', async () => {
    const { h, server: srv, acc } = await boot();
    await goOffline(h, acc.id);
    const f = await createFolder(h, acc.id, 'Fresh');
    const m1 = byTitle(h, acc.id, 'Msg 1');
    const m2 = byTitle(h, acc.id, 'Msg 2');
    await apply(h, [m1.id], { type: 'move', destFolderId: f.id });
    await apply(h, [m2.id], { type: 'move', destFolderId: f.id });
    expect(h.folderMessages(f.id).map((m) => m.id).sort()).toEqual([m1.id, m2.id].sort());
    expect(pending(h, acc.id)).toBe(3);
    await renameFolder(h, f.id, 'Fresher'); // still local: just a new name
    expect(pending(h, acc.id)).toBe(3);

    await goOnline(h, acc.id);
    expect(subj(srv, 'Fresher')).toEqual(['Msg 1', 'Msg 2']);
    expect(hasMailbox(srv, 'Fresh')).toBe(false);
    expect(subj(srv, 'INBOX')).toEqual(['Msg 3', 'Msg 4']);
    expect(h.engine.ctx.messages.row(m1.id)!.uid).toBeGreaterThan(0);
    expect(h.engine.ctx.messages.row(m1.id)!.folder_id).toBe(f.id);
    expect(h.eventsOfType('action:failed')).toEqual([]);
  });

  it('deleting a local-only folder puts the messages moved into it back', async () => {
    const { h, server: srv, acc } = await boot();
    await goOffline(h, acc.id);
    const f = await createFolder(h, acc.id, 'Temp');
    const m1 = byTitle(h, acc.id, 'Msg 1');
    await apply(h, [m1.id], { type: 'move', destFolderId: f.id });
    await deleteFolder(h, f.id);
    expect(pending(h, acc.id)).toBe(0);
    expect(h.engine.ctx.messages.row(m1.id)).toMatchObject({
      folder_id: h.folderByRole(acc.id, 'inbox').id,
    });
    await goOnline(h, acc.id);
    expect(subj(srv, 'INBOX')).toHaveLength(4);
    expect(hasMailbox(srv, 'Temp')).toBe(false);
  });

  it('moves queued before a rename use the old name; messages moved out of a deleted folder still move', async () => {
    const { h, server: srv, acc } = await boot({ folders: { Projects: seed(1).map((m) => ({ raw: m.raw.replace('Msg 1', 'Proj 1').replace(mid(1), '<p1@x>') })) } });
    await waitFor('projects synced', () => h.folderMessages(h.folderByPath(acc.id, 'Projects').id).length === 1);
    await goOffline(h, acc.id);
    const projects = h.folderByPath(acc.id, 'Projects');
    const inbox = h.folderByRole(acc.id, 'inbox');
    const m1 = byTitle(h, acc.id, 'Msg 1');
    const p1 = h.folderMessages(projects.id)[0]!;
    await apply(h, [m1.id], { type: 'move', destFolderId: projects.id }); // Inbox to Projects
    await apply(h, [p1.id], { type: 'move', destFolderId: inbox.id }); // Projects to Inbox
    await renameFolder(h, projects.id, 'Moved away');
    await deleteFolder(h, projects.id);
    expect(h.engine.ctx.folders.rowByPath(acc.id, 'Moved away')).toBeNull();
    await goOnline(h, acc.id);
    expect(hasMailbox(srv, 'Projects')).toBe(false);
    expect(hasMailbox(srv, 'Moved away')).toBe(false);
    // Msg 1 was waiting to move into the folder: it goes back, it is not lost with the folder.
    // Proj 1 left the folder first and arrives in the Inbox.
    expect(subj(srv, 'INBOX')).toEqual(['Msg 1', 'Msg 2', 'Msg 3', 'Msg 4', 'Proj 1']);
    expect(h.eventsOfType('action:failed')).toEqual([]);
  });

  it('the wanted name is taken on the server: the folder keeps a numbered name and the UI is told', async () => {
    const { h, server: srv, acc } = await boot();
    await goOffline(h, acc.id);
    const projects = h.folderByPath(acc.id, 'Projects');
    await renameFolder(h, projects.id, 'Taken');
    const f = await createFolder(h, acc.id, 'Child', 'Taken');
    h.events.length = 0;
    await srv.withClient((c) => c.mailboxCreate('Taken'));
    await goOnline(h, acc.id);
    expect(hasMailbox(srv, 'Taken')).toBe(true);
    expect(hasMailbox(srv, 'Taken (2)')).toBe(true);
    expect(hasMailbox(srv, 'Taken (2)/Child')).toBe(true);
    expect(hasMailbox(srv, 'Projects')).toBe(false);
    expect(h.folderByPath(acc.id, 'Taken (2)').id).toBe(projects.id);
    expect(h.folderByPath(acc.id, 'Taken (2)/Child').id).toBe(f.id);
    const conflicts = h.eventsOfType('folder:conflict');
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      accountId: acc.id,
      op: 'rename',
      reason: 'exists',
      folderName: 'Taken',
      resolvedName: 'Taken (2)',
    });
  });

  it('the folder is gone on the server: the rename is dropped and the local folder removed', async () => {
    const { h, server: srv, acc } = await boot();
    await goOffline(h, acc.id);
    const projects = h.folderByPath(acc.id, 'Projects');
    await renameFolder(h, projects.id, 'Whatever');
    h.events.length = 0;
    await srv.withClient((c) => c.mailboxDelete('Projects'));
    await goOnline(h, acc.id);
    expect(h.engine.ctx.folders.rowByPath(acc.id, 'Whatever')).toBeNull();
    expect(h.engine.ctx.folders.row(projects.id)).toBeNull();
    expect(hasMailbox(srv, 'Whatever')).toBe(false);
    expect(h.eventsOfType('folder:conflict')).toMatchObject([{ op: 'rename', reason: 'gone' }]);
  });

  it('deleting a folder that is already gone on the server is fine', async () => {
    const { h, server: srv, acc } = await boot();
    await goOffline(h, acc.id);
    await deleteFolder(h, h.folderByPath(acc.id, 'Projects').id);
    await srv.withClient((c) => c.mailboxDelete('Projects'));
    await goOnline(h, acc.id);
    expect(hasMailbox(srv, 'Projects')).toBe(false);
    expect(h.eventsOfType('folder:conflict')).toEqual([]);
  });

  it('creating a folder somebody else created meanwhile uses that folder', async () => {
    const { h, server: srv, acc } = await boot();
    await goOffline(h, acc.id);
    const f = await createFolder(h, acc.id, 'Shared');
    await srv.withClient((c) => c.mailboxCreate('Shared'));
    await goOnline(h, acc.id);
    expect(h.folderByPath(acc.id, 'Shared').id).toBe(f.id);
    expect(h.engine.ctx.folders.rowsForAccount(acc.id).filter((r) => r.path === 'Shared')).toHaveLength(1);
    expect(h.eventsOfType('folder:conflict')).toEqual([]);
  });

  it('create, move into it, rename and delete survive a restart', async () => {
    const { dir, dbFile, secrets } = await persistent();
    const { h, server: srv, acc } = await boot({}, { dbFile, dataDir: dir, secrets });
    await goOffline(h, acc.id);
    const f = await createFolder(h, acc.id, 'Keep');
    const m1 = byTitle(h, acc.id, 'Msg 1');
    await apply(h, [m1.id], { type: 'move', destFolderId: f.id });
    const projects = h.folderByPath(acc.id, 'Projects');
    await renameFolder(h, projects.id, 'Clients');
    const tmp = await createFolder(h, acc.id, 'Tmp');
    expect(tmp.path).toBe('Tmp');
    expect(pending(h, acc.id)).toBe(4);

    const h2 = await restart(h, srv, dir, dbFile, secrets);
    expect(pending(h2, acc.id)).toBe(4);
    expect(h2.folderByPath(acc.id, 'Keep').id).toBe(f.id);
    await deleteFolder(h2, h2.folderByPath(acc.id, 'Tmp').id); // after the restart: cancels the create
    expect(pending(h2, acc.id)).toBe(4 - 1);
    h2.engine.start();
    await waitFor('queue empty', () => pending(h2, acc.id) === 0);
    await h2.engine.actions.drain();
    expect(subj(srv, 'Keep')).toEqual(['Msg 1']);
    expect(hasMailbox(srv, 'Clients')).toBe(true);
    expect(hasMailbox(srv, 'Projects')).toBe(false);
    expect(hasMailbox(srv, 'Tmp')).toBe(false);
    expect(h2.engine.ctx.messages.row(m1.id)!.uid).toBeGreaterThan(0);
  });
});

describe('Empty Trash while moves into Trash wait', () => {
  it('queued moves to Trash are sent first and then deleted; nothing comes back after a sync', async () => {
    const { h, server: srv, acc } = await boot({ folders: { Trash: seed(1).map((m) => ({ raw: m.raw.replace('Msg 1', 'Old trash').replace(mid(1), '<old@x>') })) } });
    const trash = h.folderByRole(acc.id, 'trash');
    await waitFor('trash synced', () => h.folderMessages(trash.id).length === 1);
    await goOffline(h, acc.id);
    const m1 = byTitle(h, acc.id, 'Msg 1');
    const m2 = byTitle(h, acc.id, 'Msg 2');
    await apply(h, [m1.id, m2.id], { type: 'delete' }); // to Trash
    expect(h.folderMessages(trash.id)).toHaveLength(3);
    const res = await emptyFolder(h, trash.id);
    expect(res.deleted).toBe(3);
    expect(h.folderMessages(trash.id)).toHaveLength(0);
    expect(h.folderByRole(acc.id, 'trash').totalCount).toBe(0);
    expect(subj(srv, 'Trash')).toEqual(['Old trash']); // the server has not been told yet

    await goOnline(h, acc.id);
    expect(subj(srv, 'Trash')).toEqual([]);
    expect(subj(srv, 'INBOX')).toEqual(['Msg 3', 'Msg 4']);
    await h.engine.sessions.get(acc.id).syncAll();
    await h.engine.actions.drain();
    expect(h.folderMessages(trash.id)).toHaveLength(0);
    expect(h.inboxMessages(acc.id).map((m) => m.subject).sort()).toEqual(['Msg 3', 'Msg 4']);
    expect(h.engine.ctx.messages.idsForFolder(trash.id)).toEqual([]);
    expect(h.eventsOfType('action:failed')).toEqual([]);
  });

  it('a sync while the empty still waits does not bring the old mail back, and a restart in between is fine', async () => {
    const { dir, dbFile, secrets } = await persistent();
    const { h, server: srv, acc } = await boot(
      { folders: { Trash: seed(2).map((m, i) => ({ raw: m.raw.replace(`Msg ${i + 1}`, `Dead ${i + 1}`).replace(mid(i + 1), `<d${i}@x>`) })) } },
      { dbFile, dataDir: dir, secrets },
    );
    const trash = h.folderByRole(acc.id, 'trash');
    await waitFor('trash synced', () => h.folderMessages(trash.id).length === 2);
    await goOffline(h, acc.id);
    const m1 = byTitle(h, acc.id, 'Msg 1');
    await apply(h, [m1.id], { type: 'delete' });
    await emptyFolder(h, trash.id);
    expect(pending(h, acc.id)).toBe(2);

    const h2 = await restart(h, srv, dir, dbFile, secrets);
    expect(pending(h2, acc.id)).toBe(2);
    expect(h2.folderMessages(trash.id)).toHaveLength(0);
    h2.engine.start();
    await waitFor('queue empty', () => pending(h2, acc.id) === 0);
    await h2.engine.actions.drain();
    await h2.engine.sessions.get(acc.id).syncAll();
    expect(subj(srv, 'Trash')).toEqual([]);
    expect(subj(srv, 'INBOX')).toEqual(['Msg 2', 'Msg 3', 'Msg 4']);
    expect(h2.folderMessages(trash.id)).toHaveLength(0);
    expect(h2.inboxMessages(acc.id)).toHaveLength(3);
  });

  it('a refusal by the server brings the hidden mail back', async () => {
    const { h, server: srv, acc } = await boot({ folders: { Trash: seed(1).map((m) => ({ raw: m.raw.replace('Msg 1', 'Keepme').replace(mid(1), '<k@x>') })) } });
    const trash = h.folderByRole(acc.id, 'trash');
    await waitFor('trash synced', () => h.folderMessages(trash.id).length === 1);
    srv.rejectCommands(['UID STORE', 'STORE']);
    h.events.length = 0;
    await emptyFolder(h, trash.id).catch((e) => e);
    await waitFor('failure reported', () => h.eventsOfType('action:failed').length > 0);
    expect(h.folderMessages(trash.id)).toHaveLength(1);
    expect(h.eventsOfType('folder:conflict')).toMatchObject([{ op: 'empty', reason: 'refused' }]);
    expect(pending(h, acc.id)).toBe(0);
  });

  it('online, folders.empty still finishes before it returns', async () => {
    const { h, server: srv, acc } = await boot({ folders: { Trash: seed(2) } });
    const trash = h.folderByRole(acc.id, 'trash');
    await waitFor('trash synced', () => h.folderMessages(trash.id).length === 2);
    const res = await emptyFolder(h, trash.id);
    expect(res.deleted).toBe(2);
    expect(srv.mailbox('Trash').messages).toHaveLength(0);
    expect(h.folderMessages(trash.id)).toHaveLength(0);
  });
});

describe('Archive without an Archive folder', () => {
  it('offline: the folder is created and the message moved when the account is back', async () => {
    const { h, server: srv, acc } = await boot({ omitFolders: ['Archive'] });
    expect(h.engine.ctx.folders.rowByRole(acc.id, 'archive')).toBeNull();
    await goOffline(h, acc.id);
    const m1 = byTitle(h, acc.id, 'Msg 1');
    const m2 = byTitle(h, acc.id, 'Msg 2');
    const r1 = await apply(h, [m1.id], { type: 'archive' });
    expect(r1.failed).toEqual([]);
    const r2 = await apply(h, [m2.id], { type: 'archive' });
    expect(r2.failed).toEqual([]);
    const archive = h.folderByRole(acc.id, 'archive');
    expect(h.folderMessages(archive.id).map((m) => m.id).sort()).toEqual([m1.id, m2.id].sort());
    expect(pending(h, acc.id)).toBe(3); // one create + two moves
    expect(hasMailbox(srv, 'Archive')).toBe(false);

    await goOnline(h, acc.id);
    expect(subj(srv, 'Archive')).toEqual(['Msg 1', 'Msg 2']);
    expect(subj(srv, 'INBOX')).toEqual(['Msg 3', 'Msg 4']);
    expect(h.folderByRole(acc.id, 'archive').id).toBe(archive.id);
    expect(h.engine.ctx.folders.rowsForAccount(acc.id).filter((r) => r.role === 'archive')).toHaveLength(1);
    expect(h.eventsOfType('action:failed')).toEqual([]);
  });

  it('survives a restart in between', async () => {
    const { dir, dbFile, secrets } = await persistent();
    const { h, server: srv, acc } = await boot({ omitFolders: ['Archive'] }, { dbFile, dataDir: dir, secrets });
    await goOffline(h, acc.id);
    const m1 = byTitle(h, acc.id, 'Msg 1');
    await apply(h, [m1.id], { type: 'archive' });
    expect(pending(h, acc.id)).toBe(2);
    const h2 = await restart(h, srv, dir, dbFile, secrets);
    h2.engine.start();
    await waitFor('queue empty', () => pending(h2, acc.id) === 0);
    await h2.engine.actions.drain();
    expect(subj(srv, 'Archive')).toEqual(['Msg 1']);
    expect(h2.engine.ctx.messages.row(m1.id)!.uid).toBeGreaterThan(0);
  });

  it('online it still works at once', async () => {
    const { h, server: srv, acc } = await boot({ omitFolders: ['Archive'] });
    const m1 = byTitle(h, acc.id, 'Msg 1');
    await apply(h, [m1.id], { type: 'archive' });
    await waitFor('archived', () => subj(srv, 'Archive').length === 1);
    await h.engine.actions.drain();
    expect(subj(srv, 'Archive')).toEqual(['Msg 1']);
  });
});

describe('replied marks and reading a message whose move waits', () => {
  it('markReplied on a message with a waiting move is applied after the move', async () => {
    const { h, server: srv, acc } = await boot();
    await goOffline(h, acc.id);
    const m1 = byTitle(h, acc.id, 'Msg 1');
    const projects = h.folderByPath(acc.id, 'Projects');
    await apply(h, [m1.id], { type: 'move', destFolderId: projects.id });
    expect(h.engine.ctx.messages.row(m1.id)!.uid).toBeLessThan(0);
    h.engine.actions.markReplied(m1.id, 'answered');
    expect(h.engine.ctx.messages.row(m1.id)!.flag_answered).toBe(1);
    expect(pending(h, acc.id)).toBe(2);
    await goOnline(h, acc.id);
    expect(subj(srv, 'Projects')).toEqual(['Msg 1']);
    expect(flagsOf(srv, 'Projects', 'Msg 1')).toContain('\\Answered');
  });

  it('markReplied offline is sent later, also after a restart; forwards use $Forwarded', async () => {
    const { dir, dbFile, secrets } = await persistent();
    const { h, server: srv, acc } = await boot({}, { dbFile, dataDir: dir, secrets });
    await goOffline(h, acc.id);
    const m2 = byTitle(h, acc.id, 'Msg 2');
    const m3 = byTitle(h, acc.id, 'Msg 3');
    h.engine.actions.markReplied(m2.id, 'answered');
    h.engine.actions.markReplied(m3.id, 'forwarded');
    expect(pending(h, acc.id)).toBe(2);
    const h2 = await restart(h, srv, dir, dbFile, secrets);
    expect(pending(h2, acc.id)).toBe(2);
    h2.engine.start();
    await waitFor('queue empty', () => pending(h2, acc.id) === 0);
    await h2.engine.actions.drain();
    expect(flagsOf(srv, 'INBOX', 'Msg 2')).toContain('\\Answered');
    expect(flagsOf(srv, 'INBOX', 'Msg 3')).toContain('$Forwarded');
  });

  it('a body that is not cached opens from the original folder while its move waits', async () => {
    const { h, server: srv, acc } = await boot();
    // Online, but the queue is stopped: the move stays queued.
    h.engine.actions.stop();
    const m1 = byTitle(h, acc.id, 'Msg 1');
    const projects = h.folderByPath(acc.id, 'Projects');
    await apply(h, [m1.id], { type: 'move', destFolderId: projects.id });
    expect(h.engine.ctx.messages.row(m1.id)!.uid).toBeLessThan(0);
    expect(h.engine.ctx.messages.row(m1.id)!.body_state).not.toBe('cached');
    const body = (await h.engine.handle('messages.get', { messageId: m1.id })) as MessageBody;
    expect(body.text).toContain('Body of message 1');
    const raw = (await h.engine.handle('messages.rawSource', { messageId: m1.id })) as { source: string };
    expect(raw.source).toContain('Subject: Msg 1');
    expect(subj(srv, 'INBOX')).toHaveLength(4); // the move has not happened
  });

  it('after a folder was rebuilt on the server, the waiting message is found by Message-ID', async () => {
    const { h, server: srv, acc } = await boot();
    h.engine.actions.stop();
    const m2 = byTitle(h, acc.id, 'Msg 2');
    await apply(h, [m2.id], { type: 'move', destFolderId: h.folderByPath(acc.id, 'Projects').id });
    srv.resetMailbox('INBOX', [
      { raw: rawMessage({ subject: 'Msg 4', messageId: mid(4) }) },
      { raw: rawMessage({ subject: 'Msg 2', messageId: mid(2), text: 'Body of message 2' }) },
    ]);
    const body = (await h.engine.handle('messages.get', { messageId: m2.id })) as MessageBody;
    expect(body.text).toContain('Body of message 2');
  });
});
