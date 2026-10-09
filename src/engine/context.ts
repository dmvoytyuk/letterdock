import type { AppEvent, AppSettings } from '../shared/ipc';
import type { Credential, OAuthSessionInfo } from '../shared/internal';
import type { ContactService } from './contacts/contactService';
import type { Db } from './db/connection';
import type { AccountRepo } from './db/repos/accountRepo';
import type { FolderRepo } from './db/repos/folderRepo';
import type { MessageRepo } from './db/repos/messageRepo';
import type { Logger } from './logger';

/** Coalesces change notifications (<= 4/sec) and forwards events to main. */
export class EventHub {
  private pending: {
    folderIds: Set<number>;
    added: Set<number>;
    updated: Set<number>;
    removed: Set<number>;
  } | null = null;
  private countsDirty = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly send: (e: AppEvent) => void,
    private readonly getCounts: () => ReturnType<FolderRepo['counts']>,
    private readonly intervalMs = 250,
  ) {}

  emit(e: AppEvent): void {
    this.send(e);
  }

  changed(c: {
    folderIds?: number[];
    added?: number[];
    updated?: number[];
    removed?: number[];
  }): void {
    if (!this.pending) {
      this.pending = {
        folderIds: new Set(),
        added: new Set(),
        updated: new Set(),
        removed: new Set(),
      };
    }
    for (const f of c.folderIds ?? []) this.pending.folderIds.add(f);
    for (const id of c.added ?? []) this.pending.added.add(id);
    for (const id of c.updated ?? []) this.pending.updated.add(id);
    for (const id of c.removed ?? []) {
      this.pending.removed.add(id);
      this.pending.added.delete(id);
      this.pending.updated.delete(id);
    }
    this.countsDirty = true;
    this.schedule();
  }

  /** Counts changed without message ids (e.g. after folder changes). */
  touchCounts(): void {
    this.countsDirty = true;
    this.schedule();
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), this.intervalMs);
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.pending) {
      const p = this.pending;
      this.pending = null;
      this.send({
        type: 'messages:changed',
        folderIds: [...p.folderIds],
        added: [...p.added],
        updated: [...p.updated],
        removed: [...p.removed],
      });
    }
    if (this.countsDirty) {
      this.countsDirty = false;
      this.send({ type: 'counts:changed', ...this.getCounts() });
    }
  }
}

export interface SecretsClient {
  /** `forceRefresh`: for OAuth accounts, get a brand-new access token (the old one was rejected). */
  getCredential(accountId: string, forceRefresh?: boolean): Promise<Credential>;
  set(accountId: string, secret: { password?: string }): Promise<void>;
  delete(accountId: string): Promise<void>;
  peekOAuthSession(sessionId: string): Promise<OAuthSessionInfo>;
  adoptOAuthSession(sessionId: string, accountId: string): Promise<OAuthSessionInfo>;
}

/** The queue of unsynced changes, as the IMAP session code sees it (implemented by ActionService). */
export interface PendingOpsApi {
  /** Number of changes of this account that are not on the server yet. */
  count(accountId: string): number;
  /** Send the waiting changes now. Resolves when the queue is empty or cannot go on. */
  flush(accountId: string): Promise<void>;
  /** Waits for a send that is running right now (does not start one). */
  barrier(accountId: string): Promise<void>;
  /** Messages with a waiting flag change: a sync must not overwrite their flags. */
  messageIdsWithFlagOps(accountId: string): Set<number>;
  /** The account was removed. */
  forgetAccount(accountId: string): void;
}

/** Drafts as the sync and action code sees them (implemented by ComposeService). */
export interface DraftsApi {
  /** Draft uploads that wait for the connection (counted in AccountStatus.pendingCount). */
  queuedCount(accountId: string): number;
  /** The account is online: upload the drafts that wait. */
  flush(accountId: string): Promise<void>;
  /**
   * A sync added these rows to a Drafts folder. Removes the ones that are only a second copy of a
   * draft we show already. Returns the ids it removed.
   */
  reconcile(folderId: number, addedIds: number[]): number[];
  /** Is this row a draft that only exists on this PC so far? */
  isLocalDraft(messageId: number): boolean;
  /** The user deleted a local-only draft: forget it. */
  discardRow(messageId: number): Promise<void>;
}

/** Drafts as the sync and action code sees them (implemented by ComposeService). */
export interface DraftsApi {
  /** Draft uploads that wait for the connection (counted in AccountStatus.pendingCount). */
  queuedCount(accountId: string): number;
  /** The account is online: upload the drafts that wait. */
  flush(accountId: string): Promise<void>;
  /**
   * A sync added these rows to a Drafts folder. Removes the ones that are only a second copy of a
   * draft we show already. Returns the ids it removed.
   */
  reconcile(folderId: number, addedIds: number[]): number[];
  /** Is this row a draft that only exists on this PC so far? */
  isLocalDraft(messageId: number): boolean;
  /** The user deleted a local-only draft: forget it. */
  discardRow(messageId: number): Promise<void>;
}

export interface EngineContext {
  dataDir: string;
  db: Db;
  accounts: AccountRepo;
  folders: FolderRepo;
  messages: MessageRepo;
  contacts: ContactService;
  hub: EventHub;
  secrets: SecretsClient;
  log: Logger;
  settings: () => AppSettings;
  now: () => number;
  /**
   * Message-IDs we moved ourselves in the last minutes (key `accountId|<id>`), so the sync that sees
   * the moved message arrive does not raise a "new mail" notification for it.
   */
  recentMoves: Map<string, number>;
  /** Set by the engine once the action service exists. */
  pendingOps?: PendingOpsApi;
  /** Set by the compose service. */
  drafts?: DraftsApi;
  /** Wait before a saved draft is uploaded (saves in quick succession become one upload). Default 1500. */
  draftPushDelayMs?: number;
  /** Wait before a failed draft upload is tried again. Default 30000. */
  draftRetryMs?: number;
  /** Pauses between retries of a failed server action. Default [1000, 4000]; tests use []. */
  actionRetryDelaysMs?: number[];
  /** Pauses before the automatic re-sends of a message that failed temporarily. */
  sendRetryDelaysMs?: number[];
  /** Test-only: extra CA certificate trusted for SMTP TLS. Never set in production. */
  smtpTrustedCa?: string | Buffer;
  /** Test-only: extra nodemailer transport options (e.g. a fixed port). */
  smtpOverrides?: Record<string, unknown>;
  /** Test-only: extra CA certificate trusted for IMAP TLS. Never set in production. */
  imapTrustedCa?: string | Buffer;
}

/** Everything of one account that waits for the server: queued changes plus draft uploads. */
export function pendingTotal(ctx: EngineContext, accountId: string): number {
  return (ctx.pendingOps?.count(accountId) ?? 0) + (ctx.drafts?.queuedCount(accountId) ?? 0);
}
