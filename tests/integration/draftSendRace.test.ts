// Sending a saved draft must never leave a copy in the server Drafts folder, whatever the timing:
// the upload still running (APPEND held on the server), the account offline, or the app stopped
// before the delete could be done. The fake IMAP server holds the APPEND so the race is forced.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ComposeDraft, OutboxItem, SendReq } from '../../src/shared/ipc';
import { createHarness, waitFor, waitForInboxCursors, type Harness } from '../fakes/engineHarness';
import { rawMessage, startFakeImap, type FakeImapServer } from '../fakes/fakeImapServer';
import { startFakeSmtp, type FakeSmtpServer } from '../fakes/fakeSmtpServer';

let imap: FakeImapServer | null = null;
let smtp: FakeSmtpServer | null = null;
const harnesses: Harness[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    await h.engine.compose.shutdown().catch(() => undefined);
    await h.cleanup();
  }
  await imap?.close().catch(() => undefined);
  await smtp?.close().catch(() => undefined);
  imap = smtp = null;
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function boot(persistent = false) {
  imap = await startFakeImap({ inbox: [{ raw: rawMessage({ subject: 'Hello', messageId: '<hello@fake.test>' }) }] });
  smtp = await startFakeSmtp();
  let extra: { dbFile?: string; dataDir?: string; secrets?: Map<string, string> } = {};
  if (persistent) {
    const dir = await mkdtemp(join(tmpdir(), 'letterdock-race-'));
    dirs.push(dir);
    extra = { dbFile: join(dir, 'mail.db'), dataDir: dir, secrets: new Map() };
  }
  const h = await createHarness(imap, { smtp, ...extra });
  harnesses.push(h);
  h.engine.ctx.draftPushDelayMs = 0;
  const acc = await h.addAccount({ smtp: { host: smtp.host, port: smtp.port, security: smtp.security } });
  await waitFor('inbox synced', () => h.inboxMessages(acc.id).length === 1);
  await waitForInboxCursors(h, [acc.id]);
  await waitFor('drafts row', () => h.engine.ctx.folders.rowByRole(acc.id, 'drafts'));
  await h.engine.actions.drain();
  return { h, acc, drafts: h.folderByRole(acc.id, 'drafts'), extra };
}

const call = <T>(h: Harness, ch: string, req?: unknown) => h.engine.handle(ch, req) as Promise<T>;
const net = (h: Harness, online: boolean) => call(h, 'system.networkChanged', { online });
const serverDrafts = () => imap!.mailbox('Drafts').messages;
const isDraftsAppend = (p: { attributes?: { value?: unknown }[] }) => String(p.attributes?.[0]?.value) === 'Drafts';
const tombstones = (h: Harness) =>
  (h.engine.ctx.db.prepare('SELECT COUNT(*) AS n FROM draft_tombstone').get() as { n: number }).n;
const settle = () => new Promise((r) => setTimeout(r, 400));

async function newReq(h: Harness, accountId: string, subject: string): Promise<SendReq> {
  const d = await call<ComposeDraft>(h, 'compose.prepare', { mode: 'new', accountId });
  return {
    draftId: d.draftId,
    accountId,
    to: [{ address: 'friend@example.com' }],
    cc: [],
    bcc: [],
    subject,
    html: '<p>Body</p>',
    attachmentTokens: [],
  };
}

describe('sending a draft leaves no copy in the server Drafts folder', () => {
  it('upload still running when the message is sent: the late copy is deleted', async () => {
    const { h, acc, drafts } = await boot();
    const hold = imap!.holdCommands(['APPEND'], isDraftsAppend);
    const req = await newReq(h, acc.id, 'Race one');
    await call(h, 'compose.saveDraft', req);
    await waitFor('upload in flight', () => hold.held() === 1);
    expect(serverDrafts()).toHaveLength(0);

    await call(h, 'compose.send', req); // the local row is not linked to any server copy yet
    await waitFor('mail sent', () => smtp!.mails.length === 1);
    await waitFor('outbox empty', async () => (await call<OutboxItem[]>(h, 'outbox.list')).length === 0);
    await waitFor('draft row gone', () => h.folderMessages(drafts.id).length === 0);

    hold.release(); // the server stores its copy now
    await waitFor('copy stored then deleted', async () => {
      await h.engine.compose.drain();
      return serverDrafts().length === 0 && tombstones(h) === 0;
    });
    await settle();
    expect(serverDrafts()).toHaveLength(0);
    expect(h.folderMessages(drafts.id)).toHaveLength(0);
    expect(smtp!.mails).toHaveLength(1);
  });

  it('a second save is queued behind the running upload, then the send: still no copy left', async () => {
    const { h, acc, drafts } = await boot();
    const hold = imap!.holdCommands(['APPEND'], isDraftsAppend);
    const req = await newReq(h, acc.id, 'Race two');
    await call(h, 'compose.saveDraft', req);
    await waitFor('upload in flight', () => hold.held() === 1);
    await call(h, 'compose.saveDraft', { ...req, subject: 'Race two, edited' });
    await call(h, 'compose.send', { ...req, subject: 'Race two, edited' });
    await waitFor('mail sent', () => smtp!.mails.length === 1);
    hold.release();
    await waitFor('server Drafts empty', async () => {
      await h.engine.compose.drain();
      return serverDrafts().length === 0 && tombstones(h) === 0;
    });
    await settle();
    expect(serverDrafts()).toHaveLength(0);
    expect(h.folderMessages(drafts.id)).toHaveLength(0);
  });

  it('uploaded draft, account offline when the message is sent: the copy goes when the account is back', async () => {
    const { h, acc, drafts } = await boot();
    const req = await newReq(h, acc.id, 'Offline send');
    await call(h, 'compose.saveDraft', req);
    await waitFor('uploaded', () => serverDrafts().length === 1);
    await waitFor('linked', () => h.folderMessages(drafts.id)[0]?.draftSync === 'saved');
    await h.engine.compose.drain();

    await net(h, false);
    await waitFor('offline', () => h.engine.sessions.statuses()[0]?.state === 'offline');
    await call(h, 'compose.send', req);
    await waitFor('mail sent', () => smtp!.mails.length === 1);
    await waitFor('outbox empty', async () => (await call<OutboxItem[]>(h, 'outbox.list')).length === 0);
    // The server cannot be reached: the delete is written down, not lost.
    await waitFor('delete written down', () => tombstones(h) === 1);
    expect(serverDrafts()).toHaveLength(1);

    await net(h, true);
    await waitFor('copy deleted', () => serverDrafts().length === 0 && tombstones(h) === 0);
    await settle();
    expect(serverDrafts()).toHaveLength(0);
    expect(h.folderMessages(drafts.id)).toHaveLength(0);
  });

  it('a copy that only shows up in a later sync is dropped too (never listed)', async () => {
    const { h, acc, drafts } = await boot();
    const req = await newReq(h, acc.id, 'Late copy');
    await net(h, false);
    await waitFor('offline', () => h.engine.sessions.statuses()[0]?.state === 'offline');
    await call(h, 'compose.saveDraft', req);
    await call(h, 'compose.send', req);
    await waitFor('mail sent', () => smtp!.mails.length === 1);
    await waitFor('outbox empty', async () => (await call<OutboxItem[]>(h, 'outbox.list')).length === 0);
    await waitFor('delete written down', () => tombstones(h) === 1);
    // An upload that the app lost track of (it ended on the server) appears with the same Message-ID.
    const mid = /^Message-ID:\s*(<[^>]+>)/im.exec(String(smtp!.mails[0]!.raw ?? ''))?.[1];
    expect(mid).toBeTruthy();
    imap!.deliver('Drafts', {
      raw: rawMessage({ subject: 'Late copy', messageId: mid!, from: 'me@example.com' }),
      flags: ['\\Draft', '\\Seen'],
    });
    await net(h, true);
    await waitFor('copy deleted', () => serverDrafts().length === 0 && tombstones(h) === 0);
    await settle();
    expect(h.folderMessages(drafts.id)).toHaveLength(0);
  });

  it('the app stops while the upload is in flight: after a restart the copy is deleted', async () => {
    const first = await boot(true);
    const { h, acc, drafts } = first;
    const hold = imap!.holdCommands(['APPEND'], isDraftsAppend);
    const req = await newReq(h, acc.id, 'Race restart');
    await call(h, 'compose.saveDraft', req);
    await waitFor('upload in flight', () => hold.held() === 1);
    await call(h, 'compose.send', req);
    await waitFor('mail sent', () => smtp!.mails.length === 1);
    await waitFor('outbox empty', async () => (await call<OutboxItem[]>(h, 'outbox.list')).length === 0);
    await waitFor('delete written down', () => tombstones(h) === 1);

    // The app dies with the upload unanswered. The server did store the copy, but the app never
    // learned that; the delete was written down before the quit.
    imap!.dropConnections();
    await h.engine.shutdown();
    harnesses.splice(harnesses.indexOf(h), 1);
    const mid = /^Message-ID:\s*(<[^>]+>)/im.exec(smtp!.mails[0]!.raw.toString())?.[1];
    expect(mid).toBeTruthy();
    imap!.deliver('Drafts', {
      raw: rawMessage({ subject: 'Race restart', messageId: mid!, from: 'me@example.com' }),
      flags: ['\\Draft', '\\Seen'],
    });
    expect(serverDrafts()).toHaveLength(1);

    const h2 = await createHarness(imap!, { smtp: smtp!, ...first.extra });
    harnesses.push(h2);
    h2.engine.ctx.draftPushDelayMs = 0;
    h2.engine.start();
    await waitFor('copy deleted after restart', () => serverDrafts().length === 0);
    await waitFor('plan cleared', () => tombstones(h2) === 0);
    await settle();
    expect(h2.folderMessages(drafts.id)).toHaveLength(0);
  });
});
