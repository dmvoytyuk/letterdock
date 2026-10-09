// Gives the engine a valid access token for an OAuth account, refreshing when it is about to expire
// and saving the (possibly rotated) refresh token.
import { AppException, isAppError } from '../../shared/errors';
import type { Credential } from '../../shared/internal';
import type { SecretStore } from '../secrets/secretStore';
import type { MicrosoftOAuth, TokenSet } from './microsoft';

/** Refresh when fewer than this many ms remain (ARCHITECTURE 5.1: 120 s). */
export const REFRESH_MARGIN_MS = 120_000;

export interface TokenStore {
  get: SecretStore['get'];
  set: SecretStore['set'];
}

export class TokenManager {
  private refreshing = new Map<string, Promise<Credential>>();

  constructor(
    private readonly store: TokenStore,
    private readonly oauth: Pick<MicrosoftOAuth, 'refresh'>,
    private readonly now: () => number = () => Date.now(),
    private readonly onReauthNeeded: (accountId: string) => void = () => undefined,
  ) {}

  /** True if this account signs in with OAuth (it has a stored refresh token). */
  isOAuth(accountId: string): boolean {
    return !!this.store.get(accountId)?.refreshToken;
  }

  async getCredential(accountId: string, forceRefresh = false): Promise<Credential> {
    const rec = this.store.get(accountId);
    if (!rec?.refreshToken) {
      throw new AppException('OAUTH_REAUTH_REQUIRED', 'Sign in with Microsoft again.');
    }
    if (
      !forceRefresh &&
      rec.accessToken &&
      rec.accessExpiresAt !== undefined &&
      rec.accessExpiresAt - this.now() > REFRESH_MARGIN_MS
    ) {
      return { kind: 'oauth', accessToken: rec.accessToken, expiresAt: rec.accessExpiresAt };
    }
    // Several connections ask at once: share one refresh request per account.
    let p = this.refreshing.get(accountId);
    if (!p) {
      p = this.refresh(accountId, rec.refreshToken).finally(() => this.refreshing.delete(accountId));
      this.refreshing.set(accountId, p);
    }
    return p;
  }

  private async refresh(accountId: string, refreshToken: string): Promise<Credential> {
    let tokens: TokenSet;
    try {
      tokens = await this.oauth.refresh(refreshToken);
    } catch (e) {
      const rec = this.store.get(accountId);
      if (isAppError(e) || e instanceof AppException) {
        const err = e instanceof AppException ? e.appError : (e as { code: string });
        if (err.code === 'OAUTH_REAUTH_REQUIRED') {
          // The refresh token is dead: forget the access token so nothing keeps using it.
          await this.store.set(accountId, { accessToken: '', accessExpiresAt: 0 });
          this.onReauthNeeded(accountId);
        } else if (
          rec?.accessToken &&
          rec.accessExpiresAt !== undefined &&
          rec.accessExpiresAt > this.now() &&
          (err.code === 'HOST_UNREACHABLE' || err.code === 'TIMEOUT')
        ) {
          // Microsoft is unreachable but the old token still works for a moment.
          return { kind: 'oauth', accessToken: rec.accessToken, expiresAt: rec.accessExpiresAt };
        }
      }
      throw e;
    }
    await this.store.set(accountId, {
      accessToken: tokens.accessToken,
      accessExpiresAt: tokens.expiresAt,
      // Microsoft rotates refresh tokens: always keep the newest one.
      refreshToken: tokens.refreshToken ?? refreshToken,
    });
    return { kind: 'oauth', accessToken: tokens.accessToken, expiresAt: tokens.expiresAt };
  }

  /** Save the tokens of a finished sign-in under an account id. */
  async saveSession(accountId: string, tokens: TokenSet): Promise<void> {
    await this.store.set(accountId, {
      refreshToken: tokens.refreshToken,
      accessToken: tokens.accessToken,
      accessExpiresAt: tokens.expiresAt,
      oauthProvider: 'microsoft',
    });
  }
}
