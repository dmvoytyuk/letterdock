// Engine integration: which new mail is announced with `notify:newMail` (and which is not).
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, waitFor, type Harness } from '../fakes/engineHarness';
import { rawMessage, startFakeImap, type FakeImapServer } from '../fakes/fakeImapServer';

let server: FakeImapServer | null = null;
let h: Harness | null = null;

afterEach(async () => {
  await h?.cleanup();
  await server?.close().catch(() => undefined);
  h = server = null;
});

async function boot() {
  server = await startFakeImap({
    inbox: [{ raw: rawMessage({ subject: 'Old news' }) }, { raw: rawMessage({ subject: 'Older news' }) }],
  });
  h = await createHarness(server);
  const acc = await h.addAccount();
  await waitFor('synced', () => h!.inboxMessages(acc.id).length === 2);
  await waitFor('quiet', () => h!.engine.sessions.statuses()[0]?.state === 'online');
  return { h, server, acc };
}

const mails = (hh: Harness) => hh.eventsOfType('notify:newMail');

describe('new-mail notification events', () => {
  it('the first download announces nothing; later arrivals are announced once', async () => {
    const c = await boot();
    expect(mails(c.h)).toHaveLength(0);

    c.server.deliver('INBOX', { raw: rawMessage({ subject: 'Fresh mail', from: 'Bob <bob@example.com>' }) });
    await waitFor('announced', () => mails(c.h).length === 1);
    const ev = mails(c.h)[0]!;
    expect(ev.accountId).toBe(c.acc.id);
    expect(ev.messages.map((m) => m.subject)).toEqual(['Fresh mail']);
    expect(ev.messages[0]!.from?.address).toBe('bob@example.com');

    // A sync with nothing new does not announce it again.
    await c.h.engine.handle('sync.all', undefined);
    await new Promise((r) => setTimeout(r, 400));
    expect(mails(c.h)).toHaveLength(1);
  });

  it('does not announce mail that is already read, or very old mail', async () => {
    const c = await boot();
    c.server.deliver('INBOX', { raw: rawMessage({ subject: 'Already read' }), flags: ['\\Seen'] });
    c.server.deliver('INBOX', {
      raw: rawMessage({ subject: 'Ancient' }),
      internaldate: new Date(Date.now() - 3 * 3600_000),
    });
    c.server.deliver('INBOX', { raw: rawMessage({ subject: 'Counts' }) });
    await waitFor('announced', () => mails(c.h).length >= 1);
    await new Promise((r) => setTimeout(r, 400));
    const subjects = mails(c.h).flatMap((e) => e.messages.map((m) => m.subject));
    expect(subjects).toEqual(['Counts']);
  });

  it('does not announce a message we moved back into the Inbox ourselves', async () => {
    const c = await boot();
    const msg = c.h.inboxMessages(c.acc.id)[0]!;
    const res = (await c.h.engine.handle('messages.apply', {
      messageIds: [msg.id],
      action: { type: 'archive' },
    })) as { undoToken: string };
    await c.h.engine.actions.drain();
    c.h.events.length = 0;
    await c.h.engine.handle('messages.undo', { undoToken: res.undoToken });
    await c.h.engine.actions.drain();
    await c.h.engine.handle('sync.all', undefined);
    await new Promise((r) => setTimeout(r, 500));
    expect(mails(c.h)).toHaveLength(0);
    expect(c.h.inboxMessages(c.acc.id)).toHaveLength(2); // and no duplicate row
  });
});
