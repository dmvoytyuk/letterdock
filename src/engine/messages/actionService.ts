// Message actions (ARCHITECTURE 5.6): read/flag, move, archive, delete, spam, undo, mark all read,
// empty folder. Everything is optimistic: the local database changes first, the change is written to
// the pending queue (pendingQueue.ts), and the server follows in the background.
//   - Server unreachable / temporary error : the change stays queued and is sent later, in order, when
//     the account is online again (also after an app restart). The local change is NOT reverted.
//   - The server refuses the change        : the local change is reverted and `action:failed` raised.
//   - The message is gone on the server    : the op is dropped and the local row removed.
//   - The folder was rebuilt (UIDVALIDITY) : the message is found again by Message-ID, or dropped.
import { randomUUID } from 'node:crypto';
import type {
  ApplyActionReq,
  ApplyActionRes,
  AppError,
  FolderId,
  MarkAllReadReq,
  MessageAction,
  MessageId,
  UndoRes,
} from '../../shared/ipc';
import { UNDO_WINDOW_MS } from '../../shared/ipc';
import { AppException, toAppError } from '../../shared/errors';
import { findProviderByHost } from '../../shared/providers';
import type { ImapFlow } from 'imapflow';
import { pendingTotal, type EngineContext, type PendingOpsApi } from '../context';
import type { FolderRow, ListedFolder } from '../db/repos/folderRepo';
import { FolderOps } from '../folders/folderOps';
import type { MessageRow } from '../db/repos/messageRepo';
import type { SessionManager } from '../imap/sessionManager';
import { chunk, toSequenceSet } from '../imap/syncDiff';
import { clearCommandFailure, takeCommandFailure, type CommandFailure } from '../imap/connectionPool';
import {
  PendingQueue,
  shouldKeep,
  type DeleteOp,
  type FlagColumn,
  type FlagOp,
  type FolderOp,
  type MoveOp,
  type PendingOp,
  type RepliedOp,
} from './pendingQueue';

const UNDO_KEEP_MS = UNDO_WINDOW_MS + 30_000;
const SERVER_BATCH = 500;

/** "Try again later" answers (Gmail sends these under load): the change must wait, not be undone. */
const TRANSIENT_CODES = /^(UNAVAILABLE|SERVERBUG|THROTTLED|LIMIT|INUSE|EXPUNGEISSUED|TRYAGAIN|CONTACTADMIN)$/i;
const TRANSIENT_TEXT =
  /temporar|try again|throttl|too many|unavailable|rate limit|bandwidth|system error|internal (server )?error|server error|busy/i;

function isTransientRefusal(f: CommandFailure | undefined): boolean {
  if (!f) return false;
  return TRANSIENT_CODES.test(f.code ?? '') || TRANSIENT_TEXT.test(f.text ?? '');
}

interface MoveEntry {
  id: MessageId;
  accountId: string;
  /** Where the message is on the server (its uid there is `origUid`). */
  srcFolderId: FolderId;
  destFolderId: FolderId;
  origUid: number;
  messageIdHeader: string | null;
  /** Where undo puts it back: the folder the user saw it in before this action. */
  restoreFolderId?: FolderId;
  /** The uid to use on the server (differs from `origUid` after a UIDVALIDITY remap). */
  serverUid?: number;
}

interface MoveGroup {
  src: FolderRow;
  dest: FolderRow;
  entries: MoveEntry[];
}

interface UndoRecord {
  createdAt: number;
  entries: MoveEntry[];
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** How a batch of queued changes ended. */
type Outcome = 'done' | 'stalled';

const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;

interface Located {
  /** The folder's UIDVALIDITY changed since the uids were stored. */
  mismatch: boolean;
  /** local uid -> uid on the server now (null = the message is not there). */
  resolved: Map<number, number | null>;
}

export class ActionService implements PendingOpsApi {
  private undoStore = new Map<string, UndoRecord>();
  /** Changes waiting for the server (persisted in `pending_op`). */
  readonly queue: PendingQueue;
  /** Folder create / rename / delete / empty in the same queue (ARCHITECTURE 5.6). */
  readonly folderOps: FolderOps;
  private runners = new Map<string, Promise<void>>();
  private rerun = new Set<string>();
  /** Resolves when the batch that is being sent right now (per account) is finished. */
  private batchDone = new Map<string, Promise<void>>();
  private retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private background = new Set<Promise<void>>();
  private stopped = false;

  constructor(
    private readonly ctx: EngineContext,
    private readonly sessions: SessionManager,
  ) {
    this.queue = new PendingQueue(
      ctx.db,
      () => ctx.now(),
      (accountId) => this.queueChanged(accountId),
    );
    this.folderOps = new FolderOps(ctx, sessions, this.queue, {
      withRetry: (fn) => this.withRetry(fn),
      cancelMovesInto: (a, f) => this.cancelMovesInto(a, f),
      requireOk: (c, r, w) => this.requireOk(c as ImapFlow, r, w),
      stampMovesFrom: (a, f, p) => this.stampMovesFrom(a, f, p),
      kick: (a) => this.kick(a),
    });
    ctx.pendingOps = this;
  }

  // ---------- PendingOpsApi ----------

  count(accountId: string): number {
    return this.queue.count(accountId);
  }

  messageIdsWithFlagOps(accountId: string): Set<number> {
    return this.queue.messageIdsWithFlagOps(accountId);
  }

  serverPath(folder: FolderRow): string {
    return this.queue.serverPath(folder.account_id, folder.path, folder.delimiter);
  }

  projectFolders(accountId: string, listed: ListedFolder[]): ListedFolder[] {
    return this.folderOps.project(accountId, listed);
  }

  rememberNamespace(accountId: string, prefix: string): void {
    this.folderOps.saveNamespacePrefix(accountId, prefix);
  }

  folderGen(accountId: string): number {
    return this.folderOps.gen(accountId);
  }

  isFolderPending(accountId: string, folderId: number): boolean {
    return this.folderOps.isPending(accountId, folderId);
  }

  findMove(accountId: string, msgId: number) {
    const op = this.queue.findAnyMove(accountId, msgId);
    return op
      ? {
          srcFolderId: op.p.srcFolderId,
          origUid: op.p.origUid,
          srcUv: op.p.srcUv,
          mid: op.p.mid,
          inFlight: op.inFlight,
        }
      : undefined;
  }

  forgetAccount(accountId: string): void {
    const t = this.retryTimers.get(accountId);
    if (t) clearTimeout(t);
    this.retryTimers.delete(accountId);
    this.queue.dropAccount(accountId);
  }

  barrier(accountId: string): Promise<void> {
    return this.runners.get(accountId) ?? Promise.resolve();
  }

  /** Send the waiting changes of an account now. Resolves when the queue is empty or stuck. */
  flush(accountId: string): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const cur = this.runners.get(accountId);
    if (cur) {
      this.rerun.add(accountId); // something was added while the runner was finishing
      return cur;
    }
    if (this.queue.count(accountId) === 0) return Promise.resolve();
    const p: Promise<void> = this.runLoop(accountId).finally(() => {
      if (this.runners.get(accountId) === p) this.runners.delete(accountId);
      this.background.delete(p);
      if (this.rerun.delete(accountId)) void this.flush(accountId);
    });
    this.runners.set(accountId, p);
    this.background.add(p);
    return p;
  }

  private kick(accountId: string): void {
    void this.flush(accountId).catch(() => undefined);
  }

  private queueChanged(accountId: string): void {
    this.ctx.hub.emit({ type: 'pending:count', accountId, count: pendingTotal(this.ctx, accountId) });
    if (this.sessions.has(accountId)) this.sessions.get(accountId).refreshStatus();
  }

  /** Wait for every running server write (used by tests and on shutdown). Queued ops do not count. */
  async drain(): Promise<void> {
    while (this.background.size > 0) await Promise.allSettled([...this.background]);
  }

  /** Wait for the batch that is being sent right now (folder changes must not meet a running op). */
  async settleRunning(accountId: string): Promise<void> {
    await (this.batchDone.get(accountId) ?? Promise.resolve());
  }

  /**
   * Send the queue and wait until it is empty, stuck or cannot run (offline). Used by calls that
   * used to talk to the server directly (folder create / rename / delete / empty): online they still
   * finish before they return; offline they return at once and the change waits.
   */
  async flushAll(accountId: string): Promise<void> {
    for (let i = 0; i < 6; i++) {
      await this.flush(accountId);
      if (this.queue.count(accountId) === 0 || !this.canRun(accountId) || this.retryTimers.has(accountId)) {
        return;
      }
    }
  }

  /** Stop retrying (engine shutdown). Queued changes stay in the database for the next start. */
  stop(): void {
    this.stopped = true;
    for (const t of this.retryTimers.values()) clearTimeout(t);
    this.retryTimers.clear();
  }

  /** Run a server call, retrying temporary network errors a few times in a row. */
  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    const delays = this.ctx.actionRetryDelaysMs ?? [1000, 4000];
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (e) {
        const err = toAppError(e);
        if (!err.retryable || attempt >= delays.length) throw e;
        await sleep(delays[attempt]!);
      }
    }
  }

  /** Wait for a send that is running right now and involves these messages. */
  private async settle(ids: MessageId[]): Promise<void> {
    const accounts = new Set<string>();
    for (const id of ids) {
      const r = this.ctx.messages.row(id);
      if (r) accounts.add(r.account_id);
    }
    for (const a of accounts) {
      if (this.queue.hasInFlight(a, ids)) await (this.batchDone.get(a) ?? Promise.resolve());
    }
  }

  // ---------- entry points ----------

  async apply(req: ApplyActionReq): Promise<ApplyActionRes> {
    await this.settle(req.messageIds);
    return this.applyInternal(req.messageIds, req.action, true);
  }

  private async applyInternal(
    ids: MessageId[],
    action: MessageAction,
    withUndo: boolean,
  ): Promise<ApplyActionRes> {
    const result: ApplyActionRes = { succeeded: [], failed: [] };
    const rows: MessageRow[] = [];
    for (const id of [...new Set(ids)]) {
      const row = this.ctx.messages.row(id);
      if (row && row.flag_deleted !== 1 && this.ctx.drafts?.isLocalDraft(row.id)) {
        // A draft that is not on the server yet: delete forgets it; nothing else can be done with it.
        if (action.type === 'delete') {
          await this.ctx.drafts.discardRow(row.id);
          result.succeeded.push(row.id);
        } else if (action.type === 'markRead' || action.type === 'flag') {
          result.succeeded.push(row.id);
        } else {
          result.failed.push({
            id,
            error: toAppError(
              new AppException('NOT_FOUND', 'This draft is still being saved. Try again in a moment.', {
                retryable: true,
              }),
            ),
          });
        }
      } else if (row && row.flag_deleted !== 1) rows.push(row);
      else
        result.failed.push({
          id,
          error: toAppError(new AppException('NOT_FOUND', 'Message not found.')),
        });
    }
    switch (action.type) {
      case 'markRead':
        this.setFlag(rows, 'flag_seen', action.read, result);
        break;
      case 'flag':
        this.setFlag(rows, 'flag_flagged', action.flagged, result);
        break;
      default:
        await this.relocateRows(rows, action, result, withUndo);
    }
    return result;
  }

  // ---------- flags ----------

  private setFlag(
    rows: MessageRow[],
    column: FlagColumn,
    value: boolean,
    result: ApplyActionRes,
  ): void {
    const changed = new Set(
      this.ctx.messages.setFlagColumn(
        rows.map((r) => r.id),
        column,
        value,
      ),
    );
    const folderIds = [...new Set(rows.map((r) => r.folder_id))];
    for (const f of folderIds) this.ctx.folders.recomputeCounts(f);
    if (changed.size > 0) this.ctx.hub.changed({ folderIds, updated: [...changed] });
    result.succeeded.push(...rows.map((r) => r.id));

    const accounts = new Set<string>();
    this.ctx.db.transaction(() => {
      for (const r of rows) {
        if (!changed.has(r.id)) continue;
        this.queue.addFlag(r.account_id, {
          msgId: r.id,
          mid: r.message_id,
          folderId: r.folder_id,
          col: column,
          value,
          prev: !value,
        });
        accounts.add(r.account_id);
      }
    })();
    for (const a of accounts) this.kick(a);
  }

  // ---------- planning moves ----------

  private isGmail(accountId: string): boolean {
    const a = this.ctx.accounts.get(accountId);
    return !!a && (a.provider === 'gmail' || findProviderByHost(a.imap.host)?.id === 'gmail');
  }

  /** The archive folder; creates "Archive" when a non-Gmail account has none. */
  private async archiveFolder(accountId: string): Promise<FolderRow> {
    if (this.isGmail(accountId)) {
      // Gmail: archiving = leaving the Inbox label. Moving to All Mail does exactly that.
      const all =
        this.ctx.folders.rowByRole(accountId, 'all') ??
        this.ctx.folders.rowByPath(accountId, '[Gmail]/All Mail');
      if (!all) throw new AppException('UNSUPPORTED', 'This account has no All Mail folder.');
      return all;
    }
    const existing = this.ctx.folders.rowByRole(accountId, 'archive');
    if (existing) return existing;
    // No Archive folder yet: make it here at once and queue the create. The moves that follow wait
    // behind it, so this works offline too.
    const same = this.ctx.folders.rowByPath(accountId, `${this.folderOps.topLevelPrefix(accountId)}Archive`);
    if (same) return same;
    return this.folderOps.createLocal(accountId, null, 'Archive', 'archive');
  }

  private roleFolder(
    accountId: string,
    role: 'trash' | 'junk' | 'inbox',
    label: string,
  ): FolderRow {
    const f = this.ctx.folders.rowByRole(accountId, role);
    if (!f) throw new AppException('UNSUPPORTED', `This account has no ${label} folder.`);
    return f;
  }

  /**
   * A move that is still waiting in the queue is undone locally first (the row goes back to where
   * the server has it), so the new action starts from the real place. That is what merges
   * "A to B, then B to C" into "A to C" and cancels "A to B, then back to A".
   */
  private restoreWaitingMove(
    row: MessageRow,
    op: MoveOp,
    touched: Set<FolderId>,
    removed: MessageId[],
  ): MessageRow {
    const orig = this.ctx.folders.row(op.p.srcFolderId);
    if (!orig) throw new AppException('NOT_FOUND', 'The original folder was not found.');
    const dup = this.ctx.messages.idAt(orig.id, op.p.origUid);
    if (dup !== null && dup !== row.id) {
      this.ctx.messages.deleteById(dup);
      removed.push(dup);
    }
    touched.add(row.folder_id);
    touched.add(orig.id);
    this.ctx.messages.relocate(row.id, orig.id, op.p.origUid);
    this.queue.remove(op);
    return this.ctx.messages.row(row.id)!;
  }

  /** A folder is going away: messages whose move into it waits go back to where they came from. */
  cancelMovesInto(accountId: string, folderId: FolderId): void {
    const ops = this.queue
      .forAccount(accountId)
      .filter((o): o is MoveOp => o.kind === 'move' && !o.inFlight && o.p.destFolderId === folderId);
    if (ops.length === 0) return;
    const touched = new Set<FolderId>();
    const restored: MessageId[] = [];
    const removed: MessageId[] = [];
    for (const op of ops) {
      const row = this.ctx.messages.row(op.p.msgId);
      if (!row || row.folder_id !== folderId) {
        this.queue.remove(op);
        continue;
      }
      try {
        this.restoreWaitingMove(row, op, touched, removed);
        restored.push(row.id);
      } catch {
        // The original folder is gone too: the message cannot go back.
        this.queue.remove(op);
        this.ctx.messages.deleteById(row.id);
        removed.push(row.id);
      }
    }
    for (const f of touched) this.ctx.folders.recomputeCounts(f);
    this.ctx.hub.changed({ folderIds: [...touched], updated: restored, removed });
  }

  /** The source folder of waiting moves is deleted on this PC: remember where it is on the server. */
  stampMovesFrom(accountId: string, folderId: FolderId, serverPath: string): void {
    for (const o of this.queue.forAccount(accountId)) {
      if (o.kind === 'move' && !o.inFlight && o.p.srcFolderId === folderId) {
        o.p = { ...o.p, srcPath: serverPath };
        this.queue.persistPayload(o);
      }
    }
  }

  private async relocateRows(
    rows: MessageRow[],
    action: MessageAction,
    result: ApplyActionRes,
    withUndo: boolean,
  ): Promise<void> {
    const groups = new Map<string, MoveGroup>();
    const permanent = new Map<FolderId, { src: FolderRow; rows: MessageRow[] }>();
    const archiveCache = new Map<string, Promise<FolderRow>>();
    // Rows put back from a waiting move (they are reported as changed even if nothing else happens).
    const restored: MessageId[] = [];
    const restoredFolders = new Set<FolderId>();
    const removedDups: MessageId[] = [];

    for (const original of rows) {
      let row = original;
      const visibleFolderId = original.folder_id;
      try {
        const waiting = this.queue.findMove(row.account_id, row.id);
        if (waiting) {
          row = this.restoreWaitingMove(row, waiting, restoredFolders, removedDups);
          restored.push(row.id);
        }
        const src = this.ctx.folders.row(row.folder_id);
        if (!src) throw new AppException('NOT_FOUND', 'Folder not found.');
        let dest: FolderRow | null = null;
        switch (action.type) {
          case 'move': {
            dest = this.ctx.folders.row(action.destFolderId);
            if (!dest) throw new AppException('NOT_FOUND', 'The destination folder was not found.');
            if (dest.account_id !== row.account_id) {
              throw new AppException(
                'INVALID_INPUT',
                'Messages can only be moved within the same account.',
              );
            }
            if (dest.selectable !== 1) {
              throw new AppException('INVALID_INPUT', 'You cannot move messages into this folder.');
            }
            break;
          }
          case 'archive': {
            const gmail = this.isGmail(row.account_id);
            if (src.role === 'archive' || (gmail && src.role === 'all')) break; // already archived
            let p = archiveCache.get(row.account_id);
            if (!p) {
              p = this.archiveFolder(row.account_id);
              archiveCache.set(row.account_id, p);
            }
            dest = await p;
            break;
          }
          case 'delete': {
            const trash = this.ctx.folders.rowByRole(row.account_id, 'trash');
            if (src.role === 'trash' || !trash) {
              const g = permanent.get(src.id) ?? { src, rows: [] };
              g.rows.push(row);
              permanent.set(src.id, g);
              continue;
            }
            dest = trash;
            break;
          }
          case 'spam':
            if (src.role === 'junk') break;
            dest = this.roleFolder(row.account_id, 'junk', 'Junk');
            break;
          case 'notSpam':
            if (src.role !== 'junk') {
              throw new AppException('INVALID_INPUT', 'This message is not in the Junk folder.');
            }
            dest = this.roleFolder(row.account_id, 'inbox', 'Inbox');
            break;
          default:
            throw new AppException('INVALID_INPUT', 'Unknown action.');
        }
        if (!dest || dest.id === src.id) {
          result.succeeded.push(row.id); // nothing to do (or back where the server has it)
          continue;
        }
        const key = `${src.id}>${dest.id}`;
        const g = groups.get(key) ?? { src, dest, entries: [] };
        g.entries.push({
          id: row.id,
          accountId: row.account_id,
          srcFolderId: src.id,
          destFolderId: dest.id,
          origUid: row.uid,
          messageIdHeader: row.message_id,
          restoreFolderId: visibleFolderId !== src.id ? visibleFolderId : undefined,
        });
        groups.set(key, g);
      } catch (e) {
        result.failed.push({ id: original.id, error: toAppError(e) });
      }
    }

    // Optimistic local change.
    const allEntries: MoveEntry[] = [];
    const accounts = new Set<string>();
    this.ctx.db.transaction(() => {
      for (const g of groups.values()) {
        for (const e of g.entries) {
          this.ctx.messages.relocate(e.id, g.dest.id, -e.id); // placeholder uid until the server answers
          if (e.messageIdHeader) {
            this.ctx.recentMoves.set(`${e.accountId}|${e.messageIdHeader}`, this.ctx.now());
          }
          this.queue.addMove(e.accountId, {
            msgId: e.id,
            mid: e.messageIdHeader,
            srcFolderId: g.src.id,
            destFolderId: g.dest.id,
            origUid: e.origUid,
            srcUv: this.ctx.folders.syncState(g.src.id)?.uidvalidity ?? null,
          });
          accounts.add(e.accountId);
        }
      }
      for (const g of permanent.values()) {
        const ids = g.rows.map((r) => r.id);
        this.ctx.messages.setFlagColumn(ids, 'flag_deleted', true);
        const uv = this.ctx.folders.syncState(g.src.id)?.uidvalidity ?? null;
        for (const r of g.rows) {
          this.queue.addDelete(r.account_id, {
            msgId: r.id,
            mid: r.message_id,
            folderId: g.src.id,
            uv,
          });
          accounts.add(r.account_id);
        }
      }
    })();
    for (const g of groups.values()) {
      this.ctx.folders.recomputeCounts(g.src.id);
      this.ctx.folders.recomputeCounts(g.dest.id);
      this.ctx.hub.changed({
        folderIds: [g.src.id, g.dest.id],
        updated: g.entries.map((e) => e.id),
      });
      result.succeeded.push(...g.entries.map((e) => e.id));
      allEntries.push(...g.entries);
    }
    for (const g of permanent.values()) {
      const ids = g.rows.map((r) => r.id);
      this.ctx.folders.recomputeCounts(g.src.id);
      this.ctx.hub.changed({ folderIds: [g.src.id], removed: ids });
      result.succeeded.push(...ids);
    }
    if (restored.length > 0 || removedDups.length > 0) {
      for (const f of restoredFolders) this.ctx.folders.recomputeCounts(f);
      this.ctx.hub.changed({
        folderIds: [...restoredFolders],
        updated: restored,
        removed: removedDups,
      });
    }

    if (withUndo && allEntries.length > 0) {
      this.purgeUndo();
      const token = randomUUID();
      this.undoStore.set(token, { createdAt: this.ctx.now(), entries: allEntries });
      result.undoToken = token;
    }

    for (const a of accounts) this.kick(a);
  }

  // ---------- sending the queue ----------

  /** The connection is up, so commands can be sent. */
  private canRun(accountId: string): boolean {
    return this.sessions.has(accountId) && this.sessions.get(accountId).isReady();
  }

  private async runLoop(accountId: string): Promise<void> {
    if (this.stopped) return;
    for (;;) {
      if (this.stopped || !this.canRun(accountId)) return;
      const batch = this.queue.nextBatch(accountId);
      if (batch.length === 0) return;
      this.queue.setInFlight(batch, true);
      let release!: () => void;
      this.batchDone.set(
        accountId,
        new Promise<void>((r) => {
          release = r;
        }),
      );
      let outcome: Outcome;
      try {
        outcome = await this.executeBatch(accountId, batch);
      } catch (e) {
        // A bug or an unexpected failure: keep the changes, count the try, try again later.
        this.ctx.log.warn({ err: String((e as Error)?.message ?? e) }, 'queued change failed');
        this.queue.noteFailure(batch, String((e as Error)?.message ?? e));
        outcome = 'stalled';
      } finally {
        this.queue.setInFlight(batch, false);
        this.batchDone.delete(accountId);
        release();
      }
      if (outcome === 'stalled') {
        this.scheduleRetry(accountId, batch);
        return;
      }
    }
  }

  private scheduleRetry(accountId: string, batch: readonly PendingOp[]): void {
    if (this.stopped || this.retryTimers.has(accountId)) return;
    const tries = Math.max(1, ...batch.map((o) => o.attempts));
    const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (tries - 1));
    const t = setTimeout(() => {
      this.retryTimers.delete(accountId);
      this.kick(accountId);
    }, delay);
    t.unref?.();
    this.retryTimers.set(accountId, t);
  }

  private executeBatch(accountId: string, batch: PendingOp[]): Promise<Outcome> {
    switch (batch[0]!.kind) {
      case 'flag':
        return this.execFlags(accountId, batch as FlagOp[]);
      case 'move':
        return this.execMoves(accountId, batch as MoveOp[]);
      case 'delete':
        return this.execDeletes(accountId, batch as DeleteOp[]);
      case 'replied':
        return this.execReplied(accountId, batch as RepliedOp[]);
      default:
        return this.folderOps.exec(accountId, batch[0] as FolderOp);
    }
  }

  /** The row an op is about; found again by Message-ID if its id is gone. */
  private resolveRow(msgId: number, folderId: number, mid: string | null): MessageRow | null {
    const r = this.ctx.messages.row(msgId);
    if (r) return r;
    if (mid) {
      const id = this.ctx.messages.idsByMessageId(folderId, mid)[0];
      if (id !== undefined) return this.ctx.messages.row(id);
    }
    return null;
  }

  /**
   * imapflow does not throw when a command is refused: it returns `false`. Turn that into an error:
   * a lost connection or a "try again later" answer is temporary (the change waits), any other
   * refusal by the server is final.
   */
  private requireOk(c: ImapFlow, result: unknown, what: string): void {
    if (result !== false) return;
    this.refuse(c, what, takeCommandFailure(c));
  }

  /** Throw the right error for a refused command, and log what the server said. */
  private refuse(c: ImapFlow, what: string, f: CommandFailure | undefined): never {
    if (!c.usable) {
      throw new AppException('HOST_UNREACHABLE', 'The connection to the server was lost.');
    }
    const reason = [f?.code ? `[${f.code}]` : '', f?.text ?? ''].filter(Boolean).join(' ');
    const transient = isTransientRefusal(f);
    this.ctx.log.warn(
      { what, status: f?.status, code: f?.code, text: f?.text, command: f?.command, transient },
      'server refused a command',
    );
    throw new AppException(
      'SERVER_REJECTED',
      `The server did not accept the ${what}.${reason ? ` It said: ${reason}` : ''}`,
      { retryable: transient, ...(reason ? { details: reason } : {}) },
    );
  }

  /**
   * Send one command for a set of UIDs. When the server refuses it, find out why before giving up:
   * - some of the messages are gone from the folder (moved or deleted by another client, or by an
   *   earlier change): leave them out, remember them in `vanished`, and send the command again;
   * - the target folder is missing ([TRYCREATE]): create it once and send again;
   * - anything else is a real refusal.
   * Returns the answer of the command, or undefined when every message turned out to be gone.
   */
  private async sendToUids<R>(
    c: ImapFlow,
    uids: number[],
    what: string,
    vanished: Set<number>,
    send: (set: string) => Promise<R | false>,
    createPath?: string,
  ): Promise<R | undefined> {
    let remaining = [...uids];
    let created = false;
    for (;;) {
      if (remaining.length === 0) return undefined;
      clearCommandFailure(c);
      const res = await send(toSequenceSet(remaining));
      if (res !== false) return res;
      const f = takeCommandFailure(c);
      if (!c.usable) this.refuse(c, what, f);
      const found = await c.search({ uid: toSequenceSet(remaining) }, { uid: true });
      if (found === false) this.refuse(c, what, takeCommandFailure(c) ?? f);
      const present = new Set(found);
      const still = remaining.filter((u) => present.has(u));
      if (still.length < remaining.length) {
        for (const u of remaining) if (!present.has(u)) vanished.add(u);
        this.ctx.log.info(
          { what, gone: remaining.length - still.length, left: still.length, code: f?.code, text: f?.text },
          'messages are gone from the server folder; skipped',
        );
        remaining = still;
        continue;
      }
      if (createPath && !created && /TRYCREATE|NONEXISTENT/i.test(f?.code ?? '')) {
        created = true;
        try {
          await c.mailboxCreate(createPath);
        } catch {
          /* already there, or not allowed: the next try tells */
        }
        continue;
      }
      this.refuse(c, what, f);
    }
  }

  /** Mark the messages the server no longer has as "not there". */
  private markVanished(l: Located, vanished: Set<number>): void {
    if (vanished.size === 0) return;
    for (const [k, v] of l.resolved) if (v !== null && vanished.has(v)) l.resolved.set(k, null);
  }

  /**
   * Check, in the folder on the server, where each message is now:
   * - same UIDVALIDITY: the uid itself (or null when the message is gone from the server);
   * - changed UIDVALIDITY: looked up by Message-ID (null when not found).
   */
  private async locate(
    c: ImapFlow,
    folder: FolderRow,
    items: { uid: number; mid: string | null }[],
    expectedUv: number | null,
  ): Promise<Located> {
    const mb = await c.mailboxOpen(this.queue.serverPath(folder.account_id, folder.path, folder.delimiter)); // read-write
    const mismatch = expectedUv !== null && Number(mb.uidValidity) !== expectedUv;
    const resolved = new Map<number, number | null>();
    if (!mismatch) {
      const existing = new Set<number>();
      for (const part of chunk(items.map((i) => i.uid), SERVER_BATCH)) {
        const found = await c.search({ uid: toSequenceSet(part) }, { uid: true });
        this.requireOk(c, found, 'request');
        for (const u of found || []) existing.add(u);
      }
      for (const it of items) resolved.set(it.uid, existing.has(it.uid) ? it.uid : null);
    } else {
      for (const it of items) {
        let uid: number | null = null;
        if (it.mid) {
          const found = await c.search({ header: { 'message-id': it.mid } }, { uid: true });
          this.requireOk(c, found, 'request');
          const list = found || [];
          uid = list.length > 0 ? list[list.length - 1]! : null;
        }
        resolved.set(it.uid, uid);
      }
    }
    return { mismatch, resolved };
  }

  /** Remove ops (and optionally their local rows) for messages that are gone or cannot be found. */
  private dropOps(
    accountId: string,
    ops: readonly PendingOp[],
    rowIds: MessageId[],
    reason: 'gone' | 'uidvalidity' | null,
  ): void {
    if (ops.length === 0) return;
    this.queue.removeMany(ops);
    const folderIds = new Set<FolderId>();
    const removed: MessageId[] = [];
    for (const id of rowIds) {
      const row = this.ctx.messages.row(id);
      if (!row) continue;
      folderIds.add(row.folder_id);
      this.ctx.messages.deleteById(id);
      removed.push(id);
    }
    if (removed.length > 0) {
      for (const f of folderIds) this.ctx.folders.recomputeCounts(f);
      this.ctx.hub.changed({ folderIds: [...folderIds], removed });
    }
    if (reason) {
      this.ctx.hub.emit({ type: 'pending:dropped', accountId, count: ops.length, reason });
    }
  }

  /** A batch failed. Temporary problem: keep it. Final refusal: undo it locally and tell the UI. */
  private batchError(
    ops: PendingOp[],
    err: AppError,
    ids: MessageId[],
    revert: () => void,
    kindOverride?: 'delete',
  ): Outcome {
    if (shouldKeep(err, ops)) {
      this.ctx.log.info({ code: err.code, ops: ops.length }, 'change kept for later');
      this.queue.noteFailure(ops, err.message);
      return 'stalled';
    }
    this.ctx.log.warn(
      {
        code: err.code,
        ops: ops.length,
        kind: ops[0]!.kind,
        folders: this.opFolders(ops),
        uids: this.opUids(ops),
        reason: err.details ?? err.message,
      },
      'server refused a change; reverting',
    );
    revert();
    this.queue.removeMany(ops);
    const first = ops[0]!;
    this.ctx.hub.emit({
      type: 'action:failed',
      messageIds: ids,
      error: err,
      accountId: first.accountId,
      kind:
        kindOverride ??
        (first.kind === 'flag'
          ? first.p.col === 'flag_seen'
            ? 'read'
            : 'flag'
          : first.kind === 'move' || first.kind === 'delete'
            ? first.kind
            : undefined),
    });
    return 'done';
  }

  /** Folder paths an op batch is about (for the log). */
  private opFolders(ops: readonly PendingOp[]): string[] {
    const ids = new Set<number>();
    for (const o of ops) {
      if (o.kind === 'move') {
        ids.add(o.p.srcFolderId);
        ids.add(o.p.destFolderId);
      } else if (o.kind === 'flag' || o.kind === 'delete') ids.add(o.p.folderId);
    }
    return [...ids].map((id) => this.ctx.folders.row(id)?.path ?? `#${id}`);
  }

  /** Server uids an op batch is about (for the log). */
  private opUids(ops: readonly PendingOp[]): number[] {
    const out: number[] = [];
    for (const o of ops) {
      if (o.kind === 'move') out.push(o.p.origUid);
      else if (o.kind === 'flag' || o.kind === 'delete') {
        const r = this.ctx.messages.row(o.p.msgId);
        if (r) out.push(r.uid);
      }
    }
    return out.slice(0, 20);
  }

  // ----- flags -----

  private async execFlags(accountId: string, ops: FlagOp[]): Promise<Outcome> {
    const { col, value } = ops[0]!.p;
    const imapFlag = col === 'flag_seen' ? '\\Seen' : '\\Flagged';
    interface Item {
      op: FlagOp;
      row: MessageRow;
    }
    const byFolder = new Map<FolderId, Item[]>();
    const lost: FlagOp[] = [];
    for (const op of ops) {
      const row = this.resolveRow(op.p.msgId, op.p.folderId, op.p.mid);
      if (!row || row.uid <= 0) lost.push(op);
      else byFolder.set(row.folder_id, [...(byFolder.get(row.folder_id) ?? []), { op, row }]);
    }
    this.dropOps(accountId, lost, [], null);

    for (const [folderId, items] of byFolder) {
      const folder = this.ctx.folders.row(folderId);
      if (!folder) {
        this.dropOps(accountId, items.map((i) => i.op), [], null);
        continue;
      }
      const expectedUv = this.ctx.folders.syncState(folderId)?.uidvalidity ?? null;
      let loc: Located;
      try {
        loc = await this.withRetry(() =>
          this.sessions.get(accountId).run('user', async (c) => {
            const l = await this.locate(
              c,
              folder,
              items.map((i) => ({ uid: i.row.uid, mid: i.row.message_id })),
              expectedUv,
            );
            const uids = items
              .map((i) => l.resolved.get(i.row.uid))
              .filter((u): u is number => typeof u === 'number');
            const vanished = new Set<number>();
            for (const part of chunk(uids, SERVER_BATCH)) {
              await this.sendToUids(c, part, 'change', vanished, (set) =>
                value
                  ? c.messageFlagsAdd(set, [imapFlag], { uid: true })
                  : c.messageFlagsRemove(set, [imapFlag], { uid: true }),
              );
            }
            this.markVanished(l, vanished);
            return l;
          }),
        );
      } catch (e) {
        const outcome = this.batchError(
          items.map((i) => i.op),
          toAppError(e),
          items.map((i) => i.row.id),
          () => {
            const ids = items.map((i) => i.row.id);
            this.ctx.messages.setFlagColumn(ids, col, !value);
            this.ctx.folders.recomputeCounts(folderId);
            this.ctx.hub.changed({ folderIds: [folderId], updated: ids });
          },
        );
        if (outcome === 'stalled') return 'stalled';
        continue;
      }
      const gone = items.filter((i) => loc.resolved.get(i.row.uid) == null);
      this.queue.removeMany(items.filter((i) => !gone.includes(i)).map((i) => i.op));
      this.dropOps(
        accountId,
        gone.map((i) => i.op),
        gone.map((i) => i.row.id),
        gone.length > 0 ? (loc.mismatch ? 'uidvalidity' : 'gone') : null,
      );
    }
    return 'done';
  }

  // ----- moves -----

  private async execMoves(accountId: string, ops: MoveOp[]): Promise<Outcome> {
    const first = ops[0]!.p;
    const dest = this.ctx.folders.row(first.destFolderId);
    let src = this.ctx.folders.row(first.srcFolderId);
    if (!src && dest && first.srcPath) {
      // The source folder was deleted on this PC after the move was queued: the server still has it.
      src = { ...dest, id: first.srcFolderId, path: first.srcPath };
    }
    if (!src || !dest) {
      this.dropOps(accountId, ops, [], null);
      return 'done';
    }
    const entries: MoveEntry[] = [];
    const stale: MoveOp[] = [];
    const opOf = new Map<MoveEntry, MoveOp>();
    for (const op of ops) {
      const row = this.ctx.messages.row(op.p.msgId);
      if (!row || row.folder_id !== dest.id) {
        stale.push(op); // the row changed in the meantime: nothing sensible to send
        continue;
      }
      const e: MoveEntry = {
        id: row.id,
        accountId,
        srcFolderId: src.id,
        destFolderId: dest.id,
        origUid: op.p.origUid,
        messageIdHeader: op.p.mid,
      };
      entries.push(e);
      opOf.set(e, op);
    }
    this.dropOps(accountId, stale, [], null);
    if (entries.length === 0) return 'done';
    // The moved message will show up in the destination: it is not "new mail" (the optimistic
    // entry may be old when the move waited a long time in the queue).
    for (const e of entries) {
      if (e.messageIdHeader) this.ctx.recentMoves.set(`${accountId}|${e.messageIdHeader}`, this.ctx.now());
    }

    const g: MoveGroup = { src, dest, entries };
    const uidMap = new Map<number, number>();
    let loc: Located;
    try {
      loc = await this.withRetry(() =>
        this.sessions.get(accountId).run('user', async (c) => {
          const l = await this.locate(
            c,
            src,
            entries.map((e) => ({ uid: e.origUid, mid: e.messageIdHeader })),
            first.srcUv,
          );
          const live = entries
            .map((e) => l.resolved.get(e.origUid))
            .filter((u): u is number => typeof u === 'number');
          const destPath = this.queue.serverPath(accountId, dest.path, dest.delimiter);
          const vanished = new Set<number>();
          for (const part of chunk(live, SERVER_BATCH)) {
            const res = await this.sendToUids(
              c,
              part,
              'move',
              vanished,
              (set) =>
                c.messageMove(set, destPath, { uid: true }) as Promise<
                  { uidMap?: Map<number, number> } | false
                >,
              destPath,
            );
            if (res && res.uidMap) for (const [from, to] of res.uidMap) uidMap.set(from, to);
          }
          this.markVanished(l, vanished);
          return l;
        }),
      );
    } catch (e) {
      return this.batchError(
        entries.map((x) => opOf.get(x)!),
        toAppError(e),
        entries.map((x) => x.id),
        () => this.revertMove(g),
        dest.role === 'trash' ? 'delete' : undefined,
      );
    }
    const gone = entries.filter((e) => loc.resolved.get(e.origUid) == null);
    const live = entries.filter((e) => !gone.includes(e));
    for (const e of live) e.serverUid = loc.resolved.get(e.origUid) ?? e.origUid;
    this.queue.removeMany(live.map((e) => opOf.get(e)!));
    this.dropOps(
      accountId,
      gone.map((e) => opOf.get(e)!),
      gone.map((e) => e.id),
      gone.length > 0 ? (loc.mismatch ? 'uidvalidity' : 'gone') : null,
    );
    if (live.length > 0) this.finalizeMove({ src, dest, entries: live }, uidMap, accountId);
    return 'done';
  }

  /** The server did the move: swap the placeholder uid for the real one. */
  private finalizeMove(g: MoveGroup, uidMap: Map<number, number>, accountId: string): void {
    const { src, dest, entries } = g;
    const removed: MessageId[] = [];
    const unmapped: MoveEntry[] = [];
    for (const e of entries) {
      const row = this.ctx.messages.row(e.id);
      if (!row || row.folder_id !== dest.id) continue; // changed again meanwhile
      // A sync may have noticed the message in both places before we finished: drop the extras.
      for (const stale of this.ctx.messages.deleteByUids(src.id, [e.origUid])) removed.push(stale);
      const newUid = uidMap.get(e.serverUid ?? e.origUid);
      if (newUid === undefined) {
        unmapped.push(e);
        continue;
      }
      const dup = this.ctx.messages.idAt(dest.id, newUid);
      if (dup !== null && dup !== e.id) {
        this.ctx.messages.deleteById(dup);
        removed.push(dup);
      }
      this.ctx.messages.relocate(e.id, dest.id, newUid);
    }
    if (unmapped.length > 0) {
      // No UIDPLUS: we cannot know the new UID. Let the next sync of the destination find it.
      const gone = unmapped.map((e) => e.id);
      for (const id of gone) this.ctx.messages.deleteById(id);
      removed.push(...gone);
      void this.sessions
        .get(accountId)
        .syncFolderById(dest.id)
        .catch(() => undefined);
    }
    this.ctx.folders.recomputeCounts(src.id);
    this.ctx.folders.recomputeCounts(dest.id);
    this.ctx.hub.changed({
      folderIds: [src.id, dest.id],
      updated: entries.filter((e) => !removed.includes(e.id)).map((e) => e.id),
      removed,
    });
  }

  /** The server refused the move for good: put the rows back where they were. */
  private revertMove(g: MoveGroup): void {
    const { src, dest, entries } = g;
    const removed: MessageId[] = [];
    for (const e of entries) {
      const row = this.ctx.messages.row(e.id);
      if (!row || row.folder_id !== dest.id) continue;
      const dup = this.ctx.messages.idAt(src.id, e.origUid);
      if (dup !== null && dup !== e.id) {
        this.ctx.messages.deleteById(dup);
        removed.push(dup);
      }
      this.ctx.messages.relocate(e.id, src.id, e.origUid);
    }
    this.ctx.folders.recomputeCounts(src.id);
    this.ctx.folders.recomputeCounts(dest.id);
    this.ctx.hub.changed({
      folderIds: [src.id, dest.id],
      updated: entries.map((e) => e.id),
      removed,
    });
  }

  // ----- permanent delete -----

  private async execDeletes(accountId: string, ops: DeleteOp[]): Promise<Outcome> {
    interface Item {
      op: DeleteOp;
      row: MessageRow;
    }
    const byFolder = new Map<FolderId, Item[]>();
    const lost: DeleteOp[] = [];
    for (const op of ops) {
      const row = this.resolveRow(op.p.msgId, op.p.folderId, op.p.mid);
      if (!row || row.uid <= 0) lost.push(op);
      else byFolder.set(row.folder_id, [...(byFolder.get(row.folder_id) ?? []), { op, row }]);
    }
    // Already gone locally: nothing left to delete.
    this.dropOps(accountId, lost, [], null);

    for (const [folderId, items] of byFolder) {
      const folder = this.ctx.folders.row(folderId);
      if (!folder) {
        this.dropOps(accountId, items.map((i) => i.op), items.map((i) => i.row.id), null);
        continue;
      }
      const uv = items[0]!.op.p.uv;
      try {
        await this.withRetry(() =>
          this.sessions.get(accountId).run('user', async (c) => {
            const l = await this.locate(
              c,
              folder,
              items.map((i) => ({ uid: i.row.uid, mid: i.row.message_id })),
              uv,
            );
            const uids = items
              .map((i) => l.resolved.get(i.row.uid))
              .filter((u): u is number => typeof u === 'number');
            const vanished = new Set<number>();
            for (const part of chunk(uids, SERVER_BATCH)) {
              await this.sendToUids(c, part, 'delete', vanished, (set) =>
                c.messageDelete(set, { uid: true }),
              );
            }
          }),
        );
      } catch (e) {
        const outcome = this.batchError(
          items.map((i) => i.op),
          toAppError(e),
          items.map((i) => i.row.id),
          () => {
            const ids = items.map((i) => i.row.id);
            this.ctx.messages.setFlagColumn(ids, 'flag_deleted', false);
            this.ctx.folders.recomputeCounts(folderId);
            this.ctx.hub.changed({ folderIds: [folderId], added: ids });
          },
        );
        if (outcome === 'stalled') return 'stalled';
        continue;
      }
      // Deleted (or it was gone already): either way the message is finished.
      this.dropOps(accountId, items.map((i) => i.op), items.map((i) => i.row.id), null);
      this.ctx.folders.recomputeCounts(folderId);
      this.ctx.hub.touchCounts();
    }
    return 'done';
  }


  // ---------- undo ----------

  private purgeUndo(): void {
    const now = this.ctx.now();
    for (const [k, v] of this.undoStore) {
      if (now - v.createdAt > UNDO_KEEP_MS) this.undoStore.delete(k);
    }
  }

  async undo(token: string): Promise<UndoRes> {
    this.purgeUndo();
    const rec = this.undoStore.get(token);
    if (!rec) throw new AppException('NOT_FOUND', 'This can no longer be undone.');
    this.undoStore.delete(token);
    await this.settle(rec.entries.map((e) => e.id));

    // Put each message back into its original folder. Ids are normally unchanged.
    const bySrc = new Map<FolderId, MessageId[]>();
    for (const e of rec.entries) {
      let id: MessageId | null = null;
      const row = this.ctx.messages.row(e.id);
      if (row && row.folder_id === e.destFolderId) id = row.id;
      else if (e.messageIdHeader) {
        // The id was lost (server gave no UID mapping): find it again by Message-ID.
        const find = () => this.ctx.messages.idsByMessageId(e.destFolderId, e.messageIdHeader!)[0];
        id = find() ?? null;
        if (id === null) {
          await this.sessions
            .get(e.accountId)
            .syncFolderById(e.destFolderId)
            .catch(() => undefined);
          id = find() ?? null;
        }
      }
      const target = e.restoreFolderId ?? e.srcFolderId;
      if (id !== null) bySrc.set(target, [...(bySrc.get(target) ?? []), id]);
    }
    const restored: MessageId[] = [];
    for (const [srcFolderId, ids] of bySrc) {
      const res = await this.applyInternal(ids, { type: 'move', destFolderId: srcFolderId }, false);
      restored.push(...res.succeeded);
    }
    if (restored.length === 0) {
      throw new AppException('NOT_FOUND', 'The messages could not be found to restore.');
    }
    return { restored };
  }

  // ---------- bulk ----------

  async markAllRead(req: MarkAllReadReq): Promise<{ count: number }> {
    const ids = this.ctx.messages.unreadIds(req.scope);
    if (ids.length === 0) return { count: 0 };
    const res = await this.applyInternal(ids, { type: 'markRead', read: true }, false);
    return { count: res.succeeded.length };
  }

  /**
   * Permanently delete everything in Trash or Junk (the UI asks first). The rows are hidden at
   * once and one op in the queue empties the folder on the server, after every move into it that
   * is still waiting. Online the call returns when the server did it; offline it returns at once.
   */
  async emptyFolder(folderId: FolderId): Promise<{ deleted: number }> {
    const folder = this.ctx.folders.row(folderId);
    if (!folder) throw new AppException('NOT_FOUND', 'Folder not found.');
    if (folder.role !== 'trash' && folder.role !== 'junk') {
      throw new AppException('INVALID_INPUT', 'Only Trash and Junk can be emptied.');
    }
    await this.settleRunning(folder.account_id);
    const deleted = this.folderOps.emptyLocal(folder);
    await this.flushAll(folder.account_id);
    const err = this.folderOps.takeError(folderId);
    if (err) throw new AppException(err.code, err.message, { retryable: false });
    return { deleted };
  }

  /**
   * Marks the source of a reply / forward on the server and locally (after a successful send). The
   * mark is queued: it is sent after a move of that message that still waits, and after a restart.
   */
  markReplied(rowId: MessageId, kind: 'answered' | 'forwarded'): void {
    const row = this.ctx.messages.row(rowId);
    if (!row) return;
    if (kind === 'answered') {
      this.ctx.messages.setFlagColumn([rowId], 'flag_answered', true);
      this.ctx.hub.changed({ folderIds: [row.folder_id], updated: [rowId] });
    }
    this.queue.addRaw(row.account_id, 'replied', {
      msgId: row.id,
      mid: row.message_id,
      folderId: row.folder_id,
      flag: kind === 'answered' ? '\\Answered' : '$Forwarded',
    });
    this.kick(row.account_id);
  }

  /** Set the Answered / Forwarded flag. Best effort: a final refusal just drops the mark. */
  private async execReplied(accountId: string, ops: RepliedOp[]): Promise<Outcome> {
    const op = ops[0]!;
    const row = this.resolveRow(op.p.msgId, op.p.folderId, op.p.mid);
    const folder = row ? this.ctx.folders.row(row.folder_id) : null;
    if (!row || row.uid <= 0 || !folder) {
      this.dropOps(accountId, ops, [], null);
      return 'done';
    }
    const expectedUv = this.ctx.folders.syncState(folder.id)?.uidvalidity ?? null;
    try {
      await this.withRetry(() =>
        this.sessions.get(accountId).run('user', async (c) => {
          const l = await this.locate(c, folder, [{ uid: row.uid, mid: row.message_id }], expectedUv);
          const uid = l.resolved.get(row.uid);
          if (typeof uid === 'number') {
            this.requireOk(c, await c.messageFlagsAdd(String(uid), [op.p.flag], { uid: true }), 'change');
          }
        }),
      );
    } catch (e) {
      const err = toAppError(e);
      if (shouldKeep(err, ops)) {
        this.queue.noteFailure(ops, err.message);
        return 'stalled';
      }
      this.ctx.log.debug({ code: err.code }, 'mark replied refused; dropped');
    }
    this.queue.removeMany(ops);
    return 'done';
  }
}
