// Engine integration: smaller contract additions - scope-level loadOlder, account badge,
// per-sender image allow list.
import { afterEach, describe, expect, it } from 'vitest';
import type { Account, MessageBody } from '../../src/shared/ipc';
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

describe('sync.loadOlder with a scope', () => {
  it('unified inbox: loads older mail for every account that has some', async () => {
    const old = (n: number) => ({
      raw: rawMessage({ subject: `Old ${n}`, date: new Date(Date.now() - 200 * DAY) }),
      internaldate: new Date(Date.now() - 200 * DAY),
    });
    server = await startFakeImap({
      inbox: [old(1), old(2), { raw: rawMessage({ subject: 'Recent' }) }],
    });
    h = await createHarness(server);
    const a = await h.addAccount({ syncDays: 30 });
    const b = await h.addAccount({ email: 'second@example.com', syncDays: 30 });
    await waitFor(
      'both synced',
      () => h!.inboxMessages(a.id).length === 1 && h!.inboxMessages(b.id).length === 1,
    );
    await waitForInboxCursors(h, [a.id, b.id]);

    const list = (await h.engine.handle('messages.list', {
      scope: { kind: 'unifiedInbox' },
      cursor: null,
      limit: 50,
    })) as { canLoadOlderFromServer: boolean; items: unknown[] };
    expect(list.items).toHaveLength(2);
    expect(list.canLoadOlderFromServer).toBe(true);

    const res = (await h.engine.handle('sync.loadOlder', { scope: { kind: 'unifiedInbox' } })) as {
      fetched: number;
      reachedStart: boolean;
    };
    expect(res).toEqual({ fetched: 4, reachedStart: true });
    expect(h.inboxMessages(a.id)).toHaveLength(3);
    expect(h.inboxMessages(b.id)).toHaveLength(3);

    // Nothing left: the list no longer offers more, and a second call is a no-op.
    const after = (await h.engine.handle('messages.list', {
      scope: { kind: 'unifiedInbox' },
      cursor: null,
      limit: 50,
    })) as { canLoadOlderFromServer: boolean };
    expect(after.canLoadOlderFromServer).toBe(false);
    expect(await h.engine.handle('sync.loadOlder', { scope: { kind: 'unifiedInbox' } })).toEqual({
      fetched: 0,
      reachedStart: true,
    });
  });

  it('a single account inbox scope only touches that account; other scopes are a no-op', async () => {
    server = await startFakeImap({
      inbox: [
        { raw: rawMessage({ subject: 'Old' }), internaldate: new Date(Date.now() - 200 * DAY) },
        { raw: rawMessage({ subject: 'Recent' }) },
      ],
    });
    h = await createHarness(server);
    const a = await h.addAccount({ syncDays: 30 });
    const b = await h.addAccount({ email: 'second@example.com', syncDays: 30 });
    await waitFor(
      'both synced',
      () => h!.inboxMessages(a.id).length === 1 && h!.inboxMessages(b.id).length === 1,
    );
    await waitForInboxCursors(h, [a.id, b.id]);
    // The fake server stores the Date header as "now", so mark the old message by INTERNALDATE only:
    // the sync window uses INTERNALDATE (SEARCH SINCE), which is what matters here.
    const res = (await h.engine.handle('sync.loadOlder', {
      scope: { kind: 'accountInbox', accountId: a.id },
    })) as { fetched: number };
    expect(res.fetched).toBe(1);
    expect(h.inboxMessages(a.id)).toHaveLength(2);
    expect(h.inboxMessages(b.id)).toHaveLength(1);
    expect(await h.engine.handle('sync.loadOlder', { scope: { kind: 'unifiedFlagged' } })).toEqual({
      fetched: 0,
      reachedStart: true,
    });
  });

  it('still works with a folderId (old callers)', async () => {
    server = await startFakeImap({ inbox: [{ raw: rawMessage({ subject: 'x' }) }] });
    h = await createHarness(server);
    const a = await h.addAccount();
    await waitFor('synced', () => h!.inboxMessages(a.id).length === 1);
    const inbox = h.folderByRole(a.id, 'inbox');
    await expect(h.engine.handle('sync.loadOlder', { folderId: inbox.id })).resolves.toMatchObject({
      reachedStart: true,
    });
  });
});

describe('account badge', () => {
  it('defaults to the first letter, can be set on add and edited', async () => {
    server = await startFakeImap({});
    h = await createHarness(server);
    const a = await h.addAccount({ displayName: 'work outlook' });
    expect(a.badge).toBe('W');
    const b = await h.addAccount({ email: 'b@example.com', displayName: 'Home', badge: 'hm' });
    expect(b.badge).toBe('HM');

    const updated = (await h.engine.handle('accounts.update', {
      accountId: a.id,
      patch: { badge: 'ab c' },
    })) as Account;
    expect(updated.badge).toBe('AB');
    const list = (await h.engine.handle('accounts.list', undefined)) as Account[];
    expect(list.map((x) => x.badge)).toEqual(['AB', 'HM']);
    await expect(
      h.engine.handle('accounts.update', { accountId: a.id, patch: { badge: '  ' } }),
    ).rejects.toMatchObject({ appError: { code: 'INVALID_INPUT' } });
  });
});

describe('always load images from a sender', () => {
  it('senders.allowImages / listAllowed and MessageBody.senderImagesAllowed', async () => {
    server = await startFakeImap({
      inbox: [{ raw: rawMessage({ subject: 'News', from: 'Shop <Deals@Shop.com>' }) }],
    });
    h = await createHarness(server);
    const a = await h.addAccount();
    const msg = await waitFor('synced', () => h!.inboxMessages(a.id)[0]);
    const read = () =>
      h!.engine.handle('messages.get', { messageId: msg.id }) as Promise<MessageBody>;

    expect((await read()).senderImagesAllowed).toBe(false);
    await h.engine.handle('senders.allowImages', { address: 'deals@shop.com', allow: true });
    expect(await h.engine.handle('senders.listAllowed', undefined)).toEqual(['deals@shop.com']);
    expect((await read()).senderImagesAllowed).toBe(true); // matches whatever case the sender used
    await h.engine.handle('senders.allowImages', { address: 'Deals@Shop.com', allow: false });
    expect(await h.engine.handle('senders.listAllowed', undefined)).toEqual([]);
    expect((await read()).senderImagesAllowed).toBe(false);
    await expect(
      h.engine.handle('senders.allowImages', { address: 'nope', allow: true }),
    ).rejects.toMatchObject({ appError: { code: 'INVALID_INPUT' } });
  });
});
