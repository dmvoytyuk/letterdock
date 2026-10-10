// Paging correctness of conversations.list (newest-first walk vs full grouping) and search.local
// (duplicate copies hidden among the hits) on a few thousand generated messages.
import { afterEach, describe, expect, it } from 'vitest';
import type { ListConversationsRes, SearchRes } from '../../src/shared/ipc';
import type { HeaderInput } from '../../src/engine/db/repos/messageRepo';
import { createHarness, waitForInboxCursors, type Harness } from '../fakes/engineHarness';
import { startFakeImap, type FakeImapServer } from '../fakes/fakeImapServer';

let server: FakeImapServer | null = null;
let h: Harness | null = null;

afterEach(async () => {
  await h?.cleanup();
  await server?.close().catch(() => undefined);
  h = null;
  server = null;
});

const BASE = Date.UTC(2026, 0, 1);

async function setup() {
  server = await startFakeImap({ inbox: [] });
  h = await createHarness(server, { settings: { groupConversations: true } });
  const acc = await h.addAccount();
  await waitForInboxCursors(h, [acc.id]);
  const ctx = h.engine.ctx;
  const folder = (role: string) => ctx.folders.list(acc.id).find((f) => f.role === role)!;
  const mk = (folderId: number, uid: number, o: Partial<HeaderInput>): HeaderInput => ({
    accountId: acc.id,
    folderId,
    uid,
    messageId: null,
    inReplyTo: null,
    references: null,
    subject: 'x',
    from: { name: 'Pat', address: 'pat@example.test' },
    to: [{ address: acc.email }],
    cc: [],
    bcc: [],
    replyTo: [],
    dateMs: BASE,
    internalMs: BASE,
    size: 1000,
    flags: { seen: true, flagged: false, answered: false, draft: false, deleted: false, keywords: [] },
    modseq: null,
    hasAttachments: false,
    ...o,
  });
  return { acc, ctx, folder, mk };
}

describe('conversations.list paging at scale', () => {
  it('newest-first pages equal the reverse of the oldest-first pages, with ties and sparse views', async () => {
    const { acc, ctx, folder, mk } = await setup();
    const inbox = folder('inbox');
    const sent = folder('sent');
    const archive = folder('archive');
    const rows: HeaderInput[] = [];
    let uid = 5000;
    for (let t = 0; t < 400; t++) {
      // Many conversations share a date (ties); some have a later reply in Sent or Archive;
      // some live only in Sent (not part of the Inbox view).
      const d = BASE + Math.floor(t / 7) * 60_000;
      const kind = t % 5;
      const root = `<s${t}-0@scale.test>`;
      const f0 = kind === 4 ? sent : inbox;
      rows.push(
        mk(f0.id, ++uid, {
          messageId: root,
          subject: `topic ${t}`,
          dateMs: d,
          flags: { seen: t % 3 !== 0, flagged: t % 97 === 0, answered: false, draft: false, deleted: false, keywords: [] },
        }),
      );
      if (kind === 1 || kind === 2) {
        rows.push(
          mk((kind === 1 ? sent : archive).id, ++uid, {
            messageId: `<s${t}-1@scale.test>`,
            inReplyTo: root,
            references: root,
            subject: `Re: topic ${t}`,
            dateMs: d + 3 * 60_000 + (t % 4) * 1000,
          }),
        );
      }
    }
    ctx.messages.upsertHeaders(rows);

    const walkAll = async (direction: 'asc' | 'desc', scope: object, limit: number, unreadOnly = false) => {
      const ids: string[] = [];
      let cursor: ListConversationsRes['nextCursor'] = null;
      let total: number | null = null;
      for (let guard = 0; guard < 200; guard++) {
        const res = (await h!.engine.handle('conversations.list', {
          scope,
          limit,
          direction,
          unreadOnly,
          cursor,
        })) as ListConversationsRes;
        if (total === null) total = res.total;
        ids.push(...res.items.map((i) => i.threadId));
        cursor = res.nextCursor;
        if (!cursor) break;
      }
      return { ids, total };
    };

    const scopes = [
      { kind: 'unifiedInbox' },
      { kind: 'accountInbox', accountId: acc.id },
      { kind: 'unifiedFlagged' },
      { kind: 'unifiedUnread' },
      { kind: 'folder', folderId: archive.id },
    ];
    for (const scope of scopes) {
      for (const limit of [7, 50]) {
        const desc = await walkAll('desc', scope, limit);
        const asc = await walkAll('asc', scope, limit);
        expect(new Set(desc.ids).size).toBe(desc.ids.length);
        expect(desc.ids).toEqual([...asc.ids].reverse());
        expect(desc.total).toBe(desc.ids.length);
      }
    }
    // The Inbox view holds the 320 conversations that start in the Inbox, none that live only in Sent.
    expect((await walkAll('desc', { kind: 'unifiedInbox' }, 13)).ids.length).toBe(320);
    // A conversation whose newest message is a Sent reply sorts by that reply.
    const first = (await h!.engine.handle('conversations.list', {
      scope: { kind: 'unifiedInbox' },
      limit: 3,
    })) as ListConversationsRes;
    const dates = first.items.map((i) => i.latest.date);
    expect(dates).toEqual([...dates].sort((a, b) => b - a));
  });
});

describe('search.local paging at scale', () => {
  it('hides duplicate copies among the hits and pages without gaps or repeats', async () => {
    const { ctx, folder, mk } = await setup();
    const inbox = folder('inbox');
    const archive = folder('archive');
    const sent = folder('sent');
    const rows: HeaderInput[] = [];
    let uid = 9000;
    for (let n = 0; n < 600; n++) {
      const word = n % 2 === 0 ? 'invoice' : 'meeting';
      const mid = `<q${n}@scale.test>`;
      const d = BASE + n * 1000;
      // Every third message exists twice (Inbox + Archive); every tenth also in Sent.
      rows.push(mk(inbox.id, ++uid, { messageId: mid, subject: `${word} ${n}`, dateMs: d }));
      if (n % 3 === 0) rows.push(mk(archive.id, ++uid, { messageId: mid, subject: `${word} ${n}`, dateMs: d }));
      if (n % 10 === 0) rows.push(mk(sent.id, ++uid, { messageId: mid, subject: `${word} ${n}`, dateMs: d }));
    }
    ctx.messages.upsertHeaders(rows);

    const seen: number[] = [];
    let total = 0;
    for (let offset = 0; offset < 1000; offset += 40) {
      const res = (await h!.engine.handle('search.local', { query: 'invoice', limit: 40, offset })) as SearchRes;
      total = res.totalApprox;
      if (res.items.length === 0) break;
      seen.push(...res.items.map((i) => i.id));
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBe(300);
    expect(total).toBe(300);
    // The Inbox copy wins over Archive and Sent.
    const roles = new Set(
      seen.map((id) => (ctx.messages.row(id) as { folder_id: number }).folder_id),
    );
    expect([...roles]).toEqual([inbox.id]);
    // A copy that is not itself a hit does not hide anything: restricting to Archive shows those copies.
    const inArchive = (await h!.engine.handle('search.local', {
      query: 'invoice folder:archive',
      limit: 500,
    })) as SearchRes;
    expect(inArchive.items.length).toBe(100);
  });
});
