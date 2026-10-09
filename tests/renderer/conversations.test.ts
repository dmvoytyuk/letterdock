// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationMessage, ConversationParticipant, ConversationRow, Folder, MessageHeader } from '../../src/shared/ipc';
import { participantText, participantView } from '../../src/renderer/src/features/list/ConversationBits';
import { initialOpen } from '../../src/renderer/src/features/reading/ConversationView';
import { middleText, type MiddleInput } from '../../src/renderer/src/lib/statusBar';

type Invoke = (channel: string, req?: unknown) => Promise<unknown>;
const calls: { channel: string; req: unknown }[] = [];
let invoke: Invoke;

const person = (name: string | null, address: string, o: Partial<ConversationParticipant> = {}): ConversationParticipant => ({
  name,
  address,
  isMe: false,
  hasUnread: false,
  ...o,
});

describe('participantView (3.10.2)', () => {
  it('uses first names when they are unique and "me" for your own address', () => {
    const v = participantView([person('Anna Rossi', 'a@x'), person('Bob Lee', 'b@x', { hasUnread: true }), person('Alex Rivera', 'me@x', { isMe: true })]);
    expect(v.shown.map((s) => s.label)).toEqual(['Anna', 'Bob', 'me']);
    expect(v.shown.map((s) => s.unread)).toEqual([false, true, false]);
    expect(v.more).toBe(0);
  });
  it('uses full names when two first names are the same', () => {
    const v = participantView([person('Anna Rossi', 'a@x'), person('Anna Weber', 'w@x')]);
    expect(v.shown.map((s) => s.label)).toEqual(['Anna Rossi', 'Anna Weber']);
  });
  it('shows at most 3 names and counts the rest', () => {
    const list = ['a', 'b', 'c', 'd', 'e'].map((n) => person(n.toUpperCase(), `${n}@x`));
    const v = participantView(list);
    expect(v.shown).toHaveLength(3);
    expect(v.more).toBe(2);
    expect(participantText(list)).toBe('A, B, C and 2 more');
  });
  it('falls back to the address when there is no name', () => {
    expect(participantView([person(null, 'zed@x.example')]).shown[0]!.label).toBe('zed@x.example');
  });
});

function cm(id: number, o: { seen?: boolean; draft?: boolean } = {}): ConversationMessage {
  return {
    header: { id, seen: o.seen ?? true } as MessageHeader,
    folderId: 1,
    folderRole: 'inbox',
    folderName: 'Inbox',
    inCurrentFolder: true,
    isDraft: o.draft ?? false,
    fromMe: false,
  };
}

describe('initialOpen (3.10.4)', () => {
  it('opens the newest message and every unread one', () => {
    const open = initialOpen([cm(1), cm(2, { seen: false }), cm(3), cm(4)]);
    expect([...open].sort()).toEqual([2, 4]);
  });
  it('opens at most 8 cards: the newest of the wanted ones', () => {
    const msgs = Array.from({ length: 12 }, (_, i) => cm(i + 1, { seen: false }));
    const open = initialOpen(msgs);
    expect(open.size).toBe(8);
    expect(open.has(12)).toBe(true);
    expect(open.has(4)).toBe(false);
  });
  it('never opens a draft by itself', () => {
    const open = initialOpen([cm(1), cm(2), cm(3, { draft: true, seen: false })]);
    expect([...open]).toEqual([2]);
  });
});

describe('status bar with conversations (4.8)', () => {
  const folder = { id: 1, accountId: 'a', path: 'INBOX', name: 'INBOX', role: 'inbox', delimiter: '/', unreadCount: 3, totalCount: 248, selectable: true } as Folder;
  const base = (over: Partial<MiddleInput['list']> = {}): MiddleInput => ({
    page: 'mail',
    view: { kind: 'folder', folderId: 1 },
    accounts: [{ id: 'a', displayName: 'Alter', email: 'a@x', enabled: true } as never],
    folders: [folder],
    counts: { unifiedInboxUnread: 3, perFolder: [] },
    outboxCount: 0,
    list: { scopeKind: 'folder', isSearch: false, loading: false, total: 120, itemCount: 50, selectedCount: 0, grouped: true, ...over },
  });
  it('counts conversations and leaves out the unread part', () => {
    expect(middleText(base())).toBe('Inbox · 120 conversations');
    expect(middleText(base({ total: 1 }))).toBe('Inbox · 1 conversation');
  });
  it('"12 selected" counts conversations too', () => {
    expect(middleText(base({ selectedCount: 12 }))).toBe('12 selected');
  });
});

function row(o: Partial<ConversationRow> & { threadId: string; latestId: number; count: number }): ConversationRow {
  return {
    threadId: o.threadId,
    accountId: 'a1',
    count: o.count,
    unreadCount: o.unreadCount ?? 0,
    hasFlag: false,
    hasAttachment: false,
    participants: [],
    latest: { id: o.latestId, subject: 'Re: S', title: 'S', snippet: '', date: 1000, fromMe: o.latest?.fromMe ?? false, from: null },
    folderMessageIds: o.folderMessageIds ?? [o.latestId],
    messageIds: o.messageIds ?? [o.latestId],
  };
}

async function setup(rows: ConversationRow[]) {
  vi.resetModules();
  (window as unknown as { api: unknown }).api = {
    invoke: (c: string, r?: unknown) => {
      calls.push({ channel: c, req: r });
      return invoke(c, r);
    },
    on: () => () => undefined,
  };
  const app = (await import('../../src/renderer/src/store/app')).useApp;
  const list = (await import('../../src/renderer/src/store/list'));
  const toasts = (await import('../../src/renderer/src/store/toasts')).useToasts;
  const actions = await import('../../src/renderer/src/lib/actions');
  app.setState({ folders: [{ id: 1, accountId: 'a1', path: 'INBOX', name: 'INBOX', role: 'inbox', delimiter: '/', unreadCount: 0, totalCount: 0, selectable: true } as Folder], accounts: [] });
  list.useList.setState({
    grouped: true,
    scope: { kind: 'folder', folderId: 1 },
    items: rows.map((r) => list.conversationItem(r, 1)),
    selectedIds: [rows[0]!.latest.id],
  });
  return { list: list.useList, toasts, actions };
}

describe('actions on conversation rows (3.10.3)', () => {
  beforeEach(() => {
    calls.length = 0;
  });
  it('archive calls conversations.act once with the thread and says how many messages', async () => {
    invoke = async () => ({ succeeded: [1, 2, 3, 4], failed: [], undoToken: 'tokC', threadCount: 1, messageCount: 4 });
    const { list, toasts, actions } = await setup([row({ threadId: 't1', latestId: 10, count: 4 }), row({ threadId: 't2', latestId: 20, count: 1 })]);
    const done = actions.applyToMessages([10], { type: 'archive' });
    // The row leaves the list at once and the next row is selected.
    expect(list.getState().items.map((m) => m.id)).toEqual([20]);
    expect(list.getState().selectedIds).toEqual([20]);
    await done;
    const act = calls.filter((c) => c.channel === 'conversations.act');
    expect(act).toHaveLength(1);
    expect(act[0]!.req).toMatchObject({ threadIds: ['t1'], scope: { kind: 'folder', folderId: 1 }, action: { type: 'archive' } });
    expect(calls.some((c) => c.channel === 'messages.apply')).toBe(false);
    const t = toasts.getState().items.at(-1)!;
    expect(t.message).toBe('Conversation archived (4 messages)');
    expect(t.actionLabel).toBe('Undo');
  });
  it('several conversations: one call, one toast with both counts', async () => {
    invoke = async () => ({ succeeded: [1, 2, 3, 4, 5, 6, 7], failed: [], undoToken: 'tokD', threadCount: 2, messageCount: 7 });
    const { toasts, actions } = await setup([row({ threadId: 't1', latestId: 10, count: 4 }), row({ threadId: 't2', latestId: 20, count: 3 })]);
    await actions.applyToMessages([10, 20], { type: 'move', destFolderId: 1 });
    expect(toasts.getState().items.at(-1)!.message).toContain('Moved 2 conversations (7 messages)');
  });
  it('a conversation with one message uses the normal wording', async () => {
    invoke = async () => ({ succeeded: [20], failed: [], undoToken: 'tokE', threadCount: 1, messageCount: 1 });
    const { toasts, actions } = await setup([row({ threadId: 't2', latestId: 20, count: 1 })]);
    await actions.applyToMessages([20], { type: 'archive' });
    expect(toasts.getState().items.at(-1)!.message).toBe('1 message archived');
  });
  it('marking read updates the row at once and puts it back when the engine says no', async () => {
    invoke = async () => {
      throw { code: 'INTERNAL', message: 'Nope.', retryable: false };
    };
    const { list, actions } = await setup([row({ threadId: 't1', latestId: 10, count: 3, unreadCount: 2 })]);
    expect(list.getState().items[0]!.seen).toBe(false);
    await actions.applyToMessages([10], { type: 'markRead', read: true });
    expect(list.getState().items[0]!.seen).toBe(false);
    expect(list.getState().items[0]!.conv!.unreadCount).toBe(2);
  });
  it('reply goes to the newest message that is not yours', async () => {
    invoke = async (c) => {
      if (c === 'conversations.get') {
        return {
          threadId: 't1',
          accountId: 'a1',
          title: 'S',
          count: 3,
          messages: [
            { header: { id: 5 }, isDraft: false, fromMe: false },
            { header: { id: 6 }, isDraft: false, fromMe: true },
            { header: { id: 10 }, isDraft: false, fromMe: true },
          ],
        };
      }
      return undefined;
    };
    const { actions } = await setup([row({ threadId: 't1', latestId: 10, count: 3, latest: { fromMe: true } as never, messageIds: [5, 6, 10] })]);
    actions.composeFrom('reply', 10);
    await vi.waitFor(() => expect(calls.some((c) => c.channel === 'compose.openWindow')).toBe(true));
    expect(calls.find((c) => c.channel === 'compose.openWindow')!.req).toEqual({ mode: 'reply', sourceMessageId: 5 });
  });
  it('Shift+Delete on a conversation: dry run with threadCount/messageCount, then confirm', async () => {
    invoke = async (_c, r) =>
      (r as { confirm?: boolean }).confirm
        ? { succeeded: [1, 2, 3, 4], failed: [], permanent: true, threadCount: 1, messageCount: 4 }
        : { succeeded: [], failed: [], requiresConfirm: true, permanent: true, threadCount: 1, messageCount: 4 };
    const { list, toasts, actions } = await setup([row({ threadId: 't1', latestId: 10, count: 4, folderMessageIds: [7, 8, 9, 10] })]);
    const ui = (await import('../../src/renderer/src/store/ui')).useUi;
    await actions.applyToMessages([10], { type: 'deletePermanent' });
    expect(calls[0]!.req).toMatchObject({ threadIds: ['t1'], action: { type: 'deletePermanent' } });
    expect((calls[0]!.req as { confirm?: boolean }).confirm).toBeUndefined();
    expect(ui.getState().confirmPermanent).toEqual({ ids: [10], count: 4 });
    expect(list.getState().items).toHaveLength(1);
    await actions.applyToMessages([10], { type: 'deletePermanent' }, { confirm: true });
    expect(calls[1]!.req).toMatchObject({ confirm: true });
    expect(list.getState().items).toHaveLength(0);
    expect(toasts.getState().items.at(-1)!.message).toBe('Conversation deleted permanently (4 messages)');
  });
});
