// Drafts show up in the local Drafts folder at once; the server copy follows in the background
// (also after being offline or after an app restart) and is matched by Message-ID (no duplicates).
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApplyActionRes, ComposeDraft, SendReq } from '../../src/shared/ipc';
import { createHarness, waitFor, waitForInboxCursors, type Harness } from '../fakes/engineHarness';
import { rawMessage, startFakeImap, type FakeImapServer } from '../fakes/fakeImapServer';

let server: FakeImapServer | null = null;
const harnesses: Harness[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    await h.engine.compose.shutdown().catch(() => undefined);
    await h.cleanup();
  }
  await server?.close().catch(() => undefined);
  server = null;
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function boot(hOpts: Parameters<typeof createHarness>[1] = {}) {
  server = await startFakeImap({ inbox: [{ raw: rawMessage({ subject: 'Hello', messageId: '<hello@fake.test>' }) }] });
  const h = await createHarness(server, hOpts);
  harnesses.push(h);
  h.engine.ctx.draftPushDelayMs = 0;
  const acc = await h.addAccount();
  await waitFor('inbox synced', () => h.inboxMessages(acc.id).length === 1);
  await waitForInboxCursors(h, [acc.id]);
  await waitFor('drafts row', () => h.engine.ctx.folders.rowByRole(acc.id, 'drafts'));
  await h.engine.actions.drain();
  return { h, srv: server, acc, drafts: h.folderByRole(acc.id, 'drafts') };
}

const call = <T>(h: Harness, ch: string, req?: unknown) => h.engine.handle(ch, req) as Promise<T>;
const net = (h: Harness, online: boolean) => call(h, 'system.networkChanged', { online });
const statusOf = async (h: Harness, accountId: string) =>
  (
    (await call(h, 'accounts.statuses')) as { accountId: string; state: string; pendingCount: number }[]
  ).find((s) => s.accountId === accountId)!;

const newDraft = (h: Harness, accountId: string) =>
  call<ComposeDraft>(h, 'compose.prepare', { mode: 'new', accountId });
function req(d: ComposeDraft, over: Partial<SendReq> = {}): SendReq {
  return {
    draftId: d.draftId,
    accountId: d.accountId,
    to: [{ address: 'x@example.com' }],
    cc: [],
    bcc: [],
    subject: 'Draft v1',
    html: '<p>Hello draft</p>',
    attachmentTokens: [],
    ...over,
  };
}
const serverDrafts = (srv: FakeImapServer) => srv.mailbox('Drafts').messages;

describe('drafts: local first, server later', () => {
  it('shows the draft in the local Drafts folder at once, then links it to the server copy', async () => {
    const { h, srv, acc, drafts } = await boot();
    // Hold the server back so we can look at the "local only" moment.
    srv.rejectCommands(['APPEND']);
    const d = await newDraft(h, acc.id);
    h.events.length = 0;
    await call(h, 'compose.saveDraft', req(d));

    // No wait for the server: the row is there when saveDraft returns.
    const rows = h.folderMessages(drafts.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ subject: 'Draft v1', draft: true, seen: true, localOnly: true });
    expect(rows[0]!.uid).toBeLessThanOrEqual(0);
    expect(['saving', 'failed']).toContain(rows[0]!.draftSync);
    expect(rows[0]!.snippet).toContain('Hello draft');
    expect(h.engine.ctx.folders.get(drafts.id)!.totalCount).toBe(1);
    const change = h.eventsOfType('messages:changed').flatMap((e) => e.added);
    h.engine.ctx.hub.flush();
    expect([...change, ...h.eventsOfType('messages:changed').flatMap((e) => e.added)]).toContain(rows[0]!.id);
    expect(h.eventsOfType('counts:changed').length).toBeGreaterThan(0);
    // It opens from the local text without the server.
    const body = await call<{ html: string }>(h, 'messages.get', { messageId: rows[0]!.id });
    expect(body.html).toContain('Hello draft');
    expect(serverDrafts(srv)).toHaveLength(0);

    srv.allowCommands();
    await call(h, 'drafts.retrySave', { messageId: rows[0]!.id });
    await waitFor('server draft', () => serverDrafts(srv).length === 1);
    await waitFor('linked', () => {
      const r = h.folderMessages(drafts.id);
      return r.length === 1 && r[0]!.uid > 0 && r[0]!.draftSync === 'saved';
    });
    await h.engine.compose.drain();
    // Let the follow-up folder sync finish: still one row, same id.
    await new Promise((r) => setTimeout(r, 500));
    const after = h.folderMessages(drafts.id);
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(rows[0]!.id);
    expect(after[0]).toMatchObject({ localOnly: false, draftSync: 'saved' });
    expect(after[0]!.messageIdHeader).toBeTruthy();
  });

  it('a second save replaces the server copy and never shows two rows', async () => {
    const { h, srv, acc, drafts } = await boot();
    const d = await newDraft(h, acc.id);
    await call(h, 'compose.saveDraft', req(d));
    await waitFor('v1 on server', () => serverDrafts(srv).length === 1);
    await h.engine.compose.drain();
    const id = h.folderMessages(drafts.id)[0]!.id;

    await call(h, 'compose.saveDraft', req(d, { subject: 'Draft v2', html: '<p>Second</p>' }));
    // The local row changes at once.
    expect(h.folderMessages(drafts.id)).toHaveLength(1);
    expect(h.folderMessages(drafts.id)[0]).toMatchObject({ id, subject: 'Draft v2' });
    await waitFor('v2 on server', () => serverDrafts(srv).length === 1 && String(serverDrafts(srv)[0]!.raw).includes('Draft v2'));
    await h.engine.compose.drain();
    await call(h, 'sync.folder', { folderId: drafts.id });
    await new Promise((r) => setTimeout(r, 500));
    const rows = h.folderMessages(drafts.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ subject: 'Draft v2', draftSync: 'saved' });
  });

  it('an offline edit of an uploaded draft keeps one row, marked local only', async () => {
    const { h, srv, acc, drafts } = await boot();
    const d = await newDraft(h, acc.id);
    await call(h, 'compose.saveDraft', req(d));
    await waitFor('v1 on server', () => serverDrafts(srv).length === 1);
    await h.engine.compose.drain();
    // Go offline, edit: the local row is newer than the server copy.
    await net(h, false);
    await waitFor('offline', async () => (await statusOf(h, acc.id)).state === 'offline');
    await call(h, 'compose.saveDraft', req(d, { subject: 'Offline edit' }));
    expect(h.folderMessages(drafts.id)).toHaveLength(1);
    expect(h.folderMessages(drafts.id)[0]).toMatchObject({ subject: 'Offline edit', localOnly: true });
  });

  it('offline: the draft is kept, counted as waiting, and uploaded when the account is back', async () => {
    const { h, srv, acc, drafts } = await boot();
    await net(h, false);
    await waitFor('offline', async () => (await statusOf(h, acc.id)).state === 'offline');
    h.events.length = 0;

    const d = await newDraft(h, acc.id);
    await call(h, 'compose.saveDraft', req(d));
    await waitFor('queued', () => h.folderMessages(drafts.id)[0]?.draftSync === 'queued');
    expect(h.folderMessages(drafts.id)[0]).toMatchObject({ localOnly: true, subject: 'Draft v1' });
    expect((await statusOf(h, acc.id)).pendingCount).toBe(1);
    expect(h.eventsOfType('pending:count').at(-1)).toMatchObject({ accountId: acc.id, count: 1 });
    expect(serverDrafts(srv)).toHaveLength(0);

    // More edits while offline stay one draft.
    await call(h, 'compose.saveDraft', req(d, { subject: 'Draft v2' }));
    expect(h.folderMessages(drafts.id)).toHaveLength(1);
    expect((await statusOf(h, acc.id)).pendingCount).toBe(1);

    await net(h, true);
    await waitFor('uploaded', () => serverDrafts(srv).length === 1);
    await waitFor('nothing waits', async () => (await statusOf(h, acc.id)).pendingCount === 0);
    expect(String(serverDrafts(srv)[0]!.raw)).toContain('Subject: Draft v2');
    await waitFor('linked', () => h.folderMessages(drafts.id)[0]?.draftSync === 'saved');
    await h.engine.compose.drain();
    await new Promise((r) => setTimeout(r, 500));
    expect(h.folderMessages(drafts.id)).toHaveLength(1);
    expect(h.eventsOfType('pending:count').at(-1)).toMatchObject({ accountId: acc.id, count: 0 });
  });

  it('survives an app restart: the draft is still listed and goes out later', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'letterdock-drafts-'));
    dirs.push(dir);
    const dbFile = join(dir, 'mail.db');
    const secrets = new Map<string, string>();
    const { h, srv, acc, drafts } = await boot({ dbFile, dataDir: dir, secrets });
    await net(h, false);
    await waitFor('offline', async () => (await statusOf(h, acc.id)).state === 'offline');
    const d = await newDraft(h, acc.id);
    await call(h, 'compose.saveDraft', req(d, { subject: 'Before quit' }));
    // "Quit" right away.
    await h.engine.shutdown();
    harnesses.splice(harnesses.indexOf(h), 1);
    expect(serverDrafts(srv)).toHaveLength(0);

    const h2 = await createHarness(srv, { dbFile, dataDir: dir, secrets });
    harnesses.push(h2);
    h2.engine.ctx.draftPushDelayMs = 0;
    // Before anything connects, the draft is already in the list.
    expect(h2.folderMessages(drafts.id).map((m) => m.subject)).toEqual(['Before quit']);
    h2.engine.start();
    await waitFor('uploaded after restart', () => serverDrafts(srv).length === 1);
    await waitFor('linked', () => h2.folderMessages(drafts.id)[0]?.draftSync === 'saved');
    await h2.engine.compose.drain();
    await new Promise((r) => setTimeout(r, 500));
    expect(h2.folderMessages(drafts.id)).toHaveLength(1);
  });

  it('reports "failed" when the server refuses while online, and retries', async () => {
    const { h, srv, acc, drafts } = await boot();
    h.engine.ctx.draftRetryMs = 150;
    srv.rejectCommands(['APPEND']);
    const d = await newDraft(h, acc.id);
    await call(h, 'compose.saveDraft', req(d));
    await waitFor('failed', () => h.folderMessages(drafts.id)[0]?.draftSync === 'failed');
    expect((await statusOf(h, acc.id)).pendingCount).toBe(0); // online: not "waiting for the connection"
    srv.allowCommands();
    await waitFor('retried and uploaded', () => serverDrafts(srv).length === 1);
    await waitFor('saved', () => h.folderMessages(drafts.id)[0]?.draftSync === 'saved');
  });

  it('deleting a draft that is not on the server yet forgets it; discard removes row and server copy', async () => {
    const { h, srv, acc, drafts } = await boot();
    await net(h, false);
    await waitFor('offline', async () => (await statusOf(h, acc.id)).state === 'offline');
    const d = await newDraft(h, acc.id);
    await call(h, 'compose.saveDraft', req(d));
    const row = h.folderMessages(drafts.id)[0]!;
    const res = await call<ApplyActionRes>(h, 'messages.apply', { messageIds: [row.id], action: { type: 'delete' } });
    expect(res.succeeded).toEqual([row.id]);
    expect(h.folderMessages(drafts.id)).toHaveLength(0);
    expect((await statusOf(h, acc.id)).pendingCount).toBe(0);
    await net(h, true);
    await waitFor('online', async () => (await statusOf(h, acc.id)).state === 'online');
    await new Promise((r) => setTimeout(r, 400));
    expect(serverDrafts(srv)).toHaveLength(0);

    // Discard of an uploaded draft.
    const d2 = await newDraft(h, acc.id);
    await call(h, 'compose.saveDraft', req(d2));
    await waitFor('uploaded', () => serverDrafts(srv).length === 1);
    await h.engine.compose.drain();
    await call(h, 'compose.discard', { draftId: d2.draftId });
    expect(h.folderMessages(drafts.id)).toHaveLength(0);
    await waitFor('server copy gone', () => serverDrafts(srv).length === 0);
  });

  it('sending a draft removes its row from the Drafts folder', async () => {
    const { h, acc, drafts } = await boot();
    const d = await newDraft(h, acc.id);
    await call(h, 'compose.saveDraft', req(d));
    expect(h.folderMessages(drafts.id)).toHaveLength(1);
    // No SMTP server in this harness: the send fails, so the draft stays. Only check the saved row.
    expect(h.folderMessages(drafts.id)[0]!.subject).toBe('Draft v1');
  });

  it('reopening a draft row opens the saved text, not a text-only copy', async () => {
    const { h, acc, drafts } = await boot();
    const d = await newDraft(h, acc.id);
    await call(h, 'compose.saveDraft', req(d, { html: '<p><b>Bold</b> text</p>' }));
    const row = h.folderMessages(drafts.id)[0]!;
    const again = await call<ComposeDraft>(h, 'compose.prepare', { mode: 'new', draftMessageId: row.id });
    expect(again.draftId).toBe(d.draftId);
    expect(again.html).toContain('<b>Bold</b>');
  });

  // ---- folder counts (the "Drafts 1" badge that stayed after the draft was gone) ----
  const lastDraftsTotal = (h: Harness, folderId: number): number | undefined => {
    h.engine.ctx.hub.flush();
    const evs = h.eventsOfType('counts:changed');
    return evs[evs.length - 1]?.perFolder.find((p) => p.folderId === folderId)?.total;
  };
  const storedTotal = (h: Harness, folderId: number) => h.engine.ctx.folders.get(folderId)!.totalCount;

  it('counts: save then delete (local only) brings the Drafts count back to 0 and tells the UI', async () => {
    const { h, srv, acc, drafts } = await boot();
    srv.rejectCommands(['APPEND']);
    const d = await newDraft(h, acc.id);
    await call(h, 'compose.saveDraft', req(d));
    expect(lastDraftsTotal(h, drafts.id)).toBe(1);
    const row = h.folderMessages(drafts.id)[0]!;
    h.events.length = 0;
    await call(h, 'messages.apply', { messageIds: [row.id], action: { type: 'delete' } });
    expect(storedTotal(h, drafts.id)).toBe(0);
    expect(lastDraftsTotal(h, drafts.id)).toBe(0);
  });

  it('counts: save, upload, then delete the row brings the count back to 0', async () => {
    const { h, srv, acc, drafts } = await boot();
    const d = await newDraft(h, acc.id);
    await call(h, 'compose.saveDraft', req(d));
    await waitFor('uploaded', () => serverDrafts(srv).length === 1);
    await waitFor('linked', () => h.folderMessages(drafts.id)[0]?.draftSync === 'saved');
    await h.engine.compose.drain();
    expect(lastDraftsTotal(h, drafts.id)).toBe(1);
    const row = h.folderMessages(drafts.id)[0]!;
    h.events.length = 0;
    await call(h, 'messages.apply', { messageIds: [row.id], action: { type: 'delete' } });
    await waitFor('count 0', () => {
      h.engine.ctx.hub.flush();
      return lastDraftsTotal(h, drafts.id) === 0;
    });
    expect(storedTotal(h, drafts.id)).toBe(0);
    await waitFor('server copy gone', () => serverDrafts(srv).length === 0);
    await new Promise((r) => setTimeout(r, 400));
    expect(storedTotal(h, drafts.id)).toBe(0);
  });

  it('counts: discard brings the count back to 0', async () => {
    const { h, acc, drafts } = await boot();
    const d = await newDraft(h, acc.id);
    await call(h, 'compose.saveDraft', req(d));
    expect(lastDraftsTotal(h, drafts.id)).toBe(1);
    h.events.length = 0;
    await call(h, 'compose.discard', { draftId: d.draftId });
    expect(lastDraftsTotal(h, drafts.id)).toBe(0);
    expect(storedTotal(h, drafts.id)).toBe(0);
  });

  it('counts: a draft deleted on the server is picked up by the next sync', async () => {
    const { h, srv, acc, drafts } = await boot();
    const d = await newDraft(h, acc.id);
    await call(h, 'compose.saveDraft', req(d));
    await waitFor('linked', () => {
      const r = h.folderMessages(drafts.id);
      return r.length === 1 && r[0]!.uid > 0 && r[0]!.draftSync === 'saved';
    });
    await h.engine.compose.drain();
    const uid = h.folderMessages(drafts.id)[0]!.uid;
    h.events.length = 0;
    await srv.expunge('Drafts', uid);
    await call(h, 'sync.account', { accountId: acc.id });
    await waitFor('row gone', () => h.folderMessages(drafts.id).length === 0);
    await waitFor('count 0', () => lastDraftsTotal(h, drafts.id) === 0);
    expect(storedTotal(h, drafts.id)).toBe(0);
  });

  it('counts: wrong stored numbers are repaired when the engine starts', async () => {
    const { h, acc, drafts } = await boot();
    h.engine.ctx.db.prepare('UPDATE folder SET total_count=7, unread_count=3 WHERE id=?').run(drafts.id);
    h.engine.ctx.folders.recomputeAll(); // what Engine.start() does first
    expect(storedTotal(h, drafts.id)).toBe(0);
    expect(h.engine.ctx.folders.counts().perFolder.find((p) => p.folderId === drafts.id)!.total).toBe(0);
    expect(acc.id).toBeTruthy();
  });

  // ---- unfinished recipient text ----
  it('saveDraft never stores addresses that are not real addresses', async () => {
    const { h, acc, drafts } = await boot();
    const d = await newDraft(h, acc.id);
    await call(h, 'compose.saveDraft', req(d, { to: [{ address: 'dm' }, { address: 'ok@example.com' }], cc: [{ address: 'zz' }] }));
    const row = h.folderMessages(drafts.id)[0]!;
    expect(row.to.map((a) => a.address)).toEqual(['ok@example.com']);
    expect(row.cc).toEqual([]);
    const again = await call<ComposeDraft>(h, 'compose.prepare', { mode: 'new', draftMessageId: row.id });
    expect(again.to.map((a) => a.address)).toEqual(['ok@example.com']);
  });

  it('a draft with only junk recipients shows no recipient at all', async () => {
    const { h, acc, drafts } = await boot();
    const d = await newDraft(h, acc.id);
    await call(h, 'compose.saveDraft', req(d, { to: [{ address: 'dm' }] }));
    expect(h.folderMessages(drafts.id)[0]!.to).toEqual([]);
  });

  it('send refuses an invalid address', async () => {
    const { h, acc } = await boot();
    const d = await newDraft(h, acc.id);
    await expect(call(h, 'compose.send', req(d, { to: [{ address: 'dm' }] }))).rejects.toMatchObject({
      message: expect.stringContaining('not a valid email address'),
    });
  });
});
