// Engine integration: send later (DESIGN-SPEC 3.11) with a clock the test can move, the fake IMAP
// server and the fake SMTP server. Real sockets are used, so time is moved by an offset in the
// engine's `now()` and the scheduler is asked to look again with `scheduled.recheck()`.
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  ComposeDraft,
  OutboxItem,
  ScheduledCancelRes,
  ScheduledCount,
  ScheduledDetail,
  ScheduledItem,
  ScheduledNextDue,
  SendReq,
} from '../../src/shared/ipc';
import { createHarness, waitFor, type Harness } from '../fakes/engineHarness';
import { rawMessage, startFakeImap, type FakeImapServer } from '../fakes/fakeImapServer';
import { startFakeSmtp, type FakeSmtpServer } from '../fakes/fakeSmtpServer';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

let imap: FakeImapServer | null = null;
let smtp: FakeSmtpServer | null = null;
const harnesses: Harness[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.cleanup();
  await imap?.close().catch(() => undefined);
  await smtp?.close().catch(() => undefined);
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  imap = smtp = null;
});

interface Clock {
  offset: number;
  now(): number;
}
const makeClock = (): Clock => {
  const c: Clock = { offset: 0, now: () => Date.now() + c.offset };
  return c;
};

interface BootOpts {
  persistent?: boolean;
  spacing?: number;
}

async function boot(o: BootOpts = {}) {
  const clock = makeClock();
  imap ??= await startFakeImap({
    inbox: [{ raw: rawMessage({ subject: 'Hello', messageId: '<hello@x>' }) }],
  });
  smtp ??= await startFakeSmtp();
  let extra: { dbFile?: string; dataDir?: string; secrets?: Map<string, string> } = {};
  if (o.persistent) {
    const dir = await mkdtemp(join(tmpdir(), 'letterdock-sched-'));
    dirs.push(dir);
    extra = { dbFile: join(dir, 'mail.db'), dataDir: dir, secrets: new Map() };
  }
  const h = await createHarness(imap, {
    smtp,
    now: clock.now,
    scheduledSpacingMs: o.spacing ?? 20,
    ...extra,
  });
  harnesses.push(h);
  const acc = await h.addAccount({
    smtp: { host: smtp.host, port: smtp.port, security: smtp.security },
  });
  await waitFor('synced', () => h.inboxMessages(acc.id).length === 1);
  await waitFor('online', () => h.engine.sessions.statuses()[0]?.state === 'online');
  await waitFor('folders', () => h.engine.ctx.folders.rowByRole(acc.id, 'sent'));
  h.engine.ctx.draftPushDelayMs = 0;
  h.engine.start();
  return { h, acc, clock, extra };
}

type Booted = Awaited<ReturnType<typeof boot>>;

const call = <T>(h: Harness, ch: string, req?: unknown) => h.engine.handle(ch, req) as Promise<T>;

async function draftReq(c: Booted, over: Partial<SendReq> = {}): Promise<SendReq> {
  const d = await call<ComposeDraft>(c.h, 'compose.prepare', { mode: 'new', accountId: c.acc.id });
  return {
    draftId: d.draftId,
    accountId: d.accountId,
    to: [{ address: 'friend@example.com' }],
    cc: [],
    bcc: [],
    subject: 'See you tomorrow',
    html: '<p>Body text</p>',
    attachmentTokens: [],
    ...over,
  };
}

async function schedule(c: Booted, inMs: number, over: Partial<SendReq> = {}): Promise<ScheduledItem> {
  const draft = await draftReq(c, over);
  return call<ScheduledItem>(c.h, 'scheduled.create', {
    draftId: draft.draftId,
    sendAt: c.clock.now() + inMs,
    draft,
  });
}

const listAll = (c: Booted) => call<ScheduledItem[]>(c.h, 'scheduled.list', {});
const recheck = (c: Booted) => c.h.engine.scheduled.recheck();
const outbox = (c: Booted) => call<OutboxItem[]>(c.h, 'outbox.list');

describe('scheduling', () => {
  it('keeps the message on this PC only: not in Drafts, not on the server', async () => {
    const c = await boot();
    // The editor had autosaved a draft before the user chose "Send later".
    const draft = await draftReq(c);
    await call(c.h, 'compose.saveDraft', draft);
    await waitFor('server draft', () => imap!.mailbox('Drafts').messages.length === 1);
    const item = await call<ScheduledItem>(c.h, 'scheduled.create', {
      draftId: draft.draftId,
      sendAt: c.clock.now() + 2 * HOUR,
      draft,
    });
    expect(item).toMatchObject({ status: 'scheduled', subject: 'See you tomorrow', waiting: null, hasAttachments: false });
    expect(item.to).toEqual([{ address: 'friend@example.com' }]);
    expect(item.snippet).toContain('Body text');
    // The autosaved draft is gone from the list and from the server.
    const drafts = c.h.folderByRole(c.acc.id, 'drafts');
    expect(c.h.folderMessages(drafts.id)).toHaveLength(0);
    await waitFor('server draft removed', () => imap!.mailbox('Drafts').messages.length === 0);
    expect(smtp!.mails).toHaveLength(0);
    expect(await call<ScheduledCount>(c.h, 'scheduled.count')).toMatchObject({
      total: 1,
      scheduled: 1,
      held: 0,
      nextSendAt: item.sendAt,
    });
    expect(c.h.eventsOfType('scheduled:changed').length).toBeGreaterThan(0);
  });

  it('checks the same things as Send, and the time', async () => {
    const c = await boot();
    const bad = await draftReq(c, { to: [] });
    await expect(
      call(c.h, 'scheduled.create', { draftId: bad.draftId, sendAt: c.clock.now() + HOUR, draft: bad }),
    ).rejects.toMatchObject({ appError: { code: 'INVALID_INPUT' } });
    const ok = await draftReq(c);
    await expect(
      call(c.h, 'scheduled.create', { draftId: ok.draftId, sendAt: c.clock.now() - 1000, draft: ok }),
    ).rejects.toMatchObject({ appError: { message: 'Pick a time in the future.' } });
    await expect(
      call(c.h, 'scheduled.create', { draftId: ok.draftId, sendAt: c.clock.now() + 400 * DAY, draft: ok }),
    ).rejects.toMatchObject({ appError: { code: 'INVALID_INPUT' } });
    expect(await listAll(c)).toHaveLength(0);
  });

  it('allows at most 100', async () => {
    const c = await boot();
    const first = await draftReq(c);
    for (let i = 0; i < 100; i++) {
      c.h.engine.ctx.db
        .prepare(
          `INSERT INTO scheduled_send (account_id, draft_id, send_at, created_at, meta_json, message_id)
           VALUES (?, ?, ?, ?, '{}', '<x@x>')`,
        )
        .run(c.acc.id, `d${i}`, c.clock.now() + DAY, c.clock.now());
    }
    await expect(
      call(c.h, 'scheduled.create', { draftId: first.draftId, sendAt: c.clock.now() + HOUR, draft: first }),
    ).rejects.toMatchObject({ appError: { message: expect.stringContaining('100 scheduled messages') } });
  });
});

describe('sending on time', () => {
  it('sends when the time comes, not before, and the row is gone afterwards', async () => {
    const c = await boot();
    const item = await schedule(c, HOUR);
    c.clock.offset += 30 * MIN;
    await recheck(c);
    expect(smtp!.mails).toHaveLength(0);

    c.clock.offset += 30 * MIN + 30_000; // 30 seconds after the planned time
    await recheck(c);
    await waitFor('delivered', () => smtp!.mails.length === 1);
    expect(smtp!.mails[0]!.parsed.subject).toBe('See you tomorrow');
    expect(smtp!.mails[0]!.to).toEqual(['friend@example.com']);
    await waitFor('row gone', async () => (await listAll(c)).length === 0);
    expect(item.id).toBeGreaterThan(0);
    // Not "late": no catch-up notice for something that left on time.
    expect(c.h.eventsOfType('scheduled:due')).toHaveLength(0);
    // The copy lands in Sent like for any other mail.
    await waitFor('sent copy', () => imap!.mailbox('Sent').messages.length === 1);
    expect(await outbox(c)).toHaveLength(0);
  });

  it('the real timer fires too (no manual check)', async () => {
    const c = await boot();
    await schedule(c, 400);
    await waitFor('delivered by the timer', () => smtp!.mails.length === 1, 8000);
  });

  it('From and the text are frozen when it is scheduled', async () => {
    const c = await boot();
    await schedule(c, HOUR, { html: '<p>Frozen text</p><div>-- <br>Old signature</div>' });
    c.h.engine.ctx.accounts.update(c.acc.id, { displayName: 'Somebody Else', signature: 'New signature' });
    c.clock.offset += 2 * HOUR;
    await recheck(c);
    await waitFor('delivered', () => smtp!.mails.length === 1);
    const mail = smtp!.mails[0]!.parsed;
    expect(mail.from?.text).toContain('Me');
    expect(mail.from?.text).not.toContain('Somebody');
    expect(mail.html).toContain('Old signature');
    expect(mail.html).not.toContain('New signature');
  });

  it('sends due messages one after the other with a pause', async () => {
    const c = await boot({ spacing: 150 });
    await schedule(c, HOUR, { subject: 'one' });
    await schedule(c, HOUR + 1000, { subject: 'two' });
    await schedule(c, HOUR + 2000, { subject: 'three' });
    c.clock.offset += 2 * HOUR;
    const t0 = Date.now();
    await recheck(c);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(290); // two pauses of 150 ms
    await waitFor('all delivered', () => smtp!.mails.length === 3);
    expect(smtp!.mails.map((m) => m.parsed.subject)).toEqual(['one', 'two', 'three']);
  });

  it('after the PC was off: sends at once and says so', async () => {
    const c = await boot();
    await schedule(c, HOUR);
    await schedule(c, 2 * HOUR, { subject: 'second' });
    c.clock.offset += 5 * HOUR; // "PC off", nothing ran in between
    await recheck(c);
    await waitFor('both delivered', () => smtp!.mails.length === 2);
    const due = c.h.eventsOfType('scheduled:due');
    expect(due).toHaveLength(1);
    expect(due[0]!.count).toBe(2);
  });

  it('more than 24 hours late: held, not sent; then sent on request or moved', async () => {
    const c = await boot();
    const a = await schedule(c, HOUR, { subject: 'old news' });
    const b = await schedule(c, 2 * HOUR, { subject: 'also old' });
    c.clock.offset += 3 * DAY;
    await recheck(c);
    await new Promise((r) => setTimeout(r, 200));
    expect(smtp!.mails).toHaveLength(0);
    const list = await listAll(c);
    expect(list.map((i) => i.status)).toEqual(['held', 'held']);
    expect(list[0]!.overdueMs).toBeGreaterThan(2 * DAY);
    expect(await call<ScheduledCount>(c.h, 'scheduled.count')).toMatchObject({ scheduled: 0, held: 2, total: 2 });
    expect((await call<ScheduledNextDue>(c.h, 'scheduled.nextDue')).count).toBe(0);

    // "Send now" sends a held one.
    const sent = await call<ScheduledItem>(c.h, 'scheduled.sendNow', { id: a.id });
    expect(sent.status).toBe('sending');
    await waitFor('delivered', () => smtp!.mails.length === 1);
    expect(smtp!.mails[0]!.parsed.subject).toBe('old news');

    // "Change time" makes the other one a normal scheduled message again.
    const when = c.clock.now() + HOUR;
    const moved = await call<ScheduledItem>(c.h, 'scheduled.reschedule', { id: b.id, sendAt: when });
    expect(moved).toMatchObject({ status: 'scheduled', sendAt: when });
    c.clock.offset += 2 * HOUR;
    await recheck(c);
    await waitFor('second delivered', () => smtp!.mails.length === 2);
  });

  it('Send now skips the wait and the undo delay', async () => {
    const c = await boot();
    c.h.settings.undoSendDelayMs = 30000;
    const item = await schedule(c, 5 * DAY);
    await call(c.h, 'scheduled.sendNow', { id: item.id });
    await waitFor('delivered', () => smtp!.mails.length === 1, 5000);
  });
});

describe('connection and sign-in', () => {
  it('waits while offline and sends when the connection is back', async () => {
    const c = await boot();
    await schedule(c, HOUR);
    await call(c.h, 'system.networkChanged', { online: false });
    await waitFor('offline', () => c.h.engine.sessions.statuses()[0]?.state === 'offline');
    c.clock.offset += 2 * HOUR;
    await recheck(c);
    expect(smtp!.mails).toHaveLength(0);
    expect((await listAll(c))[0]).toMatchObject({ status: 'scheduled', waiting: 'offline' });

    await call(c.h, 'system.networkChanged', { online: true });
    await waitFor('delivered after reconnect', () => smtp!.mails.length === 1, 15_000);
  });

  it('after a long offline time the late rule decides', async () => {
    const c = await boot();
    await schedule(c, HOUR);
    await call(c.h, 'system.networkChanged', { online: false });
    await waitFor('offline', () => c.h.engine.sessions.statuses()[0]?.state === 'offline');
    c.clock.offset += 2 * DAY;
    await call(c.h, 'system.networkChanged', { online: true });
    await waitFor('held', async () => (await listAll(c))[0]?.status === 'held', 15_000);
    expect(smtp!.mails).toHaveLength(0);
  });

  it('shows "sign in" when the account is signed out, and sends after the sign-in', async () => {
    const c = await boot();
    await schedule(c, HOUR);
    c.h.secrets.set(c.acc.id, 'wrong-password');
    await call(c.h, 'accounts.reconnect', { accountId: c.acc.id });
    await waitFor('signed out', () => c.h.engine.sessions.statuses()[0]?.state === 'auth_failed');
    c.clock.offset += 2 * HOUR;
    await recheck(c);
    expect(smtp!.mails).toHaveLength(0);
    expect((await listAll(c))[0]).toMatchObject({ waiting: 'signIn' });

    await call(c.h, 'accounts.updateCredentials', { accountId: c.acc.id, password: 'testpass' });
    await waitFor('delivered after sign-in', () => smtp!.mails.length === 1, 15_000);
  });
});

describe('failures', () => {
  it('a refused message goes to the Outbox as a failed item and leaves the schedule', async () => {
    const c = await boot();
    smtp!.failNextData(5, 554);
    await schedule(c, HOUR, { subject: 'will fail' });
    c.clock.offset += 2 * HOUR;
    await recheck(c);
    await waitFor('failed in the Outbox', async () => (await outbox(c)).some((o) => o.state === 'failed'));
    expect(await listAll(c)).toHaveLength(0);
    const ev = c.h.eventsOfType('scheduled:failed');
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ accountId: c.acc.id, subject: 'will fail' });
    expect(smtp!.mails).toHaveLength(0);
    // Retrying from the Outbox works like for any message.
    smtp!.failNextData(0);
    const failed = (await outbox(c)).find((o) => o.state === 'failed')!;
    await call(c.h, 'outbox.retry', { outboxId: failed.id });
    await waitFor('delivered', () => smtp!.mails.length === 1);
  });
});

describe('edit, cancel, delete', () => {
  it('cancel makes it a normal draft again (with its attachment) and undo schedules it once more', async () => {
    const c = await boot();
    const att = await call<{ tokenId: string }>(c.h, 'compose.attachData', {
      filename: 'plan.txt',
      contentType: 'text/plain',
      data: new Uint8Array(Buffer.from('plan')),
    });
    const item = await schedule(c, 3 * HOUR, { attachmentTokens: [att.tokenId], subject: 'with file' });
    expect(item.hasAttachments).toBe(true);
    const detail = await call<ScheduledDetail>(c.h, 'scheduled.get', { id: item.id });
    expect(detail.html).toContain('Body text');
    expect(detail.attachments.map((a) => a.filename)).toEqual(['plan.txt']);

    const res = await call<ScheduledCancelRes>(c.h, 'scheduled.cancel', { id: item.id });
    expect(res.sendAt).toBe(item.sendAt);
    expect(await listAll(c)).toHaveLength(0);
    const drafts = c.h.folderByRole(c.acc.id, 'drafts');
    await waitFor('draft shown', () => c.h.folderMessages(drafts.id).some((m) => m.subject === 'with file'));
    const reopened = await call<ComposeDraft>(c.h, 'compose.prepare', { mode: 'new', draftId: res.draftId });
    expect(reopened.subject).toBe('with file');
    expect(reopened.attachments.map((a) => a.filename)).toEqual(['plan.txt']);
    c.clock.offset += 4 * HOUR;
    await recheck(c);
    expect(smtp!.mails).toHaveLength(0); // cancelled means cancelled

    // Undo: schedule the saved text again.
    const again = await call<ScheduledItem>(c.h, 'scheduled.create', {
      draftId: res.draftId,
      sendAt: c.clock.now() + HOUR,
    });
    expect(again.subject).toBe('with file');
    await waitFor('draft left Drafts again', () => c.h.folderMessages(drafts.id).length === 0);
    c.clock.offset += 2 * HOUR;
    await recheck(c);
    await waitFor('delivered', () => smtp!.mails.length === 1);
    expect(smtp!.mails[0]!.parsed.attachments.map((a) => a.filename)).toEqual(['plan.txt']);
  });

  it('delete forgets the message and its files', async () => {
    const c = await boot({ persistent: true });
    const att = await call<{ tokenId: string }>(c.h, 'compose.attachData', {
      filename: 'a.txt',
      contentType: 'text/plain',
      data: new Uint8Array(Buffer.from('a')),
    });
    const item = await schedule(c, HOUR, { attachmentTokens: [att.tokenId] });
    expect(await readdir(join(c.h.dataDir, 'scheduled'))).toHaveLength(1);
    await call(c.h, 'scheduled.delete', { id: item.id });
    expect(await listAll(c)).toHaveLength(0);
    expect(await readdir(join(c.h.dataDir, 'scheduled'))).toHaveLength(0);
    expect(c.h.engine.ctx.db.prepare('SELECT COUNT(*) AS n FROM compose_file').get()).toEqual({ n: 0 });
    c.clock.offset += 2 * HOUR;
    await recheck(c);
    expect(smtp!.mails).toHaveLength(0);
  });

  it('files of a message scheduled far ahead survive the 14-day cleanup', async () => {
    const c = await boot();
    const att = await call<{ tokenId: string }>(c.h, 'compose.attachData', {
      filename: 'long.txt',
      contentType: 'text/plain',
      data: new Uint8Array(Buffer.from('long')),
    });
    await schedule(c, 40 * DAY, { attachmentTokens: [att.tokenId] });
    c.clock.offset += 20 * DAY;
    c.h.engine.compose.start(); // starts the cleanup
    await new Promise((r) => setTimeout(r, 300));
    expect(c.h.engine.ctx.db.prepare('SELECT COUNT(*) AS n FROM compose_file').get()).toEqual({ n: 1 });
  });

  it('removing the account removes its scheduled messages', async () => {
    const c = await boot({ persistent: true });
    await schedule(c, HOUR);
    await call(c.h, 'accounts.remove', { accountId: c.acc.id });
    expect(c.h.engine.ctx.db.prepare('SELECT COUNT(*) AS n FROM scheduled_send').get()).toEqual({ n: 0 });
    expect(await readdir(join(c.h.dataDir, 'scheduled'))).toHaveLength(0);
  });
});

describe('cancelling from the Outbox', () => {
  it('a scheduled message removed from the Outbox is a draft again and is never sent later', async () => {
    const c = await boot({ persistent: true });
    smtp!.failNextData(1, 451);
    (c.h.engine.ctx as { sendRetryDelaysMs?: number[] }).sendRetryDelaysMs = [60 * MIN];
    await schedule(c, HOUR, { subject: 'changed my mind' });
    c.clock.offset += 2 * HOUR;
    await recheck(c);
    const queued = await waitFor('waiting in the Outbox', async () =>
      (await outbox(c)).find((o) => o.state === 'queued' && o.attempts === 1),
    );
    const res = await call<{ draftId: string | null }>(c.h, 'outbox.cancel', { outboxId: queued.id });
    expect(res.draftId).toBeTruthy();
    expect(await listAll(c)).toHaveLength(0);
    const drafts = c.h.folderByRole(c.acc.id, 'drafts');
    await waitFor('draft is back', () => c.h.folderMessages(drafts.id).some((m) => m.subject === 'changed my mind'));
    const reopened = await call<ComposeDraft>(c.h, 'compose.prepare', { mode: 'new', draftId: res.draftId });
    expect(reopened.subject).toBe('changed my mind');

    // After a restart nothing sends it.
    await c.h.engine.shutdown();
    harnesses.splice(harnesses.indexOf(c.h), 1);
    const h2 = await createHarness(imap!, { smtp: smtp!, now: c.clock.now, scheduledSpacingMs: 20, ...c.extra });
    harnesses.push(h2);
    h2.engine.start();
    await waitFor('online', () => h2.engine.sessions.statuses()[0]?.state === 'online');
    c.clock.offset += 10 * MIN;
    await h2.engine.scheduled.recheck();
    await new Promise((r) => setTimeout(r, 300));
    expect(smtp!.mails).toHaveLength(0);
  });
});

describe('quit prompt data', () => {
  it('counts messages due within 24 hours', async () => {
    const c = await boot();
    const soon = await schedule(c, 3 * HOUR);
    await schedule(c, 3 * DAY, { subject: 'far' });
    const due = await call<ScheduledNextDue>(c.h, 'scheduled.nextDue');
    expect(due).toEqual({ count: 1, nextSendAt: soon.sendAt });
  });
});

describe('after a crash while sending', () => {
  it('does not send twice when the message already reached the Sent folder', async () => {
    const c = await boot({ persistent: true });
    const item = await schedule(c, HOUR, { subject: 'sent once' });
    c.clock.offset += 2 * HOUR;
    await recheck(c);
    await waitFor('delivered', () => smtp!.mails.length === 1);
    await waitFor('copy in Sent', () => imap!.mailbox('Sent').messages.length === 1);
    await waitFor('row gone', async () => (await listAll(c)).length === 0);

    // Make it look like the app died after the mail went out but before the schedule row was removed.
    const db = c.h.engine.ctx.db;
    const sentRaw = String(imap!.mailbox('Sent').messages[0]!.raw);
    const mid = /Message-ID: (<[^>]+>)/i.exec(sentRaw)![1]!;
    const nowMs = c.clock.now();
    db.prepare(
      `INSERT INTO scheduled_send (id, account_id, draft_id, subject, send_at, created_at, status, meta_json, message_id, sending_since, raw_path)
       VALUES (?, ?, 'gone', 'sent once', ?, ?, 'sending', '{}', ?, ?, '')`,
    ).run(item.id, c.acc.id, nowMs - HOUR, nowMs - 3 * HOUR, mid, nowMs);
    await c.h.engine.shutdown();
    harnesses.splice(harnesses.indexOf(c.h), 1);

    const clock = c.clock;
    const h2 = await createHarness(imap!, {
      smtp: smtp!,
      now: clock.now,
      scheduledSpacingMs: 20,
      ...c.extra,
    });
    harnesses.push(h2);
    h2.engine.start();
    await waitFor('online', () => h2.engine.sessions.statuses()[0]?.state === 'online');
    // Too early: it might still be on its way.
    await h2.engine.scheduled.recheck();
    expect(h2.engine.scheduled.list()).toHaveLength(1);
    clock.offset += 6 * MIN;
    await h2.engine.scheduled.recheck();
    expect(h2.engine.scheduled.list()).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 300));
    expect(smtp!.mails).toHaveLength(1);
  });

  it('sends it again when the Sent folder has no copy', async () => {
    const c = await boot({ persistent: true });
    // The first attempt fails with a temporary error and the retry is far away.
    smtp!.failNextData(1, 451);
    (c.h.engine.ctx as { sendRetryDelaysMs?: number[] }).sendRetryDelaysMs = [60 * MIN];
    await schedule(c, HOUR, { subject: 'resend me' });
    c.clock.offset += 2 * HOUR;
    await recheck(c);
    await waitFor('on its way', async () => (await outbox(c)).some((o) => o.state === 'queued' && o.attempts === 1));
    expect((await listAll(c))[0]).toMatchObject({ status: 'sending' });
    expect(smtp!.mails).toHaveLength(0);
    // The app stops here.
    await c.h.engine.shutdown();
    harnesses.splice(harnesses.indexOf(c.h), 1);

    const h2 = await createHarness(imap!, { smtp: smtp!, now: c.clock.now, scheduledSpacingMs: 20, ...c.extra });
    harnesses.push(h2);
    h2.engine.start();
    await waitFor('online', () => h2.engine.sessions.statuses()[0]?.state === 'online');
    // The Outbox did not re-send it behind our back.
    await new Promise((r) => setTimeout(r, 300));
    expect(smtp!.mails).toHaveLength(0);
    expect(h2.engine.compose.list()).toHaveLength(0);
    c.clock.offset += 6 * MIN;
    await h2.engine.scheduled.recheck();
    await waitFor('sent again', () => smtp!.mails.length === 1);
    expect(smtp!.mails[0]!.parsed.subject).toBe('resend me');
    await waitFor('finished', () => h2.engine.scheduled.list().length === 0);
  });
});
