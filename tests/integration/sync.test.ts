// Engine integration: sync, IDLE, flags, expunge, UIDVALIDITY, reconnect — real IMAP over a socket.
// Flag/expunge cases run twice: with CONDSTORE and without (full flag-fetch fallback).
import { afterEach, describe, expect, it } from 'vitest';
import type { AccountStatus } from '../../src/shared/ipc';
import { createHarness, waitFor, type Harness } from '../fakes/engineHarness';
import {
  DEFAULT_PLUGINS,
  PLUGINS_NO_CONDSTORE,
  rawMessage,
  type SeedMessage,
  startFakeImap,
  type FakeImapServer,
} from '../fakes/fakeImapServer';

const HOUR = 3_600_000;
const seed = (n: number, flags: string[] = []): SeedMessage[] =>
  Array.from({ length: n }, (_, i) => ({
    raw: rawMessage({
      subject: `Seed ${i + 1}`,
      messageId: `<seed-${i + 1}@fake.test>`,
      date: new Date(Date.now() - (n - i) * HOUR),
    }),
    flags,
    internaldate: new Date(Date.now() - (n - i) * HOUR),
  }));

let server: FakeImapServer | null = null;
let h: Harness | null = null;

afterEach(async () => {
  await h?.cleanup();
  await server?.close();
  h = null;
  server = null;
});

async function boot(plugins = DEFAULT_PLUGINS, inbox = seed(3)) {
  server = await startFakeImap({ plugins, inbox });
  h = await createHarness(server);
  const acc = await h.addAccount();
  return { server, h, acc };
}

const subjects = (hh: Harness, accId: string) =>
  hh
    .inboxMessages(accId)
    .map((m) => m.subject)
    .sort();

describe('initial sync', () => {
  it('stores message headers in SQLite and saves the sync cursors', async () => {
    const { h: hh, acc, server: srv } = await boot();
    await waitFor('3 messages', () => hh.inboxMessages(acc.id).length === 3);
    const msgs = hh.inboxMessages(acc.id);
    expect(subjects(hh, acc.id)).toEqual(['Seed 1', 'Seed 2', 'Seed 3']);
    const m = msgs.find((x) => x.subject === 'Seed 1')!;
    expect(m.from).toEqual({ name: 'Alice', address: 'alice@example.com' });
    expect(m.to).toEqual([{ name: 'Me', address: 'me@example.com' }]);
    expect(m.messageIdHeader).toBe('<seed-1@fake.test>');
    expect(m.seen).toBe(false);
    expect(m.size).toBeGreaterThan(100);
    expect(m.hasAttachments).toBe(false);
    const inbox = hh.folderByRole(acc.id, 'inbox');
    expect(inbox.totalCount).toBe(3);
    expect(inbox.unreadCount).toBe(3);
    await waitFor(
      'cursors saved',
      () => hh.engine.ctx.folders.syncState(inbox.id)!.uidnext !== null,
    );
    const state = hh.engine.ctx.folders.syncState(inbox.id)!;
    expect(state.uidvalidity).toBe(srv.mailbox('INBOX').uidvalidity);
    expect(state.uidnext).toBe(4);
    const row = hh.engine.ctx.db
      .prepare('SELECT COUNT(*) AS n FROM message WHERE folder_id = ?')
      .get(inbox.id) as { n: number };
    expect(row.n).toBe(3);
  });

  it('keeps \\Seen from the server and counts unread correctly', async () => {
    const { h: hh, acc } = await boot(DEFAULT_PLUGINS, [
      ...seed(2),
      { raw: rawMessage({ subject: 'Read one' }), flags: ['\\Seen', '\\Flagged'] },
    ]);
    await waitFor('3 messages', () => hh.inboxMessages(acc.id).length === 3);
    const read = hh.inboxMessages(acc.id).find((x) => x.subject === 'Read one')!;
    expect(read.seen).toBe(true);
    expect(read.flagged).toBe(true);
    expect(hh.folderByRole(acc.id, 'inbox').unreadCount).toBe(2);
  });

  it('Gmail-like layout: read mail stays read in the unified list and counts; syncing never sets Seen', async () => {
    const mk = (n: number, flags: string[]): SeedMessage => ({
      raw: rawMessage({
        subject: `G${n}`,
        messageId: `<g${n}@fake.test>`,
        text: `Body text number ${n}`,
      }),
      flags,
    });
    const read = mk(1, ['\\Seen']);
    const unread = mk(2, []);
    server = await startFakeImap({
      gmailLayout: true,
      inbox: [read, unread],
      folders: { 'All Mail': [read, unread], Projects: [read] },
    });
    h = await createHarness(server);
    const acc = await h.addAccount();
    await waitFor('all synced', () => {
      const all = h!.folderByPath(acc.id, 'All Mail');
      return h!.folderMessages(all.id).length === 2 && h!.inboxMessages(acc.id).length === 2;
    });
    await waitFor('snippets', () => h!.inboxMessages(acc.id).every((m) => m.snippet.length > 0));
    const list = h.engine.ctx.messages.list({
      scope: { kind: 'unifiedInbox' },
      cursor: null,
      limit: 50,
    });
    expect(list.items.map((m) => [m.subject, m.seen]).sort()).toEqual([
      ['G1', true],
      ['G2', false],
    ]);
    expect(list.items.find((m) => m.subject === 'G1')!.snippet).toContain('Body text number 1');
    expect(h.folderByRole(acc.id, 'inbox').unreadCount).toBe(1);
    expect(h.engine.ctx.folders.counts().unifiedInboxUnread).toBe(1);
    // The unread message must still be unread on the server (snippet peek used BODY.PEEK).
    expect(server.mailbox('INBOX').messages.map((m) => m.flags.includes('\\Seen'))).toEqual([
      true,
      false,
    ]);
  });

  it('syncs the other folders too, and the account ends up online', async () => {
    server = await startFakeImap({
      inbox: seed(1),
      folders: { Sent: [{ raw: rawMessage({ subject: 'Sent one' }), flags: ['\\Seen'] }] },
    });
    h = await createHarness(server);
    const acc = await h.addAccount();
    await waitFor('sent synced', () => {
      const sent = h!.folderByRole(acc.id, 'sent');
      return h!.folderMessages(sent.id).length === 1;
    });
    const st = (): AccountStatus =>
      h!.engine.sessions.statuses().find((s) => s.accountId === acc.id)!;
    await waitFor('online', () => st().state === 'online');
    expect(st().lastSyncAt).not.toBeNull();
  });
});

describe('IDLE / new mail', () => {
  it('a message delivered after the first sync appears and fires messages:changed', async () => {
    const { h: hh, acc, server: srv } = await boot();
    await waitFor('3 messages', () => hh.inboxMessages(acc.id).length === 3);
    const inbox = hh.folderByRole(acc.id, 'inbox');
    await waitFor('idle connection open', () => srv.connectionCount() >= 1);
    hh.engine.ctx.hub.flush();
    hh.events.length = 0;

    srv.deliver('INBOX', { raw: rawMessage({ subject: 'Fresh arrival' }) });

    // Well under the 2-minute poll interval: only IDLE can make this fast.
    await waitFor('new message locally', () =>
      hh.inboxMessages(acc.id).find((m) => m.subject === 'Fresh arrival'),
    );
    const added = hh.inboxMessages(acc.id).find((m) => m.subject === 'Fresh arrival')!;
    const ev = await waitFor('messages:changed for the new message', () =>
      hh
        .eventsOfType('messages:changed')
        .find((e) => e.added.includes(added.id) && e.folderIds.includes(inbox.id)),
    );
    expect(ev.removed).toEqual([]);
    expect(hh.folderByRole(acc.id, 'inbox').unreadCount).toBe(4);
  });

  it('does not fire messages:changed again when nothing changed', async () => {
    const { h: hh, acc } = await boot();
    await waitFor('3 messages', () => hh.inboxMessages(acc.id).length === 3);
    await waitFor('settled', () => hh.engine.sessions.statuses()[0]?.state === 'online');
    const inbox = hh.folderByRole(acc.id, 'inbox');
    hh.engine.ctx.hub.flush();
    hh.events.length = 0;
    await hh.engine.handle('sync.folder', { folderId: inbox.id });
    await new Promise((r) => setTimeout(r, 800));
    expect(hh.eventsOfType('messages:changed')).toEqual([]);
  });
});

describe.each([
  ['with CONDSTORE', DEFAULT_PLUGINS],
  ['without CONDSTORE', PLUGINS_NO_CONDSTORE],
])('flags and deletions %s', (_label, plugins) => {
  it('marking read in the app is written to the server', async () => {
    const { h: hh, acc, server: srv } = await boot(plugins);
    await waitFor('3 messages', () => hh.inboxMessages(acc.id).length === 3);
    const target = hh.inboxMessages(acc.id).find((m) => m.subject === 'Seed 2')!;

    await hh.engine.handle('messages.apply', {
      messageIds: [target.id],
      action: { type: 'markRead', read: true },
    });

    const serverMsg = () => srv.mailbox('INBOX').messages.find((m) => m.uid === target.uid)!;
    await waitFor('\\Seen on server', () => serverMsg().flags.includes('\\Seen'));
    expect(hh.folderByRole(acc.id, 'inbox').unreadCount).toBe(2);

    await hh.engine.handle('messages.apply', {
      messageIds: [target.id],
      action: { type: 'markRead', read: false },
    });
    await waitFor('\\Seen removed on server', () => !serverMsg().flags.includes('\\Seen'));
  });

  it('starring in the app is written to the server', async () => {
    const { h: hh, acc, server: srv } = await boot(plugins);
    await waitFor('3 messages', () => hh.inboxMessages(acc.id).length === 3);
    const target = hh.inboxMessages(acc.id)[0];
    await hh.engine.handle('messages.apply', {
      messageIds: [target.id],
      action: { type: 'flag', flagged: true },
    });
    await waitFor('\\Flagged on server', () =>
      srv
        .mailbox('INBOX')
        .messages.find((m) => m.uid === target.uid)!
        .flags.includes('\\Flagged'),
    );
  });

  it('a flag change made elsewhere is picked up (push or manual sync)', async () => {
    const { h: hh, acc, server: srv } = await boot(plugins);
    await waitFor('3 messages', () => hh.inboxMessages(acc.id).length === 3);
    const target = hh.inboxMessages(acc.id).find((m) => m.subject === 'Seed 1')!;
    expect(target.seen).toBe(false);

    await srv.setFlags('INBOX', target.uid, { add: ['\\Seen', '\\Flagged'] });

    await waitFor(
      'external flags applied',
      () => {
        const m = hh.inboxMessages(acc.id).find((x) => x.id === target.id)!;
        return m.seen && m.flagged;
      },
      15_000,
    );
    expect(hh.folderByRole(acc.id, 'inbox').unreadCount).toBe(2);

    await srv.setFlags('INBOX', target.uid, { remove: ['\\Seen'] });
    const inbox = hh.folderByRole(acc.id, 'inbox');
    await waitFor(
      'external un-read applied',
      async () => {
        await hh.engine.handle('sync.folder', { folderId: inbox.id });
        return !hh.inboxMessages(acc.id).find((x) => x.id === target.id)!.seen;
      },
      15_000,
    );
  });

  it('a flag change in a non-INBOX folder is picked up by an incremental sync', async () => {
    server = await startFakeImap({
      plugins,
      inbox: seed(1),
      folders: {
        Archive: [{ raw: rawMessage({ subject: 'Archived' }) }],
      },
    });
    h = await createHarness(server);
    const acc = await h.addAccount();
    const archive = await waitFor('archive synced', () => {
      const f = h!.folderByRole(acc.id, 'archive');
      return h!.folderMessages(f.id).length === 1 ? f : null;
    });
    const uid = h.folderMessages(archive.id)[0].uid;
    await server.setFlags('Archive', uid, { add: ['\\Seen'] });
    await waitFor('archive flag synced', async () => {
      await h!.engine.handle('sync.folder', { folderId: archive.id });
      return h!.folderMessages(archive.id)[0].seen;
    });
  });

  it('a message deleted on the server disappears locally', async () => {
    const { h: hh, acc, server: srv } = await boot(plugins);
    await waitFor('3 messages', () => hh.inboxMessages(acc.id).length === 3);
    const victim = hh.inboxMessages(acc.id).find((m) => m.subject === 'Seed 2')!;
    hh.engine.ctx.hub.flush();
    hh.events.length = 0;

    await srv.expunge('INBOX', victim.uid);

    await waitFor(
      'message removed locally',
      () => !hh.inboxMessages(acc.id).some((m) => m.id === victim.id),
      15_000,
    );
    expect(subjects(hh, acc.id)).toEqual(['Seed 1', 'Seed 3']);
    const ev = await waitFor('removal event', () =>
      hh.eventsOfType('messages:changed').find((e) => e.removed.includes(victim.id)),
    );
    expect(ev.removed).toContain(victim.id);
    expect(hh.folderByRole(acc.id, 'inbox').totalCount).toBe(2);
  });

  it('a delete followed by a new arrival keeps UIDs straight', async () => {
    const { h: hh, acc, server: srv } = await boot(plugins);
    await waitFor('3 messages', () => hh.inboxMessages(acc.id).length === 3);
    const first = hh.inboxMessages(acc.id).find((m) => m.subject === 'Seed 1')!;
    await srv.expunge('INBOX', first.uid);
    srv.deliver('INBOX', { raw: rawMessage({ subject: 'After delete' }) });
    await waitFor(
      'state converged',
      () => subjects(hh, acc.id).join('|') === 'After delete|Seed 2|Seed 3',
      15_000,
    );
  });
});

describe('UIDVALIDITY change', () => {
  it('purges the folder and resyncs from scratch', async () => {
    const { h: hh, acc, server: srv } = await boot();
    await waitFor('3 messages', () => hh.inboxMessages(acc.id).length === 3);
    const inbox = hh.folderByRole(acc.id, 'inbox');
    // Rows land before the cursors are saved; the cursors are the real end of the first sync.
    await waitFor(
      'cursors saved',
      () => hh.engine.ctx.folders.syncState(inbox.id)!.uidvalidity !== null,
    );
    const oldIds = hh.inboxMessages(acc.id).map((m) => m.id);
    const oldValidity = hh.engine.ctx.folders.syncState(inbox.id)!.uidvalidity;
    hh.engine.ctx.hub.flush();
    hh.events.length = 0;

    srv.resetMailbox('INBOX', [
      { raw: rawMessage({ subject: 'Reborn A', messageId: '<a@fake.test>' }) },
      { raw: rawMessage({ subject: 'Reborn B', messageId: '<b@fake.test>' }) },
    ]);
    await hh.engine.handle('sync.folder', { folderId: inbox.id });

    await waitFor('resynced', () => subjects(hh, acc.id).join('|') === 'Reborn A|Reborn B', 15_000);
    await waitFor(
      'new cursors saved',
      () =>
        hh.engine.ctx.folders.syncState(inbox.id)!.uidvalidity === srv.mailbox('INBOX').uidvalidity,
    );
    const state = hh.engine.ctx.folders.syncState(inbox.id)!;
    expect(state.uidvalidity).toBe(srv.mailbox('INBOX').uidvalidity);
    expect(state.uidvalidity).not.toBe(oldValidity);
    expect(
      hh
        .inboxMessages(acc.id)
        .map((m) => m.uid)
        .sort(),
    ).toEqual([1, 2]);
    await waitFor('purge reported as removed', () =>
      hh.eventsOfType('messages:changed').some((e) => oldIds.every((id) => e.removed.includes(id))),
    );
  });
});

describe('reconnect', () => {
  it('reconnects after the server drops every connection and keeps receiving mail', async () => {
    const { h: hh, acc, server: srv } = await boot();
    await waitFor('3 messages', () => hh.inboxMessages(acc.id).length === 3);
    await waitFor('online', () => hh.engine.sessions.statuses()[0]?.state === 'online');
    hh.engine.ctx.hub.flush();
    hh.events.length = 0;

    srv.dropConnections();

    await waitFor('retrying state reported', () =>
      hh.eventsOfType('account:status').some((e) => e.status.state === 'retrying'),
    );
    await waitFor(
      'online again',
      () => {
        const last = hh.eventsOfType('account:status').at(-1)!;
        return last.status.state === 'online' || last.status.state === 'syncing';
      },
      20_000,
    );

    srv.deliver('INBOX', { raw: rawMessage({ subject: 'After reconnect' }) });
    await waitFor('mail after reconnect', () =>
      hh.inboxMessages(acc.id).some((m) => m.subject === 'After reconnect'),
    );
  });
});
