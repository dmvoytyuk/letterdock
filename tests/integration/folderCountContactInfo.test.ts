// Engine integration: folders.count (for "Run rules on this folder") and contacts.get (address popover).
import { afterEach, describe, expect, it } from 'vitest';
import type { ContactInfo, FolderCountRes } from '../../src/shared/ipc';
import { createHarness, waitFor, waitForInboxCursors, type Harness } from '../fakes/engineHarness';
import { rawMessage, startFakeImap, type FakeImapServer } from '../fakes/fakeImapServer';

let server: FakeImapServer | null = null;
let h: Harness | null = null;

afterEach(async () => {
  await h?.cleanup();
  await server?.close().catch(() => undefined);
  h = null;
  server = null;
});

const H = 3_600_000;
const at = (hours: number) => new Date(Date.now() - (50 - hours) * H);

async function boot(secondAccount = false) {
  server = await startFakeImap({
    inbox: [
      { raw: rawMessage({ subject: 'One', messageId: '<1@x>', from: 'Anna Bell <anna@example.com>', date: at(1) }), internaldate: at(1) },
      { raw: rawMessage({ subject: 'Two', messageId: '<2@x>', from: 'Anna B. <ANNA@example.com>', date: at(2) }), internaldate: at(2) },
      { raw: rawMessage({ subject: 'Three', messageId: '<3@x>', from: 'Bob <bob@example.com>', date: at(3) }), internaldate: at(3), flags: ['\\Seen'] },
    ],
    folders: {
      Projects: [{ raw: rawMessage({ subject: 'P1', messageId: '<p1@x>', from: 'Dora <dora@example.com>', date: at(4) }), internaldate: at(4) }],
    },
  });
  h = await createHarness(server);
  const acc = await h.addAccount();
  await waitFor('inbox synced', () => h!.inboxMessages(acc.id).length === 3);
  await waitForInboxCursors(h, [acc.id]);
  const projects = h.folderByPath(acc.id, 'Projects');
  await h.engine.handle('sync.folder', { folderId: projects.id });
  await waitFor('projects synced', () => h!.folderMessages(projects.id).length === 1);
  let acc2 = null;
  if (secondAccount) {
    acc2 = await h.addAccount({ email: 'two@example.com', displayName: 'Two' });
    await waitFor('second inbox synced', () => h!.inboxMessages(acc2!.id).length === 3);
  }
  return { h, acc, acc2, projects };
}

const count = (hh: Harness, req: object) => hh.engine.handle('folders.count', req) as Promise<FolderCountRes>;
const info = (hh: Harness, address: string) => hh.engine.handle('contacts.get', { address }) as Promise<ContactInfo>;

describe('folders.count', () => {
  it('counts a folder: total and unread', async () => {
    const c = await boot();
    const inbox = c.h.folderByRole(c.acc.id, 'inbox');
    expect(await count(c.h, { folderId: inbox.id })).toEqual({ total: 3, unread: 2 });
    expect(await count(c.h, { folderId: c.projects.id })).toEqual({ total: 1, unread: 1 });
  });

  it('follows reading, and leaves out drafts and deleted messages (like a rules run)', async () => {
    const c = await boot();
    const inbox = c.h.folderByRole(c.acc.id, 'inbox');
    const one = c.h.inboxMessages(c.acc.id).find((m) => m.subject === 'One')!;
    await c.h.engine.handle('messages.apply', { messageIds: [one.id], action: { type: 'markRead', read: true } });
    expect(await count(c.h, { folderId: inbox.id })).toEqual({ total: 3, unread: 1 });
    const two = c.h.inboxMessages(c.acc.id).find((m) => m.subject === 'Two')!;
    await c.h.engine.handle('messages.apply', { messageIds: [two.id], action: { type: 'deletePermanent' }, confirm: true });
    expect(await count(c.h, { folderId: inbox.id })).toEqual({ total: 2, unread: 0 });
    // Same numbers as the rules dialog reads from countMatches ("messages looked at").
    const m = (await c.h.engine.handle('rules.countMatches', {
      rule: { accountId: null, matchMode: 'all', conditions: [{ field: 'hasAttachment' }] },
      folderId: inbox.id,
    })) as { total: number };
    expect(m.total).toBe(2);
  });

  it('counts all Inboxes, of one account or of every account', async () => {
    const c = await boot(true);
    expect(await count(c.h, { folderId: 'allInboxes' })).toEqual({ total: 6, unread: 4 });
    expect(await count(c.h, { folderId: 'allInboxes', accountId: c.acc.id })).toEqual({ total: 3, unread: 2 });
    expect(await count(c.h, { folderId: 'allInboxes', accountId: null })).toEqual({ total: 6, unread: 4 });
    expect(await count(c.h, { folderId: 'allInboxes', accountId: 'nobody' })).toEqual({ total: 0, unread: 0 });
  });

  it('rejects an unknown folder and a folder of another account', async () => {
    const c = await boot(true);
    await expect(count(c.h, { folderId: 987654 })).rejects.toMatchObject({ appError: { code: 'NOT_FOUND' } });
    const inbox = c.h.folderByRole(c.acc.id, 'inbox');
    await expect(count(c.h, { folderId: inbox.id, accountId: c.acc2!.id })).rejects.toMatchObject({
      appError: { code: 'INVALID_INPUT' },
    });
  });
});

describe('contacts.get', () => {
  it('tells name, counts and accounts of a known address', async () => {
    const c = await boot();
    await waitFor('contacts learned', async () => (await info(c.h, 'anna@example.com')).known);
    const anna = await info(c.h, 'anna@example.com');
    expect(anna).toMatchObject({
      address: 'anna@example.com',
      known: true,
      sentCount: 0,
      isOwn: false,
      forgotten: false,
      accountIds: [c.acc.id],
    });
    expect(anna.receivedCount).toBeGreaterThanOrEqual(2);
    expect(anna.name).toBeTruthy();
    expect(anna.lastUsed).toBeGreaterThan(0);
  });

  it('is not case sensitive and trims the address', async () => {
    const c = await boot();
    await waitFor('contacts learned', async () => (await info(c.h, 'bob@example.com')).known);
    expect((await info(c.h, '  BOB@Example.com ')).address).toBe('bob@example.com');
    expect((await info(c.h, 'BOB@EXAMPLE.COM')).known).toBe(true);
  });

  it('counts mail sent to an address', async () => {
    const c = await boot();
    c.h.engine.ctx.contacts.recordSent(c.acc.id, [{ address: 'carl@example.com', name: 'Carl' }], '<sent1@x>');
    const carl = await info(c.h, 'carl@example.com');
    expect(carl).toMatchObject({ known: true, sentCount: 1, name: 'Carl' });
    expect(carl.lastUsed).toBeGreaterThan(0);
  });

  it('an unknown address still answers (zero counts), and own addresses say so', async () => {
    const c = await boot();
    expect(await info(c.h, 'nobody@nowhere.test')).toEqual({
      address: 'nobody@nowhere.test',
      name: null,
      known: false,
      sentCount: 0,
      receivedCount: 0,
      lastUsed: 0,
      accountIds: [],
      isOwn: false,
      forgotten: false,
    });
    expect((await info(c.h, 'ME@example.com')).isOwn).toBe(true);
  });

  it('shows that an address was removed from the suggestions', async () => {
    const c = await boot();
    await waitFor('contacts learned', async () => (await info(c.h, 'bob@example.com')).known);
    await c.h.engine.handle('contacts.forget', { address: 'bob@example.com' });
    const bob = await info(c.h, 'bob@example.com');
    expect(bob).toMatchObject({ known: false, forgotten: true, sentCount: 0 });
  });

  it('lists the accounts that know the address, the most used first', async () => {
    const c = await boot(true);
    await waitFor('contacts learned', async () => (await info(c.h, 'anna@example.com')).accountIds.length === 2);
    c.h.engine.ctx.contacts.recordSent(c.acc2!.id, [{ address: 'anna@example.com' }], '<s2@x>');
    const anna = await info(c.h, 'anna@example.com');
    expect(anna.accountIds[0]).toBe(c.acc2!.id);
    expect(new Set(anna.accountIds)).toEqual(new Set([c.acc.id, c.acc2!.id]));
  });
});
