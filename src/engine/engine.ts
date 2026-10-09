// Wires repos and services together. Used by engine/index.ts (utility process) and by tests.
import { join } from 'node:path';
import type { AppEvent, AppSettings, IpcReq, IpcRes } from '../shared/ipc';
import type { EngineChannel } from '../shared/channels';
import type { MainToEngineMethods } from '../shared/internal';
import { makeNetworkDeps, type DiscoverDeps } from './accounts/autodiscover';
import { AccountService } from './accounts/accountService';
import { EventHub, type EngineContext, type SecretsClient } from './context';
import { openDatabase, type Db } from './db/connection';
import { AccountRepo } from './db/repos/accountRepo';
import { FolderRepo } from './db/repos/folderRepo';
import { MessageRepo } from './db/repos/messageRepo';
import { FolderService } from './folders/folderService';
import { SessionManager } from './imap/sessionManager';
import type { Logger } from './logger';
import { ComposeService } from './smtp/composeService';
import { ScheduledService } from './smtp/scheduledService';
import { SearchService } from './search/searchService';
import { ActionService } from './messages/actionService';
import { MessageService } from './messages/messageService';
import { ConversationService } from './messages/conversationService';
import { RulesService } from './messages/rulesService';
import { ThreadBackfill } from './messages/threadBackfill';
import { ContactService } from './contacts/contactService';
import { pruneBodyCache } from './messages/bodyCache';

export interface EngineOptions {
  dataDir: string;
  send: (e: AppEvent) => void;
  secrets: SecretsClient;
  settings: () => AppSettings;
  log: Logger;
  db?: Db; // tests pass an in-memory DB
  nativeBinding?: string;
  discoverDeps?: DiscoverDeps;
  now?: () => number;
  /** Test-only: extra CA certificate trusted for IMAP TLS (fixture server). */
  imapTrustedCa?: string | Buffer;
  /** Test-only: extra CA certificate trusted for SMTP TLS. */
  smtpTrustedCa?: string | Buffer;
  smtpOverrides?: Record<string, unknown>;
  actionRetryDelaysMs?: number[];
  sendRetryDelaysMs?: number[];
  /** Pause between two scheduled messages that go out one after the other (default 2000). */
  scheduledSpacingMs?: number;
  /** Messages per batch when rules run on a folder (default 500). */
  rulesBatchSize?: number;
}

type Handlers = { [C in EngineChannel]: (req: IpcReq<C>) => Promise<IpcRes<C>> | IpcRes<C> };

export interface Engine {
  ctx: EngineContext;
  sessions: SessionManager;
  actions: ActionService;
  compose: ComposeService;
  scheduled: ScheduledService;
  rules: RulesService;
  handle(channel: string, payload: unknown): Promise<unknown>;
  /** The settings changed (the settings() callback now returns the new values). */
  applySettings(): Promise<void>;
  start(): void;
  shutdown(): Promise<void>;
  /** Test hook: resolves when messages stored before conversations existed are threaded. */
  threadsReady(): Promise<void>;
}

export function createEngine(opts: EngineOptions): Engine {
  const db =
    opts.db ?? openDatabase(join(opts.dataDir, 'mail.db'), { nativeBinding: opts.nativeBinding });
  const folders = new FolderRepo(db);
  const ctx: EngineContext = {
    dataDir: opts.dataDir,
    db,
    accounts: new AccountRepo(db),
    folders,
    messages: new MessageRepo(db),
    hub: new EventHub(opts.send, () => folders.counts()),
    secrets: opts.secrets,
    log: opts.log,
    settings: opts.settings,
    now: opts.now ?? (() => Date.now()),
    imapTrustedCa: opts.imapTrustedCa,
    smtpTrustedCa: opts.smtpTrustedCa,
    smtpOverrides: opts.smtpOverrides,
    actionRetryDelaysMs: opts.actionRetryDelaysMs,
    sendRetryDelaysMs: opts.sendRetryDelaysMs,
    scheduledSpacingMs: opts.scheduledSpacingMs,
    rulesBatchSize: opts.rulesBatchSize,
    recentMoves: new Map(),
  } as unknown as EngineContext;
  ctx.contacts = new ContactService(ctx);
  const sessions = new SessionManager(ctx);
  const accounts = new AccountService(ctx, sessions, opts.discoverDeps ?? makeNetworkDeps());
  const messages = new MessageService(ctx, sessions);
  const actions = new ActionService(ctx, sessions);
  const folderSvc = new FolderService(ctx, sessions, actions);
  const search = new SearchService(ctx, sessions);
  const compose = new ComposeService(ctx, sessions, messages, actions);
  const scheduled = new ScheduledService(ctx, sessions, compose);
  const rules = new RulesService(ctx, actions);
  const conversations = new ConversationService(ctx, messages, actions);
  const threadBackfill = new ThreadBackfill(ctx);
  ctx.hub.threadSource = {
    keysOf: (ids) => ctx.messages.threadKeysOf(ids),
    drain: () => ctx.messages.drainTouchedThreads(),
    enabled: () => ctx.settings().groupConversations === true,
  };

  const handlers: Handlers = {
    'accounts.list': () => accounts.list(),
    'accounts.discover': (r) => accounts.discover(r.email),
    'accounts.test': (r) => accounts.test(r),
    'accounts.add': (r) => accounts.add(r),
    'accounts.update': (r) => accounts.update(r),
    'accounts.updateCredentials': (r) => accounts.updateCredentials(r.accountId, r.password),
    'accounts.remove': (r) => accounts.remove(r.accountId),
    'accounts.reorder': (r) => accounts.reorder(r.orderedIds),
    'accounts.statuses': () => sessions.statuses(),

    'folders.list': (r) => folderSvc.list(r?.accountId),
    'folders.counts': () => folders.counts(),
    'folders.create': (r) => folderSvc.create(r),
    'folders.rename': (r) => folderSvc.rename(r),
    'folders.delete': (r) => folderSvc.delete(r),

    'messages.list': (r) => messages.list(r),
    'messages.get': (r) => messages.get(r.messageId),
    'messages.getHeaders': (r) => messages.getHeaders(r.messageIds),
    'messages.rawSource': (r) => messages.rawSource(r.messageId),
    'messages.apply': (r) => actions.apply(r),
    'conversations.list': (r) => conversations.list(r),
    'conversations.get': (r) => conversations.get(r),
    'conversations.act': (r) => conversations.act(r),
    'attachments.cidData': (r) => messages.cidData(r.messageId, r.contentId),

    'folders.empty': (r) => actions.emptyFolder(r.folderId),
    'messages.undo': (r) => actions.undo(r.undoToken),
    'messages.markAllRead': (r) => actions.markAllRead(r),
    'senders.allowImages': (r) => messages.allowSenderImages(r.address, r.allow),
    'senders.listAllowed': () => ctx.messages.listAllowedSenders(),
    'compose.attachData': (r) => compose.attachData(r),
    'compose.prepare': (r) => compose.prepare(r),
    'compose.discard': (r) => compose.discard(r.draftId),
    'compose.saveDraft': (r) => compose.saveDraft(r),
    'compose.send': (r) => compose.send(r),
    'drafts.retrySave': (r) => compose.retrySave(r.messageId),
    'outbox.list': () => compose.list(),
    'outbox.retry': (r) => compose.retry(r.outboxId),
    'outbox.cancel': (r) => compose.cancel(r.outboxId),

    'contacts.suggest': (r) => ctx.contacts.suggest(r.query, r.accountId, r.limit ?? 8),
    'contacts.forget': (r) => ctx.contacts.forget(r.address),

    'scheduled.create': (r) => scheduled.create(r),
    'scheduled.reschedule': (r) => scheduled.reschedule(r.id, r.sendAt),
    'scheduled.sendNow': (r) => scheduled.sendNow(r.id),
    'scheduled.cancel': (r) => scheduled.cancel(r.id),
    'scheduled.delete': (r) => scheduled.delete(r.id),
    'scheduled.list': (r) => scheduled.list(r?.accountId),
    'scheduled.get': (r) => scheduled.get(r.id),
    'scheduled.count': () => scheduled.count(),
    'scheduled.nextDue': () => scheduled.nextDue(),

    'rules.list': () => rules.list(),
    'rules.create': (r) => rules.create(r),
    'rules.update': (r) => rules.update(r.id, r.patch),
    'rules.delete': (r) => rules.delete(r.id),
    'rules.reorder': (r) => rules.reorder(r.ids),
    'rules.countMatches': (r) => rules.countMatches(r),
    'rules.runNow': (r) => rules.runNow(r),
    'rules.cancelRun': (r) => rules.cancelRun(r.runId),
    'rulesActivity.list': () => rules.activityList(),
    'rulesActivity.undo': (r) => rules.undoActivity(r.id),
    'rulesActivity.clear': () => rules.clearActivity(),

    'search.local': (r) => search.local(r),
    'search.server': (r) => search.server(r),

    'sync.account': (r) => {
      void actions.flush(r.accountId); // "Sync now" also sends waiting changes at once
      void sessions.get(r.accountId).syncAll();
    },
    'sync.folder': (r) => {
      const row = ctx.folders.row(r.folderId);
      if (!row) throw new Error('Folder not found');
      void sessions
        .get(row.account_id)
        .syncFolderById(r.folderId)
        .catch((e) => ctx.log.warn({ err: String(e?.message ?? e) }, 'sync.folder failed'));
    },
    'sync.all': () => {
      for (const id of actions.queue.accountsWithOps()) void actions.flush(id);
      void sessions.syncAll();
    },
    'sync.loadOlder': (r) => messages.loadOlder(r),

    'system.networkChanged': async (r) => {
      await sessions.setOnline(r.online);
      if (r.online) {
        compose.onOnline();
        void scheduled.recheck();
      }
    },
  };

  const internal: {
    [K in
      | 'engine.settings'
      | 'attachments.prepare'
      | 'attachments.register'
      | 'accounts.reconnect'
      | 'scheduled.recheck']: (
      req: MainToEngineMethods[K]['req'],
    ) => Promise<MainToEngineMethods[K]['res']> | MainToEngineMethods[K]['res'];
  } = {
    // Settings are read lazily through opts.settings(); a smaller cache cap trims at once.
    'engine.settings': () => cleanBodyCache(),
    'attachments.prepare': (r) => messages.prepareAttachment(r.attachmentId),
    'attachments.register': async (r) => {
      const out = [];
      for (const f of r.files) out.push(await compose.registerFile(f.path, f.filename, f.contentType));
      return out;
    },
    'accounts.reconnect': async (r) => {
      await sessions.restart(r.accountId);
      void scheduled.recheck();
    },
    // The PC woke up or was unlocked: clocks may have jumped, so look at the schedule again.
    'scheduled.recheck': () => void scheduled.recheck(),
  };

  let cacheTimer: ReturnType<typeof setInterval> | null = null;
  let cacheCleaning: Promise<void> | null = null;
  const cleanBodyCache = (): Promise<void> => {
    cacheCleaning ??= pruneBodyCache(ctx)
      .then(() => undefined)
      .catch((e) => ctx.log.warn({ err: String(e?.message ?? e) }, 'body cache cleanup failed'))
      .finally(() => {
        cacheCleaning = null;
      });
    return cacheCleaning;
  };

  return {
    ctx,
    sessions,
    actions,
    compose,
    scheduled,
    rules,
    applySettings: () => cleanBodyCache(),
    threadsReady: () => threadBackfill.whenDone(),
    async handle(channel, payload) {
      const h = (handlers as Record<string, (r: unknown) => unknown>)[channel];
      if (h) return h(payload);
      const i = (internal as Record<string, (r: unknown) => unknown>)[channel];
      if (i) return i(payload);
      throw new Error(`Unknown channel: ${channel}`);
    },
    start() {
      // Stored counts may be off (older versions): recompute them from the rows once at start.
      try {
        folders.recomputeAll();
        ctx.hub.touchCounts();
      } catch (e) {
        ctx.log.warn({ err: String((e as Error)?.message ?? e) }, 'recomputing folder counts failed');
      }
      sessions.startAll();
      // Keep downloaded mail under the size cap: once a bit after start, then every hour.
      setTimeout(() => void cleanBodyCache(), 30_000).unref();
      cacheTimer = setInterval(() => void cleanBodyCache(), 60 * 60_000);
      cacheTimer.unref();
      // Messages that were on their way when the app stopped must not be re-sent by the Outbox.
      scheduled.recoverOnStart();
      compose.start();
      scheduled.start();
      threadBackfill.start();
      // One-time learning from the headers that are already stored (runs in small chunks).
      void ctx.contacts.backfill().catch((e) =>
        ctx.log.warn({ err: String(e?.message ?? e) }, 'contacts backfill failed'),
      );
    },
    async shutdown() {
      if (cacheTimer) clearInterval(cacheTimer);
      threadBackfill.stop();
      scheduled.stop();
      ctx.contacts.stop();
      await compose.shutdown().catch(() => undefined);
      actions.stop();
      await actions.drain().catch(() => undefined);
      await sessions.shutdown();
      ctx.hub.flush();
      db.close();
    },
  };
}
