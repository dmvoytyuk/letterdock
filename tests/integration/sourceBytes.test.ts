// Engine integration: the raw message for "Save as .eml" (messages.sourceBytes, main-only).
import { afterEach, describe, expect, it } from 'vitest';
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

const call = <T>(ch: string, req?: unknown) => h!.engine.handle(ch, req) as Promise<T>;

async function boot() {
  // Headers, then "Caf" + the single byte 0xE9 (Latin-1 e acute): not valid UTF-8.
  const head = rawMessage({
    subject: 'Cafe menu',
    messageId: '<eml@x>',
    from: 'Anna <anna@example.com>',
  }).replace(/\r?\n\r?\n[\s\S]*$/, '\r\n\r\n');
  const body = Buffer.concat([
    Buffer.from(head),
    Buffer.from([0x43, 0x61, 0x66, 0xe9, 0x0d, 0x0a]),
  ]);
  server = await startFakeImap({ inbox: [{ raw: body.toString('latin1') }] });
  h = await createHarness(server);
  const acc = await h.addAccount();
  await waitFor('synced', () => h!.inboxMessages(acc.id).length === 1);
  await waitForInboxCursors(h, [acc.id]);
  await waitFor('online', () => h!.engine.sessions.statuses()[0]?.state === 'online');
  return { acc, body, id: h.inboxMessages(acc.id)[0]!.id };
}

describe('messages.sourceBytes', () => {
  it('returns the exact bytes of the message and its subject', async () => {
    const c = await boot();
    const res = await call<{ data: Uint8Array; subject: string }>('messages.sourceBytes', {
      messageId: c.id,
    });
    expect(res.subject).toContain('menu');
    expect(res.data).toBeInstanceOf(Uint8Array);
    const got = Buffer.from(res.data);
    // The 8-bit byte survived (a text round trip would have turned it into U+FFFD).
    expect(got.includes(Buffer.from([0x43, 0x61, 0x66, 0xe9]))).toBe(true);
    expect(got.includes(Buffer.from('�'))).toBe(false);
    expect(got.toString('latin1')).toContain('Message-ID: <eml@x>');
  });

  it('offline: refuses with HOST_UNREACHABLE and a plain message', async () => {
    const c = await boot();
    await call('system.networkChanged', { online: false });
    await waitFor('offline', () => h!.engine.sessions.statuses()[0]?.state === 'offline');
    await expect(call('messages.sourceBytes', { messageId: c.id })).rejects.toMatchObject({
      appError: { code: 'HOST_UNREACHABLE', message: expect.stringContaining('offline') as string },
    });
  });

  it('offline after the message was opened: the stored raw bytes are returned unchanged', async () => {
    const c = await boot();
    await call('messages.get', { messageId: c.id });
    await call('system.networkChanged', { online: false });
    await waitFor('offline', () => h!.engine.sessions.statuses()[0]?.state === 'offline');
    const res = await call<{ data: Uint8Array }>('messages.sourceBytes', { messageId: c.id });
    expect(Buffer.from(res.data).equals(c.body)).toBe(true);
    const src = await call<{ source: string }>('messages.rawSource', { messageId: c.id });
    expect(src.source).toContain('Message-ID: <eml@x>');
  });

  it('unknown message: NOT_FOUND', async () => {
    await boot();
    await expect(call('messages.sourceBytes', { messageId: 999999 })).rejects.toMatchObject({
      appError: { code: 'NOT_FOUND' },
    });
  });
});
