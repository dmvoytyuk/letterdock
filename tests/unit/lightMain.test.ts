// Main-process pieces of the light features (DESIGN-SPEC 3.13): toast XML and activation, toast buttons
// in the Notifier, snooze-return notification, one-click unsubscribe, unsubscribe.run, the new
// settings (quick replies etc.) and the request checks of the new channels.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { IncomingMessage, ServerResponse } from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Notifier, type ToastSpec } from '../../src/main/notifications';
import { DEFAULT_SETTINGS, mergeSettings, sanitizeQuickReplies } from '../../src/main/settings';
import { isKnownChannel, schemas } from '../../src/main/ipcSchemas';
import { MAIN_CHANNELS, isMainChannel } from '../../src/shared/channels';
import { buildToastXml, encodeActivationArgs, escapeXml, parseActivationArgs } from '../../src/main/toast';
import { onToastActivation } from '../../src/main/toastActions';
import { postOneClick } from '../../src/main/unsubscribe/oneClick';
import { runUnsubscribe, type UnsubscribeDeps } from '../../src/main/unsubscribe/run';
import type { AppEvent, AppSettings, MessageHeader } from '../../src/shared/ipc';

function msg(id: number, over: Partial<MessageHeader> = {}): MessageHeader {
  return {
    id, accountId: 'a1', folderId: 1, uid: id, messageIdHeader: `<${id}@x>`, subject: `Subject ${id}`,
    from: { name: `Sender ${id}`, address: `s${id}@x.com` }, to: [], cc: [], date: 0, snippet: `snippet ${id}`,
    seen: false, flagged: false, answered: false, draft: false, hasAttachments: false, size: 1, bodyCached: false,
    ...over,
  };
}

describe('toast XML', () => {
  const ctx = { accountId: 'acc & <1>', messageId: 42 };

  it('builds buttons with background activation and escapes everything', () => {
    const xml = buildToastXml({
      title: 'Alice <a@x.com> & "co"',
      body: "It's 5 < 6",
      silent: true,
      context: ctx,
      buttons: [
        { action: 'read', label: 'Mark as read' },
        { action: 'archive', label: 'Archive' },
      ],
    });
    expect(xml).toContain('<text>Alice &lt;a@x.com&gt; &amp; &quot;co&quot;</text>');
    expect(xml).toContain('<text>It&apos;s 5 &lt; 6</text>');
    expect(xml).toContain('<audio silent="true"/>');
    expect(xml.match(/activationType="background"/g)).toHaveLength(2);
    expect(xml).toContain('content="Mark as read"');
    expect(xml).toContain('content="Archive"');
    // nothing from the mail can break out of an attribute
    expect(xml).not.toMatch(/acc & </);
    expect(xml.startsWith('<toast launch="')).toBe(true);
    expect(xml.endsWith('</toast>')).toBe(true);
  });

  it('leaves out the audio element for sound and the actions element without buttons', () => {
    const xml = buildToastXml({ title: 'T', body: '', silent: false, context: ctx, buttons: [] });
    expect(xml).not.toContain('<audio');
    expect(xml).not.toContain('<actions>');
    expect(xml).toContain('<text>T</text>');
    expect(xml.match(/<text>/g)).toHaveLength(1); // empty body = no empty line
  });

  it('drops characters XML cannot hold', () => {
    expect(escapeXml('a\u0000b\u0008c\u001fd')).toBe('abcd');
  });

  it('round-trips the activation arguments, also for odd account ids', () => {
    const args = encodeActivationArgs('archive', ctx);
    expect(parseActivationArgs(args)).toEqual({ action: 'archive', accountId: ctx.accountId, messageId: 42 });
    for (const a of ['open', 'read'] as const) {
      expect(parseActivationArgs(encodeActivationArgs(a, ctx))?.action).toBe(a);
    }
  });

  it('ignores arguments that are not ours', () => {
    for (const bad of [undefined, null, '', 'foo=bar', 'a=delete&acc=x&msg=1', 'a=read&acc=&msg=1', 'a=read&acc=x&msg=abc',
      'a=read&acc=x&msg=-1', 'a=read&acc=x&msg=1e3', `a=read&acc=${'x'.repeat(200)}&msg=1`, 'x'.repeat(1000)]) {
      expect(parseActivationArgs(bad as string)).toBeNull();
    }
  });
});

describe('toast activation', () => {
  function deps(over: Partial<Parameters<typeof onToastActivation>[0]> = {}) {
    const sent: AppEvent[] = [];
    const d = {
      engine: vi.fn(async () => ({ done: true, undoToken: 'tok' })),
      mainVisible: () => true,
      sendToMain: (e: AppEvent) => sent.push(e),
      openMessage: vi.fn(),
      showPlain: vi.fn(),
      ...over,
    };
    return { d: d as Parameters<typeof onToastActivation>[0], sent, raw: d };
  }

  it('Archive runs in the background and tells the visible main window', async () => {
    const { d, sent, raw } = deps();
    await onToastActivation(d, { arguments: encodeActivationArgs('archive', { accountId: 'a1', messageId: 7 }), type: 'action' });
    expect(raw.engine).toHaveBeenCalledWith('notifications.action', { accountId: 'a1', messageId: 7, action: 'archive' });
    expect(raw.openMessage).not.toHaveBeenCalled(); // nothing comes to the front
    expect(sent).toEqual([{ type: 'notify:actionDone', action: 'archive', accountId: 'a1', messageId: 7, undoToken: 'tok' }]);
  });

  it('says nothing when the window is hidden, or the message is already gone or read', async () => {
    const hidden = deps({ mainVisible: () => false });
    await onToastActivation(hidden.d, { arguments: encodeActivationArgs('read', { accountId: 'a1', messageId: 7 }) });
    expect(hidden.sent).toEqual([]);
    const gone = deps({ engine: vi.fn(async () => ({ done: false })) as never });
    await onToastActivation(gone.d, { arguments: encodeActivationArgs('read', { accountId: 'a1', messageId: 7 }) });
    expect(gone.sent).toEqual([]);
    expect(gone.raw.showPlain).not.toHaveBeenCalled();
  });

  it('clicking the toast opens the message; junk is ignored; a failing engine gives a plain note', async () => {
    const a = deps();
    await onToastActivation(a.d, { arguments: encodeActivationArgs('open', { accountId: 'a1', messageId: 9 }), type: 'click' });
    expect(a.raw.openMessage).toHaveBeenCalledWith(9);
    await onToastActivation(a.d, { arguments: 'garbage' });
    expect(a.raw.engine).not.toHaveBeenCalled();
    const f = deps({ engine: vi.fn(async () => { throw new Error('down'); }) as never });
    await onToastActivation(f.d, { arguments: encodeActivationArgs('archive', { accountId: 'a1', messageId: 7 }) });
    expect(f.raw.showPlain).toHaveBeenCalledWith("Couldn't archive", expect.any(String));
  });
});

describe('Notifier: buttons and snooze return', () => {
  function setup(over: Partial<AppSettings> = {}) {
    const toasts: ToastSpec[] = [];
    let timers: (() => void)[] = [];
    const settings = { ...DEFAULT_SETTINGS, ...over };
    const n = new Notifier({
      show: (t) => toasts.push(t),
      settings: () => settings,
      isMainFocused: () => false,
      accountName: async () => 'Work',
      focusMain: vi.fn(),
      setTimer: (fn) => (timers.push(fn), 0),
    });
    const fire = async () => {
      const t = timers;
      timers = [];
      t.forEach((f) => f());
      await new Promise((r) => setTimeout(r, 0));
    };
    return { n, toasts, fire };
  }

  it('one message gets Mark as read and Archive; no Archive button without an Archive folder', async () => {
    const a = setup();
    a.n.newMail('a1', [msg(1)], true);
    await a.fire();
    expect(a.toasts[0]!.buttons?.map((b) => b.action)).toEqual(['read', 'archive']);
    expect(a.toasts[0]!.context).toEqual({ accountId: 'a1', messageId: 1 });
    const b = setup();
    b.n.newMail('a1', [msg(2)], false);
    await b.fire();
    expect(b.toasts[0]!.buttons?.map((x) => x.action)).toEqual(['read']);
  });

  it('a grouped toast has no buttons, and the setting turns them off', async () => {
    const a = setup();
    a.n.newMail('a1', [msg(1), msg(2), msg(3), msg(4)], true);
    await a.fire();
    expect(a.toasts).toHaveLength(1);
    expect(a.toasts[0]!.buttons).toBeUndefined();
    const off = setup({ notifyActions: false });
    off.n.newMail('a1', [msg(5)], true);
    await off.fire();
    expect(off.toasts[0]!.buttons).toBeUndefined();
  });

  it('keeps the buttons in the "New mail" privacy mode', async () => {
    const a = setup({ notifications: { ...DEFAULT_SETTINGS.notifications, showPreview: false } });
    a.n.newMail('a1', [msg(1)], true);
    await a.fire();
    expect(a.toasts[0]).toMatchObject({ title: 'New mail', body: 'Work' });
    expect(a.toasts[0]!.buttons).toHaveLength(2);
  });

  it('shows one "Snoozed mail is back" notification, honoring the settings', () => {
    const a = setup();
    a.n.snoozeReturned('a1', [msg(1), msg(2), msg(3)]);
    expect(a.toasts).toHaveLength(1);
    expect(a.toasts[0]).toMatchObject({ title: 'Snoozed mail is back', body: '3 messages are back in your Inbox' });
    expect(a.toasts[0]!.buttons).toBeUndefined();
    a.n.snoozeReturned('a1', [msg(4)]);
    expect(a.toasts[1]!.body).toContain('Sender 4');
    expect(a.toasts[1]!.body).toContain('Subject 4');

    const priv = setup({ notifications: { ...DEFAULT_SETTINGS.notifications, showPreview: false } });
    priv.n.snoozeReturned('a1', [msg(4)]);
    expect(priv.toasts[0]!.body).toBe('A message is back in your Inbox');

    const off = setup({ notifySnoozeReturn: false });
    off.n.snoozeReturned('a1', [msg(1)]);
    expect(off.toasts).toHaveLength(0);
    const muted = setup({ notifications: { ...DEFAULT_SETTINGS.notifications, mutedAccountIds: ['a1'] } });
    muted.n.snoozeReturned('a1', [msg(1)]);
    expect(muted.toasts).toHaveLength(0);
    const disabled = setup({ notifications: { ...DEFAULT_SETTINGS.notifications, enabled: false } });
    disabled.n.snoozeReturned('a1', [msg(1)]);
    expect(disabled.toasts).toHaveLength(0);
  });
});

describe('settings: quick replies and the new keys', () => {
  it('has the defaults of the design', () => {
    expect(DEFAULT_SETTINGS).toMatchObject({
      quickReplies: [],
      recentCommands: [],
      snoozeTimes: { morning: '08:00', evening: '18:00', weekendMorning: '09:00' },
      showTrackerNotice: true,
      notifyActions: true,
      notifySnoozeReturn: true,
    });
  });

  it('keeps stored arrays (they were dropped by the old object merge) and checks them', () => {
    const s = mergeSettings({
      quickReplies: [
        { id: 'q1', name: ' Thanks ', text: 'Thank you', accountId: null },
        { id: 'q2', name: 'thanks', text: 'duplicate name', accountId: null },
        { id: 'q3', name: '', text: 'no name', accountId: null },
        { id: 'q4', name: 'x'.repeat(41), text: 'long name', accountId: null },
        { id: 'q5', name: 'Long', text: 'x'.repeat(2001), accountId: null },
        { id: 'q6', name: 'Mine', text: 'ok', accountId: 'a1' },
        { id: 'q1', name: 'same id', text: 'ok', accountId: null },
        { nonsense: true } as never,
      ],
      recentCommands: ['New message', 5 as never, '', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
      snoozeTimes: { morning: '7:30', evening: '19:15', weekendMorning: '25:00' },
    });
    expect(s.quickReplies.map((q) => q.id)).toEqual(['q1', 'q6']);
    expect(s.quickReplies[0]!.name).toBe('Thanks');
    expect(s.quickReplies[1]!.accountId).toBe('a1');
    expect(s.recentCommands).toHaveLength(8);
    expect(s.recentCommands[0]).toBe('New message');
    expect(s.snoozeTimes).toEqual({ morning: '08:00', evening: '19:15', weekendMorning: '09:00' });
  });

  it('allows at most 50 quick replies', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ id: `q${i}`, name: `n${i}`, text: 't', accountId: null }));
    expect(sanitizeQuickReplies(many)).toHaveLength(50);
    expect(sanitizeQuickReplies('nope')).toEqual([]);
  });

  const patch = (x: object) => schemas['settings.set'].safeParse(x).success;
  const qr = (i: number, over: object = {}) => ({ id: `q${i}`, name: `Name ${i}`, text: 'Hello', accountId: null, ...over });

  it('the settings.set request enforces the limits', () => {
    expect(patch({ quickReplies: [qr(1), qr(2, { accountId: 'a1' })] })).toBe(true);
    expect(patch({ quickReplies: Array.from({ length: 51 }, (_, i) => qr(i)) })).toBe(false);
    expect(patch({ quickReplies: Array.from({ length: 50 }, (_, i) => qr(i)) })).toBe(true);
    expect(patch({ quickReplies: [qr(1, { name: 'x'.repeat(41) })] })).toBe(false);
    expect(patch({ quickReplies: [qr(1, { name: 'x'.repeat(40) })] })).toBe(true);
    expect(patch({ quickReplies: [qr(1, { text: 'x'.repeat(2001) })] })).toBe(false);
    expect(patch({ quickReplies: [qr(1, { text: 'x'.repeat(2000) })] })).toBe(true);
    expect(patch({ quickReplies: [qr(1, { name: '' })] })).toBe(false);
    expect(patch({ quickReplies: [qr(1, { text: '' })] })).toBe(false);
    expect(patch({ quickReplies: [qr(1, { name: 'Same' }), qr(2, { name: 'SAME' })] })).toBe(false);
    expect(patch({ quickReplies: [qr(1), qr(1, { name: 'Other' })] })).toBe(false);
    expect(patch({ recentCommands: ['a', 'b'] })).toBe(true);
    expect(patch({ recentCommands: Array.from({ length: 9 }, () => 'x') })).toBe(false);
    expect(patch({ snoozeTimes: { morning: '08:00', evening: '18:30', weekendMorning: '09:00' } })).toBe(true);
    expect(patch({ snoozeTimes: { morning: '8:00', evening: '18:30', weekendMorning: '09:00' } })).toBe(false);
    expect(patch({ snoozeTimes: { morning: '08:00' } })).toBe(false);
    expect(patch({ showTrackerNotice: false, notifyActions: false, notifySnoozeReturn: false })).toBe(true);
    expect(patch({ notifyActions: 'yes' })).toBe(false);
  });
});

describe('new channels: routing and request checks', () => {
  it('knows them, and unsubscribe.run is the only main channel', () => {
    for (const c of ['unsubscribe.info', 'unsubscribe.run', 'unsubscribe.forgetHistory', 'snooze.set', 'snooze.clear',
      'snooze.list', 'snooze.count', 'pin.set', 'mute.set', 'messages.countFromSender', 'messages.trashFromSender']) {
      expect(isKnownChannel(c)).toBe(true);
    }
    expect(isMainChannel('unsubscribe.run')).toBe(true);
    expect(MAIN_CHANNELS.filter((c) => /snooze|pin|mute|unsubscribe\.(info|forget)/.test(c))).toEqual([]);
    // internal channels are not reachable from the renderer
    for (const c of ['unsubscribe.record', 'unsubscribe.targets', 'unsubscribe.sendMailto', 'notifications.action']) {
      expect(isKnownChannel(c)).toBe(false);
    }
  });

  it('checks the requests', () => {
    expect(schemas['snooze.set'].safeParse({ messageIds: [1], until: Date.now() + 1000 }).success).toBe(true);
    expect(schemas['snooze.set'].safeParse({ threadIds: ['t:1'], scope: { kind: 'unifiedInbox' }, until: 5 }).success).toBe(true);
    expect(schemas['snooze.set'].safeParse({ until: 5 }).success).toBe(false); // no target
    expect(schemas['snooze.set'].safeParse({ messageIds: [], until: 5 }).success).toBe(false);
    expect(schemas['snooze.clear'].safeParse({}).success).toBe(false);
    expect(schemas['pin.set'].safeParse({ messageIds: [1], pinned: true }).success).toBe(true);
    expect(schemas['pin.set'].safeParse({ messageIds: [1] }).success).toBe(false);
    expect(schemas['mute.set'].safeParse({ messageIds: [1], muted: true }).success).toBe(true);
    expect(schemas['mute.set'].safeParse({ threads: [{ accountId: 'a', threadId: 't' }], muted: false }).success).toBe(true);
    expect(schemas['mute.set'].safeParse({ muted: true }).success).toBe(false);
    expect(schemas['unsubscribe.run'].safeParse({ messageId: 1, method: 'one-click' }).success).toBe(true);
    expect(schemas['unsubscribe.run'].safeParse({ messageId: 1, method: 'https://evil' }).success).toBe(false);
    // the renderer can only name a message and a method, never an address
    expect(schemas['unsubscribe.run'].safeParse({ messageId: 1, method: 'page', url: 'https://x' }).success).toBe(true);
    expect(schemas['messages.countFromSender'].safeParse({ accountId: 'a', address: 'x@y.com' }).success).toBe(true);
  });
});

// ---------- one-click POST against a local https server ----------
const require_ = createRequire(import.meta.url);
const CERT_DIR = join(dirname(require_.resolve('hoodiecrow-imap/package.json')), 'cert');
const KEY = readFileSync(join(CERT_DIR, 'server.key'), 'utf8');
const CERT = readFileSync(join(CERT_DIR, 'server.crt'), 'utf8');

interface Seen {
  method?: string;
  url?: string;
  headers: Record<string, unknown>;
  body: string;
}

describe('one-click unsubscribe request', () => {
  const servers: https.Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => { s.closeAllConnections(); s.close(r); })));
  });

  async function serve(handler: (req: IncomingMessage, res: ServerResponse, seen: Seen[]) => void) {
    const seen: Seen[] = [];
    const s = https.createServer({ key: KEY, cert: CERT }, (req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, headers: req.headers, body });
        handler(req, res, seen);
      });
    });
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    servers.push(s);
    const port = (s.address() as AddressInfo).port;
    return { seen, url: (p = '/u') => `https://localhost:${port}${p}` };
  }
  const opts = { allowPrivate: true, ca: CERT };

  it('sends the RFC 8058 body, with no cookies, no Referer and no credentials', async () => {
    const srv = await serve((_q, res) => res.writeHead(200).end('ok'));
    const r = await postOneClick(srv.url('/unsub?id=1'), opts);
    expect(r).toEqual({ ok: true, status: 200 });
    const q = srv.seen[0]!;
    expect(q.method).toBe('POST');
    expect(q.url).toBe('/unsub?id=1');
    expect(q.body).toBe('List-Unsubscribe=One-Click');
    expect(q.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(q.headers['content-length']).toBe(String('List-Unsubscribe=One-Click'.length));
    expect(q.headers['cookie']).toBeUndefined();
    expect(q.headers['referer']).toBeUndefined();
    expect(q.headers['authorization']).toBeUndefined();
  });

  it('follows up to 3 redirects (POST again) and gives up after that', async () => {
    const srv = await serve((q, res, seen) => {
      const n = seen.length;
      if (q.url!.startsWith('/hop') && n <= 3) res.writeHead(307, { location: `/hop${n}` }).end();
      else res.writeHead(204).end();
    });
    const ok = await postOneClick(srv.url('/hop'), opts);
    expect(ok.ok).toBe(true);
    expect(srv.seen.map((s) => s.method)).toEqual(['POST', 'POST', 'POST', 'POST']);
    expect(srv.seen.every((s) => s.body === 'List-Unsubscribe=One-Click')).toBe(true);

    const loop = await serve((_q, res) => res.writeHead(302, { location: '/again' }).end());
    expect(await postOneClick(loop.url('/x'), opts)).toEqual({ ok: false, reason: 'redirects' });
    expect(loop.seen).toHaveLength(4); // the first request plus 3 redirects
  });

  it('does not follow a redirect to plain http', async () => {
    const srv = await serve((_q, res) => res.writeHead(302, { location: 'http://localhost:1/x' }).end());
    expect(await postOneClick(srv.url(), opts)).toMatchObject({ ok: false, reason: 'insecure' });
  });

  it('303 continues with a GET', async () => {
    const srv = await serve((q, res) => (q.url === '/done' ? res.writeHead(200).end() : res.writeHead(303, { location: '/done' }).end()));
    expect((await postOneClick(srv.url('/x'), opts)).ok).toBe(true);
    expect(srv.seen.map((s) => s.method)).toEqual(['POST', 'GET']);
  });

  it('reports a refusal, a timeout and an unreachable server', async () => {
    const no = await serve((_q, res) => res.writeHead(403).end());
    expect(await postOneClick(no.url(), opts)).toEqual({ ok: false, status: 403, reason: 'status' });
    const slow = await serve(() => undefined);
    expect(await postOneClick(slow.url(), { ...opts, timeoutMs: 200 })).toMatchObject({ ok: false, reason: 'timeout' });
    expect(await postOneClick('https://localhost:1/x', { ...opts, timeoutMs: 2000 })).toMatchObject({ ok: false, reason: 'network' });
    expect(await postOneClick('not a url')).toMatchObject({ ok: false });
  });

  it('refuses private and loopback addresses unless a test allows them', async () => {
    const srv = await serve((_q, res) => res.writeHead(200).end());
    expect(await postOneClick(srv.url().replace('localhost', '127.0.0.1'), { ca: CERT })).toMatchObject({ ok: false, reason: 'blocked' });
    expect(await postOneClick(srv.url(), { ca: CERT })).toMatchObject({ ok: false, reason: 'blocked' }); // via DNS
    expect(await postOneClick('https://10.0.0.5/x')).toMatchObject({ ok: false, reason: 'blocked' });
    expect(await postOneClick('https://[::1]/x')).toMatchObject({ ok: false, reason: 'blocked' });
    expect(await postOneClick('http://example.com/x')).toMatchObject({ ok: false, reason: 'insecure' });
    expect(srv.seen).toHaveLength(0);
  });
});

describe('unsubscribe.run', () => {
  function make(targets: object, over: Partial<UnsubscribeDeps> = {}) {
    const calls: [string, unknown][] = [];
    const d: UnsubscribeDeps = {
      engine: (async (ch: string, p?: unknown) => {
        calls.push([ch, p]);
        if (ch === 'unsubscribe.targets') return { auth: 'verified', oneClickUrl: null, pageUrl: null, mailto: null, ...targets };
        return undefined;
      }) as never,
      postOneClick: vi.fn(async () => ({ ok: true as const, status: 200 })),
      openExternal: vi.fn(async () => undefined),
      isOnline: () => true,
      ...over,
    };
    return { d, calls };
  }

  it('one-click: posts the address from the message, then remembers it', async () => {
    const { d, calls } = make({ oneClickUrl: 'https://example.com/u' });
    expect(await runUnsubscribe(d, { messageId: 5, method: 'one-click' })).toEqual({ ok: true, method: 'one-click' });
    expect(d.postOneClick).toHaveBeenCalledWith('https://example.com/u');
    expect(calls.at(-1)).toEqual(['unsubscribe.record', { messageId: 5, method: 'one-click' }]);
  });

  it('a failed request records nothing and says why', async () => {
    const { d, calls } = make({ oneClickUrl: 'https://example.com/u' }, {
      postOneClick: vi.fn(async () => ({ ok: false as const, status: 500, reason: 'status' as const })),
    });
    const r = await runUnsubscribe(d, { messageId: 5, method: 'one-click' });
    expect(r).toMatchObject({ ok: false, method: 'one-click', error: { code: 'SERVER_REJECTED' } });
    expect(calls.find(([c]) => c === 'unsubscribe.record')).toBeUndefined();
    const t = make({ oneClickUrl: 'https://example.com/u' }, { postOneClick: vi.fn(async () => ({ ok: false as const, reason: 'timeout' as const })) });
    expect(await runUnsubscribe(t.d, { messageId: 5, method: 'one-click' })).toMatchObject({ error: { code: 'TIMEOUT' } });
  });

  it('offline: no request, retryable error', async () => {
    const { d } = make({ oneClickUrl: 'https://example.com/u', pageUrl: 'https://example.com/p' }, { isOnline: () => false });
    expect(await runUnsubscribe(d, { messageId: 5, method: 'one-click' })).toMatchObject({ ok: false, error: { code: 'HOST_UNREACHABLE', retryable: true } });
    expect(await runUnsubscribe(d, { messageId: 5, method: 'page' })).toMatchObject({ ok: false });
    expect(d.postOneClick).not.toHaveBeenCalled();
    expect(d.openExternal).not.toHaveBeenCalled();
  });

  it('mailto goes through the engine with the address from the header', async () => {
    const mailto = { address: 'u@example.com', subject: 'remove', body: '' };
    const { d, calls } = make({ mailto });
    expect((await runUnsubscribe(d, { messageId: 5, method: 'mailto' })).ok).toBe(true);
    expect(calls.map(([c]) => c)).toEqual(['unsubscribe.targets', 'unsubscribe.sendMailto', 'unsubscribe.record']);
    expect(calls[1]![1]).toEqual({ messageId: 5, ...mailto });
  });

  it('page opens the https address in the browser and is recorded as "page"', async () => {
    const { d, calls } = make({ pageUrl: 'https://example.com/p' });
    expect((await runUnsubscribe(d, { messageId: 5, method: 'page' })).ok).toBe(true);
    expect(d.openExternal).toHaveBeenCalledWith('https://example.com/p');
    expect(calls.at(-1)).toEqual(['unsubscribe.record', { messageId: 5, method: 'page' }]);
    const bad = make({ pageUrl: 'http://example.com/p' });
    expect((await runUnsubscribe(bad.d, { messageId: 5, method: 'page' })).ok).toBe(false);
    expect(bad.d.openExternal).not.toHaveBeenCalled();
  });

  it('never acts for a sender whose check failed, and refuses a method the message does not have', async () => {
    const { d } = make({ auth: 'failed', oneClickUrl: 'https://example.com/u', pageUrl: 'https://example.com/p' });
    for (const method of ['one-click', 'mailto', 'page'] as const) {
      expect((await runUnsubscribe(d, { messageId: 5, method })).ok).toBe(false);
    }
    expect(d.postOneClick).not.toHaveBeenCalled();
    expect(d.openExternal).not.toHaveBeenCalled();
    const none = make({});
    for (const method of ['one-click', 'mailto', 'page'] as const) {
      expect(await runUnsubscribe(none.d, { messageId: 5, method })).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED' } });
    }
  });
});
