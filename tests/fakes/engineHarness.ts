// Boots a real engine (temp data dir, in-memory SQLite) against a FakeImapServer.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine, type Engine } from '../../src/engine/engine';
import { openDatabase } from '../../src/engine/db/connection';
import { nullLogger } from '../../src/engine/logger';
import { DEFAULT_SETTINGS } from '../../src/main/settings';
import type {
  Account,
  AppEvent,
  AppSettings,
  Folder,
  MessageHeader,
  NewAccountInput,
} from '../../src/shared/ipc';
import { TEST_PASSWORD, TEST_USER, type FakeImapServer } from './fakeImapServer';
import type { OAuthSessionInfo } from '../../src/shared/internal';
import type { FakeSmtpServer } from './fakeSmtpServer';

export interface HarnessOptions {
  /** Keep the database in this file (to restart an engine on the same data). Default: in memory. */
  dbFile?: string;
  /** Use this data folder instead of a new temporary one (the caller removes it). */
  dataDir?: string;
  /** Share the password store between two engines (a restart). */
  secrets?: Map<string, string>;
  smtp?: FakeSmtpServer;
  settings?: Partial<AppSettings>;
  sendRetryDelaysMs?: number[];
  /** The engine's clock (a test can move it forward). Default: the real time. */
  now?: () => number;
  /** Pause between scheduled messages that leave one after the other. Default 20 ms. */
  scheduledSpacingMs?: number;
}

export interface Harness {
  engine: Engine;
  settings: AppSettings;
  events: AppEvent[];
  dataDir: string;
  secrets: Map<string, string>;
  /** OAuth sign-ins waiting to be adopted (sessionId -> who/token). */
  oauthSessions: Map<string, OAuthSessionInfo>;
  /** Access token per OAuth account id. */
  oauthTokens: Map<string, string>;
  addAccount(over?: Partial<NewAccountInput>): Promise<Account>;
  folderByPath(accountId: string, path: string): Folder;
  folderByRole(accountId: string, role: string): Folder;
  inboxMessages(accountId: string): MessageHeader[];
  folderMessages(folderId: number): MessageHeader[];
  eventsOfType<T extends AppEvent['type']>(type: T): Extract<AppEvent, { type: T }>[];
  cleanup(): Promise<void>;
}

export async function createHarness(
  server: FakeImapServer,
  opts: HarnessOptions = {},
): Promise<Harness> {
  // Tests send at once unless they ask for an undo delay.
  const settings: AppSettings = { ...DEFAULT_SETTINGS, undoSendDelayMs: 0, ...opts.settings };
  const dataDir = opts.dataDir ?? (await mkdtemp(join(tmpdir(), 'letterdock-it-')));
  const events: AppEvent[] = [];
  const secrets = opts.secrets ?? new Map<string, string>();
  const oauthSessions = new Map<string, OAuthSessionInfo>();
  const oauthTokens = new Map<string, string>();
  const engine = createEngine({
    dataDir,
    db: openDatabase(opts.dbFile ?? ':memory:'),
    send: (e) => events.push(e),
    log: nullLogger(),
    settings: () => settings,
    secrets: {
      getCredential: async (id) =>
        oauthTokens.has(id)
          ? { kind: 'oauth', accessToken: oauthTokens.get(id)!, expiresAt: Date.now() + 3_600_000 }
          : { kind: 'password', password: secrets.get(id) ?? '' },
      set: async (id, s) => {
        if (s.password !== undefined) secrets.set(id, s.password);
      },
      delete: async (id) => {
        secrets.delete(id);
        oauthTokens.delete(id);
      },
      peekOAuthSession: async (sid) => {
        const info = oauthSessions.get(sid);
        if (!info) throw new Error(`no oauth session ${sid}`);
        return info;
      },
      adoptOAuthSession: async (sid, accountId) => {
        const info = oauthSessions.get(sid);
        if (!info) throw new Error(`no oauth session ${sid}`);
        oauthSessions.delete(sid);
        oauthTokens.set(accountId, info.accessToken);
        return info;
      },
    },
    discoverDeps: { fetchText: async () => null, resolveMx: async () => [] },
    imapTrustedCa: server.ca,
    actionRetryDelaysMs: [],
    smtpTrustedCa: opts.smtp?.ca,
    sendRetryDelaysMs: opts.sendRetryDelaysMs ?? [30, 30, 30],
    now: opts.now,
    scheduledSpacingMs: opts.scheduledSpacingMs ?? 20,
  });

  const h: Harness = {
    engine,
    settings,
    events,
    dataDir,
    secrets,
    oauthSessions,
    oauthTokens,
    async addAccount(over = {}) {
      return (await engine.handle('accounts.add', {
        email: 'me@example.com',
        displayName: 'Me',
        authType: 'password',
        password: TEST_PASSWORD,
        username: TEST_USER,
        imap: { host: server.host, port: server.port, security: 'ssl' },
        smtp: opts.smtp
          ? { host: opts.smtp.host, port: opts.smtp.port, security: opts.smtp.security }
          : { host: server.host, port: 1, security: 'ssl' },
        syncDays: 30,
        ...over,
      } satisfies NewAccountInput)) as Account;
    },
    folderByPath(accountId, path) {
      const row = engine.ctx.folders.rowByPath(accountId, path);
      if (!row) throw new Error(`no local folder ${path}`);
      return engine.ctx.folders.get(row.id)!;
    },
    folderByRole(accountId, role) {
      const row = engine.ctx.folders.rowByRole(accountId, role as never);
      if (!row) throw new Error(`no local folder with role ${role}`);
      return engine.ctx.folders.get(row.id)!;
    },
    folderMessages(folderId) {
      const res = engine.ctx.messages.list({
        scope: { kind: 'folder', folderId },
        cursor: null,
        limit: 500,
      });
      return res.items;
    },
    inboxMessages(accountId) {
      return h.folderMessages(h.folderByRole(accountId, 'inbox').id);
    },
    eventsOfType<T extends AppEvent['type']>(type: T) {
      return events.filter((e) => e.type === type) as Extract<AppEvent, { type: T }>[];
    },
    async cleanup() {
      await engine.shutdown().catch(() => undefined);
      if (!opts.dataDir) await rm(dataDir, { recursive: true, force: true });
    },
  };
  return h;
}

/** Poll until `fn` returns a truthy value (or throw with `what` after the timeout). */
export async function waitFor<T>(
  what: string,
  fn: () => T | Promise<T>,
  timeoutMs = 30_000, // generous: polling returns as soon as true, so only a real hang pays it
): Promise<NonNullable<T>> {
  const start = Date.now();
  let lastErr: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v as NonNullable<T>;
    } catch (e) {
      lastErr = e;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for ${what}${lastErr ? `: ${String(lastErr)}` : ''}`);
    }
    await new Promise((r) => setTimeout(r, 40));
  }
}

/**
 * Initial sync inserts rows first and saves the folder cursors (uidvalidity, oldest UID) last.
 * "Rows are visible" is therefore NOT "sync finished": loadOlder skips folders without cursors.
 * Wait for the cursors, which is the real completion signal.
 */
export async function waitForInboxCursors(hh: Harness, accountIds: string[]): Promise<void> {
  await waitFor('inbox cursors saved', () =>
    accountIds.every((id) => {
      const st = hh.engine.ctx.folders.syncState(hh.folderByRole(id, 'inbox').id);
      return st !== null && st.uidvalidity !== null && st.oldestSyncedUid !== null;
    }),
  );
}
