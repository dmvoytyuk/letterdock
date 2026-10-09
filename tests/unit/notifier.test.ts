import { describe, expect, it, vi } from 'vitest';
import { Notifier, type ToastSpec } from '../../src/main/notifications';
import { DEFAULT_SETTINGS } from '../../src/main/settings';
import type { AppSettings, MessageHeader } from '../../src/shared/ipc';

function msg(id: number, over: Partial<MessageHeader> = {}): MessageHeader {
  return {
    id,
    accountId: 'a1',
    folderId: 1,
    uid: id,
    messageIdHeader: `<${id}@x>`,
    subject: `Subject ${id}`,
    from: { name: `Sender ${id}`, address: `s${id}@x.com` },
    to: [],
    cc: [],
    date: 0,
    snippet: `snippet ${id}`,
    seen: false,
    flagged: false,
    answered: false,
    draft: false,
    hasAttachments: false,
    size: 1,
    bodyCached: false,
    ...over,
  };
}

function setup(over: Partial<AppSettings['notifications']> = {}, focused = false) {
  const toasts: ToastSpec[] = [];
  const focus = vi.fn();
  let timers: (() => void)[] = [];
  let now = 1_000_000;
  const n = new Notifier({
    show: (t) => toasts.push(t),
    settings: () => ({ ...DEFAULT_SETTINGS, notifications: { ...DEFAULT_SETTINGS.notifications, ...over } }),
    isMainFocused: () => focused,
    accountName: async (id) => (id === 'a1' ? 'Work' : 'Home'),
    focusMain: focus,
    setTimer: (fn) => {
      timers.push(fn);
      return 0;
    },
    now: () => now,
  });
  const fire = async () => {
    const t = timers;
    timers = [];
    t.forEach((f) => f());
    await new Promise((r) => setTimeout(r, 0));
  };
  return { n, toasts, focus, fire, advance: (ms: number) => (now += ms) };
}

describe('Notifier', () => {
  it('shows sender, subject and snippet for a single message; click opens it', async () => {
    const { n, toasts, focus, fire } = setup();
    n.newMail('a1', [msg(1)]);
    expect(toasts).toHaveLength(0); // gathered for a moment first
    await fire();
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({ title: 'Sender 1', silent: false });
    expect(toasts[0]!.body).toContain('Subject 1');
    expect(toasts[0]!.body).toContain('snippet 1');
    toasts[0]!.onClick();
    expect(focus).toHaveBeenCalledWith(1);
  });

  it('groups a burst of more than three into one toast', async () => {
    const { n, toasts, focus, fire } = setup();
    n.newMail('a1', [msg(1), msg(2)]);
    n.newMail('a1', [msg(3), msg(4), msg(5)]);
    await fire();
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({ title: '5 new messages', body: 'in Work' });
    toasts[0]!.onClick();
    expect(focus).toHaveBeenCalledWith(); // no single message to open
  });

  it('three or fewer are shown one by one', async () => {
    const { n, toasts, fire } = setup();
    n.newMail('a1', [msg(1), msg(2), msg(3)]);
    await fire();
    expect(toasts.map((t) => t.title)).toEqual(['Sender 1', 'Sender 2', 'Sender 3']);
  });

  it('never shows the same message twice, nor read mail', async () => {
    const { n, toasts, fire } = setup();
    n.newMail('a1', [msg(1)]);
    await fire();
    n.newMail('a1', [msg(1), msg(2, { seen: true })]);
    await fire();
    expect(toasts).toHaveLength(1);
  });

  it('respects the settings: off, muted account, hidden preview, silent', async () => {
    const off = setup({ enabled: false });
    off.n.newMail('a1', [msg(1)]);
    await off.fire();
    expect(off.toasts).toHaveLength(0);

    const muted = setup({ mutedAccountIds: ['a1'] });
    muted.n.newMail('a1', [msg(1)]);
    await muted.fire();
    expect(muted.toasts).toHaveLength(0);

    const hidden = setup({ showPreview: false, sound: false });
    hidden.n.newMail('a1', [msg(1)]);
    await hidden.fire();
    expect(hidden.toasts[0]).toMatchObject({ title: 'New mail', body: 'Work', silent: true });
  });

  it('shows nothing while the window is focused', async () => {
    const { n, toasts, fire } = setup({}, true);
    n.newMail('a1', [msg(1)]);
    await fire();
    expect(toasts).toHaveLength(0);
  });

  it('keeps accounts apart', async () => {
    const { n, toasts, fire } = setup();
    n.newMail('a1', [msg(1)]);
    n.newMail('a2', [msg(2, { accountId: 'a2' })]);
    await fire();
    expect(toasts).toHaveLength(2);
  });

  it('sign-in problem: one toast per account per 24 hours', async () => {
    const { n, toasts, advance } = setup();
    await n.authRequired('a1');
    await n.authRequired('a1');
    expect(toasts).toHaveLength(1);
    expect(toasts[0]!.title).toBe('Work needs you to sign in again');
    await n.authRequired('a2');
    expect(toasts).toHaveLength(2);
    advance(25 * 3600 * 1000);
    await n.authRequired('a1');
    expect(toasts).toHaveLength(3);
  });
});
