// Sign in with Microsoft: OAuth 2.0 authorization code flow with PKCE (public client, no secret),
// loopback redirect, system browser (ARCHITECTURE 5.3, Appendix A).
// Scopes use the full Outlook resource URLs (Microsoft's IMAP/SMTP OAuth documentation).
import { AppException } from '../../shared/errors';
import type { OAuthSessionInfo } from '../../shared/internal';
import { startLoopback, type Loopback } from './loopback';
import { challengeFor, generateVerifier, randomToken } from './pkce';

export const MS_SCOPES = [
  'https://outlook.office.com/IMAP.AccessAsUser.All',
  'https://outlook.office.com/SMTP.Send',
  'offline_access',
  'openid',
  'email',
  'profile',
] as const;
export const MS_SCOPE = MS_SCOPES.join(' ');

const DEFAULT_AUTHORITY = 'https://login.microsoftonline.com';
const SESSION_TTL_MS = 15 * 60_000;

export interface TokenSet {
  accessToken: string;
  /** Microsoft may rotate it; undefined only if the server did not send a new one. */
  refreshToken: string | undefined;
  expiresAt: number;
  idToken: string | undefined;
}

export interface MicrosoftOAuthDeps {
  /** Effective client ID (override or built-in), or null if none is configured. */
  clientId: () => string | null;
  tenant: () => string;
  openExternal: (url: string) => Promise<void>;
  fetch?: typeof fetch;
  now?: () => number;
  /** Base URL of the sign-in server. Tests point this at a local mock. */
  authority?: string;
  /** How long to wait for the user in the browser. */
  loginTimeoutMs?: number;
}

interface Session {
  id: string;
  verifier: string;
  state: string;
  nonce: string;
  redirectUri: string;
  clientId: string;
  tenant: string;
  loopback: Loopback;
  createdAt: number;
  /** Set once complete() has exchanged the code. */
  tokens?: TokenSet & { email: string };
  completing?: Promise<OAuthSessionInfo & { sessionId: string }>;
}

export function isValidTenant(t: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/.test(t);
}

/** Read the claims of a JWT. No signature check: it came straight from the token endpoint over TLS. */
export function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  const part = jwt.split('.')[1];
  if (!part) return null;
  try {
    return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

/** Map a token endpoint error to our error codes. */
export function mapTokenError(status: number, body: unknown): AppException {
  const b = (body ?? {}) as { error?: string; error_description?: string };
  const code = b.error ?? '';
  const desc = (b.error_description ?? '').split('\r\n')[0]!.slice(0, 400);
  const details = `${status} ${code}: ${desc}`;
  if (code === 'invalid_grant' || code === 'interaction_required' || code === 'consent_required') {
    return new AppException(
      'OAUTH_REAUTH_REQUIRED',
      'Your Microsoft sign-in has expired or was revoked. Sign in again.',
      { details },
    );
  }
  if (code === 'invalid_client' || code === 'unauthorized_client' || /AADSTS(700016|50020|700025)/.test(desc)) {
    return new AppException(
      'OAUTH_NOT_CONFIGURED',
      'This kind of Microsoft account is not allowed by the sign-in app. Check the client ID and the tenant in Settings.',
      { details },
    );
  }
  if (code === 'invalid_scope') {
    return new AppException(
      'OAUTH_NOT_CONFIGURED',
      'The sign-in app does not have permission for mail access. Check its API permissions.',
      { details },
    );
  }
  if (status >= 500 || status === 429) {
    return new AppException('HOST_UNREACHABLE', 'Microsoft sign-in is not available right now.', {
      retryable: true,
      details,
    });
  }
  return new AppException('INTERNAL', 'Microsoft sign-in failed.', { details });
}

export class MicrosoftOAuth {
  private sessions = new Map<string, Session>();
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly deps: MicrosoftOAuthDeps) {
    this.fetchFn = deps.fetch ?? fetch;
    this.now = deps.now ?? (() => Date.now());
  }

  private endpoint(tenant: string, path: 'authorize' | 'token'): string {
    return `${this.deps.authority ?? DEFAULT_AUTHORITY}/${encodeURIComponent(tenant)}/oauth2/v2.0/${path}`;
  }

  private requireClient(): { clientId: string; tenant: string } {
    const clientId = this.deps.clientId();
    if (!clientId) {
      throw new AppException(
        'OAUTH_NOT_CONFIGURED',
        'Sign in with Microsoft is not set up in this build. Add a client ID in Settings, under Sign-in keys.',
      );
    }
    const tenant = this.deps.tenant();
    if (!isValidTenant(tenant)) {
      throw new AppException('INVALID_INPUT', 'The tenant in Settings is not valid.');
    }
    return { clientId, tenant };
  }

  private sweep(): void {
    const now = this.now();
    for (const [id, s] of this.sessions) {
      if (now - s.createdAt > SESSION_TTL_MS) {
        s.loopback.close();
        this.sessions.delete(id);
      }
    }
  }

  /** Step 1: listen on a loopback port, open the browser. */
  async start(loginHint?: string): Promise<{ sessionId: string; authUrl: string }> {
    this.sweep();
    const { clientId, tenant } = this.requireClient();
    const state = randomToken(24);
    const nonce = randomToken(24);
    const verifier = generateVerifier();
    const loopback = await startLoopback({
      expectedState: state,
      timeoutMs: this.deps.loginTimeoutMs ?? 5 * 60_000,
    });
    // Microsoft ignores the port of a registered http://localhost redirect (public clients).
    const redirectUri = `http://localhost:${loopback.port}`;
    const params = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      response_mode: 'query',
      scope: MS_SCOPE,
      state,
      nonce,
      code_challenge: challengeFor(verifier),
      code_challenge_method: 'S256',
    });
    if (loginHint) params.set('login_hint', loginHint);
    else params.set('prompt', 'select_account');
    const authUrl = `${this.endpoint(tenant, 'authorize')}?${params.toString()}`;

    const id = randomToken(18);
    this.sessions.set(id, {
      id,
      verifier,
      state,
      nonce,
      redirectUri,
      clientId,
      tenant,
      loopback,
      createdAt: this.now(),
    });
    try {
      await this.deps.openExternal(authUrl);
    } catch (e) {
      this.cancel(id);
      throw new AppException('INTERNAL', 'Could not open your web browser.', { details: String(e) });
    }
    return { sessionId: id, authUrl };
  }

  /** Step 2: wait for the browser redirect, exchange the code, learn the address. */
  complete(sessionId: string): Promise<OAuthSessionInfo & { sessionId: string }> {
    const s = this.sessions.get(sessionId);
    if (!s) return Promise.reject(new AppException('NOT_FOUND', 'This sign-in is no longer active. Start again.'));
    if (!s.completing) {
      s.completing = this.finish(s).catch((e) => {
        this.cancel(sessionId);
        throw e;
      });
      // The caller may not be awaiting yet when it fails (e.g. the user closed the browser tab).
      s.completing.catch(() => undefined);
    }
    return s.completing;
  }

  private async finish(s: Session): Promise<OAuthSessionInfo & { sessionId: string }> {
    const { code } = await s.loopback.result;
    const body = new URLSearchParams({
      client_id: s.clientId,
      grant_type: 'authorization_code',
      code,
      redirect_uri: s.redirectUri,
      code_verifier: s.verifier,
      scope: MS_SCOPE,
    });
    const tokens = await this.tokenRequest(s.tenant, body);
    if (!tokens.refreshToken) {
      throw new AppException(
        'OAUTH_NOT_CONFIGURED',
        'Microsoft did not allow staying signed in (offline access). Check the app permissions.',
      );
    }
    const claims = tokens.idToken ? decodeJwtPayload(tokens.idToken) : null;
    if (!claims) throw new AppException('INTERNAL', 'Microsoft did not say who signed in.');
    const aud = claims.aud;
    if (aud !== s.clientId) {
      throw new AppException('INTERNAL', 'The sign-in answer was meant for a different app.');
    }
    if (claims.nonce !== undefined && claims.nonce !== s.nonce) {
      throw new AppException('INTERNAL', 'The sign-in answer did not match the request.');
    }
    const email = [claims.email, claims.preferred_username, claims.upn].find(
      (v): v is string => typeof v === 'string' && v.includes('@'),
    );
    if (!email) throw new AppException('INTERNAL', 'Microsoft did not say which address signed in.');
    s.tokens = { ...tokens, email };
    return { sessionId: s.id, email, accessToken: tokens.accessToken, expiresAt: tokens.expiresAt };
  }

  /** The tokens of a finished sign-in, without consuming it. */
  peek(sessionId: string): OAuthSessionInfo {
    const t = this.sessions.get(sessionId)?.tokens;
    if (!t) throw new AppException('NOT_FOUND', 'Sign in with Microsoft first.');
    return { email: t.email, accessToken: t.accessToken, expiresAt: t.expiresAt };
  }

  /** Hand the tokens over (once) and forget the session. */
  take(sessionId: string): TokenSet & { email: string } {
    const s = this.sessions.get(sessionId);
    if (!s?.tokens) throw new AppException('NOT_FOUND', 'Sign in with Microsoft first.');
    this.sessions.delete(sessionId);
    s.loopback.close();
    return s.tokens;
  }

  cancel(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    this.sessions.delete(sessionId);
    s.loopback.close();
  }

  /** Get a new access token. Throws OAUTH_REAUTH_REQUIRED when the refresh token is dead. */
  async refresh(refreshToken: string): Promise<TokenSet> {
    const { clientId, tenant } = this.requireClient();
    const body = new URLSearchParams({
      client_id: clientId,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      scope: MS_SCOPE,
    });
    return this.tokenRequest(tenant, body);
  }

  private async tokenRequest(tenant: string, body: URLSearchParams): Promise<TokenSet> {
    let res: Response;
    try {
      res = await this.fetchFn(this.endpoint(tenant, 'token'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: body.toString(),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (e) {
      throw new AppException('HOST_UNREACHABLE', 'Could not reach Microsoft sign-in. Check your internet connection.', {
        retryable: true,
        details: String((e as Error)?.message ?? e),
      });
    }
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      /* not JSON */
    }
    if (!res.ok) throw mapTokenError(res.status, json);
    const j = json as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number | string;
      id_token?: string;
    };
    if (!j?.access_token) throw new AppException('INTERNAL', 'Microsoft sign-in returned no access token.');
    const expiresIn = Number(j.expires_in ?? 3600);
    return {
      accessToken: j.access_token,
      refreshToken: j.refresh_token,
      expiresAt: this.now() + (Number.isFinite(expiresIn) ? expiresIn : 3600) * 1000,
      idToken: j.id_token,
    };
  }
}
