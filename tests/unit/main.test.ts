import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SecretStore, type SafeStorageLike } from '../../src/main/secrets/secretStore';
import { DEFAULT_SETTINGS, SettingsStore, mergeSettings } from '../../src/main/settings';
import { RpcPeer, type WireMessage } from '../../src/shared/rpcPeer';
import { makeError, toAppError, AppException } from '../../src/shared/errors';
import { schemas, isKnownChannel } from '../../src/main/ipcSchemas';
import { MAIN_CHANNELS, isMainChannel } from '../../src/shared/channels';
import { isSafeExternalUrl, isExecutableName } from '../../src/shared/safety';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'letterdock-test-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Reversible "encryption" that is NOT plaintext, so we can prove the file has no secret in clear. */
const fakeSafe = (available = true): SafeStorageLike => ({
  isEncryptionAvailable: () => available,
  encryptString: (s) =>
    Buffer.from(
      Buffer.from(s, 'utf8')
        .reverse()
        .map((b) => b ^ 0x5a),
    ),
  decryptString: (b) =>
    Buffer.from(Buffer.from(b).map((x) => x ^ 0x5a))
      .reverse()
      .toString('utf8'),
});

describe('SecretStore', () => {
  it('round-trips and never writes the secret in plaintext', async () => {
    const file = join(dir, 'secrets.bin');
    const store = new SecretStore(file, fakeSafe());
    await store.load();
    await store.set('acc-1', { password: 'hunter2-very-secret' });
    expect(readFileSync(file).includes(Buffer.from('hunter2-very-secret'))).toBe(false);
    expect(existsSync(`${file}.tmp`)).toBe(false);

    const again = new SecretStore(file, fakeSafe());
    await again.load();
    expect(again.get('acc-1')?.password).toBe('hunter2-very-secret');
    await again.delete('acc-1');
    const third = new SecretStore(file, fakeSafe());
    await third.load();
    expect(third.get('acc-1')).toBeUndefined();
  });

  it('refuses to store secrets when encryption is unavailable (no plaintext fallback)', async () => {
    const store = new SecretStore(join(dir, 's.bin'), fakeSafe(false));
    await store.load();
    await expect(store.set('a', { password: 'x' })).rejects.toBeInstanceOf(AppException);
    expect(existsSync(join(dir, 's.bin'))).toBe(false);
  });

  it('keeps a corrupt file aside and starts empty', async () => {
    const file = join(dir, 's.bin');
    writeFileSync(file, Buffer.from('garbage-not-json'));
    const store = new SecretStore(file, fakeSafe());
    await store.load();
    expect(store.get('a')).toBeUndefined();
    expect(existsSync(`${file}.corrupt`)).toBe(true);
  });

  it('serialises concurrent writes', async () => {
    const file = join(dir, 's.bin');
    const store = new SecretStore(file, fakeSafe());
    await store.load();
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => store.set(`a${i}`, { password: `p${i}` })),
    );
    const again = new SecretStore(file, fakeSafe());
    await again.load();
    for (let i = 0; i < 20; i++) expect(again.get(`a${i}`)?.password).toBe(`p${i}`);
  });
});

describe('settings', () => {
  it('merges over defaults and ignores wrongly-typed values', () => {
    const s = mergeSettings({
      theme: 'dark',
      markReadDelayMs: 'soon' as unknown as number,
      notifications: { enabled: false } as never,
    });
    expect(s.theme).toBe('dark');
    expect(s.markReadDelayMs).toBe(DEFAULT_SETTINGS.markReadDelayMs);
    expect(s.notifications).toEqual({ ...DEFAULT_SETTINGS.notifications, enabled: false });
  });

  it('persists settings and the Microsoft override; effective ID falls back to built-in', () => {
    const path = join(dir, 'settings.json');
    const a = new SettingsStore(path);
    a.set({ theme: 'light' });
    expect(a.getOAuth().microsoft.tenant).toBe('common');
    expect(a.getOAuth().microsoft.effectiveClientId).toBe(a.getOAuth().microsoft.builtInClientId);
    a.setOAuth({ microsoft: { clientIdOverride: ' my-id ', tenant: 'consumers' } });
    const b = new SettingsStore(path);
    expect(b.get().theme).toBe('light');
    expect(b.getOAuth().microsoft).toMatchObject({
      clientIdOverride: 'my-id',
      effectiveClientId: 'my-id',
      tenant: 'consumers',
    });
  });
});

describe('RpcPeer', () => {
  function pair() {
    const a: RpcPeer = new RpcPeer(
      (m) => queueMicrotask(() => b.handleMessage(m)),
      async (ch, p) => {
        if (ch === 'boom') throw new AppException('NOT_FOUND', 'nope');
        return { echoA: ch, p };
      },
    );
    const events: unknown[] = [];
    const b: RpcPeer = new RpcPeer(
      (m) => queueMicrotask(() => a.handleMessage(m)),
      async (ch, p) => ({ echoB: ch, p }),
      (e) => events.push(e),
    );
    return { a, b, events };
  }

  it('does request/response both ways and propagates AppErrors as plain objects', async () => {
    const { a, b } = pair();
    expect(await a.request('x', 1)).toEqual({ echoB: 'x', p: 1 });
    expect(await b.request('y', 2)).toEqual({ echoA: 'y', p: 2 });
    await expect(b.request('boom')).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'nope' });
  });

  it('forwards events and fails pending requests on failAll', async () => {
    const sent: WireMessage[] = [];
    const lonely = new RpcPeer(
      (m) => sent.push(m),
      async () => null,
    );
    const p = lonely.request('never');
    lonely.failAll(makeError('INTERNAL', 'engine died'));
    await expect(p).rejects.toMatchObject({ message: 'engine died' });
    const { a, events } = pair();
    a.emitEvent({ type: 'accounts:changed' });
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual([{ type: 'accounts:changed' }]);
  });

  it('times out', async () => {
    const lonely = new RpcPeer(
      () => undefined,
      async () => null,
    );
    await expect(lonely.request('slow', undefined, 10)).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('toAppError normalises unknown throwables without leaking internals as the message', () => {
    expect(toAppError(new Error('secret stack')).message).not.toContain('secret');
    expect(toAppError(new Error('x')).code).toBe('INTERNAL');
  });
});

describe('IPC schemas and channel routing', () => {
  it('validates good payloads and rejects malformed ones', () => {
    expect(schemas['accounts.list'].safeParse(undefined).success).toBe(true);
    expect(
      schemas['messages.list'].safeParse({
        scope: { kind: 'unifiedInbox' },
        cursor: null,
        limit: 50,
      }).success,
    ).toBe(true);
    expect(
      schemas['messages.list'].safeParse({ scope: { kind: 'nope' }, cursor: null, limit: 50 })
        .success,
    ).toBe(false);
    expect(
      schemas['messages.list'].safeParse({
        scope: { kind: 'unifiedInbox' },
        cursor: null,
        limit: 5000,
      }).success,
    ).toBe(false);
    expect(
      schemas['folders.create'].safeParse({ accountId: 'a', parentPath: null, name: 'X' }).success,
    ).toBe(true);
    expect(schemas['folders.rename'].safeParse({ folderId: 'x', newName: 'y' }).success).toBe(
      false,
    );
    expect(
      schemas['messages.apply'].safeParse({ messageIds: [], action: { type: 'delete' } }).success,
    ).toBe(false);
    expect(schemas['accounts.add'].safeParse({ email: 'a@b.co' }).success).toBe(false);
  });

  it('knows its channels; main-owned ones are a subset', () => {
    expect(isKnownChannel('accounts.list')).toBe(true);
    expect(isKnownChannel('constructor')).toBe(false);
    expect(isKnownChannel('__proto__')).toBe(false);
    for (const c of MAIN_CHANNELS) expect(isKnownChannel(c)).toBe(true);
    expect(isMainChannel('settings.get')).toBe(true);
    expect(isMainChannel('messages.list')).toBe(false);
  });

  it('only lets http, https and mailto URLs out; flags executables', () => {
    expect(isSafeExternalUrl('https://example.com/a?b=1')).toBe(true);
    expect(isSafeExternalUrl('mailto:a@b.co')).toBe(true);
    for (const bad of [
      'file:///C:/Windows/System32/calc.exe',
      'javascript:alert(1)',
      'ms-msdt:/x',
      'not a url',
    ]) {
      expect(isSafeExternalUrl(bad)).toBe(false);
    }
    expect(isExecutableName('Invoice.PDF.exe')).toBe(true);
    expect(isExecutableName('photo.jpg')).toBe(false);
  });
});
