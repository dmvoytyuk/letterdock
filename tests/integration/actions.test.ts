// Engine integration: move / delete / archive / spam / undo / mark all read / empty folder,
// against the in-process IMAP server, with and without MOVE and UIDPLUS.
import { afterEach, describe, expect, it } from 'vitest';
import type { ApplyActionRes } from '../../src/shared/ipc';
import { createHarness, waitFor, type Harness } from '../fakes/engineHarness';
import {
  DEFAULT_PLUGINS,
  rawMessage,
  startFakeImap,
  type FakeImapOptions,
  type FakeImapServer,
} from '../fakes/fakeImapServer';

let server: FakeImapServer | null = null;
let h: Harness | null = null;

afterEach(async () => {
  await h?.cleanup();
  await server?.close().catch(() => undefined);
  h = null;
  server = null;
});

const seed = (n: number, prefix = 'Msg') =>
  Array.from({ length: n }, (_, i) => ({ raw: rawMessage({ subject: `${prefix} ${i + 1}` }) }));

async function boot(opts: FakeImapOptions = {}, accountOver: Record<string, unknown> = {}) {
  server = await startFakeImap({ inbox: seed(3), ...opts });
  h = await createHarness(server);
  const acc = await h.addAccount(accountOver);
  await waitFor('inbox synced', () => h!.inboxMessages(acc.id).length === (opts.inbox ?? seed(3)).length);
  // Wait for the other folders so that trash/archive/junk rows exist with sync state.
  await waitFor('folders listed', () => h!.engine.ctx.folders.rowByRole(acc.id, 'trash'));
  await h.engine.actions.drain();
  return { h, server, acc };
}

const apply = (hh: Harness, messageIds: number[], action: object) =>
  hh.engine.handle('messages.apply', { messageIds, action }) as Promise<ApplyActionRes>;

const serverSubjects = (srv: FakeImapServer, path: string) =>
  srv
    .mailbox(path)
    .messages.map((m) => /Subject: (.*)\r?\n/.exec(String(m.raw))?.[1] ?? '?')
    .sort();

const PLUGIN_SETS: [string, string[]][] = [
  ['with MOVE + UIDPLUS', DEFAULT_PLUGINS],
  ['without MOVE (COPY + delete)', DEFAULT_PLUGINS.filter((p) => p !== 'MOVE')],
];

describe.each(PLUGIN_SETS)('moving messages %s', (_label, plugins) => {
  it('move: the row changes folder at once, keeps its id, and the server follows', async () => {
    const ctx = await boot({ plugins });
    const acc = ctx.acc;
    const msg = ctx.h.inboxMessages(acc.id).find((m) => m.subject === 'Msg 2')!;
    const projects = ctx.h.folderByPath(acc.id, 'Projects');

    const res = await apply(ctx.h, [msg.id], { type: 'move', destFolderId: projects.id });
    expect(res.succeeded).toEqual([msg.id]);
    expect(res.undoToken).toBeTruthy();
    // Optimistic: already in Projects locally.
    expect(ctx.h.folderMessages(projects.id).map((m) => m.id)).toEqual([msg.id]);
    expect(ctx.h.inboxMessages(acc.id).map((m) => m.id)).not.toContain(msg.id);

    await ctx.h.engine.actions.drain();
    expect(serverSubjects(ctx.server, 'Projects')).toEqual(['Msg 2']);
    expect(serverSubjects(ctx.server, 'INBOX')).toEqual(['Msg 1', 'Msg 3']);
    // Real UID is stored (not the negative placeholder) and matches the server.
    const row = ctx.h.engine.ctx.messages.row(msg.id)!;
    const serverUid = ctx.server.mailbox('Projects').messages[0]!.uid;
    expect(row.uid).toBe(serverUid);
    expect(ctx.h.folderByRole(acc.id, 'inbox').unreadCount).toBe(2);
  });

  it('delete: Inbox -> Trash, then Trash -> gone for good', async () => {
    const ctx = await boot({ plugins });
    const acc = ctx.acc;
    const msg = ctx.h.inboxMessages(acc.id)[0]!;
    await apply(ctx.h, [msg.id], { type: 'delete' });
    await ctx.h.engine.actions.drain();
    expect(ctx.server.mailbox('Trash').messages).toHaveLength(1);
    expect(ctx.server.mailbox('INBOX').messages).toHaveLength(2);

    const trash = ctx.h.folderByRole(acc.id, 'trash');
    const inTrash = ctx.h.folderMessages(trash.id);
    expect(inTrash.map((m) => m.id)).toEqual([msg.id]);
    const res = await apply(ctx.h, [msg.id], { type: 'delete' });
    expect(res.undoToken).toBeUndefined(); // permanent: no undo
    expect(ctx.h.folderMessages(trash.id)).toHaveLength(0); // hidden at once
    await ctx.h.engine.actions.drain();
    expect(ctx.server.mailbox('Trash').messages).toHaveLength(0);
    expect(ctx.h.engine.ctx.messages.row(msg.id)).toBeNull();
  });

  it('archive moves to the Archive folder; spam / not spam go to Junk and back', async () => {
    const ctx = await boot({ plugins });
    const acc = ctx.acc;
    const [a, b] = ctx.h.inboxMessages(acc.id);
    await apply(ctx.h, [a!.id], { type: 'archive' });
    await apply(ctx.h, [b!.id], { type: 'spam' });
    await ctx.h.engine.actions.drain();
    expect(ctx.server.mailbox('Archive').messages).toHaveLength(1);
    expect(ctx.server.mailbox('Junk').messages).toHaveLength(1);

    await apply(ctx.h, [b!.id], { type: 'notSpam' });
    await ctx.h.engine.actions.drain();
    expect(ctx.server.mailbox('Junk').messages).toHaveLength(0);
    expect(ctx.server.mailbox('INBOX').messages).toHaveLength(2);
    expect(ctx.h.inboxMessages(acc.id).map((m) => m.id)).toContain(b!.id);
  });

  it('undo puts the message back where it was', async () => {
    const ctx = await boot({ plugins });
    const acc = ctx.acc;
    const msg = ctx.h.inboxMessages(acc.id)[0]!;
    const res = await apply(ctx.h, [msg.id], { type: 'delete' });
    await ctx.h.engine.actions.drain();
    expect(ctx.server.mailbox('INBOX').messages).toHaveLength(2);

    const undone = (await ctx.h.engine.handle('messages.undo', {
      undoToken: res.undoToken,
    })) as { restored: number[] };
    expect(undone.restored).toEqual([msg.id]);
    await ctx.h.engine.actions.drain();
    expect(ctx.server.mailbox('INBOX').messages).toHaveLength(3);
    expect(ctx.server.mailbox('Trash').messages).toHaveLength(0);
    expect(ctx.h.inboxMessages(acc.id).map((m) => m.id)).toContain(msg.id);
    // A token works once.
    await expect(
      ctx.h.engine.handle('messages.undo', { undoToken: res.undoToken }),
    ).rejects.toMatchObject({ appError: { code: 'NOT_FOUND' } });
  });
});

describe('moves on a server without UIDPLUS', () => {
  it('still moves, and undo finds the message again by its Message-ID', async () => {
    const plugins = DEFAULT_PLUGINS.filter((p) => p !== 'UIDPLUS' && p !== 'MOVE');
    const ctx = await boot({ plugins });
    const acc = ctx.acc;
    const msg = ctx.h.inboxMessages(acc.id)[0]!;
    const res = await apply(ctx.h, [msg.id], { type: 'delete' });
    await ctx.h.engine.actions.drain();
    expect(ctx.server.mailbox('Trash').messages).toHaveLength(1);

    const undone = (await ctx.h.engine.handle('messages.undo', {
      undoToken: res.undoToken,
    })) as { restored: number[] };
    expect(undone.restored).toHaveLength(1);
    await ctx.h.engine.actions.drain();
    expect(ctx.server.mailbox('INBOX').messages).toHaveLength(3);
    expect(ctx.server.mailbox('Trash').messages).toHaveLength(0);
  });
});

describe('special cases', () => {
  it('archive creates an Archive folder when the account has none', async () => {
    const ctx = await boot({});
    const acc = ctx.acc;
    // Remove Archive on the server and let the app notice.
    await ctx.server.withClient((c) => c.mailboxDelete('Archive'));
    await ctx.h.engine.sessions.get(acc.id).discoverFolders();
    expect(ctx.h.engine.ctx.folders.rowByRole(acc.id, 'archive')).toBeNull();

    const msg = ctx.h.inboxMessages(acc.id)[0]!;
    const res = await apply(ctx.h, [msg.id], { type: 'archive' });
    expect(res.failed).toEqual([]);
    await ctx.h.engine.actions.drain();
    expect(ctx.h.engine.ctx.folders.rowByRole(acc.id, 'archive')).not.toBeNull();
    expect(ctx.server.mailbox('Archive').messages).toHaveLength(1);
  });

  it('Gmail archive moves to All Mail (the Inbox label goes away)', async () => {
    const ctx = await boot({ gmailLayout: true }, { email: 'me@gmail.com' });
    const acc = ctx.acc;
    expect(acc.provider).toBe('gmail');
    await waitFor('all mail listed', () => ctx.h.engine.ctx.folders.rowByRole(acc.id, 'all'));
    const msg = ctx.h.inboxMessages(acc.id)[0]!;
    await apply(ctx.h, [msg.id], { type: 'archive' });
    await ctx.h.engine.actions.drain();
    expect(ctx.server.mailbox('All Mail').messages).toHaveLength(1);
    expect(ctx.server.mailbox('INBOX').messages).toHaveLength(2);
    expect(ctx.server.mailbox('Archive').messages).toHaveLength(0);
  });

  it('refuses to move messages between accounts', async () => {
    const ctx = await boot({});
    const second = await ctx.h.addAccount({ email: 'other@example.com' });
    await waitFor('second synced', () => ctx.h.engine.ctx.folders.rowByRole(second.id, 'inbox'));
    const msg = ctx.h.inboxMessages(ctx.acc.id)[0]!;
    const foreign = ctx.h.folderByPath(second.id, 'Projects');
    const res = await apply(ctx.h, [msg.id], { type: 'move', destFolderId: foreign.id });
    expect(res.succeeded).toEqual([]);
    expect(res.failed[0]!.error.code).toBe('INVALID_INPUT');
  });

  it('a move the server refuses is reverted and reported', async () => {
    const ctx = await boot({});
    const acc = ctx.acc;
    const msg = ctx.h.inboxMessages(acc.id)[0]!;
    const inbox = ctx.h.folderByRole(acc.id, 'inbox');
    const projects = ctx.h.folderByPath(acc.id, 'Projects');
    // The server refuses every move (e.g. no permission): a final answer, not a connection problem.
    ctx.server.rejectCommands(['UID MOVE', 'UID COPY']);
    ctx.h.events.length = 0;
    await apply(ctx.h, [msg.id], { type: 'move', destFolderId: projects.id });
    await waitFor('revert + failure event', () => ctx.h.eventsOfType('action:failed').length > 0);
    const failed = ctx.h.eventsOfType('action:failed')[0]!;
    expect(failed.messageIds).toEqual([msg.id]);
    expect(failed.error.retryable).toBe(false);
    expect(ctx.h.engine.ctx.messages.row(msg.id)!.folder_id).toBe(inbox.id);
    expect(ctx.h.engine.ctx.messages.row(msg.id)!.uid).toBe(msg.uid);
    expect(ctx.h.engine.actions.count(acc.id)).toBe(0);
  });

  it('a permanent delete the server refuses brings the message back', async () => {
    const ctx = await boot({ folders: { Trash: seed(1, 'Old') } });
    const acc = ctx.acc;
    await waitFor('trash synced', () => {
      const t = ctx.h.folderByRole(acc.id, 'trash');
      return ctx.h.folderMessages(t.id).length === 1;
    });
    const trash = ctx.h.folderByRole(acc.id, 'trash');
    const [old] = ctx.h.folderMessages(trash.id);
    ctx.server.rejectCommands(['UID STORE']);
    await apply(ctx.h, [old!.id], { type: 'delete' });
    await waitFor('failure event', () => ctx.h.eventsOfType('action:failed').length > 0);
    expect(ctx.h.folderMessages(trash.id).map((m) => m.id)).toEqual([old!.id]);
    expect(ctx.h.engine.actions.count(acc.id)).toBe(0);
  });

  it('markAllRead marks every unread message in the scope, on the server too', async () => {
    const ctx = await boot({});
    const acc = ctx.acc;
    const inbox = ctx.h.folderByRole(acc.id, 'inbox');
    const res = (await ctx.h.engine.handle('messages.markAllRead', {
      scope: { kind: 'folder', folderId: inbox.id },
    })) as { count: number };
    expect(res.count).toBe(3);
    await ctx.h.engine.actions.drain();
    expect(ctx.server.mailbox('INBOX').messages.every((m) => m.flags.includes('\\Seen'))).toBe(true);
    expect(ctx.h.folderByRole(acc.id, 'inbox').unreadCount).toBe(0);
    const again = (await ctx.h.engine.handle('messages.markAllRead', {
      scope: { kind: 'account', accountId: acc.id },
    })) as { count: number };
    expect(again.count).toBe(0);
  });

  it('folders.empty wipes Trash on the server and locally, but refuses other folders', async () => {
    const ctx = await boot({ folders: { Trash: seed(2, 'Dead') } });
    const acc = ctx.acc;
    const trash = ctx.h.folderByRole(acc.id, 'trash');
    await waitFor('trash synced', () => ctx.h.folderMessages(trash.id).length === 2);
    const res = (await ctx.h.engine.handle('folders.empty', { folderId: trash.id })) as {
      deleted: number;
    };
    expect(res.deleted).toBe(2);
    expect(ctx.server.mailbox('Trash').messages).toHaveLength(0);
    expect(ctx.h.folderMessages(trash.id)).toHaveLength(0);

    const inbox = ctx.h.folderByRole(acc.id, 'inbox');
    await expect(ctx.h.engine.handle('folders.empty', { folderId: inbox.id })).rejects.toMatchObject({
      appError: { code: 'INVALID_INPUT' },
    });
  });

  it('a server-side move made while the sync runs does not duplicate the row', async () => {
    const ctx = await boot({});
    const acc = ctx.acc;
    const msg = ctx.h.inboxMessages(acc.id)[0]!;
    await apply(ctx.h, [msg.id], { type: 'delete' });
    // A sync of both folders right now must not leave two copies behind.
    await ctx.h.engine.handle('sync.all', undefined);
    await ctx.h.engine.actions.drain();
    await ctx.h.engine.sessions.get(acc.id).syncAll();
    const trash = ctx.h.folderByRole(acc.id, 'trash');
    const inboxIds = ctx.h.inboxMessages(acc.id).map((m) => m.id);
    expect(inboxIds).not.toContain(msg.id);
    expect(ctx.h.inboxMessages(acc.id)).toHaveLength(2);
    expect(ctx.h.folderMessages(trash.id)).toHaveLength(1);
  });
});
