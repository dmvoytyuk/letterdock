// The oauth.* channels and the sign-in sessions the engine borrows tokens from.
import { AppException } from '../../shared/errors';
import type { OAuthSessionInfo } from '../../shared/internal';
import type {
  Account,
  OAuthCompleteReq,
  OAuthCompleteRes,
  OAuthReauthReq,
  OAuthStartReq,
  OAuthStartRes,
} from '../../shared/ipc';
import type { MicrosoftOAuth } from './microsoft';
import type { TokenManager } from './tokenManager';

export interface OAuthServiceDeps {
  microsoft: MicrosoftOAuth;
  tokens: TokenManager;
  /** Looks up an account (via the engine). */
  getAccount: (accountId: string) => Promise<Account | null>;
  /** Tell the engine to reconnect an account after its tokens were renewed. */
  reconnect: (accountId: string) => Promise<void>;
}

export class OAuthService {
  /** Reauthorizations in progress, by account (a second click joins the first). */
  private reauth = new Map<string, Promise<void>>();

  constructor(private readonly d: OAuthServiceDeps) {}

  start(req: OAuthStartReq): Promise<OAuthStartRes> {
    if (req.provider !== 'microsoft') {
      throw new AppException('UNSUPPORTED', 'Only Sign in with Microsoft is available.');
    }
    return this.d.microsoft.start(req.loginHint);
  }

  async complete(req: OAuthCompleteReq): Promise<OAuthCompleteRes> {
    const r = await this.d.microsoft.complete(req.sessionId);
    return { email: r.email, sessionId: r.sessionId };
  }

  cancel(sessionId: string): void {
    this.d.microsoft.cancel(sessionId);
  }

  peekSession(sessionId: string): OAuthSessionInfo {
    return this.d.microsoft.peek(sessionId);
  }

  /** accounts.add took the session: store its tokens under the new account. */
  async adoptSession(sessionId: string, accountId: string): Promise<OAuthSessionInfo> {
    const t = this.d.microsoft.take(sessionId);
    await this.d.tokens.saveSession(accountId, t);
    return { email: t.email, accessToken: t.accessToken, expiresAt: t.expiresAt };
  }

  /** "Sign in again": run the browser flow for an existing account and swap in the new tokens. */
  reauthorize(req: OAuthReauthReq): Promise<void> {
    const running = this.reauth.get(req.accountId);
    if (running) return running;
    const p = this.doReauthorize(req.accountId).finally(() => this.reauth.delete(req.accountId));
    this.reauth.set(req.accountId, p);
    return p;
  }

  private async doReauthorize(accountId: string): Promise<void> {
    const account = await this.d.getAccount(accountId);
    if (!account) throw new AppException('NOT_FOUND', 'Account not found.');
    if (account.authType !== 'oauth2') {
      throw new AppException('INVALID_INPUT', 'This account does not use Sign in with Microsoft.');
    }
    const { sessionId } = await this.d.microsoft.start(account.email);
    const done = await this.d.microsoft.complete(sessionId);
    if (done.email.toLowerCase() !== account.email.toLowerCase()) {
      this.d.microsoft.cancel(sessionId);
      throw new AppException(
        'INVALID_INPUT',
        `You signed in as ${done.email}, but this account is ${account.email}. Sign in with ${account.email}.`,
      );
    }
    const tokens = this.d.microsoft.take(sessionId);
    await this.d.tokens.saveSession(accountId, tokens);
    await this.d.reconnect(accountId);
  }
}
