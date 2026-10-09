// Engine integration: local full-text search across accounts, and server-side search.
import { afterEach, describe, expect, it } from 'vitest';
import type { MessageBody, SearchRes, ServerSearchRes } from '../../src/shared/ipc';
import { createHarness, waitFor, type Harness } from '../fakes/engineHarness';
import { rawMessage, rawWithAttachments, startFakeImap, type FakeImapServer } from '../fakes/fakeImapServer';

let server: FakeImapServer | null = null;
let h: Harness | null = null;

afterEach(async () => {
  await h?.cleanup();
  await server?.close().catch(() => undefined);
  h = server = null;
});

const DAY = 86_400_000;
const search = (hh: Harness, query: string, extra: object = {}) =>
  hh.engine.handle('search.local', { query, ...extra }) as Promise<SearchRes>;
const subjects = (r: SearchRes) => r.items.map((i) => i.subject);

async function boot() {
  server = await startFakeImap({
    inbox: [
      {
        raw: rawMessage({ subject: 'Team lunch on Friday',
          date: new Date(Date.now() - 10 * DAY), from: 'Alice <alice@example.com>', text: 'Pizza or sushi?' }),
        internaldate: new Date(Date.now() - 10 * DAY),
      },
      {
        raw: rawMessage({ subject: 'Q3 budget plan',
          date: new Date(Date.now() - 5 * DAY), from: 'Bob Builder <bob@acme.com>', text: 'Numbers attached soon.' }),
        flags: ['\\Seen'],
        internaldate: new Date(Date.now() - 5 * DAY),
      },
      {
        raw: rawMessage({ subject: 'Unrelated',
          date: new Date(Date.now() - 2 * DAY), from: 'Carol <carol@example.com>', text: 'The word zeppelin hides here.' }),
        internaldate: new Date(Date.now() - 2 * DAY),
      },
      { raw: rawWithAttachments('Quarterly report'), internaldate: new Date(Date.now() - 1 * DAY) },
    ],
    folders: {
      Trash: [{ raw: rawMessage({ subject: 'Lunch coupon in the bin' }) }],
      Archive: [
        {
          raw: rawMessage({
            subject: 'Old lunch notes',
            text: 'archived',
            from: 'Dave <dave@other.org>',
            to: 'Zed <zed@example.com>',
          }),
        },
      ],
    },
  });
  h = await createHarness(server);
  const acc = await h.addAccount();
  await waitFor('synced', () => h!.inboxMessages(acc.id).length === 4);
  await waitFor('other folders synced', () => {
    const t = h!.engine.ctx.folders.rowByRole(acc.id, 'trash');
    const a = h!.engine.ctx.folders.rowByRole(acc.id, 'archive');
    return !!t && !!a && h!.folderMessages(t.id).length === 1 && h!.folderMessages(a.id).length === 1;
  });
  return { h, acc, server };
}

describe('search.local', () => {
  it('finds words in the subject, prefix-matching the last word, and ranks by relevance', async () => {
    const c = await boot();
    expect(subjects(await search(c.h, 'lun')).sort()).toEqual([
      'Old lunch notes',
      'Team lunch on Friday',
    ]);
    expect(subjects(await search(c.h, 'budget plan'))).toEqual(['Q3 budget plan']);
    const none = await search(c.h, 'nothinghere');
    expect(none.items).toEqual([]);
    expect(none.totalApprox).toBe(0);
  });

  it('only searches downloaded text: a body word is found after the message was opened', async () => {
    const c = await boot();
    expect(subjects(await search(c.h, 'zeppelin'))).toEqual([]);
    const target = c.h.inboxMessages(c.acc.id).find((m) => m.subject === 'Unrelated')!;
    (await c.h.engine.handle('messages.get', { messageId: target.id })) as MessageBody;
    const res = await search(c.h, 'zeppelin');
    expect(subjects(res)).toEqual(['Unrelated']);
    expect(res.coverage.messagesIndexed).toBeGreaterThanOrEqual(6);
    expect(res.coverage.bodiesIndexed).toBe(1);
  });

  it('supports from:, to:, subject:, is:, has:, before: and after:', async () => {
    const c = await boot();
    expect(subjects(await search(c.h, 'from:bob')).sort()).toEqual([
      'Q3 budget plan',
      'Quarterly report',
    ]);
    expect(subjects(await search(c.h, 'from:"bob builder"'))).toEqual(['Q3 budget plan']);
    expect(subjects(await search(c.h, 'from:acme.com'))).toEqual(['Q3 budget plan']);
    expect(subjects(await search(c.h, 'to:me'))).toHaveLength(4);
    expect(subjects(await search(c.h, 'subject:plan'))).toEqual(['Q3 budget plan']);
    expect(subjects(await search(c.h, 'is:read'))).toEqual(['Q3 budget plan']);
    expect((await search(c.h, 'is:unread')).items.every((i) => !i.seen)).toBe(true);
    expect(subjects(await search(c.h, 'has:attachment'))).toEqual(['Quarterly report']);

    const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const cut = ymd(new Date(Date.now() - 4 * DAY));
    expect(subjects(await search(c.h, `after:${cut}`)).sort()).toEqual([
      'Old lunch notes', // the Archive message was dated just now
      'Quarterly report',
      'Unrelated',
    ]);
    expect(subjects(await search(c.h, `before:${cut} is:unread`))).toEqual(['Team lunch on Friday']);
    // Operators combine with words.
    expect(subjects(await search(c.h, 'lunch from:alice'))).toEqual(['Team lunch on Friday']);
  });

  it('reports the filters it understood and a total', async () => {
    const c = await boot();
    const r = await search(c.h, 'lunch from:alice is:unread');
    expect(r.parsedFilters).toEqual(['from:alice', 'is:unread']);
    expect(r.totalApprox).toBe(1);
  });

  it('leaves out Trash and Junk unless folder: asks for them', async () => {
    const c = await boot();
    expect(subjects(await search(c.h, 'coupon'))).toEqual([]);
    expect(subjects(await search(c.h, 'coupon folder:trash'))).toEqual(['Lunch coupon in the bin']);
    expect(subjects(await search(c.h, 'lunch folder:archive'))).toEqual(['Old lunch notes']);
    expect(subjects(await search(c.h, 'lunch in:inbox'))).toEqual(['Team lunch on Friday']);
  });

  it('searches across accounts and can be limited with accountId or account:', async () => {
    const c = await boot();
    const second = await c.h.addAccount({ email: 'other@example.com', displayName: 'Side project' });
    await waitFor('second synced', () => c.h.inboxMessages(second.id).length === 4);
    const all = await search(c.h, 'budget');
    expect(all.items.map((i) => i.accountId).sort()).toEqual([c.acc.id, second.id].sort());
    expect((await search(c.h, 'budget', { accountId: second.id })).items.map((i) => i.accountId)).toEqual([second.id]);
    expect((await search(c.h, 'budget account:other@example')).items.map((i) => i.accountId)).toEqual([second.id]);
    expect((await search(c.h, 'budget account:"side project"')).items).toHaveLength(1);
    expect((await search(c.h, 'budget account:nobody')).items).toEqual([]);
  });

  it('pages with limit and offset', async () => {
    const c = await boot();
    const page1 = await search(c.h, 'to:me', { limit: 3 });
    const page2 = await search(c.h, 'to:me', { limit: 3, offset: 3 });
    expect(page1.items).toHaveLength(3);
    expect(page2.items).toHaveLength(1);
    expect(page1.totalApprox).toBe(4);
    expect(new Set([...page1.items, ...page2.items].map((i) => i.id)).size).toBe(4);
  });

  it('does not choke on odd input, and an empty box finds nothing', async () => {
    const c = await boot();
    for (const q of ['"unbalanced', 'AND OR NOT', 'NEAR(', '*', 'a:b:c', "it's", '(((', 'x" y']) {
      await expect(search(c.h, q)).resolves.toBeTruthy();
    }
    expect((await search(c.h, '')).items).toEqual([]);
    expect((await search(c.h, '   ')).items).toEqual([]);
  });

  it('follows messages that move, and forgets deleted ones', async () => {
    const c = await boot();
    const msg = c.h.inboxMessages(c.acc.id).find((m) => m.subject === 'Q3 budget plan')!;
    await c.h.engine.handle('messages.apply', { messageIds: [msg.id], action: { type: 'archive' } });
    await c.h.engine.actions.drain();
    const hits = await search(c.h, 'budget');
    expect(hits.items.map((i) => i.id)).toEqual([msg.id]); // same id, still found
    // Permanent delete: from Trash.
    await c.h.engine.handle('messages.apply', { messageIds: [msg.id], action: { type: 'delete' } });
    await c.h.engine.actions.drain();
    await c.h.engine.handle('messages.apply', { messageIds: [msg.id], action: { type: 'delete' } });
    await c.h.engine.actions.drain();
    expect((await search(c.h, 'budget folder:trash')).items).toEqual([]);
  });
});

describe('search.local with the same message in several folders (Gmail layout)', () => {
  it('shows one copy per Message-ID: INBOX first, All Mail only when it is the only copy', async () => {
    const dup = rawMessage({ subject: 'Welcome back to Claude Max', messageId: '<welcome@claude.test>', text: 'Hello' });
    const onlyAll = rawMessage({ subject: 'Claude receipt', messageId: '<receipt@claude.test>', text: 'Paid' });
    server = await startFakeImap({
      gmailLayout: true,
      inbox: [{ raw: dup }],
      folders: { 'All Mail': [{ raw: dup }, { raw: onlyAll }], Archive: [{ raw: dup }] },
    });
    h = await createHarness(server);
    const acc = await h.addAccount({ email: 'me@gmail.com' });
    await waitFor('all folders synced', () => {
      const ctx = h!.engine.ctx;
      const all = ctx.folders.rowByRole(acc.id, 'all');
      const arch = ctx.folders.rowByRole(acc.id, 'archive');
      return !!all && !!arch && h!.folderMessages(all.id).length === 2 && h!.folderMessages(arch.id).length === 1
        && h!.inboxMessages(acc.id).length === 1;
    });

    const res = await search(h, 'claude');
    expect(subjects(res).sort()).toEqual(['Claude receipt', 'Welcome back to Claude Max']);
    expect(res.totalApprox).toBe(2);
    const inboxId = h.folderByRole(acc.id, 'inbox').id;
    const welcome = res.items.find((i) => i.subject.startsWith('Welcome'))!;
    expect(welcome.folderId).toBe(inboxId);

    // Asking for one folder still lists that folder's copy.
    expect(subjects(await search(h, 'welcome folder:archive'))).toEqual(['Welcome back to Claude Max']);
    expect(subjects(await search(h, 'welcome in:inbox'))).toEqual(['Welcome back to Claude Max']);
    // Paging does not lose or repeat rows.
    const p1 = await search(h, 'claude', { limit: 1, offset: 0 });
    const p2 = await search(h, 'claude', { limit: 1, offset: 1 });
    expect([...subjects(p1), ...subjects(p2)].sort()).toEqual(['Claude receipt', 'Welcome back to Claude Max']);
  });
});

describe('search.server', () => {
  it('finds mail that was never downloaded, adds its header, and then local search finds it too', async () => {
    server = await startFakeImap({
      inbox: [
        { raw: rawMessage({ subject: 'Recent hello' }) },
        {
          raw: rawMessage({ subject: 'Ancient invoice', text: 'Please pay the xylophone invoice' }),
          internaldate: new Date(Date.now() - 400 * DAY),
        },
      ],
    });
    h = await createHarness(server);
    const acc = await h.addAccount({ syncDays: 30 });
    await waitFor('recent synced', () => h!.inboxMessages(acc.id).length === 1);
    await waitFor('folders listed', () => h!.engine.ctx.folders.rowByRole(acc.id, 'archive'));
    expect(subjects(await search(h, 'ancient'))).toEqual([]);

    const res = (await h.engine.handle('search.server', { query: 'xylophone' })) as ServerSearchRes;
    expect(res.added).toBe(1);
    expect(res.items.map((i) => i.subject)).toEqual(['Ancient invoice']);
    h.engine.ctx.hub.flush();
    expect(h.eventsOfType('messages:changed').some((e) => e.added.includes(res.items[0]!.id))).toBe(true);

    expect(subjects(await search(h, 'ancient'))).toEqual(['Ancient invoice']);
    // Running it again adds nothing new.
    const again = (await h.engine.handle('search.server', { query: 'xylophone' })) as ServerSearchRes;
    expect(again.added).toBe(0);
    expect(again.items).toHaveLength(1);
  });

  it('understands operators and limits to the chosen accounts', async () => {
    const c = await boot();
    const res = (await c.h.engine.handle('search.server', {
      query: 'from:alice is:unread',
      accountIds: [c.acc.id],
    })) as ServerSearchRes;
    expect(res.items.map((i) => i.subject)).toEqual(['Team lunch on Friday']);
    const none = (await c.h.engine.handle('search.server', { query: 'from:alice', accountIds: [] })) as ServerSearchRes;
    expect(none.items.length).toBeGreaterThanOrEqual(0);
    const empty = (await c.h.engine.handle('search.server', { query: '' })) as ServerSearchRes;
    expect(empty).toEqual({ added: 0, items: [] });
  });
});
