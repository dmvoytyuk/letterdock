// Engine integration: `messages.list` with sort (date, sender, subject), both directions, paging
// with a keyset cursor: no gaps and no repeats, in every scope.
import { afterEach, describe, expect, it } from 'vitest';
import type { ListMessagesRes, ListScope } from '../../src/shared/ipc';
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
const t0 = Date.now() - 48 * H;
const at = (hours: number) => new Date(t0 + hours * H);
const mail = (subject: string, from: string, hours: number, id: string) => ({
  raw: rawMessage({ subject, messageId: `<${id}@x>`, date: at(hours), from }),
  internaldate: at(hours),
});

/** Seven messages: repeated senders and subjects, and two with exactly the same date. */
const OPTS = {
  inbox: [
    mail('Zeta report', 'Carl <carl@example.com>', 1, 'z1'),
    mail('alpha plan', 'Anna <anna@example.com>', 2, 'a1'),
    mail('Re: Beta notes', 'Bob <bob@example.com>', 3, 'b1'),
    mail('Gamma', 'Anna <anna@example.com>', 4, 'g1'),
    mail('Alpha plan', 'Erik <erik@example.com>', 5, 'a2'),
    mail('Re: Alpha plan', 'Carl <carl@example.com>', 5, 'a3'),
    mail('Delta', 'dora@example.com', 6, 'd1'),
  ],
};

async function boot() {
  server = await startFakeImap(OPTS);
  h = await createHarness(server);
  const acc = await h.addAccount();
  await waitFor('inbox synced', () => h!.inboxMessages(acc.id).length === OPTS.inbox.length);
  await waitForInboxCursors(h, [acc.id]);
  return { h, acc };
}

const page = (hh: Harness, scope: ListScope, extra: object) =>
  hh.engine.handle('messages.list', { scope, cursor: null, limit: 50, ...extra }) as Promise<ListMessagesRes>;

async function allPages(hh: Harness, scope: ListScope, extra: object, limit: number): Promise<number[]> {
  const out: number[] = [];
  let cursor: ListMessagesRes['nextCursor'] = null;
  for (let guard = 0; guard < 30; guard++) {
    const res = (await hh.engine.handle('messages.list', { scope, cursor, limit, ...extra })) as ListMessagesRes;
    out.push(...res.items.map((i) => i.id));
    cursor = res.nextCursor;
    if (!cursor) return out;
  }
  throw new Error('paging did not end');
}

const combos = [
  ['date', 'desc'],
  ['date', 'asc'],
  ['sender', 'asc'],
  ['sender', 'desc'],
  ['subject', 'asc'],
  ['subject', 'desc'],
] as const;

describe('messages.list sort', () => {
  it('orders by date (newest first by default), sender and subject; equal keys newest first', async () => {
    const c = await boot();
    const dflt = await page(c.h, { kind: 'unifiedInbox' }, {});
    const dates = dflt.items.map((m) => m.date);
    expect(dates).toEqual([...dates].sort((a, b) => b - a));
    const asc = await page(c.h, { kind: 'unifiedInbox' }, { sort: 'date', direction: 'asc' });
    expect(asc.items.map((m) => m.id)).toEqual([...dflt.items.map((m) => m.id)].reverse());

    const sender = await page(c.h, { kind: 'unifiedInbox' }, { sort: 'sender' });
    expect(sender.items.map((m) => m.from?.name ?? m.from?.address)).toEqual([
      'Anna',
      'Anna',
      'Bob',
      'Carl',
      'Carl',
      'dora@example.com',
      'Erik',
    ]);
    // Anna: Gamma (hour 4) before alpha plan (hour 2)
    expect(sender.items.slice(0, 2).map((m) => m.subject)).toEqual(['Gamma', 'alpha plan']);

    const subject = await page(c.h, { kind: 'unifiedInbox' }, { sort: 'subject' });
    // Same subject (ignoring case and Re:): newest first. a2 and a3 share the date; the higher id first.
    expect(subject.items.map((m) => m.subject.toLowerCase().replace(/^re: /, ''))).toEqual([
      'alpha plan',
      'alpha plan',
      'alpha plan',
      'beta notes',
      'delta',
      'gamma',
      'zeta report',
    ]);
    expect(subject.items[2]!.subject).toBe('alpha plan');
    const za = await page(c.h, { kind: 'unifiedInbox' }, { sort: 'subject', direction: 'desc' });
    expect(za.items[0]!.subject).toBe('Zeta report');
    expect(za.total).toBe(7);
  });

  it('the next-page position of a sender or subject sort carries the key; a date position does not', async () => {
    const c = await boot();
    const s = await page(c.h, { kind: 'unifiedInbox' }, { sort: 'sender', limit: 3 });
    expect(s.nextCursor?.key).toBe('bob');
    const j = await page(c.h, { kind: 'unifiedInbox' }, { sort: 'subject', limit: 2 });
    expect(j.nextCursor?.key).toBe('alpha plan');
    const d = await page(c.h, { kind: 'unifiedInbox' }, { limit: 2 });
    expect(d.nextCursor).not.toHaveProperty('key');
  });

  it('refuses a position without a key for a sender or subject sort', async () => {
    const c = await boot();
    const d = await page(c.h, { kind: 'unifiedInbox' }, { limit: 2 });
    await expect(
      page(c.h, { kind: 'unifiedInbox' }, { sort: 'sender', cursor: d.nextCursor }),
    ).rejects.toMatchObject({ appError: { code: 'INVALID_INPUT' } });
  });

  const scopes: [string, (hh: Harness, accountId: string) => ListScope][] = [
    ['unifiedInbox', () => ({ kind: 'unifiedInbox' })],
    ['unifiedUnread', () => ({ kind: 'unifiedUnread' })],
    ['accountInbox', (_hh, accountId) => ({ kind: 'accountInbox', accountId })],
    [
      'folder',
      (hh, accountId) => ({ kind: 'folder', folderId: hh.engine.ctx.folders.rowByRole(accountId, 'inbox')!.id }),
    ],
  ];

  it.each(combos)(
    'paging one by one equals one page (%s %s), no gaps, no repeats, in every scope',
    async (sort, direction) => {
      const c = await boot();
      for (const [name, mk] of scopes) {
        const scope = mk(c.h, c.acc.id);
        const whole = await allPages(c.h, scope, { sort, direction }, 50);
        expect(whole, name).toHaveLength(7);
        expect(new Set(whole).size, name).toBe(7);
        for (const limit of [1, 2, 3, 6]) {
          expect(await allPages(c.h, scope, { sort, direction }, limit), `${name} limit ${limit}`).toEqual(whole);
        }
      }
    },
  );

  it('paging works for the flagged scope and with unreadOnly', async () => {
    const c = await boot();
    const ids = c.h.inboxMessages(c.acc.id).map((m) => m.id);
    await c.h.engine.handle('messages.apply', { messageIds: ids.slice(0, 5), action: { type: 'flag', flagged: true } });
    await c.h.engine.handle('messages.apply', { messageIds: ids.slice(0, 2), action: { type: 'markRead', read: true } });
    for (const [sort, direction] of combos) {
      const flagged = await allPages(c.h, { kind: 'unifiedFlagged' }, { sort, direction }, 50);
      expect(flagged).toHaveLength(5);
      expect(await allPages(c.h, { kind: 'unifiedFlagged' }, { sort, direction }, 2)).toEqual(flagged);
      const unread = await allPages(c.h, { kind: 'unifiedInbox' }, { sort, direction, unreadOnly: true }, 50);
      expect(unread).toHaveLength(5);
      expect(await allPages(c.h, { kind: 'unifiedInbox' }, { sort, direction, unreadOnly: true }, 2)).toEqual(unread);
    }
  });
});
