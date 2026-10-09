// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Folder, MessageHeader } from '../../src/shared/ipc';

type Invoke = (channel: string, req?: unknown) => Promise<unknown>;
const calls: { channel: string; req: unknown }[] = [];
let invoke: Invoke;

function folder(id: number, role: Folder['role'], accountId = 'a1'): Folder {
  return { id, accountId, path: role ?? 'X', name: role ?? 'X', role, delimiter: '/', unreadCount: 0, totalCount: 0, selectable: true };
}
function msg(id: number, folderId: number): MessageHeader {
  return {
    id,
    accountId: 'a1',
    folderId,
    uid: id,
    messageIdHeader: null,
    subject: `m${id}`,
    from: null,
    to: [],
    cc: [],
    date: 1000 - id,
    snippet: '',
    seen: true,
    flagged: false,
    answered: false,
    draft: false,
    hasAttachments: false,
    size: 1,
    bodyCached: true,
  };
}

async function setup() {
  vi.resetModules();
  (window as unknown as { api: unknown }).api = {
    invoke: (c: string, r?: unknown) => {
      calls.push({ channel: c, req: r });
      return invoke(c, r);
    },
    on: () => () => undefined,
  };
  const app = (await import('../../src/renderer/src/store/app')).useApp;
  const list = (await import('../../src/renderer/src/store/list')).useList;
  const toasts = (await import('../../src/renderer/src/store/toasts')).useToasts;
  const undo = (await import('../../src/renderer/src/store/undo')).useUndo;
  const actions = await import('../../src/renderer/src/lib/actions');
  app.setState({ folders: [folder(1, 'inbox'), folder(2, 'trash'), folder(3, 'archive')], accounts: [] });
  list.setState({ items: [msg(1, 1), msg(2, 1), msg(3, 1)], selectedIds: [2], focusId: 2 });
  return { list, toasts, undo, actions };
}

describe('applyToMessages', () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it('removes the row at once, selects the next message and offers Undo', async () => {
    invoke = async () => ({ succeeded: [2], failed: [], undoToken: 'tok1' });
    const { list, toasts, undo, actions } = await setup();
    const done = actions.applyToMessages([2], { type: 'delete' });
    // Optimistic: gone before the engine answered.
    expect(list.getState().items.map((m) => m.id)).toEqual([1, 3]);
    expect(list.getState().selectedIds).toEqual([3]);
    await done;
    expect(undo.getState().token).toBe('tok1');
    const t = toasts.getState().items.at(-1)!;
    expect(t.message).toContain('1 message deleted');
    expect(t.actionLabel).toBe('Undo');
  });

  it('says "for good" when the message was already in Trash (no undo token)', async () => {
    invoke = async () => ({ succeeded: [5], failed: [] });
    const { list, toasts, actions } = await setup();
    list.setState({ items: [msg(5, 2)], selectedIds: [] });
    await actions.applyToMessages([5], { type: 'delete' });
    const t = toasts.getState().items.at(-1)!;
    expect(t.message).toContain('deleted for good');
    expect(t.actionLabel).toBeUndefined();
  });

  it('shows the engine error and asks for a refresh when the move fails', async () => {
    invoke = async (c) => {
      if (c === 'messages.apply') {
        return { succeeded: [], failed: [{ id: 2, error: { code: 'HOST_UNREACHABLE', message: 'Offline.', retryable: true } }] };
      }
      return { items: [], nextCursor: null, canLoadOlderFromServer: false, total: 0 };
    };
    const { toasts, actions } = await setup();
    const ok = await actions.applyToMessages([2], { type: 'archive' });
    expect(ok).toBe(false);
    expect(toasts.getState().items.some((t) => t.message === 'Offline.' && t.tone === 'danger')).toBe(true);
  });

  it('reverts a read-state change when the engine rejects it', async () => {
    invoke = async () => {
      throw { code: 'INTERNAL', message: 'Nope.', retryable: false };
    };
    const { list, actions } = await setup();
    await actions.applyToMessages([1], { type: 'markRead', read: false });
    expect(list.getState().items.find((m) => m.id === 1)!.seen).toBe(true);
  });

  it('asks before deleting mail that is already in Trash', async () => {
    invoke = async () => ({ succeeded: [], failed: [] });
    const { list, actions } = await setup();
    const ui = (await import('../../src/renderer/src/store/ui')).useUi;
    list.setState({ items: [msg(5, 2)] });
    actions.deleteMessages([5]);
    expect(ui.getState().confirmPermanent).toEqual({ ids: [5], count: 1 });
    expect(calls.some((c) => c.channel === 'messages.apply')).toBe(false);
  });
});

describe('Shift+Delete (permanent delete)', () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it('asks the engine first (no confirm), changes nothing, and opens the dialog with the count', async () => {
    invoke = async () => ({ succeeded: [], failed: [], requiresConfirm: true, permanent: true });
    const { list, actions } = await setup();
    const ui = (await import('../../src/renderer/src/store/ui')).useUi;
    const ok = await actions.applyToMessages([1, 2], { type: 'deletePermanent' });
    expect(ok).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.req).toEqual({ messageIds: [1, 2], action: { type: 'deletePermanent' } });
    expect(list.getState().items.map((m) => m.id)).toEqual([1, 2, 3]);
    expect(ui.getState().confirmPermanent).toEqual({ ids: [1, 2], count: 2 });
  });

  it('after the dialog it sends confirm: true, removes the rows and offers no Undo', async () => {
    invoke = async () => ({ succeeded: [2], failed: [], permanent: true });
    const { list, toasts, undo, actions } = await setup();
    await actions.applyToMessages([2], { type: 'deletePermanent' }, { confirm: true });
    expect(calls[0]!.req).toEqual({ messageIds: [2], action: { type: 'deletePermanent' }, confirm: true });
    expect(list.getState().items.map((m) => m.id)).toEqual([1, 3]);
    expect(undo.getState().token).toBeNull();
    const t = toasts.getState().items.at(-1)!;
    expect(t.message).toBe('1 message deleted permanently');
    expect(t.actionLabel).toBeUndefined();
  });
});

describe('undo', () => {
  it('calls messages.undo with the token and refreshes', async () => {
    invoke = async (c) => (c === 'messages.undo' ? { restored: [2] } : { items: [], nextCursor: null, canLoadOlderFromServer: false, total: 0 });
    calls.length = 0;
    await setup();
    const { undoWithToken } = await import('../../src/renderer/src/store/undo');
    await undoWithToken('tokX');
    expect(calls.find((c) => c.channel === 'messages.undo')?.req).toEqual({ undoToken: 'tokX' });
  });
});
