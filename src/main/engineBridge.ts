// Requests the engine sends to main (it owns safeStorage and the OAuth tokens).
import { AppException } from '../shared/errors';
import type { Credential, EngineToMainMethods, SecretRecord } from '../shared/internal';
import type { OAuthService } from './oauth/service';
import type { TokenManager } from './oauth/tokenManager';
import type { SecretStore } from './secrets/secretStore';

type Methods = EngineToMainMethods;

export function createEngineBridge(deps: {
  secrets: Pick<SecretStore, 'get' | 'set' | 'delete'>;
  tokens: TokenManager;
  oauth: OAuthService;
}): (channel: string, payload: unknown) => Promise<unknown> {
  return async (channel, payload) => {
    switch (channel as keyof Methods) {
      case 'secrets.getCredential': {
        const p = payload as Methods['secrets.getCredential']['req'];
        if (deps.tokens.isOAuth(p.accountId)) {
          return deps.tokens.getCredential(p.accountId, p.forceRefresh === true);
        }
        const rec = deps.secrets.get(p.accountId);
        if (!rec?.password) {
          throw new AppException('AUTH_FAILED', 'The saved password was not found. Sign in again.');
        }
        const cred: Credential = { kind: 'password', password: rec.password };
        return cred;
      }
      case 'secrets.set': {
        const p = payload as Methods['secrets.set']['req'];
        const secret: SecretRecord = p.secret ?? {};
        await deps.secrets.set(p.accountId, secret);
        return undefined;
      }
      case 'secrets.delete':
        await deps.secrets.delete((payload as Methods['secrets.delete']['req']).accountId);
        return undefined;
      case 'secrets.peekOAuthSession':
        return deps.oauth.peekSession((payload as Methods['secrets.peekOAuthSession']['req']).sessionId);
      case 'secrets.adoptOAuthSession': {
        const p = payload as Methods['secrets.adoptOAuthSession']['req'];
        return deps.oauth.adoptSession(p.sessionId, p.accountId);
      }
      default:
        throw new AppException('INTERNAL', `Unknown engine request ${channel}`);
    }
  };
}
