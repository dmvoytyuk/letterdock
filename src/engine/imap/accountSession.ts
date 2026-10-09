// One AccountSession per enabled account: an IDLE connection on INBOX plus a small work pool.
// Handles reconnect with backoff, polling fallback and the state machine (ARCHITECTURE 5.4).
import type { ImapFlow } from 'imapflow';
import type {
  Account,
  AccountStatus,
  AppError,
  ConnectionState,
  FolderId,
  LoadOlderRes,
} from '../../shared/ipc';
import { AppException, makeError } from '../../shared/errors';
import { findProviderByHost } from '../../shared/providers';
import { pendingTotal, type EngineContext } from '../context';
import type { FolderRow, ListedFolder } from '../db/repos/folderRepo';
import {
  createImapClient,
  WorkPool,
  type IdleBudget,
  type Priority,
  type Semaphore,
} from './connectionPool';
import { mapNetworkError } from './errors';
import { dedupeRoles, mapRole, syncPriority } from './mailboxRoles';
import { backfillSnippetBatch, BACKFILL_BATCH } from './snippets';
import { loadOlder, syncFolder } from './syncFolder';
import { isWidenPending, pruneToWindow, setWidenPending, widenFolder } from './history';
import { backoffDelayMs } from './syncDiff';
import { newMailToAnnounce } from '../notify';

export interface SessionShared {
  semaphore: Semaphore;
  idleBudget: IdleBudget;
}

const INBOX_POLL_IDLE_MS = 2 * 60_000;
const INBOX_POLL_NOIDLE_MS = 60_000;
const INBOX_POLL_NOBUDGET_MS = 5 * 60_000;
const OTHER_POLL_MS = 10 * 60_000;
const WATCHDOG_MS = 10 * 60_000;
/** Most rows per folder the snippet backfill looks at in one app session. */
const BACKFILL_MAX_PER_FOLDER = 2000;

export class AccountSession {
  private state: ConnectionState = 'disabled';
  private error: AppError | null = null;
  private nextRetryAt: number | null = null;
  private lastSyncAt: number | null = null;

  private idleClient: ImapFlow | null = null;
  private pool: WorkPool | null = null;
  private stopped = true;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private idleDebounce: ReturnType<typeof setTimeout> | null = null;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private usesIdle = false;
  private idleSupported = true;
  private activeSyncs = 0;
  private lastOtherPoll = 0;
  private lastInboxPoll = 0;
  private inflight = new Map<FolderId, { promise: Promise<void>; rerun: boolean }>();
  private connectGeneration = 0;
  /** OAuth: the server refused our token once already (we then asked for a fresh one). */
  private oauthRetried = false;
  private forceTokenRefresh = false;
  private backfillRunning = false;
  private backfilled = new Map<FolderId, number>();

  constructor(
    private readonly ctx: EngineContext,
    private account: Account,
    private readonly shared: SessionShared,
  ) {}

  get id(): string {
    return this.account.id;
  }

  setAccount(a: Account): void {
    this.account = a;
  }

  getStatus(): AccountStatus {
    return {
      accountId: this.account.id,
      state: this.state,
      lastSyncAt: this.lastSyncAt,
      error: this.error,
      nextRetryAt: this.nextRetryAt,
      pendingCount: pendingTotal(this.ctx, this.account.id),
    };
  }

  private setState(state: ConnectionState, error: AppError | null = null): void {
    const prev = this.state;
    const prevErr = this.error;
    this.state = state;
    this.error = error;
    if (state !== 'retrying') this.nextRetryAt = null;
    if (prev !== state || prevErr?.code !== error?.code || state === 'retrying') {
      this.ctx.hub.emit({ type: 'account:status', status: this.getStatus() });
    }
  }

  // ---------- lifecycle ----------

  start(): void {
    if (!this.stopped) return;
    if (!this.account.enabled) {
      this.setState('disabled');
      return;
    }
    this.stopped = false;
    this.attempt = 0;
    this.oauthRetried = false;
    this.forceTokenRefresh = false;
    this.backfilled.clear();
    this.pool = new WorkPool(
      () => this.makeClient(),
      () => Math.min(4, Math.max(1, this.ctx.settings().maxWorkConnectionsPerAccount)),
      this.shared.semaphore,
    );
    void this.connect();
  }

  async stop(finalState: ConnectionState = 'disabled'): Promise<void> {
    this.stopped = true;
    this.connectGeneration++;
    this.clearTimers();
    this.shared.idleBudget.release(this.account.id);
    const idle = this.idleClient;
    this.idleClient = null;
    if (idle) {
      idle.removeAllListeners('close');
      try {
        idle.close();
      } catch {
        /* ignore */
      }
    }
    await this.pool?.close();
    this.pool = null;
    this.setState(finalState);
  }

  private clearTimers(): void {
    for (const t of [this.retryTimer, this.idleDebounce]) if (t) clearTimeout(t);
    this.retryTimer = null;
    this.idleDebounce = null;
    if (this.ticker) clearInterval(this.ticker);
    if (this.watchdog) clearInterval(this.watchdog);
    this.ticker = null;
    this.watchdog = null;
  }

  private async makeClient(autoIdleDelayMs?: number): Promise<ImapFlow> {
    const force = this.forceTokenRefresh;
    this.forceTokenRefresh = false;
    const cred = await this.ctx.secrets.getCredential(this.account.id, force);
    const client = createImapClient(
      this.account,
      cred,
      this.ctx.log,
      this.ctx.imapTrustedCa,
      autoIdleDelayMs,
    );
    await client.connect();
    return client;
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const gen = ++this.connectGeneration;
    if (this.state !== 'retrying') this.setState('connecting');
    try {
      if (this.shared.idleBudget.tryAcquire(this.account.id)) {
        // The dedicated INBOX connection should start IDLE almost at once: imapflow's 15 s default
        // would leave a window after every (re)connect where new mail is not pushed.
        const client = await this.makeClient(1000);
        if (this.stopped || gen !== this.connectGeneration) {
          client.close();
          return;
        }
        this.idleSupported = client.capabilities.has('IDLE');
        await client.mailboxOpen('INBOX', { readOnly: true });
        this.attachIdle(client);
        this.usesIdle = this.idleSupported;
        if (!this.idleSupported) this.shared.idleBudget.release(this.account.id);
      } else {
        // Over the global IDLE budget: poll through the work pool instead.
        this.usesIdle = false;
        await this.pool!.run('sync', (c) => c.noop());
      }
    } catch (e) {
      if (gen === this.connectGeneration) this.handleFailure(e);
      return;
    }
    if (this.stopped || gen !== this.connectGeneration) return;
    this.attempt = 0;
    this.oauthRetried = false;
    this.setState('online');
    this.startTimers();
    void this.afterOnline();
  }

  /** Back online: first send the changes that were made while we could not reach the server. */
  private async afterOnline(): Promise<void> {
    try {
      await this.ctx.pendingOps?.flush(this.account.id);
    } catch (e) {
      this.ctx.log.warn(
        { accountId: this.account.id, err: String((e as Error)?.message ?? e) },
        'sending queued changes failed',
      );
    }
    // Drafts saved while we were offline: upload them in the background.
    void this.ctx.drafts?.flush(this.account.id).catch(() => undefined);
    if (!this.stopped) await this.bootstrap();
  }

  /** The connection is up and can take commands (queued changes are only sent then). */
  isReady(): boolean {
    return !this.stopped && this.pool !== null && (this.state === 'online' || this.state === 'syncing');
  }

  /** Tell the UI the status changed (e.g. the number of waiting changes). */
  refreshStatus(): void {
    this.ctx.hub.emit({ type: 'account:status', status: this.getStatus() });
  }

  private attachIdle(client: ImapFlow): void {
    this.idleClient = client;
    const nudge = () => this.scheduleInboxSync();
    client.on('exists', nudge);
    client.on('expunge', nudge);
    client.on('flags', nudge);
    client.on('close', () => {
      if (this.stopped || this.idleClient !== client) return;
      this.ctx.log.info({ accountId: this.account.id }, 'idle connection closed; reconnecting');
      this.idleClient = null;
      this.shared.idleBudget.release(this.account.id);
      this.clearTimers();
      this.handleFailure(new Error('Connection closed'), true);
    });
  }

  private handleFailure(e: unknown, transient = false): void {
    if (this.stopped) return;
    let err = mapNetworkError(e);
    if (err.code === 'AUTH_FAILED' && this.account.authType === 'oauth2') {
      // The access token may simply be stale. Try once with a brand-new one before asking the user.
      if (!this.oauthRetried) {
        this.oauthRetried = true;
        this.forceTokenRefresh = true;
        transient = true;
        err = { ...err, code: 'HOST_UNREACHABLE', retryable: true };
      } else {
        err = makeError(
          'OAUTH_REAUTH_REQUIRED',
          'Microsoft did not accept the sign-in. Sign in again.',
          { details: err.details },
        );
      }
    }
    this.ctx.log.warn(
      { accountId: this.account.id, code: err.code, details: err.details },
      'connection failure',
    );
    this.shared.idleBudget.release(this.account.id);
    const idle = this.idleClient;
    this.idleClient = null;
    if (idle) {
      idle.removeAllListeners('close');
      try {
        idle.close();
      } catch {
        /* ignore */
      }
    }
    this.clearTimers();
    if (err.code === 'AUTH_FAILED') {
      this.setState('auth_failed', err);
      this.ctx.hub.emit({
        type: 'account:authRequired',
        accountId: this.account.id,
        reason: 'password',
      });
      return;
    }
    if (err.code === 'OAUTH_REAUTH_REQUIRED') {
      this.setState('needs_reauth', err);
      this.ctx.hub.emit({
        type: 'account:authRequired',
        accountId: this.account.id,
        reason: 'oauth',
      });
      return;
    }
    this.attempt++;
    const delay = transient && this.attempt === 1 ? 1000 : backoffDelayMs(this.attempt);
    this.nextRetryAt = this.ctx.now() + delay;
    this.setState('retrying', err);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, delay);
  }

  /** Run a job on the work pool. Auth failures flip the account state. */
  async run<T>(priority: Priority, fn: (c: ImapFlow) => Promise<T>): Promise<T> {
    if (!this.pool) throw new AppException('HOST_UNREACHABLE', 'This account is not connected.');
    try {
      return await this.pool.run(priority, fn);
    } catch (e) {
      const err = mapNetworkError(e);
      if (
        err.code === 'AUTH_FAILED' &&
        !this.stopped &&
        this.state !== 'auth_failed' &&
        this.state !== 'needs_reauth'
      ) {
        this.handleFailure(e);
      }
      throw new AppException(err.code, err.message, {
        details: err.details,
        retryable: err.retryable,
      });
    }
  }

  // ---------- timers ----------

  private startTimers(): void {
    this.lastInboxPoll = this.ctx.now();
    this.lastOtherPoll = this.ctx.now();
    this.ticker = setInterval(() => this.tick(), 30_000);
    if (this.usesIdle) {
      this.watchdog = setInterval(() => {
        const c = this.idleClient;
        if (!c) return;
        c.noop().catch(() => c.close());
      }, WATCHDOG_MS);
    }
  }

  private tick(): void {
    if (this.stopped || this.state === 'auth_failed' || this.state === 'needs_reauth') return;
    const now = this.ctx.now();
    const inboxEvery = this.usesIdle
      ? INBOX_POLL_IDLE_MS
      : this.idleSupported
        ? INBOX_POLL_NOBUDGET_MS
        : INBOX_POLL_NOIDLE_MS;
    if (now - this.lastInboxPoll >= inboxEvery) {
      this.lastInboxPoll = now;
      this.scheduleInboxSync(0);
    }
    if (now - this.lastOtherPoll >= OTHER_POLL_MS) {
      this.lastOtherPoll = now;
      void this.syncOthers();
    }
  }

  private scheduleInboxSync(delay = 500): void {
    if (this.idleDebounce) clearTimeout(this.idleDebounce);
    this.idleDebounce = setTimeout(() => {
      this.idleDebounce = null;
      const inbox = this.ctx.folders.rowByRole(this.account.id, 'inbox');
      if (inbox) this.syncFolderRow(inbox, 'sync').catch(() => undefined);
    }, delay);
  }

  // ---------- sync ----------

  private syncableFolders(): FolderRow[] {
    const skip = findProviderByHost(this.account.imap.host)?.skipSyncRoles ?? [];
    return this.ctx.folders
      .rowsForAccount(this.account.id)
      .filter((f) => f.selectable === 1 && !(f.role && (skip as string[]).includes(f.role)))
      .sort((a, b) => syncPriority(a.role) - syncPriority(b.role) || a.id - b.id);
  }

  private async bootstrap(): Promise<void> {
    try {
      await this.discoverFolders();
      for (const f of this.syncableFolders()) {
        if (this.stopped) return;
        await this.syncFolderRow(f, 'sync').catch((e) =>
          this.ctx.log.warn(
            { accountId: this.account.id, folder: f.path, err: String(e?.message ?? e) },
            'folder sync failed',
          ),
        );
      }
    } catch (e) {
      this.ctx.log.warn(
        { accountId: this.account.id, err: String((e as Error)?.message ?? e) },
        'bootstrap failed',
      );
    }
    await this.widenHistory();
    void this.backfillSnippets();
  }

  private widening = false;
  private widenAgain = false;
  /** Changes whenever the window is narrowed; a widening that started before it stops. */
  private historyEpoch = 0;
  /** Widening and narrowing never run at the same time: both change the folder cursors. */
  private historyLane: Promise<unknown> = Promise.resolve();

  private onHistoryLane<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.historyLane.then(fn, fn);
    this.historyLane = run.catch(() => undefined);
    return run;
  }

  /**
   * The user made the "keep mail for" window wider: fetch the older headers down to it. If the
   * account cannot be reached now, the request stays saved and runs after the next connect.
   */
  async widenHistory(): Promise<void> {
    if (this.widening) {
      this.widenAgain = true; // a running widening picks the new request up when it is done
      return;
    }
    if (!this.isReady() || !isWidenPending(this.ctx, this.account.id)) return;
    this.widening = true;
    try {
      await this.onHistoryLane(async () => {
        const epoch = this.historyEpoch;
        const cancelled = () => this.stopped || epoch !== this.historyEpoch;
        do {
          this.widenAgain = false;
          for (const f of this.syncableFolders()) {
            if (cancelled()) return;
            const fresh = this.ctx.folders.row(f.id);
            if (!fresh || fresh.uidvalidity === null) continue;
            await this.run('sync', (c) =>
              widenFolder(this.ctx, c, fresh, this.account.syncDays, cancelled),
            );
          }
          if (cancelled()) return;
          if (!this.widenAgain) setWidenPending(this.ctx, this.account.id, false);
        } while (this.widenAgain);
      });
    } catch (e) {
      this.ctx.log.warn(
        { accountId: this.account.id, err: String((e as Error)?.message ?? e) },
        'fetching older mail failed; will try again after the next connect',
      );
    } finally {
      this.widening = false;
    }
  }

  /**
   * The user made the window narrower: stop a widening that is running, wait until it has let go
   * of the folder cursors, then remove the older mail from this PC.
   */
  async pruneHistory(syncDays: number): Promise<number> {
    this.historyEpoch++;
    setWidenPending(this.ctx, this.account.id, false);
    return this.onHistoryLane(() => pruneToWindow(this.ctx, this.account.id, syncDays));
  }

  /**
   * Fill list snippets for rows synced before snippets existed. Runs on the lowest-priority lane in
   * small batches, so user actions and sync always go first. Bounded per folder and per session.
   */
  private async backfillSnippets(): Promise<void> {
    if (this.backfillRunning || this.stopped) return;
    this.backfillRunning = true;
    try {
      for (const f of this.syncableFolders()) {
        // Only folders that finished their first sync.
        if (f.uidvalidity === null) continue;
        while (!this.stopped && (this.backfilled.get(f.id) ?? 0) < BACKFILL_MAX_PER_FOLDER) {
          const fresh = this.ctx.folders.row(f.id);
          if (!fresh) break;
          const n = await this.run('background', async (c) => {
            await c.mailboxOpen(fresh.path, { readOnly: true });
            return backfillSnippetBatch(this.ctx, c, fresh, BACKFILL_BATCH);
          }).catch((e) => {
            this.ctx.log.debug({ folder: f.path, err: String(e?.message ?? e) }, 'snippet backfill stopped');
            return 0;
          });
          if (n === 0) break;
          this.backfilled.set(f.id, (this.backfilled.get(f.id) ?? 0) + n);
        }
        if (this.stopped) return;
      }
    } catch (e) {
      // E.g. the engine is shutting down. The backfill is best effort.
      this.ctx.log.debug({ err: String((e as Error)?.message ?? e) }, 'snippet backfill failed');
    } finally {
      this.backfillRunning = false;
    }
  }

  private async syncOthers(): Promise<void> {
    for (const f of this.syncableFolders()) {
      if (this.stopped) return;
      if (f.role === 'inbox' || f.uidvalidity === null) continue;
      await this.syncFolderRow(f, 'background').catch(() => undefined);
    }
  }

  /** Sync all folders now (manual refresh / F9). */
  async syncAll(): Promise<void> {
    if (this.stopped) return;
    await this.discoverFolders().catch(() => undefined);
    for (const f of this.syncableFolders()) {
      await this.syncFolderRow(f, 'sync').catch(() => undefined);
    }
  }

  syncFolderById(id: FolderId, priority: Priority = 'user'): Promise<void> {
    const row = this.ctx.folders.row(id);
    if (!row || row.account_id !== this.account.id) {
      throw new AppException('NOT_FOUND', 'Folder not found.');
    }
    return this.syncFolderRow(row, priority);
  }

  /** Coalesces concurrent requests: one run in flight, at most one queued re-run. */
  private syncFolderRow(folder: FolderRow, priority: Priority): Promise<void> {
    const cur = this.inflight.get(folder.id);
    if (cur) {
      cur.rerun = true;
      return cur.promise;
    }
    const entry = { rerun: false, promise: Promise.resolve() };
    const exec = async () => {
      this.beginSync();
      try {
        // Queued changes go first: a sync must not undo them or find the message twice.
        await this.ctx.pendingOps?.barrier(this.account.id).catch(() => undefined);
        do {
          entry.rerun = false;
          const fresh = this.ctx.folders.row(folder.id);
          if (!fresh) return;
          const res = await this.run(priority, (c) =>
            syncFolder(this.ctx, c, fresh, this.account.syncDays),
          );
          this.lastSyncAt = this.ctx.now();
          const fresh2 = newMailToAnnounce(this.ctx, fresh, res);
          if (fresh2.length > 0) {
            this.ctx.hub.emit({
              type: 'notify:newMail',
              accountId: this.account.id,
              messages: fresh2,
            });
          }
        } while (entry.rerun && !this.stopped);
      } finally {
        this.inflight.delete(folder.id);
        this.endSync();
      }
    };
    entry.promise = exec();
    this.inflight.set(folder.id, entry);
    return entry.promise;
  }

  private beginSync(): void {
    this.activeSyncs++;
    if (this.state === 'online') this.setState('syncing');
  }
  private endSync(): void {
    this.activeSyncs = Math.max(0, this.activeSyncs - 1);
    if (this.activeSyncs === 0 && this.state === 'syncing') this.setState('online');
    else if (this.activeSyncs === 0)
      this.ctx.hub.emit({ type: 'account:status', status: this.getStatus() });
  }

  async loadOlderFor(folderId: FolderId): Promise<LoadOlderRes> {
    return this.run('user', (c) => loadOlder(this.ctx, c, folderId));
  }

  // ---------- folders ----------

  async discoverFolders(): Promise<void> {
    const entries = await this.run('user', (c) => c.list());
    const listed: ListedFolder[] = entries.map((e) => ({
      path: e.path,
      name: e.name,
      delimiter: e.delimiter || null,
      role: mapRole({ path: e.path, name: e.name, specialUse: e.specialUse }),
      subscribed: e.subscribed !== false,
      selectable: !e.flags.has('\\Noselect') && !e.flags.has('\\NonExistent'),
    }));
    const deduped = dedupeRoles(listed);
    const changed = this.ctx.folders.syncListed(this.account.id, deduped);
    if (changed) {
      this.ctx.hub.emit({ type: 'folders:changed', accountId: this.account.id });
      this.ctx.hub.touchCounts();
    }
  }
}
