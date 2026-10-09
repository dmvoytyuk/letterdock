// Engine integration: sorting conversations (sender, subject, date, both directions, paging) and
// deleting conversations / messages for good (confirm step, no undo, offline queue, Gmail via Trash).
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ApplyActionRes,
  ConversationActRes,
  ListConversationsRes,
  ListScope,
} from '../../src/shared/ipc';
import { createHarness, waitFor, waitForInboxCursors, type Harness } from '../fakes/engineHarness';
import {
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

const H = 3_600_000;
const t0 = Date.now() - 48 * H;
const at = (hours: number) => new Date(t0 + hours * H);
const mail = (subject: string, from: string, hours: number, id: string) => ({
  raw: rawMessage({ subject, messageId: `<${id}@x>`, date: at(hours), from }),
  internaldate: at(hours),
});

/** Five conversations with different senders and subjects; two share a subject. */
function sortOpts(): FakeImapOptions {
  return {
    inbox: [
      mail('Zeta report', 'Carl <carl@example.com>', 1, 'z1'),
      mail('alpha plan', 'Anna <anna@example.com>', 2, 'a1'),
      mail('Re: Beta notes', 'Bob <bob@example.com>', 3, 'b1'),
      mail('Gamma', 'Dora <dora@example.com>', 4, 'g1'),
      mail('Alpha plan', 'Erik <erik@example.com>', 5, 'a2'),
    ],
  };
}

async function boot(opts: FakeImapOptions, count: number) {
  server = await startFakeImap(opts);
  h = await createHarness(server);
  const acc = await h.addAccount();
  await waitFor('inbox synced', () => h!.inboxMessages(acc.id).length === count);
  await waitForInboxCursors(h, [acc.id]);
  await waitFor('trash row', () => h!.engine.ctx.folders.rowByRole(acc.id, 'trash'));
  await h.engine.actions.drain();
  return { h, server: server!, acc };
}

const list = (hh: Harness, scope: ListScope, extra: object = {}) =>
  hh.engine.handle('conversations.list', { scope, cursor: null, limit: 50, ...extra }) as Promise<ListConversationsRes>;

/** Reads every page with the given page size and returns the senders (first names) in order. */
async function allPages(
  hh: Harness,
  extra: { sort?: string; direction?: string },
  limit: number,
): Promise<string[]> {
  const out: string[] = [];
  let cursor: ListConversationsRes['nextCursor'] = null;
  for (let guard = 0; guard < 20; guard++) {
    const res = (await hh.engine.handle('conversations.list', {
      scope: { kind: 'unifiedInbox' },
      cursor,
      limit,
      ...extra,
    })) as ListConversationsRes;
    out.push(...res.items.map((i) => i.latest.from!.name!));
    cursor = res.nextCursor;
    if (!cursor) return out;
  }
  throw new Error('paging did not end');
}

describe('conversation sort', () => {
  it('sorts by latest date, newest first by default and oldest first on request', async () => {
    const c = await boot(sortOpts(), 5);
    expect((await list(c.h, { kind: 'unifiedInbox' })).items.map((i) => i.latest.from!.name)).toEqual([
      'Erik',
      'Dora',
      'Bob',
      'Anna',
      'Carl',
    ]);
    const asc = await list(c.h, { kind: 'unifiedInbox' }, { sort: 'date', direction: 'asc' });
    expect(asc.items.map((i) => i.latest.from!.name)).toEqual(['Carl', 'Anna', 'Bob', 'Dora', 'Erik']);
    expect(asc.total).toBe(5);
  });

  it('sorts by the latest sender (A to Z by default) and reverses with direction', async () => {
    const c = await boot(sortOpts(), 5);
    const az = await list(c.h, { kind: 'unifiedInbox' }, { sort: 'sender' });
    expect(az.items.map((i) => i.latest.from!.name)).toEqual(['Anna', 'Bob', 'Carl', 'Dora', 'Erik']);
    const za = await list(c.h, { kind: 'unifiedInbox' }, { sort: 'sender', direction: 'desc' });
    expect(za.items.map((i) => i.latest.from!.name)).toEqual(['Erik', 'Dora', 'Carl', 'Bob', 'Anna']);
  });

  it('sorts by the subject without Re:/Fwd:, equal subjects newest first', async () => {
    const c = await boot(sortOpts(), 5);
    const az = await list(c.h, { kind: 'unifiedInbox' }, { sort: 'subject' });
    // alpha plan x2 (Erik is newer than Anna), beta notes, gamma, zeta report
    expect(az.items.map((i) => i.latest.from!.name)).toEqual(['Erik', 'Anna', 'Bob', 'Dora', 'Carl']);
    const za = await list(c.h, { kind: 'unifiedInbox' }, { sort: 'subject', direction: 'desc' });
    expect(za.items.map((i) => i.latest.from!.name)).toEqual(['Carl', 'Dora', 'Bob', 'Erik', 'Anna']);
  });

  it('uses the sender and subject of the LATEST message of a conversation', async () => {
    const c = await boot(
      {
        inbox: [
          mail('Plan', 'Zed <zed@example.com>', 1, 'p1'),
          {
            raw: rawMessage({
              subject: 'Re: Plan',
              messageId: '<p2@x>',
              inReplyTo: '<p1@x>',
              references: '<p1@x>',
              date: at(6),
              from: 'Amy <amy@example.com>',
            }),
            internaldate: at(6),
          },
          mail('Middle', 'Max <max@example.com>', 3, 'm1'),
        ],
      },
      3,
    );
    const res = await list(c.h, { kind: 'unifiedInbox' }, { sort: 'sender' });
    // "Plan" is one conversation whose latest sender is Amy, so it comes first.
    expect(res.items.map((i) => i.latest.from!.name)).toEqual(['Amy', 'Max']);
    expect(res.items[0]!.count).toBe(2);
  });

  it.each([
    ['date', 'desc'],
    ['date', 'asc'],
    ['sender', 'asc'],
    ['sender', 'desc'],
    ['subject', 'asc'],
    ['subject', 'desc'],
  ])('paging one by one gives the same rows as one page (%s %s), no repeats, no gaps', async (sort, direction) => {
    const c = await boot(sortOpts(), 5);
    const whole = await allPages(c.h, { sort, direction }, 50);
    expect(whole).toHaveLength(5);
    for (const limit of [1, 2, 3]) {
      const paged = await allPages(c.h, { sort, direction }, limit);
      expect(paged).toEqual(whole);
      expect(new Set(paged).size).toBe(5);
    }
  });

  it('the next-page position of a sender or subject sort carries the key', async () => {
    const c = await boot(sortOpts(), 5);
    const p1 = await list(c.h, { kind: 'unifiedInbox' }, { sort: 'sender', limit: 2 });
    expect(p1.nextCursor).toMatchObject({ key: 'bob' });
    const s1 = await list(c.h, { kind: 'unifiedInbox' }, { sort: 'subject', limit: 2 });
    expect(s1.nextCursor?.key).toBe('alpha plan');
    // A date cursor has no key (backward compatible).
    const d1 = await list(c.h, { kind: 'unifiedInbox' }, { limit: 2 });
    expect(d1.nextCursor).not.toHaveProperty('key');
  });

  it('refuses a position from another sort order', async () => {
    const c = await boot(sortOpts(), 5);
    const p1 = await list(c.h, { kind: 'unifiedInbox' }, { limit: 2 });
    await expect(
      c.h.engine.handle('conversations.list', {
        scope: { kind: 'unifiedInbox' },
        cursor: p1.nextCursor,
        limit: 2,
        sort: 'sender',
      }),
    ).rejects.toMatchObject({ appError: { code: 'INVALID_INPUT' } });
  });

  it('sort works together with unreadOnly', async () => {
    const c = await boot(sortOpts(), 5);
    const anna = c.h.inboxMessages(c.acc.id).find((m) => m.from?.name === 'Anna')!;
    await c.h.engine.handle('messages.apply', { messageIds: [anna.id], action: { type: 'markRead', read: true } });
    const res = await list(c.h, { kind: 'unifiedInbox' }, { sort: 'sender', unreadOnly: true });
    expect(res.items.map((i) => i.latest.from!.name)).toEqual(['Bob', 'Carl', 'Dora', 'Erik']);
    expect(res.total).toBe(4);
  });
});

const net = (hh: Harness, online: boolean) => hh.engine.handle('system.networkChanged', { online });
const statusOf = async (hh: Harness, accountId: string) =>
  ((await hh.engine.handle('accounts.statuses', undefined)) as { accountId: string; state: string }[]).find(
    (s) => s.accountId === accountId,
  )!;
const pendingKinds = (hh: Harness) =>
  (hh.engine.ctx.db.prepare('SELECT kind FROM pending_op ORDER BY id').all() as { kind: string }[]).map((r) => r.kind);
const subjectsOn = (srv: FakeImapServer, path: string) =>
  srv
    .mailbox(path)
    .messages.map((m) => /Subject: (.*)\r?\n/.exec(String(m.raw))?.[1] ?? '?')
    .sort();

/** "Budget" conversation (2 messages) and "Lunch?" (1). */
function deleteOpts(extra: FakeImapOptions = {}): FakeImapOptions {
  return {
    inbox: [
      mail('Budget', 'Anna <anna@example.com>', 1, 'b1'),
      {
        raw: rawMessage({
          subject: 'Re: Budget',
          messageId: '<b2@x>',
          inReplyTo: '<b1@x>',
          references: '<b1@x>',
          date: at(2),
          from: 'Bob <bob@example.com>',
        }),
        internaldate: at(2),
      },
      mail('Lunch?', 'Carl <carl@example.com>', 3, 'l1'),
    ],
    ...extra,
  };
}

const act = (hh: Harness, threadIds: string[], scope: ListScope, extra: object = {}) =>
  hh.engine.handle('conversations.act', {
    threadIds,
    scope,
    action: { type: 'deletePermanent' },
    ...extra,
  }) as Promise<ConversationActRes>;

describe('permanent delete of conversations', () => {
  it('asks first: without confirm nothing changes and the answer says how many would go', async () => {
    const c = await boot(deleteOpts(), 3);
    const scope: ListScope = { kind: 'unifiedInbox' };
    const budget = (await list(c.h, scope)).items.find((i) => i.latest.title === 'Budget')!;
    const res = await act(c.h, [budget.threadId], scope);
    expect(res).toMatchObject({
      requiresConfirm: true,
      permanent: true,
      succeeded: [],
      failed: [],
      threadCount: 1,
      messageCount: 2,
    });
    expect(res.undoToken).toBeUndefined();
    expect(c.h.inboxMessages(c.acc.id)).toHaveLength(3);
    expect(pendingKinds(c.h)).toEqual([]);
    expect(subjectsOn(c.server, 'INBOX')).toHaveLength(3);
  });

  it('with confirm it deletes from the Inbox for good: no Trash copy, no undo token', async () => {
    const c = await boot(deleteOpts(), 3);
    const scope: ListScope = { kind: 'unifiedInbox' };
    const budget = (await list(c.h, scope)).items.find((i) => i.latest.title === 'Budget')!;
    const res = await act(c.h, [budget.threadId], scope, { confirm: true });
    expect(res.requiresConfirm).toBeUndefined();
    expect(res.permanent).toBe(true);
    expect(res.undoToken).toBeUndefined();
    expect(res.messageCount).toBe(2);
    expect(res.succeeded).toHaveLength(2);
    // Gone at once from the list, and the Trash got nothing.
    expect(c.h.inboxMessages(c.acc.id).map((m) => m.subject)).toEqual(['Lunch?']);
    await c.h.engine.actions.drain();
    await waitFor('server expunged', () => subjectsOn(c.server, 'INBOX').length === 1);
    expect(subjectsOn(c.server, 'INBOX')).toEqual(['Lunch?']);
    expect(c.server.mailbox('Trash').messages).toHaveLength(0);
    // Undo is not possible: there is no token, and a made-up one is refused.
    await expect(c.h.engine.handle('messages.undo', { undoToken: 'nope' })).rejects.toMatchObject({
      appError: { code: 'NOT_FOUND' },
    });
  });

  it('changes only the messages of the viewed folder (Sent copies stay)', async () => {
    const c = await boot(
      deleteOpts({
        folders: {
          Sent: [
            {
              raw: rawMessage({
                subject: 'Re: Budget',
                messageId: '<b3@x>',
                inReplyTo: '<b2@x>',
                references: '<b1@x> <b2@x>',
                date: at(2.5),
                from: 'Me <me@example.com>',
                to: 'Bob <bob@example.com>',
              }),
              internaldate: at(2.5),
              flags: ['\\Seen'],
            },
          ],
        },
      }),
      3,
    );
    await waitFor('sent synced', () => {
      const f = c.h.engine.ctx.folders.rowByRole(c.acc.id, 'sent');
      return !!f && c.h.engine.ctx.folders.syncState(f.id)?.uidvalidity != null;
    });
    const scope: ListScope = { kind: 'unifiedInbox' };
    const budget = (await list(c.h, scope)).items.find((i) => i.latest.title === 'Budget')!;
    expect(budget.count).toBe(3);
    const res = await act(c.h, [budget.threadId], scope, { confirm: true });
    expect(res.messageCount).toBe(2); // the two Inbox messages
    await c.h.engine.actions.drain();
    await waitFor('inbox expunged', () => subjectsOn(c.server, 'INBOX').length === 1);
    expect(c.server.mailbox('Sent').messages).toHaveLength(1);
  });

  it('works from any folder, not only Trash', async () => {
    const c = await boot(deleteOpts({ folders: { Projects: [mail('Plan', 'Dora <dora@example.com>', 1, 'p1')] } }), 3);
    const projects = c.h.folderByPath(c.acc.id, 'Projects');
    await c.h.engine.handle('sync.folder', { folderId: projects.id });
    await waitFor('projects synced', () => c.h.folderMessages(projects.id).length === 1);
    const scope: ListScope = { kind: 'folder', folderId: projects.id };
    const row = (await list(c.h, scope)).items[0]!;
    await act(c.h, [row.threadId], scope, { confirm: true });
    expect(c.h.folderMessages(projects.id)).toHaveLength(0);
    await c.h.engine.actions.drain();
    await waitFor('server expunged', () => c.server.mailbox('Projects').messages.length === 0);
    expect(c.server.mailbox('Trash').messages).toHaveLength(0);
  });

  it('is queued while offline and runs when the account is back', async () => {
    const c = await boot(deleteOpts(), 3);
    await net(c.h, false);
    await waitFor('offline', async () => (await statusOf(c.h, c.acc.id)).state === 'offline');
    const scope: ListScope = { kind: 'unifiedInbox' };
    const lunch = (await list(c.h, scope)).items.find((i) => i.latest.title === 'Lunch?')!;
    const res = await act(c.h, [lunch.threadId], scope, { confirm: true });
    expect(res.permanent).toBe(true);
    expect(c.h.inboxMessages(c.acc.id).map((m) => m.subject).sort()).toEqual(['Budget', 'Re: Budget']);
    expect(pendingKinds(c.h)).toEqual(['delete']);
    expect(subjectsOn(c.server, 'INBOX')).toHaveLength(3);
    await net(c.h, true);
    await waitFor('server expunged', () => subjectsOn(c.server, 'INBOX').length === 2);
    await waitFor('queue empty', () => pendingKinds(c.h).length === 0);
    expect(c.server.mailbox('Trash').messages).toHaveLength(0);
  });

  it('a conversation with nothing in the viewed folder is skipped (no confirm needed)', async () => {
    const c = await boot(deleteOpts(), 3);
    const res = await act(c.h, ['m:999999'], { kind: 'unifiedInbox' });
    expect(res).toMatchObject({ succeeded: [], failed: [], threadCount: 0, messageCount: 0 });
    expect(res.requiresConfirm).toBeUndefined();
  });
});

describe('permanent delete of messages', () => {
  const apply = (hh: Harness, messageIds: number[], extra: object = {}) =>
    hh.engine.handle('messages.apply', { messageIds, action: { type: 'deletePermanent' }, ...extra }) as Promise<ApplyActionRes>;

  it('needs confirm, then removes the message for good (also outside Trash)', async () => {
    const c = await boot(deleteOpts(), 3);
    const lunch = c.h.inboxMessages(c.acc.id).find((m) => m.subject === 'Lunch?')!;
    const ask = await apply(c.h, [lunch.id]);
    expect(ask).toMatchObject({ requiresConfirm: true, permanent: true, succeeded: [] });
    expect(c.h.inboxMessages(c.acc.id)).toHaveLength(3);
    const done = await apply(c.h, [lunch.id], { confirm: true });
    expect(done.succeeded).toEqual([lunch.id]);
    expect(done.permanent).toBe(true);
    expect(done.undoToken).toBeUndefined();
    await c.h.engine.actions.drain();
    await waitFor('server expunged', () => subjectsOn(c.server, 'INBOX').length === 2);
    expect(c.server.mailbox('Trash').messages).toHaveLength(0);
  });

  it('a plain delete in Trash reports permanent too', async () => {
    const c = await boot(deleteOpts(), 3);
    const lunch = c.h.inboxMessages(c.acc.id).find((m) => m.subject === 'Lunch?')!;
    const first = (await c.h.engine.handle('messages.apply', {
      messageIds: [lunch.id],
      action: { type: 'delete' },
    })) as ApplyActionRes;
    expect(first.permanent).toBeUndefined();
    expect(first.undoToken).toBeTruthy();
    await c.h.engine.actions.drain();
    const second = (await c.h.engine.handle('messages.apply', {
      messageIds: [lunch.id],
      action: { type: 'delete' },
    })) as ApplyActionRes;
    expect(second.permanent).toBe(true);
    expect(second.undoToken).toBeUndefined();
  });
});

describe('permanent delete on Gmail', () => {
  it('goes through Trash so that the message is really deleted, not just unlabeled', async () => {
    const c = await boot(deleteOpts({ gmailLayout: true }), 3);
    // The fake server cannot be told apart from Gmail by its host: mark the account as Gmail.
    c.h.engine.ctx.db.prepare("UPDATE account SET provider = 'gmail' WHERE id = ?").run(c.acc.id);
    const lunch = c.h.inboxMessages(c.acc.id).find((m) => m.subject === 'Lunch?')!;
    const viaTrash = vi.spyOn(c.h.engine.actions as unknown as { gmailToTrash: () => unknown }, 'gmailToTrash');
    const res = (await c.h.engine.handle('messages.apply', {
      messageIds: [lunch.id],
      action: { type: 'deletePermanent' },
      confirm: true,
    })) as ApplyActionRes;
    expect(res.permanent).toBe(true);
    await c.h.engine.actions.drain();
    expect(viaTrash).toHaveBeenCalledTimes(1);
    await waitFor('gone from the Inbox on the server', () => subjectsOn(c.server, 'INBOX').length === 2);
    await waitFor('queue empty', () => pendingKinds(c.h).length === 0);
    // Not left in Trash either.
    const trashPath = c.h.folderByRole(c.acc.id, 'trash').path;
    expect(c.server.mailbox(trashPath).messages).toHaveLength(0);
    expect(c.h.inboxMessages(c.acc.id).map((m) => m.subject).sort()).toEqual(['Budget', 'Re: Budget']);
    expect(c.h.engine.ctx.messages.row(lunch.id)).toBeFalsy();
  });
});
