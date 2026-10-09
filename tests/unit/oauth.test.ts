// Sign in with Microsoft: PKCE, loopback flow, token endpoint errors, refresh and rotation.
// The token endpoint is a mocked fetch; the browser is simulated with a real request to the
// loopback port. Nothing leaves this machine.
import { describe, expect, it, vi } from 'vitest';
import { challengeFor, generateVerifier } from '../../src/main/oauth/pkce';
import {
  MicrosoftOAuth,
  MS_SCOPE,
  decodeJwtPayload,
  mapTokenError,
  isValidTenant,
  type MicrosoftOAuthDeps,
} from '../../src/main/oauth/microsoft';
import { TokenManager, REFRESH_MARGIN_MS } from '../../src/main/oauth/tokenManager';
import { OAuthService } from '../../src/main/oauth/service';
import { createEngineBridge } from '../../src/main/engineBridge';
import { SettingsStore } from '../../src/main/settings';
import type { SecretRecord } from '../../src/shared/internal';
import type { Account } from '../../src/shared/ipc';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLIENT = '11111111-2222-3333-4444-555555555555';

function jwt(claims: Record<string, unknown>): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({ alg: 'none' })}.${enc(claims)}.sig`;
}

interface Call {
  url: string;
  body: URLSearchParams;
}

function mockFetch(
  responder: (call: Call) => { status?: number; json: unknown } | Error,
): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const f = async (input: unknown, init?: { body?: string }) => {
    const call = { url: String(input), body: new URLSearchParams(init?.body ?? '') };
    calls.push(call);
    const r = responder(call);
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.json), {
      status: r.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return { fetch: f as unknown as typeof fetch, calls };
}

function makeMs(over: Partial<MicrosoftOAuthDeps> = {}, authCode = 'the-code') {
  const opened: string[] = [];
  let nonce = '';
  const m = mockFetch((call) => {
    if (call.body.get('grant_type') === 'authorization_code') {
      return {
        json: {
          access_token: 'AT1',
          refresh_token: 'RT1',
          expires_in: 3600,
          id_token: jwt({ aud: CLIENT, email: 'Me@Outlook.com', nonce }),
        },
      };
    }
    return { json: { access_token: 'AT2', refresh_token: 'RT2', expires_in: 3600 } };
  });
  const ms = new MicrosoftOAuth({
    clientId: () => CLIENT,
    tenant: () => 'common',
    openExternal: async (u) => {
      opened.push(u);
      nonce = new URL(u).searchParams.get('nonce') ?? '';
    },
    fetch: m.fetch,
    ...over,
  });
  /** Pretend to be the browser being redirected back. */
  const browser = async (authUrl: string, extra: Record<string, string> = {}) => {
    const u = new URL(authUrl);
    const redirect = new URL(u.searchParams.get('redirect_uri')!);
    const url = new URL(`http://127.0.0.1:${redirect.port}/`);
    url.searchParams.set('code', authCode);
    url.searchParams.set('state', u.searchParams.get('state')!);
    for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, v);
    return fetch(url);
  };
  return { ms, opened, calls: m.calls, browser };
}

describe('PKCE', () => {
  it('matches the RFC 7636 test vector', () => {
    expect(challengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });
  it('verifiers are 43 url-safe characters and differ each time', () => {
    const a = generateVerifier();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateVerifier()).not.toBe(a);
  });
});

describe('helpers', () => {
  it('decodes JWT claims and validates tenants', () => {
    expect(decodeJwtPayload(jwt({ a: 1 }))).toEqual({ a: 1 });
    expect(decodeJwtPayload('nope')).toBeNull();
    for (const ok of ['common', 'consumers', 'organizations', 'contoso.onmicrosoft.com', '9188040d-6c67-4c5b-b112-36a304b66dad']) {
      expect(isValidTenant(ok)).toBe(true);
    }
    for (const bad of ['', 'a/b', '../x', 'a b', 'x?y=1', '.hidden']) expect(isValidTenant(bad)).toBe(false);
  });

  it('maps token errors to app error codes', () => {
    expect(mapTokenError(400, { error: 'invalid_grant' }).appError.code).toBe('OAUTH_REAUTH_REQUIRED');
    expect(mapTokenError(400, { error: 'interaction_required' }).appError.code).toBe('OAUTH_REAUTH_REQUIRED');
    expect(mapTokenError(400, { error: 'invalid_client', error_description: 'AADSTS700016: x' }).appError.code).toBe('OAUTH_NOT_CONFIGURED');
    expect(mapTokenError(400, { error: 'invalid_request', error_description: 'AADSTS50020: user from other tenant' }).appError.code).toBe('OAUTH_NOT_CONFIGURED');
    const busy = mapTokenError(503, {});
    expect(busy.appError.code).toBe('HOST_UNREACHABLE');
    expect(busy.appError.retryable).toBe(true);
    expect(mapTokenError(400, null).appError.code).toBe('INTERNAL');
  });
});

describe('MicrosoftOAuth.start / complete', () => {
  it('builds the authorize URL (PKCE S256, full Outlook scopes, loopback redirect) and opens the browser', async () => {
    const { ms, opened } = makeMs();
    const { sessionId, authUrl } = await ms.start('me@outlook.com');
    expect(opened).toEqual([authUrl]);
    const u = new URL(authUrl);
    expect(u.origin + u.pathname).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
    const p = u.searchParams;
    expect(p.get('client_id')).toBe(CLIENT);
    expect(p.get('response_type')).toBe('code');
    expect(p.get('scope')).toBe(MS_SCOPE);
    expect(p.get('scope')).toContain('https://outlook.office.com/IMAP.AccessAsUser.All');
    expect(p.get('scope')).toContain('https://outlook.office.com/SMTP.Send');
    expect(p.get('scope')).toContain('offline_access');
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(p.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(p.get('redirect_uri')).toMatch(/^http:\/\/localhost:\d+$/);
    expect(p.get('login_hint')).toBe('me@outlook.com');
    expect(p.get('state')!.length).toBeGreaterThan(20);
    ms.cancel(sessionId);
  });

  it('exchanges the code with the verifier and reads the address from the id_token', async () => {
    const { ms, calls, browser } = makeMs();
    const { sessionId, authUrl } = await ms.start();
    const challenge = new URL(authUrl).searchParams.get('code_challenge')!;
    expect(new URL(authUrl).searchParams.get('prompt')).toBe('select_account');

    const done = ms.complete(sessionId);
    const res = await browser(authUrl);
    expect(res.status).toBe(200);
    const info = await done;
    expect(info).toMatchObject({ email: 'Me@Outlook.com', sessionId, accessToken: 'AT1' });

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/token');
    expect(call.body.get('grant_type')).toBe('authorization_code');
    expect(call.body.get('code')).toBe('the-code');
    expect(call.body.get('client_id')).toBe(CLIENT);
    expect(call.body.get('client_secret')).toBeNull(); // public client
    expect(call.body.get('scope')).toBe(MS_SCOPE);
    expect(call.body.get('redirect_uri')).toBe(new URL(authUrl).searchParams.get('redirect_uri'));
    expect(challengeFor(call.body.get('code_verifier')!)).toBe(challenge);

    expect(ms.peek(sessionId)).toMatchObject({ email: 'Me@Outlook.com', accessToken: 'AT1' });
    const taken = ms.take(sessionId);
    expect(taken.refreshToken).toBe('RT1');
    expect(() => ms.peek(sessionId)).toThrow();
  });

  it('ignores a callback with the wrong state and keeps waiting', async () => {
    const { ms, browser } = makeMs();
    const { sessionId, authUrl } = await ms.start();
    const done = ms.complete(sessionId);
    const bad = await browser(authUrl, { state: 'forged' });
    expect(bad.status).toBe(400);
    const stray = await fetch(`http://127.0.0.1:${new URL(new URL(authUrl).searchParams.get('redirect_uri')!).port}/favicon.ico`);
    expect(stray.status).toBe(404);
    await browser(authUrl);
    await expect(done).resolves.toMatchObject({ email: 'Me@Outlook.com' });
  });

  it('reports a cancelled sign-in as CANCELLED', async () => {
    const { ms, browser } = makeMs();
    const { sessionId, authUrl } = await ms.start();
    const done = ms.complete(sessionId);
    await browser(authUrl, { error: 'access_denied', error_description: 'user said no' });
    await expect(done).rejects.toMatchObject({ appError: { code: 'CANCELLED' } });
    expect(() => ms.peek(sessionId)).toThrow();
  });

  it('times out when the user never comes back', async () => {
    const { ms } = makeMs({ loginTimeoutMs: 40 });
    const { sessionId } = await ms.start();
    await expect(ms.complete(sessionId)).rejects.toMatchObject({ appError: { code: 'TIMEOUT' } });
  });

  it('cancel() frees the port and fails a pending complete()', async () => {
    const { ms } = makeMs();
    const { sessionId, authUrl } = await ms.start();
    const port = new URL(new URL(authUrl).searchParams.get('redirect_uri')!).port;
    const done = ms.complete(sessionId);
    ms.cancel(sessionId);
    await expect(done).rejects.toMatchObject({ appError: { code: 'CANCELLED' } });
    await new Promise((r) => setTimeout(r, 400));
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
  });

  it('refuses without a client ID, with a bad tenant, and for an id_token meant for another app', async () => {
    const none = makeMs({ clientId: () => null });
    await expect(none.ms.start()).rejects.toMatchObject({ appError: { code: 'OAUTH_NOT_CONFIGURED' } });
    const badTenant = makeMs({ tenant: () => '../evil' });
    await expect(badTenant.ms.start()).rejects.toMatchObject({ appError: { code: 'INVALID_INPUT' } });

    const wrongAud = makeMs({
      fetch: mockFetch(() => ({
        json: { access_token: 'a', refresh_token: 'r', expires_in: 1, id_token: jwt({ aud: 'other', email: 'x@y.com' }) },
      })).fetch,
    });
    const { sessionId, authUrl } = await wrongAud.ms.start();
    const done = wrongAud.ms.complete(sessionId);
    await wrongAud.browser(authUrl);
    await expect(done).rejects.toMatchObject({ appError: { code: 'INTERNAL' } });
  });

  it('uses the configured tenant in the endpoints', async () => {
    const { ms, calls, browser } = makeMs({ tenant: () => 'contoso.onmicrosoft.com' });
    const { sessionId, authUrl } = await ms.start();
    expect(authUrl).toContain('/contoso.onmicrosoft.com/oauth2/v2.0/authorize');
    const done = ms.complete(sessionId);
    await browser(authUrl);
    await done;
    expect(calls[0]!.url).toContain('/contoso.onmicrosoft.com/oauth2/v2.0/token');
  });

  it('surfaces a token endpoint error from the code exchange', async () => {
    const { ms, browser } = makeMs({
      fetch: mockFetch(() => ({ status: 400, json: { error: 'invalid_grant', error_description: 'AADSTS70008: expired' } })).fetch,
    });
    const { sessionId, authUrl } = await ms.start();
    const done = ms.complete(sessionId);
    await browser(authUrl);
    await expect(done).rejects.toMatchObject({ appError: { code: 'OAUTH_REAUTH_REQUIRED' } });
  });
});

// ---------------- token manager ----------------

function memStore(initial: Record<string, SecretRecord> = {}) {
  const data: Record<string, SecretRecord> = { ...initial };
  return {
    data,
    get: (k: string) => data[k],
    set: async (k: string, v: SecretRecord) => {
      data[k] = { ...(data[k] ?? {}), ...v };
    },
  };
}

describe('TokenManager', () => {
  const T0 = 1_000_000_000;

  it('returns the cached token while it is valid, without calling Microsoft', async () => {
    const store = memStore({ a: { refreshToken: 'R', accessToken: 'AT', accessExpiresAt: T0 + 10 * 60_000 } });
    const refresh = vi.fn();
    const tm = new TokenManager(store, { refresh }, () => T0);
    await expect(tm.getCredential('a')).resolves.toEqual({ kind: 'oauth', accessToken: 'AT', expiresAt: T0 + 600_000 });
    expect(refresh).not.toHaveBeenCalled();
  });

  it('refreshes inside the margin and saves the rotated refresh token', async () => {
    const store = memStore({ a: { refreshToken: 'R1', accessToken: 'old', accessExpiresAt: T0 + REFRESH_MARGIN_MS - 1000 } });
    const refresh = vi.fn(async () => ({ accessToken: 'new', refreshToken: 'R2', expiresAt: T0 + 3_600_000, idToken: undefined }));
    const tm = new TokenManager(store, { refresh }, () => T0);
    const cred = await tm.getCredential('a');
    expect(cred).toMatchObject({ accessToken: 'new' });
    expect(refresh).toHaveBeenCalledWith('R1');
    expect(store.data.a).toMatchObject({ refreshToken: 'R2', accessToken: 'new', accessExpiresAt: T0 + 3_600_000 });
  });

  it('keeps the old refresh token when none is sent back', async () => {
    const store = memStore({ a: { refreshToken: 'R1' } });
    const tm = new TokenManager(store, { refresh: async () => ({ accessToken: 'n', refreshToken: undefined, expiresAt: T0 + 1000_000, idToken: undefined }) }, () => T0);
    await tm.getCredential('a');
    expect(store.data.a!.refreshToken).toBe('R1');
  });

  it('shares one refresh between simultaneous callers', async () => {
    const store = memStore({ a: { refreshToken: 'R1' } });
    const refresh = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return { accessToken: 'n', refreshToken: 'R2', expiresAt: T0 + 3_600_000, idToken: undefined };
    });
    const tm = new TokenManager(store, { refresh }, () => T0);
    const results = await Promise.all([tm.getCredential('a'), tm.getCredential('a'), tm.getCredential('a')]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(new Set(results.map((r) => (r.kind === 'oauth' ? r.accessToken : ''))).size).toBe(1);
  });

  it('forceRefresh ignores a valid cached token', async () => {
    const store = memStore({ a: { refreshToken: 'R', accessToken: 'AT', accessExpiresAt: T0 + 3_000_000 } });
    const refresh = vi.fn(async () => ({ accessToken: 'fresh', refreshToken: 'R', expiresAt: T0 + 3_600_000, idToken: undefined }));
    const tm = new TokenManager(store, { refresh }, () => T0);
    await expect(tm.getCredential('a', true)).resolves.toMatchObject({ accessToken: 'fresh' });
  });

  it('invalid_grant: OAUTH_REAUTH_REQUIRED, access token dropped, callback fired', async () => {
    const store = memStore({ a: { refreshToken: 'dead', accessToken: 'AT', accessExpiresAt: T0 + 10 } });
    const needed = vi.fn();
    const err = mapTokenError(400, { error: 'invalid_grant' });
    const tm = new TokenManager(store, { refresh: async () => { throw err; } }, () => T0, needed);
    await expect(tm.getCredential('a')).rejects.toMatchObject({ appError: { code: 'OAUTH_REAUTH_REQUIRED' } });
    expect(needed).toHaveBeenCalledWith('a');
    expect(store.data.a!.accessToken).toBe('');
  });

  it('Microsoft unreachable: a still-valid old token is used, otherwise a retryable error', async () => {
    const down = mapTokenError(503, {});
    const valid = memStore({ a: { refreshToken: 'R', accessToken: 'AT', accessExpiresAt: T0 + 30_000 } });
    const tm1 = new TokenManager(valid, { refresh: async () => { throw down; } }, () => T0);
    await expect(tm1.getCredential('a')).resolves.toMatchObject({ accessToken: 'AT' });

    const expired = memStore({ a: { refreshToken: 'R', accessToken: 'AT', accessExpiresAt: T0 - 1 } });
    const tm2 = new TokenManager(expired, { refresh: async () => { throw down; } }, () => T0);
    await expect(tm2.getCredential('a')).rejects.toMatchObject({ appError: { code: 'HOST_UNREACHABLE', retryable: true } });
  });

  it('an account without a refresh token must sign in again', async () => {
    const tm = new TokenManager(memStore(), { refresh: vi.fn() }, () => T0);
    expect(tm.isOAuth('x')).toBe(false);
    await expect(tm.getCredential('x')).rejects.toMatchObject({ appError: { code: 'OAUTH_REAUTH_REQUIRED' } });
  });
});

// ---------------- service + engine bridge ----------------

const account = (over: Partial<Account> = {}): Account => ({
  id: 'acc1',
  email: 'me@outlook.com',
  displayName: 'Me',
  color: null,
  provider: 'outlook',
  authType: 'oauth2',
  oauthProvider: 'microsoft',
  imap: { host: 'outlook.office365.com', port: 993, security: 'ssl' },
  smtp: { host: 'smtp-mail.outlook.com', port: 587, security: 'starttls' },
  username: 'me@outlook.com',
  syncDays: 90,
  signature: null,
  enabled: true,
  sortOrder: 0,
  badge: 'M',
  ...over,
});

describe('OAuthService', () => {
  function setup(acc: Account, mail = 'Me@Outlook.com') {
    const store = memStore();
    const { fetch: f } = mockFetch((call) =>
      call.body.get('grant_type') === 'authorization_code'
        ? { json: { access_token: 'AT', refresh_token: 'RT', expires_in: 3600, id_token: jwt({ aud: CLIENT, email: mail }) } }
        : { json: {} },
    );
    const { ms, browser } = makeMs({ fetch: f });
    const reconnect = vi.fn(async () => undefined);
    const svc = new OAuthService({
      microsoft: ms,
      tokens: new TokenManager(store, ms),
      getAccount: async (id) => (id === acc.id ? acc : null),
      reconnect,
    });
    return { svc, store, reconnect, browser, ms };
  }

  it('rejects other providers (Google is deferred)', () => {
    const { svc } = setup(account());
    expect(() => svc.start({ provider: 'google' })).toThrow(/Only Sign in with Microsoft/);
  });

  it('adoptSession stores the tokens under the account and consumes the session', async () => {
    const { svc, store, browser } = setup(account());
    const { sessionId, authUrl } = await svc.start({ provider: 'microsoft' });
    const done = svc.complete({ sessionId });
    await browser(authUrl);
    await done;
    expect(svc.peekSession(sessionId).email).toBe('Me@Outlook.com');
    const info = await svc.adoptSession(sessionId, 'newacc');
    expect(info.accessToken).toBe('AT');
    expect(store.data.newacc).toMatchObject({ refreshToken: 'RT', accessToken: 'AT', oauthProvider: 'microsoft' });
    expect(() => svc.peekSession(sessionId)).toThrow();
  });

  it('reauthorize: signs in again, swaps the tokens and reconnects the account', async () => {
    const a = account();
    const { svc, store, reconnect, browser, ms } = setup(a);
    const origStart = ms.start.bind(ms);
    let hint: string | undefined;
    ms.start = async (h) => {
      hint = h;
      const r = await origStart(h);
      setTimeout(() => void browser(r.authUrl), 10); // the user approves in the browser
      return r;
    };
    await svc.reauthorize({ accountId: a.id });
    expect(hint).toBe(a.email);
    expect(store.data[a.id]).toMatchObject({ refreshToken: 'RT' });
    expect(reconnect).toHaveBeenCalledWith(a.id);
  });

  it('reauthorize refuses a different mailbox', async () => {
    const a = account();
    const { svc, store, reconnect, browser, ms } = setup(a, 'someone@else.com');
    const origStart = ms.start.bind(ms);
    ms.start = async (h) => {
      const r = await origStart(h);
      setTimeout(() => void browser(r.authUrl), 10);
      return r;
    };
    await expect(svc.reauthorize({ accountId: a.id })).rejects.toMatchObject({ appError: { code: 'INVALID_INPUT' } });
    expect(store.data[a.id]).toBeUndefined();
    expect(reconnect).not.toHaveBeenCalled();
  });

  it('reauthorize only works for OAuth accounts', async () => {
    const { svc } = setup(account({ authType: 'password', oauthProvider: null }));
    await expect(svc.reauthorize({ accountId: 'acc1' })).rejects.toMatchObject({ appError: { code: 'INVALID_INPUT' } });
  });
});

describe('engine bridge', () => {
  it('serves OAuth accounts from the token manager and password accounts from the store', async () => {
    const store = memStore({
      o: { refreshToken: 'R', accessToken: 'AT', accessExpiresAt: Date.now() + 3_600_000 },
      p: { password: 'secret' },
    });
    const tokens = new TokenManager(store, { refresh: vi.fn() });
    const bridge = createEngineBridge({
      secrets: { get: store.get, set: store.set, delete: async () => undefined },
      tokens,
      oauth: {} as never,
    });
    await expect(bridge('secrets.getCredential', { accountId: 'o' })).resolves.toMatchObject({ kind: 'oauth', accessToken: 'AT' });
    await expect(bridge('secrets.getCredential', { accountId: 'p' })).resolves.toEqual({ kind: 'password', password: 'secret' });
    await expect(bridge('secrets.getCredential', { accountId: 'zz' })).rejects.toMatchObject({ appError: { code: 'AUTH_FAILED' } });
  });
});

describe('settings validation', () => {
  it('rejects a tenant or client ID that could break the URL', () => {
    const s = new SettingsStore(join(mkdtempSync(join(tmpdir(), 'mr-')), 'settings.json'));
    expect(() => s.setOAuth({ microsoft: { clientIdOverride: '', tenant: 'a/b' } })).toThrow();
    expect(() => s.setOAuth({ microsoft: { clientIdOverride: 'x y&z', tenant: 'common' } })).toThrow();
    const ok = s.setOAuth({ microsoft: { clientIdOverride: CLIENT, tenant: ' consumers ' } });
    expect(ok.microsoft).toMatchObject({ clientIdOverride: CLIENT, effectiveClientId: CLIENT, tenant: 'consumers' });
  });
});
