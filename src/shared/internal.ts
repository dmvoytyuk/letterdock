// Channels between main and the engine that the renderer never sees.
import type { AppSettings, DraftAttachment } from './ipc';

export type Credential =
  | { kind: 'password'; password: string }
  | { kind: 'oauth'; accessToken: string; expiresAt: number };

export interface SecretRecord {
  password?: string;
  /** OAuth (Microsoft). Never leave main except the short-lived access token. */
  refreshToken?: string;
  accessToken?: string;
  accessExpiresAt?: number;
  oauthProvider?: 'microsoft';
}

/** What an unfinished or finished OAuth sign-in gives the engine (no refresh token). */
export interface OAuthSessionInfo {
  email: string;
  accessToken: string;
  expiresAt: number;
}

/** Engine asks main (main owns safeStorage). */
export interface EngineToMainMethods {
  'secrets.getCredential': {
    req: { accountId: string; forceRefresh?: boolean };
    res: Credential;
  };
  'secrets.set': { req: { accountId: string; secret: SecretRecord }; res: void };
  'secrets.delete': { req: { accountId: string }; res: void };
  /** Look at a finished OAuth sign-in (used by accounts.test). Does not consume it. */
  'secrets.peekOAuthSession': { req: { sessionId: string }; res: OAuthSessionInfo };
  /** Move a finished OAuth sign-in's tokens under the new account id. Consumes the session. */
  'secrets.adoptOAuthSession': {
    req: { sessionId: string; accountId: string };
    res: OAuthSessionInfo;
  };
}

export interface EngineInit {
  dataDir: string;
  settings: AppSettings;
  appVersion: string;
  /** Test/dev hook: override better-sqlite3 native binding path. */
  nativeBinding?: string;
}

export interface PreparedAttachment {
  path: string;
  filename: string;
  size: number;
  contentType: string;
}

/** Main asks the engine (not in the public contract). */
export interface MainToEngineMethods {
  'engine.init': { req: EngineInit; res: void };
  'engine.settings': { req: AppSettings; res: void };
  'attachments.prepare': { req: { attachmentId: number }; res: PreparedAttachment };
  /** Files picked in the native dialog: the engine copies them and returns opaque tokens. */
  'attachments.register': {
    req: { files: { path: string; filename: string; contentType: string }[] };
    res: DraftAttachment[];
  };
  /** Reconnect an account after its OAuth tokens were renewed. */
  'accounts.reconnect': { req: { accountId: string }; res: void };
  /** The PC woke up from sleep or was unlocked: check the scheduled messages again. */
  'scheduled.recheck': { req: { reason: 'resume' | 'unlock' }; res: void };
}
