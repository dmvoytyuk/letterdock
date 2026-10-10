// Engine integration: compose, send (SMTP), outbox, undo send, drafts, XOAUTH2 - against the
// in-process IMAP server and a local fake SMTP server. Nothing here touches the internet.
import { afterEach, describe, expect, it } from 'vitest';
import type { ComposeDraft, SendReq, SendRes } from '../../src/shared/ipc';
import { createHarness, waitFor, type Harness, type HarnessOptions } from '../fakes/engineHarness';
import {
  PDF_TEXT,
  TEST_TOKEN,
  rawMessage,
  rawWithAttachments,
  startFakeImap,
  type FakeImapOptions,
  type FakeImapServer,
} from '../fakes/fakeImapServer';
import { SMTP_PASSWORD, startFakeSmtp, type FakeSmtpOptions, type FakeSmtpServer } from '../fakes/fakeSmtpServer';

let imap: FakeImapServer | null = null;
let smtp: FakeSmtpServer | null = null;
let h: Harness | null = null;

afterEach(async () => {
  await h?.engine.compose.shutdown().catch(() => undefined);
  await h?.cleanup();
  await imap?.close().catch(() => undefined);
  await smtp?.close().catch(() => undefined);
  h = imap = smtp = null;
});

async function boot(
  o: {
    imap?: FakeImapOptions;
    smtp?: FakeSmtpOptions;
    harness?: Omit<HarnessOptions, 'smtp'>;
    account?: Record<string, unknown>;
  } = {},
) {
  imap = await startFakeImap({
    inbox: [
      {
        raw: rawMessage({
          subject: 'Lunch?',
          from: 'Alice <alice@example.com>',
          to: 'Me <me@example.com>, Carol <carol@example.com>',
          messageId: '<orig-1@example.com>',
          text: 'Are you free at noon?\r\nLet me know.',
        }),
      },
      { raw: rawWithAttachments('Quarterly report') },
    ],
    ...o.imap,
  });
  smtp = await startFakeSmtp(o.smtp);
  h = await createHarness(imap, { smtp, ...o.harness });
  h.engine.ctx.draftPushDelayMs = 0; // upload saved drafts at once
  const acc = await h.addAccount({
    smtp: { host: smtp.host, port: smtp.port, security: smtp.security },
    ...o.account,
  });
  const expected = o.imap?.inbox?.length ?? 2;
  await waitFor('inbox synced', () => h!.inboxMessages(acc.id).length === expected);
  await waitFor('folders', () => h!.engine.ctx.folders.rowByRole(acc.id, 'sent'));
  await h.engine.actions.drain();
  return { h, acc, imap, smtp };
}

const handle = <T>(hh: Harness, ch: string, req?: unknown) => hh.engine.handle(ch, req) as Promise<T>;

function sendReq(draft: ComposeDraft, over: Partial<SendReq> = {}): SendReq {
  return {
    draftId: draft.draftId,
    accountId: draft.accountId,
    to: draft.to,
    cc: draft.cc,
    bcc: draft.bcc,
    subject: draft.subject,
    html: draft.html,
    attachmentTokens: draft.attachments.map((a) => a.tokenId),
    ...over,
  };
}

const newDraft = (hh: Harness, accountId: string) =>
  handle<ComposeDraft>(hh, 'compose.prepare', { mode: 'new', accountId });

describe('prepare: reply / reply all / forward', () => {
  it('reply: To = sender, Re: subject, quoted text, signature', async () => {
    const c = await boot();
    c.h.engine.ctx.accounts.update(c.acc.id, { signature: 'Cheers,\nMe' });
    const src = c.h.inboxMessages(c.acc.id).find((m) => m.subject === 'Lunch?')!;
    const d = await handle<ComposeDraft>(c.h, 'compose.prepare', {
      mode: 'reply',
      sourceMessageId: src.id,
    });
    expect(d.to).toEqual([{ name: 'Alice', address: 'alice@example.com' }]);
    expect(d.cc).toEqual([]);
    expect(d.subject).toBe('Re: Lunch?');
    expect(d.accountId).toBe(c.acc.id);
    expect(d.inReplyToMessageId).toBe(src.id);
    expect(d.html).toContain('Are you free at noon?');
    expect(d.html).toContain('<blockquote');
    expect(d.html).toContain('Cheers,<br>Me');
    expect(d.html).not.toMatch(/<script/i);
  });

  it('reply all: adds the other recipients but not your own address', async () => {
    const c = await boot();
    const src = c.h.inboxMessages(c.acc.id).find((m) => m.subject === 'Lunch?')!;
    const d = await handle<ComposeDraft>(c.h, 'compose.prepare', {
      mode: 'replyAll',
      sourceMessageId: src.id,
    });
    expect(d.to.map((a) => a.address)).toEqual(['alice@example.com', 'carol@example.com']);
  });

  it('forward: Fwd: subject, original attachments are carried over as tokens', async () => {
    const c = await boot();
    const src = c.h.inboxMessages(c.acc.id).find((m) => m.subject === 'Quarterly report')!;
    const d = await handle<ComposeDraft>(c.h, 'compose.prepare', {
      mode: 'forward',
      sourceMessageId: src.id,
    });
    expect(d.subject).toBe('Fwd: Quarterly report');
    expect(d.to).toEqual([]);
    expect(d.attachments.map((a) => a.filename)).toEqual(['report.pdf']); // inline logo is not copied
    expect(d.attachments[0]!.tokenId.startsWith('file:')).toBe(true);
    expect(d.html).toContain('Forwarded message');
  });

  it('quoted text is escaped, so a hostile original cannot inject markup', async () => {
    const c = await boot({
      imap: {
        inbox: [
          {
            raw: rawMessage({
              subject: 'x',
              text: '<img src=x onerror=alert(1)><script>boom()</script>',
            }),
          },
        ],
      },
    });
    const src = c.h.inboxMessages(c.acc.id)[0]!;
    const d = await handle<ComposeDraft>(c.h, 'compose.prepare', {
      mode: 'reply',
      sourceMessageId: src.id,
    });
    expect(d.html).not.toContain('<script');
    expect(d.html).not.toContain('<img');
    expect(d.html).toContain('&lt;script&gt;');
  });

  it('a mailto: link prefills a new message', async () => {
    const c = await boot();
    const d = await handle<ComposeDraft>(c.h, 'compose.prepare', {
      mode: 'new',
      mailto: 'mailto:bob@example.com?subject=Hi%20there&cc=eve@example.com&body=Hello%0AWorld',
    });
    expect(d.to).toEqual([{ address: 'bob@example.com' }]);
    expect(d.cc).toEqual([{ address: 'eve@example.com' }]);
    expect(d.subject).toBe('Hi there');
    expect(d.html).toContain('Hello<br>World');
  });
});

describe('sending', () => {
  it('sends a reply: headers, Bcc handling, Sent copy, \\Answered, outbox cleared', async () => {
    const c = await boot();
    const src = c.h.inboxMessages(c.acc.id).find((m) => m.subject === 'Lunch?')!;
    const d = await handle<ComposeDraft>(c.h, 'compose.prepare', {
      mode: 'reply',
      sourceMessageId: src.id,
    });
    c.h.events.length = 0;
    const res = await handle<SendRes>(
      c.h,
      'compose.send',
      sendReq(d, {
        bcc: [{ address: 'secret@example.com' }],
        html: '<p>Yes, <b>noon</b> works.</p>' + d.html,
      }),
    );
    expect(res.state).toBe('queued');
    await waitFor('smtp mail', () => c.smtp.mails.length === 1);
    await waitFor('send result', () => c.h.eventsOfType('send:result').length === 1);
    expect(c.h.eventsOfType('send:result')[0]).toMatchObject({ ok: true, outboxId: res.outboxId });

    const m = c.smtp.mails[0]!;
    expect(m.method).toBe('PLAIN');
    expect(m.from).toBe('me@example.com');
    expect(m.to.sort()).toEqual(['alice@example.com', 'secret@example.com']);
    expect(m.parsed.subject).toBe('Re: Lunch?');
    expect(m.parsed.inReplyTo).toBe('<orig-1@example.com>');
    expect(String(m.parsed.references)).toContain('<orig-1@example.com>');
    expect(m.parsed.html).toContain('Yes, <b>noon</b> works.');
    expect(m.parsed.text).toContain('noon works');
    expect(m.parsed.messageId).toMatch(/@example\.com>$/);
    // Bcc recipients are in the envelope only.
    expect(m.raw.toString('utf8')).not.toMatch(/^bcc:/im);
    expect(m.raw.toString('utf8')).not.toContain('secret@example.com');

    // Copy in Sent (this server does not save sent mail by itself) - with the Bcc visible to us.
    await waitFor('sent copy', () => imap!.mailbox('Sent').messages.length === 1);
    const copy = String(imap!.mailbox('Sent').messages[0]!.raw);
    expect(copy).toContain('Subject: Re: Lunch?');
    expect(copy).toContain('Bcc: secret@example.com');
    expect(imap!.mailbox('Sent').messages[0]!.flags).toContain('\\Seen');

    // The original is marked answered, on the server too.
    await waitFor('answered', () => c.h.engine.ctx.messages.headers([src.id])[0]!.answered);
    await c.h.engine.actions.drain();
    await waitFor('server \\Answered', () =>
      imap!
        .mailbox('INBOX')
        .messages.find((x) => x.uid === src.uid)!
        .flags.includes('\\Answered'),
    );
    expect(await handle(c.h, 'outbox.list')).toEqual([]);
  });

  it('attaches picked files and forwarded originals with the right bytes', async () => {
    const c = await boot();
    const src = c.h.inboxMessages(c.acc.id).find((m) => m.subject === 'Quarterly report')!;
    const d = await handle<ComposeDraft>(c.h, 'compose.prepare', {
      mode: 'forward',
      sourceMessageId: src.id,
    });
    const extra = await handle<{ tokenId: string; filename: string }>(c.h, 'compose.attachData', {
      filename: 'notes.txt',
      contentType: 'text/plain',
      data: new TextEncoder().encode('remember the milk'),
    });
    await handle(c.h, 'compose.send', sendReq(d, {
      to: [{ address: 'dave@example.com' }],
      attachmentTokens: [...d.attachments.map((a) => a.tokenId), extra.tokenId],
    }));
    await waitFor('smtp mail', () => c.smtp.mails.length === 1);
    const atts = c.smtp.mails[0]!.parsed.attachments;
    const pdf = atts.find((a) => a.filename === 'report.pdf')!;
    const txt = atts.find((a) => a.filename === 'notes.txt')!;
    expect(pdf.content.toString('utf8')).toBe(PDF_TEXT);
    expect(pdf.contentType).toBe('application/pdf');
    expect(txt.content.toString('utf8')).toBe('remember the milk');
    expect(c.smtp.mails[0]!.parsed.subject).toBe('Fwd: Quarterly report');
  });

  it('does not add a Sent copy for providers that save one themselves (Gmail address)', async () => {
    const c = await boot({ account: { email: 'me@gmail.com' } });
    expect(c.acc.provider).toBe('gmail');
    const d = await newDraft(c.h, c.acc.id);
    await handle(c.h, 'compose.send', sendReq(d, { to: [{ address: 'x@example.com' }], subject: 'Hi' }));
    await waitFor('smtp mail', () => c.smtp.mails.length === 1);
    await waitFor('send result', () => c.h.eventsOfType('send:result').length === 1);
    await new Promise((r) => setTimeout(r, 300));
    expect(imap!.mailbox('Sent').messages).toHaveLength(0);
  });

  it('validates recipients, addresses and attachment tokens', async () => {
    const c = await boot();
    const d = await newDraft(c.h, c.acc.id);
    await expect(handle(c.h, 'compose.send', sendReq(d))).rejects.toMatchObject({
      appError: { code: 'INVALID_INPUT' },
    });
    await expect(
      handle(c.h, 'compose.send', sendReq(d, { to: [{ address: 'not-an-address' }] })),
    ).rejects.toMatchObject({ appError: { code: 'INVALID_INPUT' } });
    await expect(
      handle(
        c.h,
        'compose.send',
        sendReq(d, { to: [{ address: 'a@example.com' }], attachmentTokens: ['file:nope'] }),
      ),
    ).rejects.toMatchObject({ appError: { code: 'NOT_FOUND' } });
    expect(c.smtp.mails).toHaveLength(0);
  });

  it('a recipient the server refuses is reported but the rest is sent', async () => {
    const c = await boot({ smtp: { rejectRcpt: ['bad@example.com'] } });
    const d = await newDraft(c.h, c.acc.id);
    await handle(c.h, 'compose.send', sendReq(d, {
      to: [{ address: 'good@example.com' }, { address: 'bad@example.com' }],
      subject: 'Two',
    }));
    await waitFor('send result', () => c.h.eventsOfType('send:result').length === 1);
    const r = c.h.eventsOfType('send:result')[0]!;
    expect(r.ok).toBe(true);
    expect(r.error?.message).toContain('bad@example.com');
    expect(c.smtp.mails[0]!.to).toEqual(['good@example.com']);
  });

  it('works with STARTTLS', async () => {
    const c = await boot({ smtp: { security: 'starttls' } });
    const d = await newDraft(c.h, c.acc.id);
    await handle(c.h, 'compose.send', sendReq(d, { to: [{ address: 'x@example.com' }], subject: 'TLS' }));
    await waitFor('smtp mail', () => c.smtp.mails.length === 1);
    expect(c.smtp.mails[0]!.parsed.subject).toBe('TLS');
  });
});

describe('outbox: retries, failures, undo send', () => {
  it('retries a temporary server error and then succeeds', async () => {
    const c = await boot();
    c.smtp.failNextData(2);
    const d = await newDraft(c.h, c.acc.id);
    await handle(c.h, 'compose.send', sendReq(d, { to: [{ address: 'x@example.com' }], subject: 'Retry' }));
    await waitFor('delivered after retries', () => c.smtp.mails.length === 1);
    await waitFor('outbox empty', async () => ((await handle(c.h, 'outbox.list')) as unknown[]).length === 0);
    expect(c.h.eventsOfType('send:result').every((e) => e.ok)).toBe(true);
  });

  it('gives up after the retries, keeps the message as failed, and outbox.retry sends it', async () => {
    const c = await boot();
    c.smtp.failNextData(10);
    const d = await newDraft(c.h, c.acc.id);
    const res = await handle<SendRes>(c.h, 'compose.send', sendReq(d, { to: [{ address: 'x@example.com' }], subject: 'Stuck' }));
    await waitFor('failed', async () => {
      const list = (await handle(c.h, 'outbox.list')) as { state: string }[];
      return list[0]?.state === 'failed';
    });
    const failed = c.h.eventsOfType('send:result').find((e) => !e.ok)!;
    expect(failed.outboxId).toBe(res.outboxId);
    expect(failed.error?.retryable).toBe(true);
    const item = ((await handle(c.h, 'outbox.list')) as { lastError: string; attempts: number }[])[0]!;
    expect(item.lastError).toBeTruthy();
    expect(item.attempts).toBe(4);

    c.smtp.failNextData(0);
    await handle(c.h, 'outbox.retry', { outboxId: res.outboxId });
    await waitFor('delivered', () => c.smtp.mails.length === 1);
    await waitFor('outbox empty', async () => ((await handle(c.h, 'outbox.list')) as unknown[]).length === 0);
  });

  it('a wrong password fails at once (no retries) with AUTH_FAILED', async () => {
    const c = await boot();
    c.h.secrets.set(c.acc.id, 'wrong-for-smtp'); // IMAP stays connected; SMTP now gets a bad password
    const d = await newDraft(c.h, c.acc.id);
    await handle(c.h, 'compose.send', sendReq(d, { to: [{ address: 'x@example.com' }], subject: 'Auth' }));
    await waitFor('failure', () => c.h.eventsOfType('send:result').length === 1);
    const r = c.h.eventsOfType('send:result')[0]!;
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('AUTH_FAILED');
    expect(c.smtp.authAttempts).toHaveLength(1);
    const [item] = (await handle(c.h, 'outbox.list')) as { state: string }[];
    expect(item!.state).toBe('failed');
    c.h.secrets.set(c.acc.id, SMTP_PASSWORD);
  });

  it('undo send: cancelling inside the delay stops the send and brings the draft back', async () => {
    const c = await boot({ harness: { settings: { undoSendDelayMs: 20_000 } } });
    const d = await newDraft(c.h, c.acc.id);
    const res = await handle<SendRes>(
      c.h,
      'compose.send',
      sendReq(d, { to: [{ address: 'x@example.com' }], subject: 'Oops', html: '<p>draft text</p>' }),
    );
    expect(res.sendAt).toBeGreaterThan(Date.now() + 5_000);
    const [item] = (await handle(c.h, 'outbox.list')) as { state: string; sendAt: number }[];
    expect(item).toMatchObject({ state: 'queued', sendAt: res.sendAt });

    const cancelled = await handle<{ draftId: string | null }>(c.h, 'outbox.cancel', { outboxId: res.outboxId });
    expect(cancelled.draftId).toBe(d.draftId);
    expect(await handle(c.h, 'outbox.list')).toEqual([]);

    const back = await handle<ComposeDraft>(c.h, 'compose.prepare', { mode: 'new', draftId: cancelled.draftId! });
    expect(back.subject).toBe('Oops');
    expect(back.html).toBe('<p>draft text</p>');
    expect(back.to).toEqual([{ address: 'x@example.com' }]);

    await new Promise((r) => setTimeout(r, 900));
    expect(c.smtp.mails).toHaveLength(0);
  });

  it('without a cancel, the message goes out when the delay is over', async () => {
    const c = await boot({ harness: { settings: { undoSendDelayMs: 300 } } });
    const d = await newDraft(c.h, c.acc.id);
    const t0 = Date.now();
    await handle(c.h, 'compose.send', sendReq(d, { to: [{ address: 'x@example.com' }], subject: 'Later' }));
    expect(c.smtp.mails).toHaveLength(0);
    await waitFor('delivered', () => c.smtp.mails.length === 1);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
  });

  it('a queued message survives an engine restart (compose.start re-arms it)', async () => {
    const c = await boot({ harness: { settings: { undoSendDelayMs: 2_000 } } });
    const d = await newDraft(c.h, c.acc.id);
    await handle(c.h, 'compose.send', sendReq(d, { to: [{ address: 'x@example.com' }], subject: 'Persist' }));
    await c.h.engine.compose.shutdown();
    expect(c.smtp.mails).toHaveLength(0);
    c.h.engine.compose.start();
    await waitFor('delivered', () => c.smtp.mails.length === 1);
  });
});

describe('drafts', () => {
  it('saves to the Drafts folder, replaces the copy on every save, and discard removes it', async () => {
    const c = await boot();
    const d = await newDraft(c.h, c.acc.id);
    const req = sendReq(d, { to: [{ address: 'x@example.com' }], subject: 'Draft v1', bcc: [{ address: 'b@example.com' }] });
    const saved = await handle<{ savedAt: number }>(c.h, 'compose.saveDraft', req);
    expect(saved.savedAt).toBeGreaterThan(0);
    const drafts = () => imap!.mailbox('Drafts').messages;
    await waitFor('server draft', () => drafts().length === 1);
    expect(drafts()[0]!.flags).toEqual(expect.arrayContaining(['\\Draft', '\\Seen']));
    expect(String(drafts()[0]!.raw)).toContain('Subject: Draft v1');
    expect(String(drafts()[0]!.raw)).toContain('Bcc: b@example.com');

    await handle(c.h, 'compose.saveDraft', { ...req, subject: 'Draft v2' });
    await waitFor('replaced', () => drafts().length === 1 && String(drafts()[0]!.raw).includes('Subject: Draft v2'));

    // Reopen from the local copy.
    const again = await handle<ComposeDraft>(c.h, 'compose.prepare', { mode: 'new', draftId: d.draftId });
    expect(again.subject).toBe('Draft v2');

    await handle(c.h, 'compose.discard', { draftId: d.draftId });
    await waitFor('server draft gone', () => drafts().length === 0);
    await expect(
      handle(c.h, 'compose.prepare', { mode: 'new', draftId: d.draftId }),
    ).rejects.toMatchObject({ appError: { code: 'NOT_FOUND' } });
  });

  it('sending a saved draft removes the draft from the Drafts folder', async () => {
    const c = await boot();
    const d = await newDraft(c.h, c.acc.id);
    const req = sendReq(d, { to: [{ address: 'x@example.com' }], subject: 'Soon sent' });
    await handle(c.h, 'compose.saveDraft', req);
    await waitFor('server draft', () => imap!.mailbox('Drafts').messages.length === 1);
    // The copy on the server appears before the local row is linked to it; wait for the link, or send cannot find it.
    await waitFor('draft linked to server copy', () =>
      (c.h.engine.ctx.db.prepare('SELECT server_folder_id AS f FROM draft_state WHERE draft_id = ?').get(d.draftId) as { f: number | null } | undefined)?.f != null);
    await handle(c.h, 'compose.send', req);
    await waitFor('delivered', () => c.smtp.mails.length === 1);
    await waitFor('draft removed', () => imap!.mailbox('Drafts').messages.length === 0);
  });

  it('opens a draft message from the Drafts folder for editing', async () => {
    const c = await boot();
    const d = await newDraft(c.h, c.acc.id);
    await handle(c.h, 'compose.saveDraft', sendReq(d, {
      to: [{ address: 'x@example.com' }],
      subject: 'From the folder',
      html: '<p>Body of the draft</p>',
    }));
    const drafts = c.h.engine.ctx.folders.rowByRole(c.acc.id, 'drafts')!;
    await waitFor('draft synced', () => c.h.folderMessages(drafts.id).length === 1);
    const msg = c.h.folderMessages(drafts.id)[0]!;
    const edit = await handle<ComposeDraft>(c.h, 'compose.prepare', { mode: 'new', draftMessageId: msg.id });
    expect(edit.subject).toBe('From the folder');
    expect(edit.to).toEqual([{ address: 'x@example.com' }]);
    expect(edit.html).toContain('Body of the draft');
    // Saving again replaces the same server draft.
    await handle(c.h, 'compose.saveDraft', sendReq(edit, { subject: 'Edited' }));
    await waitFor('replaced on server', () => {
      const m = imap!.mailbox('Drafts').messages;
      return m.length === 1 && String(m[0]!.raw).includes('Subject: Edited');
    });
  });
});

describe('OAuth (XOAUTH2) accounts', () => {
  it('accounts.test and accounts.add use the access token', async () => {
    imap = await startFakeImap({ inbox: [{ raw: rawMessage({ subject: 'Hello' }) }] });
    smtp = await startFakeSmtp({ accessToken: TEST_TOKEN, user: 'testuser' });
    h = await createHarness(imap, { smtp });
    h.oauthSessions.set('sess-1', {
      email: 'me@example.com',
      accessToken: TEST_TOKEN,
      expiresAt: Date.now() + 3_600_000,
    });
    const input = {
      email: 'me@example.com',
      authType: 'oauth2' as const,
      oauthProvider: 'microsoft' as const,
      oauthSessionId: 'sess-1',
      username: 'testuser', // the login name the two fake servers know
      imap: { host: imap.host, port: imap.port, security: 'ssl' as const },
      smtp: { host: smtp.host, port: smtp.port, security: 'ssl' as const },
    };
    const t = (await h.engine.handle('accounts.test', { input })) as {
      imap: { ok: boolean };
      smtp: { ok: boolean };
    };
    expect(t).toEqual({ imap: { ok: true }, smtp: { ok: true } });
    expect(smtp.authAttempts.at(-1)).toEqual({ method: 'XOAUTH2', ok: true });

    const added = (await h.engine.handle('accounts.add', { ...input, displayName: 'Work' })) as {
      id: string;
      authType: string;
      oauthProvider: string;
    };
    expect(added).toMatchObject({ authType: 'oauth2', oauthProvider: 'microsoft' });
    expect(h.oauthTokens.get(added.id)).toBe(TEST_TOKEN); // tokens moved to the account
    expect(h.oauthSessions.has('sess-1')).toBe(false); // session consumed
    await waitFor('synced via XOAUTH2', () => h!.inboxMessages(added.id).length === 1);
  });

  it('a rejected token shows up as AUTH_FAILED in accounts.test', async () => {
    imap = await startFakeImap({});
    smtp = await startFakeSmtp({ accessToken: TEST_TOKEN, user: 'testuser' });
    h = await createHarness(imap, { smtp });
    h.oauthSessions.set('bad', { email: 'me@example.com', accessToken: 'expired', expiresAt: 0 });
    const t = (await h.engine.handle('accounts.test', {
      input: {
        email: 'me@example.com',
        authType: 'oauth2',
        oauthProvider: 'microsoft',
        oauthSessionId: 'bad',
        username: 'testuser',
        imap: { host: imap.host, port: imap.port, security: 'ssl' },
        smtp: { host: smtp.host, port: smtp.port, security: 'ssl' },
      },
    })) as { imap: { error: { code: string } }; smtp: { error: { code: string } } };
    expect(t.imap.error.code).toBe('AUTH_FAILED');
    expect(t.smtp.error.code).toBe('AUTH_FAILED');
  });

  it('refuses a session that belongs to a different address', async () => {
    imap = await startFakeImap({});
    h = await createHarness(imap);
    h.oauthSessions.set('s', { email: 'someone@else.com', accessToken: TEST_TOKEN, expiresAt: 0 });
    await expect(
      h.engine.handle('accounts.add', {
        email: 'me@example.com',
        displayName: 'x',
        authType: 'oauth2',
        oauthProvider: 'microsoft',
        oauthSessionId: 's',
        username: 'testuser',
        imap: { host: imap.host, port: imap.port, security: 'ssl' },
        smtp: { host: imap.host, port: 1, security: 'ssl' },
      }),
    ).rejects.toMatchObject({ appError: { code: 'INVALID_INPUT' } });
  });

  it('sends over XOAUTH2', async () => {
    const c = await boot({ smtp: { accessToken: TEST_TOKEN, user: 'testuser' } });
    c.h.oauthTokens.set(c.acc.id, TEST_TOKEN); // pretend this account signed in with OAuth
    c.h.engine.ctx.db.prepare("UPDATE account SET auth_type='oauth2', oauth_provider='microsoft' WHERE id=?").run(c.acc.id);
    const d = await newDraft(c.h, c.acc.id);
    await handle(c.h, 'compose.send', sendReq(d, { to: [{ address: 'x@example.com' }], subject: 'Token' }));
    await waitFor('smtp mail', () => c.smtp.mails.length === 1);
    expect(c.smtp.mails[0]!.method).toBe('XOAUTH2');
  });
});
