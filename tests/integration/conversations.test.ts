// Engine integration: conversations (list, open, act, Gmail thread ids, events) against the fake servers.
import { afterEach, describe, expect, it } from 'vitest';
import type {
  ConversationActRes,
  ConversationRow,
  GetConversationRes,
  ListConversationsRes,
  ListScope,
} from '../../src/shared/ipc';
import { createHarness, waitFor, type Harness } from '../fakes/engineHarness';
import {
  PLUGINS_GMAIL,
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

/** Two conversations: "Budget" (inbox 2 + my reply in Sent) and "Lunch" (one mail). */
function budgetOpts(extra: FakeImapOptions = {}): FakeImapOptions {
  return {
    inbox: [
      {
        raw: rawMessage({ subject: 'Budget', messageId: '<b1@x>', date: at(1), from: 'Anna <anna@example.com>' }),
        internaldate: at(1),
      },
      {
        raw: rawMessage({
          subject: 'Re: Budget',
          messageId: '<b3@x>',
          inReplyTo: '<b2@x>',
          references: '<b1@x> <b2@x>',
          date: at(5),
          from: 'Bob <bob@example.com>',
        }),
        internaldate: at(5),
      },
      {
        raw: rawMessage({ subject: 'Lunch?', messageId: '<l1@x>', date: at(3), from: 'Carl <carl@example.com>' }),
        internaldate: at(3),
      },
    ],
    folders: {
      Sent: [
        {
          raw: rawMessage({
            subject: 'Re: Budget',
            messageId: '<b2@x>',
            inReplyTo: '<b1@x>',
            references: '<b1@x>',
            date: at(2),
            from: 'Me <me@example.com>',
            to: 'Anna <anna@example.com>',
          }),
          internaldate: at(2),
          flags: ['\\Seen'],
        },
      ],
    },
    ...extra,
  };
}

async function boot(opts: FakeImapOptions) {
  server = await startFakeImap(opts);
  h = await createHarness(server);
  const acc = await h.addAccount();
  const inboxN = opts.inbox?.length ?? 0;
  await waitFor('inbox synced', () => h!.inboxMessages(acc.id).length === inboxN);
  await waitFor('sent synced', () => {
    const f = h!.engine.ctx.folders.rowByRole(acc.id, 'sent');
    return !!f && h!.engine.ctx.folders.syncState(f.id)?.uidvalidity != null;
  });
  await h.engine.actions.drain();
  return { h, server, acc };
}

const list = (hh: Harness, scope: ListScope, extra: object = {}) =>
  hh.engine.handle('conversations.list', {
    scope,
    cursor: null,
    limit: 50,
    ...extra,
  }) as Promise<ListConversationsRes>;

const byTitle = (res: ListConversationsRes, title: string): ConversationRow =>
  res.items.find((i) => i.latest.title === title)!;

describe('conversation list', () => {
  it('groups by headers and includes Sent and Archive in Inbox views', async () => {
    const c = await boot(budgetOpts());
    const res = await list(c.h, { kind: 'unifiedInbox' });
    expect(res.total).toBe(2);
    expect(res.items.map((i) => i.latest.title)).toEqual(['Budget', 'Lunch?']);
    const budget = byTitle(res, 'Budget');
    expect(budget.count).toBe(3);
    expect(budget.unreadCount).toBe(2); // the Sent copy is read
    expect(budget.folderMessageIds).toHaveLength(2); // only the Inbox ones
    expect(budget.latest.fromMe).toBe(false);
    expect(budget.latest.subject).toBe('Re: Budget');
    // Newest sender first, my address is "me".
    expect(budget.participants.map((p) => p.address)).toEqual([
      'bob@example.com',
      'me@example.com',
      'anna@example.com',
    ]);
    expect(budget.participants.find((p) => p.address === 'me@example.com')!.isMe).toBe(true);
    expect(budget.participants.find((p) => p.address === 'bob@example.com')!.hasUnread).toBe(true);
    expect(byTitle(res, 'Lunch?').count).toBe(1);
  });

  it('the same view in the Sent folder only counts the Sent message', async () => {
    const c = await boot(budgetOpts());
    const sent = c.h.folderByRole(c.acc.id, 'sent');
    const res = await list(c.h, { kind: 'folder', folderId: sent.id });
    expect(res.total).toBe(1);
    expect(res.items[0]!.count).toBe(1);
    expect(res.items[0]!.latest.fromMe).toBe(true);
    // And the Inbox folder behaves like the Inbox view.
    const inbox = c.h.folderByRole(c.acc.id, 'inbox');
    const inboxRes = await list(c.h, { kind: 'folder', folderId: inbox.id });
    expect(byTitle(inboxRes, 'Budget').count).toBe(3);
  });

  it('Unread shows conversations with an unread Inbox message; unreadOnly narrows the same way', async () => {
    const c = await boot(budgetOpts());
    const lunch = c.h.inboxMessages(c.acc.id).find((m) => m.subject === 'Lunch?')!;
    await c.h.engine.handle('messages.apply', { messageIds: [lunch.id], action: { type: 'markRead', read: true } });
    const unread = await list(c.h, { kind: 'unifiedUnread' });
    expect(unread.items.map((i) => i.latest.title)).toEqual(['Budget']);
    expect(unread.items[0]!.count).toBe(3);
    const only = await list(c.h, { kind: 'unifiedInbox' }, { unreadOnly: true });
    expect(only.items.map((i) => i.latest.title)).toEqual(['Budget']);
  });

  it('Flagged shows the conversation of a flagged message', async () => {
    const c = await boot(budgetOpts());
    const lunch = c.h.inboxMessages(c.acc.id).find((m) => m.subject === 'Lunch?')!;
    await c.h.engine.handle('messages.apply', { messageIds: [lunch.id], action: { type: 'flag', flagged: true } });
    const flagged = await list(c.h, { kind: 'unifiedFlagged' });
    expect(flagged.items.map((i) => i.latest.title)).toEqual(['Lunch?']);
    expect(flagged.items[0]!.hasFlag).toBe(true);
  });

  it('pages with a cursor', async () => {
    const c = await boot(budgetOpts());
    const p1 = await list(c.h, { kind: 'unifiedInbox' }, { limit: 1 });
    expect(p1.items).toHaveLength(1);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = (await c.h.engine.handle('conversations.list', {
      scope: { kind: 'unifiedInbox' },
      cursor: p1.nextCursor,
      limit: 1,
    })) as ListConversationsRes;
    expect(p2.items.map((i) => i.latest.title)).toEqual(['Lunch?']);
    expect(p2.nextCursor).toBeNull();
    expect(p2.total).toBeNull();
  });

  it('a message in two folders (Gmail All Mail) counts once', async () => {
    const c = await boot(
      budgetOpts({
        gmailLayout: true,
        folders: {
          'All Mail': [
            {
              raw: rawMessage({ subject: 'Lunch?', messageId: '<l1@x>', date: at(3), from: 'Carl <carl@example.com>' }),
              internaldate: at(3),
            },
          ],
        },
      }),
    );
    await waitFor('all mail synced', () => {
      const f = c.h.engine.ctx.folders.rowByRole(c.acc.id, 'all');
      return !!f && f.total_count >= 1;
    });
    const res = await list(c.h, { kind: 'unifiedInbox' });
    expect(byTitle(res, 'Lunch?').count).toBe(1);
  });

  it('never crosses accounts', async () => {
    server = await startFakeImap(budgetOpts());
    h = await createHarness(server);
    const a1 = await h.addAccount();
    const a2 = await h.addAccount({ email: 'two@example.com', displayName: 'Two' });
    await waitFor('both synced', () => h!.inboxMessages(a1.id).length === 3 && h!.inboxMessages(a2.id).length === 3);
    const res = await list(h, { kind: 'unifiedInbox' });
    expect(res.items.filter((i) => i.latest.title === 'Budget')).toHaveLength(2);
    expect(new Set(res.items.map((i) => i.threadId)).size).toBe(res.items.length);
  });
});

describe('open a conversation', () => {
  it('gives the messages oldest first with folder info', async () => {
    const c = await boot(budgetOpts());
    const row = byTitle(await list(c.h, { kind: 'unifiedInbox' }), 'Budget');
    const scope: ListScope = { kind: 'unifiedInbox' };
    const res = (await c.h.engine.handle('conversations.get', {
      threadId: row.threadId,
      accountId: c.acc.id,
      scope,
    })) as GetConversationRes;
    expect(res.title).toBe('Budget');
    expect(res.count).toBe(3);
    expect(res.messages.map((m) => m.header.messageIdHeader)).toEqual(['<b1@x>', '<b2@x>', '<b3@x>']);
    expect(res.messages.map((m) => m.folderRole)).toEqual(['inbox', 'sent', 'inbox']);
    expect(res.messages.map((m) => m.inCurrentFolder)).toEqual([true, false, true]);
    expect(res.messages.every((m) => !m.isDraft)).toBe(true);
    expect(res.messages[1]!.fromMe).toBe(true);
    // Without a view nothing is "current".
    const plain = (await c.h.engine.handle('conversations.get', {
      threadId: row.threadId,
      accountId: c.acc.id,
    })) as GetConversationRes;
    expect(plain.messages.every((m) => !m.inCurrentFolder)).toBe(true);
  });

  it('a draft of the conversation is listed but not counted', async () => {
    const c = await boot(budgetOpts());
    const row = byTitle(await list(c.h, { kind: 'unifiedInbox' }), 'Budget');
    const src = c.h.engine.ctx.messages.row(row.messageIds[0]!)!;
    const draft = (await c.h.engine.handle('compose.prepare', {
      mode: 'reply',
      sourceMessageId: src.id,
    })) as { draftId: string; accountId: string; to: []; cc: []; bcc: []; subject: string; html: string };
    await c.h.engine.handle('compose.saveDraft', {
      draftId: draft.draftId,
      accountId: draft.accountId,
      to: [{ address: 'anna@example.com' }],
      cc: [],
      bcc: [],
      subject: draft.subject,
      html: '<p>Draft text</p>',
      attachmentTokens: [],
    });
    const res = (await c.h.engine.handle('conversations.get', {
      threadId: row.threadId,
      accountId: c.acc.id,
      scope: { kind: 'unifiedInbox' },
    })) as GetConversationRes;
    const drafts = res.messages.filter((m) => m.isDraft);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.folderRole).toBe('drafts');
    expect(res.count).toBe(3);
    // The row in the list does not count the draft either.
    const again = byTitle(await list(c.h, { kind: 'unifiedInbox' }), 'Budget');
    expect(again.count).toBe(3);
  });

  it('says so when it is gone', async () => {
    const c = await boot(budgetOpts());
    await expect(
      c.h.engine.handle('conversations.get', { threadId: 't:nope', accountId: c.acc.id }),
    ).rejects.toMatchObject({ appError: { code: 'NOT_FOUND' } });
  });
});

describe('actions on conversations', () => {
  const act = (hh: Harness, threadIds: string[], scope: ListScope, action: object) =>
    hh.engine.handle('conversations.act', { threadIds, scope, action }) as Promise<ConversationActRes>;

  it('archive moves only the messages in this folder, one undo brings them back', async () => {
    const c = await boot(budgetOpts());
    const row = byTitle(await list(c.h, { kind: 'unifiedInbox' }), 'Budget');
    const res = await act(c.h, [row.threadId], { kind: 'unifiedInbox' }, { type: 'archive' });
    expect(res.threadCount).toBe(1);
    expect(res.messageCount).toBe(2);
    expect(res.undoToken).toBeTruthy();
    const archive = c.h.folderByRole(c.acc.id, 'archive');
    expect(c.h.folderMessages(archive.id)).toHaveLength(2);
    // The Sent copy stays in Sent.
    expect(c.h.folderMessages(c.h.folderByRole(c.acc.id, 'sent').id)).toHaveLength(1);
    // Still in Inbox views (Archive counts), with 3 messages.
    const after = byTitle(await list(c.h, { kind: 'unifiedInbox' }), 'Lunch?');
    expect(after).toBeTruthy();
    // But the Budget conversation has no Inbox message left, so it left the Inbox list.
    expect((await list(c.h, { kind: 'unifiedInbox' })).items.map((i) => i.latest.title)).toEqual(['Lunch?']);
    await c.h.engine.actions.drain();

    await c.h.engine.handle('messages.undo', { undoToken: res.undoToken });
    await c.h.engine.actions.drain();
    expect(c.h.inboxMessages(c.acc.id)).toHaveLength(3);
    expect((await list(c.h, { kind: 'unifiedInbox' })).items).toHaveLength(2);
  });

  it('delete moves them to Trash, Sent copies stay', async () => {
    const c = await boot(budgetOpts());
    const row = byTitle(await list(c.h, { kind: 'unifiedInbox' }), 'Budget');
    const res = await act(c.h, [row.threadId], { kind: 'unifiedInbox' }, { type: 'delete' });
    expect(res.messageCount).toBe(2);
    expect(c.h.folderMessages(c.h.folderByRole(c.acc.id, 'trash').id)).toHaveLength(2);
    expect(c.h.folderMessages(c.h.folderByRole(c.acc.id, 'sent').id)).toHaveLength(1);
    await c.h.engine.actions.drain();
  });

  it('read marks every unread message; unread marks only the newest', async () => {
    const c = await boot(budgetOpts());
    const row = byTitle(await list(c.h, { kind: 'unifiedInbox' }), 'Budget');
    await act(c.h, [row.threadId], { kind: 'unifiedInbox' }, { type: 'markRead', read: true });
    expect(c.h.inboxMessages(c.acc.id).filter((m) => m.subject.includes('Budget')).every((m) => m.seen)).toBe(true);
    const res = await act(c.h, [row.threadId], { kind: 'unifiedInbox' }, { type: 'markRead', read: false });
    expect(res.messageCount).toBe(1);
    const budget = c.h.inboxMessages(c.acc.id).filter((m) => m.subject.includes('Budget'));
    expect(budget.filter((m) => !m.seen).map((m) => m.messageIdHeader)).toEqual(['<b3@x>']);
    await c.h.engine.actions.drain();
  });

  it('flag: the newest one gets flagged; flagging again off unflags all', async () => {
    const c = await boot(budgetOpts());
    const row = byTitle(await list(c.h, { kind: 'unifiedInbox' }), 'Budget');
    await act(c.h, [row.threadId], { kind: 'unifiedInbox' }, { type: 'flag', flagged: true });
    let budget = c.h.inboxMessages(c.acc.id).filter((m) => m.subject.includes('Budget'));
    expect(budget.filter((m) => m.flagged).map((m) => m.messageIdHeader)).toEqual(['<b3@x>']);
    const res = await act(c.h, [row.threadId], { kind: 'unifiedInbox' }, { type: 'flag', flagged: false });
    expect(res.messageCount).toBe(1);
    budget = c.h.inboxMessages(c.acc.id).filter((m) => m.subject.includes('Budget'));
    expect(budget.some((m) => m.flagged)).toBe(false);
    await c.h.engine.actions.drain();
  });

  it('several conversations: one call, one undo', async () => {
    const c = await boot(budgetOpts());
    const rows = (await list(c.h, { kind: 'unifiedInbox' })).items;
    const res = await act(c.h, rows.map((r) => r.threadId), { kind: 'unifiedInbox' }, { type: 'archive' });
    expect(res.threadCount).toBe(2);
    expect(res.messageCount).toBe(3);
    expect(typeof res.undoToken).toBe('string');
    await c.h.engine.actions.drain();
  });
});

describe('late parents and events', () => {
  it('a parent that arrives later joins the conversation and an event says so', async () => {
    const c = await boot({
      inbox: [
        {
          raw: rawMessage({
            subject: 'Re: Plan',
            messageId: '<p2@x>',
            inReplyTo: '<p1@x>',
            references: '<p1@x>',
            date: at(4),
          }),
          internaldate: at(4),
        },
      ],
    });
    c.h.settings.groupConversations = true;
    expect((await list(c.h, { kind: 'unifiedInbox' })).items).toHaveLength(1);
    c.h.events.length = 0;
    c.server.deliver('INBOX', {
      raw: rawMessage({ subject: 'Plan', messageId: '<p1@x>', date: at(2) }),
      internaldate: at(2),
    });
    await waitFor('merged', async () => {
      const res = await list(c.h, { kind: 'unifiedInbox' });
      return res.items.length === 1 && res.items[0]!.count === 2;
    });
    await waitFor('conversations:changed event', () => c.h.eventsOfType('conversations:changed').length > 0);
    const ev = c.h.eventsOfType('conversations:changed');
    const row = (await list(c.h, { kind: 'unifiedInbox' })).items[0]!;
    expect(ev.some((e) => e.accountId === c.acc.id && e.threadIds.includes(row.threadId))).toBe(true);
  });

  it('sends no conversation events while the setting is off', async () => {
    const c = await boot(budgetOpts());
    c.h.events.length = 0;
    c.server.deliver('INBOX', { raw: rawMessage({ subject: 'New one' }) });
    await waitFor('new mail', () => c.h.inboxMessages(c.acc.id).length === 4);
    await new Promise((r) => setTimeout(r, 400));
    expect(c.h.eventsOfType('conversations:changed')).toHaveLength(0);
  });
});

describe('Gmail conversation ids', () => {
  const gm = (subject: string, mid: string, thr: string, hours: number, extra: object = {}) => ({
    raw: rawMessage({ subject, messageId: mid, date: at(hours), ...extra }),
    internaldate: at(hours),
    gmThrid: thr,
  });

  it('uses X-GM-THRID, even without matching headers', async () => {
    const c = await boot({
      plugins: PLUGINS_GMAIL,
      inbox: [
        gm('Trip', '<t1@x>', '900', 1),
        gm('Completely different subject', '<t2@x>', '900', 2),
        // Looks linked by headers, but Gmail says it is another conversation.
        gm('Re: Trip', '<t3@x>', '901', 3, { inReplyTo: '<t1@x>', references: '<t1@x>' }),
      ],
    });
    const res = await list(c.h, { kind: 'unifiedInbox' });
    expect(res.items).toHaveLength(2);
    const grouped = res.items.find((i) => i.count === 2)!;
    expect(grouped.threadId).toBe(`g:${c.acc.id}:900`);
    // New mail gets its id from the live sync.
    c.server.deliver('INBOX', gm('Trip details', '<t4@x>', '900', 4));
    await waitFor('joined', async () => (await list(c.h, { kind: 'unifiedInbox' })).items.find((i) => i.threadId === grouped.threadId)?.count === 3);
  });

  it('fills the id in for mail stored before, in the background', async () => {
    const c = await boot({
      plugins: PLUGINS_GMAIL,
      inbox: [gm('Trip', '<t1@x>', '900', 1), gm('Other title', '<t2@x>', '900', 2)],
    });
    expect((await list(c.h, { kind: 'unifiedInbox' })).items).toHaveLength(1);
    // Put the rows back to how they were before conversations existed.
    const ctx = c.h.engine.ctx;
    ctx.db.exec("UPDATE message SET thread_id = 'm:' || id");
    ctx.db.exec("DELETE FROM kv WHERE k LIKE 'thrid_done:%'");
    expect((await list(c.h, { kind: 'unifiedInbox' })).items).toHaveLength(2);
    await c.h.engine.handle('accounts.reconnect', { accountId: c.acc.id });
    await waitFor('server ids filled in', async () => (await list(c.h, { kind: 'unifiedInbox' })).items.length === 1, 15_000);
  });
});
