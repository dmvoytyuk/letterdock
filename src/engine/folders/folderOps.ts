// Folder changes in the offline queue (ARCHITECTURE 5.6): create, rename, delete, empty.
//
// Like message actions, a folder change is done on this PC at once (optimistic) and written to the
// pending queue; the server follows in order when the account is online. This file holds
//   - the local half (change the database, queue the op, merge it with waiting ops),
//   - the server half (send one op, handle conflicts),
//   - `project`: the folder list from the server with the waiting changes applied, so that a folder
//     refresh cannot undo them.
//
// Rules that keep this simple:
//   - A local folder keeps its row id for its whole life. Ops and moves refer to the id, so a move
//     into a folder that is still only local is sent after the create (queue order) and uses the
//     real path then.
//   - A folder is "pending" while a create or rename op for it waits.
//   - Ops carry the path the SERVER has when the op runs (`fromPath`, `path`).
//   - A new op is merged into the newest waiting folder op only (so order never changes).
import type { AppError, FolderId, FolderRole, MessageId } from '../../shared/ipc';
import { AppException, toAppError } from '../../shared/errors';
import type { EngineContext } from '../context';
import type { FolderRow, ListedFolder } from '../db/repos/folderRepo';
import type { SessionManager } from '../imap/sessionManager';
import {
  shouldKeep,
  type FolderCreateOp,
  type FolderDeleteOp,
  type FolderEmptyOp,
  type FolderOp,
  type FolderRenameOp,
  type PendingQueue,
} from '../messages/pendingQueue';

export type FolderOutcome = 'done' | 'stalled';

/** What FolderOps needs from the action service. */
export interface FolderOpsHost {
  withRetry<T>(fn: () => Promise<T>): Promise<T>;
  /** Put messages back whose move into this folder waits (the folder is going away). */
  cancelMovesInto(accountId: string, folderId: FolderId): void;
  /** `requireOk` of the action service: a `false` answer from imapflow becomes an error. */
  requireOk(c: unknown, result: unknown, what: string): void;
  /** Mark waiting moves out of this folder with the server path (the row is about to be removed). */
  stampMovesFrom(accountId: string, folderId: FolderId, serverPath: string): void;
  kick(accountId: string): void;
}

const leafOf = (path: string, delimiter: string | null): string =>
  delimiter && path.includes(delimiter) ? path.slice(path.lastIndexOf(delimiter) + delimiter.length) : path;

const parentPath = (path: string, delimiter: string | null): string | null => {
  if (!delimiter) return null;
  const i = path.lastIndexOf(delimiter);
  return i > 0 ? path.slice(0, i) : null;
};

const NS_KEY = (accountId: string) => `nsprefix:${accountId}`;

export class FolderOps {
  /** Counts finished folder ops per account (see PendingOpsApi.folderGen). */
  private gens = new Map<string, number>();
  /** The last final refusal per folder, for the call that is waiting for the result. */
  private errors = new Map<string, AppError>();

  constructor(
    private readonly ctx: EngineContext,
    private readonly sessions: SessionManager,
    private readonly queue: PendingQueue,
    private readonly host: FolderOpsHost,
  ) {}

  // ---------- small helpers ----------

  gen(accountId: string): number {
    return this.gens.get(accountId) ?? 0;
  }

  private bump(accountId: string): void {
    this.gens.set(accountId, this.gen(accountId) + 1);
  }

  /** The error that made the server refuse this op for good (read once). */
  takeError(key: string | number): AppError | undefined {
    const k = String(key);
    const e = this.errors.get(k);
    this.errors.delete(k);
    return e;
  }

  private waitingCreate(accountId: string, folderId: FolderId): FolderCreateOp | undefined {
    return this.queue
      .folderOps(accountId)
      .find((o): o is FolderCreateOp => o.kind === 'folderCreate' && o.p.folderId === folderId);
  }

  /** Created or renamed here, not yet on the server. */
  isPending(accountId: string, folderId: FolderId): boolean {
    return this.queue
      .folderOps(accountId)
      .some((o) => (o.kind === 'folderCreate' || o.kind === 'folderRename') && o.p.folderId === folderId);
  }

  private delimiterFor(accountId: string): string | null {
    return this.ctx.folders.rowsForAccount(accountId).find((r) => r.delimiter)?.delimiter ?? null;
  }

  /** The namespace prefix for top-level folders, remembered from the last time we were connected. */
  private prefixFor(accountId: string): string {
    const r = this.ctx.db.prepare('SELECT v FROM kv WHERE k = ?').get(NS_KEY(accountId)) as
      | { v: string }
      | undefined;
    return r?.v ?? '';
  }

  saveNamespacePrefix(accountId: string, prefix: string): void {
    this.ctx.db
      .prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
      .run(NS_KEY(accountId), prefix);
  }

  topLevelPrefix(accountId: string): string {
    return this.prefixFor(accountId);
  }

  private changed(accountId: string): void {
    this.ctx.hub.emit({ type: 'folders:changed', accountId });
    this.ctx.hub.touchCounts();
  }

  /** Rewrite the paths in waiting folder ops: `from` (and everything below it) becomes `to`. */
  private rewritePaths(accountId: string, from: string, to: string, delimiter: string | null): void {
    const re = (p: string): string =>
      p === from ? to : delimiter && p.startsWith(from + delimiter) ? to + p.slice(from.length) : p;
    for (const o of this.queue.folderOps(accountId)) {
      if (o.inFlight) continue;
      let before: string;
      switch (o.kind) {
        case 'folderCreate':
          before = JSON.stringify(o.p);
          o.p = { ...o.p, path: re(o.p.path) };
          break;
        case 'folderRename':
          before = JSON.stringify(o.p);
          o.p = { ...o.p, fromPath: re(o.p.fromPath), toPath: re(o.p.toPath) };
          break;
        case 'folderDelete':
          before = JSON.stringify(o.p);
          o.p = { ...o.p, path: re(o.p.path) };
          break;
        default:
          continue;
      }
      if (before !== JSON.stringify(o.p)) this.queue.persistPayload(o);
    }
  }

  /** Remove a folder row and its messages from this PC. */
  private removeLocal(row: FolderRow): MessageId[] {
    const ids = this.ctx.messages.idsForFolder(row.id);
    this.ctx.db.transaction(() => {
      this.ctx.folders.delete(row.id);
      this.ctx.messages.ftsDeleteMany(ids);
    })();
    this.ctx.hub.changed({ folderIds: [row.id], removed: ids });
    return ids;
  }

  /** Local-only folders below a local-only folder. */
  private localChildren(accountId: string, row: FolderRow): FolderRow[] {
    if (!row.delimiter) return [];
    const prefix = row.path + row.delimiter;
    return this.ctx.folders
      .rowsForAccount(accountId)
      .filter((r) => r.path.startsWith(prefix) && this.waitingCreate(accountId, r.id));
  }

  // ---------- local half ----------

  /** Create: a local row with the wanted path, and the create op behind it. */
  createLocal(
    accountId: string,
    parent: FolderRow | null,
    leaf: string,
    role: FolderRole | null = null,
  ): FolderRow {
    const delimiter = parent?.delimiter ?? this.delimiterFor(accountId);
    const prefix = parent ? '' : this.prefixFor(accountId);
    const path = parent ? (delimiter ? `${parent.path}${delimiter}${leaf}` : leaf) : `${prefix}${leaf}`;
    if (this.ctx.folders.rowByPath(accountId, path)) {
      throw new AppException('INVALID_INPUT', 'A folder with this name already exists.');
    }
    const row = this.ctx.db.transaction(() => {
      const r = this.ctx.folders.insertLocal(accountId, { path, name: leaf, delimiter, role });
      this.queue.addRaw(accountId, 'folderCreate', { folderId: r.id, path });
      return r;
    })();
    this.changed(accountId);
    this.host.kick(accountId);
    return row;
  }

  /** Rename: the row (and its children) change at once; the server follows. */
  renameLocal(row: FolderRow, newPath: string, leaf: string): void {
    const accountId = row.account_id;
    const create = this.waitingCreate(accountId, row.id);
    this.ctx.db.transaction(() => {
      if (create && !create.inFlight) {
        // Create then rename = create with the final name.
        const oldOp = create.p.path;
        const newOp = oldOp.slice(0, oldOp.length - leafOf(oldOp, row.delimiter).length) + leaf;
        this.rewritePaths(accountId, oldOp, newOp, row.delimiter);
      } else {
        const last = this.queue.lastFolderOp(accountId);
        if (last && last.kind === 'folderRename' && !last.inFlight && last.p.folderId === row.id) {
          if (last.p.fromPath === newPath) this.queue.remove(last); // renamed back
          else {
            last.p = { ...last.p, toPath: newPath };
            this.queue.persistPayload(last);
          }
        } else {
          this.queue.addRaw(accountId, 'folderRename', {
            folderId: row.id,
            fromPath: row.path,
            toPath: newPath,
          });
        }
      }
      this.ctx.folders.renamePath(accountId, row.path, newPath, row.delimiter);
    })();
    this.changed(accountId);
    this.host.kick(accountId);
  }

  /** Delete: the folder and its messages disappear at once; the server follows. */
  deleteLocal(row: FolderRow): void {
    const accountId = row.account_id;
    const create = this.waitingCreate(accountId, row.id);
    if (create && !create.inFlight) {
      // Create then delete = nothing. The folder was never on the server.
      for (const child of this.localChildren(accountId, row)) this.cancelLocalNew(child);
      this.cancelLocalNew(row);
      this.changed(accountId);
      return;
    }
    this.host.cancelMovesInto(accountId, row.id);
    const serverPath = this.queue.serverPath(accountId, row.path, row.delimiter);
    this.host.stampMovesFrom(accountId, row.id, serverPath);
    this.ctx.db.transaction(() => {
      const last = this.queue.lastFolderOp(accountId);
      let path = row.path;
      if (last && last.kind === 'folderRename' && !last.inFlight && last.p.folderId === row.id) {
        path = last.p.fromPath; // rename then delete = delete the original
        this.queue.remove(last);
      }
      // Empty ops of this folder are pointless now.
      for (const o of this.queue.folderOps(accountId)) {
        if (o.kind === 'folderEmpty' && !o.inFlight && o.p.folderId === row.id) this.queue.remove(o);
      }
      this.queue.addRaw(accountId, 'folderDelete', { path, delimiter: row.delimiter });
      this.removeLocal(row);
    })();
    this.changed(accountId);
    this.host.kick(accountId);
  }

  /** A folder that only exists here: forget it, its create and the moves into it. */
  private cancelLocalNew(row: FolderRow): void {
    const accountId = row.account_id;
    this.host.cancelMovesInto(accountId, row.id);
    const ops = this.queue
      .folderOps(accountId)
      .filter((o) => o.kind !== 'folderDelete' && 'folderId' in o.p && o.p.folderId === row.id);
    this.queue.removeMany(ops);
    this.removeLocal(row);
  }

  /**
   * Empty (Trash / Junk): hide every row at once (a sync must not bring them back) and queue one op
   * that deletes the folder content on the server. Moves into the folder that are still waiting
   * stay in the queue before the op, so they are sent first and then deleted with the rest.
   */
  emptyLocal(row: FolderRow): number {
    const accountId = row.account_id;
    const all = this.ctx.messages.idsForFolder(row.id);
    const visible = this.ctx.messages.list({
      scope: { kind: 'folder', folderId: row.id },
      cursor: null,
      limit: 1,
    }).total ?? 0;
    this.ctx.db.transaction(() => {
      this.ctx.messages.setFlagColumn(all, 'flag_deleted', true);
      this.queue.addRaw(accountId, 'folderEmpty', { folderId: row.id, ids: all });
    })();
    this.ctx.folders.recomputeCounts(row.id);
    this.ctx.hub.changed({ folderIds: [row.id], removed: all });
    this.host.kick(accountId);
    return visible;
  }

  // ---------- project the waiting changes onto a server folder list ----------

  project(accountId: string, listed: ListedFolder[]): ListedFolder[] {
    const ops = this.queue.folderOps(accountId);
    if (ops.length === 0) return listed;
    let out = listed.map((l) => ({ ...l }));
    for (const o of ops) {
      switch (o.kind) {
        case 'folderCreate': {
          if (out.some((l) => l.path === o.p.path)) break;
          const row = this.ctx.folders.row(o.p.folderId);
          const delimiter = row?.delimiter ?? this.delimiterFor(accountId);
          out.push({
            path: o.p.path,
            name: leafOf(o.p.path, delimiter),
            delimiter,
            role: row?.role ?? null,
            subscribed: true,
            selectable: true,
          });
          break;
        }
        case 'folderRename': {
          const { fromPath, toPath } = o.p;
          out = out.map((l) => {
            const d = l.delimiter;
            if (l.path === fromPath) return { ...l, path: toPath, name: leafOf(toPath, d) };
            if (d && l.path.startsWith(fromPath + d)) return { ...l, path: toPath + l.path.slice(fromPath.length) };
            return l;
          });
          break;
        }
        case 'folderDelete':
          out = out.filter((l) => l.path !== o.p.path);
          break;
        default:
          break;
      }
    }
    return out;
  }

  // ---------- server half ----------

  async exec(accountId: string, op: FolderOp): Promise<FolderOutcome> {
    try {
      switch (op.kind) {
        case 'folderCreate':
          return await this.execCreate(accountId, op);
        case 'folderRename':
          return await this.execRename(accountId, op);
        case 'folderDelete':
          return await this.execDelete(accountId, op);
        case 'folderEmpty':
          return await this.execEmpty(accountId, op);
      }
    } catch (e) {
      return this.failed(accountId, op, toAppError(e));
    }
  }

  /** The op ended for good (done, dropped or refused). */
  private finish(op: FolderOp): void {
    this.queue.remove(op);
    this.bump(op.accountId);
    this.changed(op.accountId);
  }

  private failed(accountId: string, op: FolderOp, err: AppError): FolderOutcome {
    if (shouldKeep(err, [op])) {
      this.ctx.log.info({ code: err.code, kind: op.kind }, 'folder change kept for later');
      this.queue.noteFailure([op], err.message);
      return 'stalled';
    }
    this.ctx.log.warn({ code: err.code, kind: op.kind }, 'server refused a folder change; undoing');
    this.refused(accountId, op, err);
    return 'done';
  }

  private notify(
    accountId: string,
    op: 'create' | 'rename' | 'delete' | 'empty',
    folderName: string,
    reason: 'exists' | 'gone' | 'refused',
    resolvedName?: string,
  ): void {
    this.ctx.hub.emit({ type: 'folder:conflict', accountId, op, folderName, reason, resolvedName });
  }

  /** Undo the local half of a change the server refused for good. */
  private refused(accountId: string, op: FolderOp, err: AppError): void {
    switch (op.kind) {
      case 'folderCreate': {
        const row = this.ctx.folders.row(op.p.folderId);
        this.errors.set(String(op.p.folderId), err);
        this.finish(op);
        if (row) {
          for (const child of this.localChildren(accountId, row)) this.cancelLocalNew(child);
          this.cancelLocalNew(row);
          this.changed(accountId);
        }
        this.notify(accountId, 'create', leafOf(op.p.path, row?.delimiter ?? null), 'refused');
        break;
      }
      case 'folderRename': {
        const row = this.ctx.folders.row(op.p.folderId);
        this.errors.set(String(op.p.folderId), err);
        this.finish(op);
        if (row && row.path === op.p.toPath) {
          this.ctx.folders.renamePath(accountId, row.path, op.p.fromPath, row.delimiter);
        }
        this.notify(accountId, 'rename', leafOf(op.p.toPath, row?.delimiter ?? null), 'refused');
        break;
      }
      case 'folderDelete':
        this.errors.set(`del:${accountId}:${op.p.path}`, err);
        this.finish(op);
        // The folder is still on the server: the next folder refresh brings it back.
        void this.sessions.get(accountId).discoverFolders().catch(() => undefined);
        this.notify(accountId, 'delete', leafOf(op.p.path, op.p.delimiter), 'refused');
        break;
      case 'folderEmpty': {
        this.errors.set(String(op.p.folderId), err);
        this.finish(op);
        const row = this.ctx.folders.row(op.p.folderId);
        if (row) {
          this.ctx.messages.setFlagColumn(op.p.ids, 'flag_deleted', false);
          this.ctx.folders.recomputeCounts(row.id);
          this.ctx.hub.changed({ folderIds: [row.id], added: op.p.ids });
        }
        this.ctx.hub.emit({
          type: 'action:failed',
          messageIds: op.p.ids.slice(0, 200),
          error: err,
          accountId,
          kind: 'delete',
        });
        this.notify(accountId, 'empty', row?.name ?? '', 'refused');
        break;
      }
    }
  }

  private async listPaths(accountId: string): Promise<Set<string>> {
    return this.host.withRetry(() =>
      this.sessions.get(accountId).run('user', async (c) => {
        const all = await c.list();
        return new Set(all.map((e) => e.path));
      }),
    );
  }

  private async execCreate(accountId: string, op: FolderCreateOp): Promise<FolderOutcome> {
    const row = this.ctx.folders.row(op.p.folderId);
    if (!row) {
      this.finish(op); // forgotten meanwhile
      return 'done';
    }
    const wanted = op.p.path;
    const path = await this.host.withRetry(() =>
      this.sessions.get(accountId).run('user', async (c) => {
        const all = await c.list();
        const have = all.find((e) => e.path === wanted);
        if (have) return have.path; // it exists already (made elsewhere): use it
        const res = await c.mailboxCreate(wanted);
        await c.mailboxSubscribe(res.path).catch(() => undefined);
        return res.path;
      }),
    );
    if (path !== row.path) {
      const clash = this.ctx.folders.rowByPath(accountId, path);
      if (!clash || clash.id === row.id) {
        this.ctx.folders.renamePath(accountId, row.path, path, row.delimiter);
      }
    }
    this.finish(op);
    return 'done';
  }

  private async execRename(accountId: string, op: FolderRenameOp): Promise<FolderOutcome> {
    const row = this.ctx.folders.row(op.p.folderId);
    if (!row) {
      this.finish(op);
      return 'done';
    }
    const { fromPath, toPath } = op.p;
    const delimiter = row.delimiter;
    const res = await this.host.withRetry(() =>
      this.sessions.get(accountId).run('user', async (c) => {
        const all = new Set((await c.list()).map((e) => e.path));
        if (!all.has(fromPath)) return { gone: true as const };
        let to = toPath;
        if (to !== fromPath && all.has(to)) {
          // The wanted name is taken on the server: keep ours, with a number.
          const base = parentPath(toPath, delimiter);
          const leaf = leafOf(toPath, delimiter);
          for (let n = 2; ; n++) {
            const candidate = `${base !== null ? base + delimiter : ''}${leaf} (${n})`;
            if (!all.has(candidate) && !this.ctx.folders.rowByPath(accountId, candidate)) {
              to = candidate;
              break;
            }
          }
        }
        if (to !== fromPath) await c.mailboxRename(fromPath, to);
        return { gone: false as const, to };
      }),
    );
    if (res.gone) {
      // The folder is not on the server any more. Drop the change and the local folder.
      this.finish(op);
      for (const o of this.queue.folderOps(accountId)) {
        if (!o.inFlight && 'folderId' in o.p && o.p.folderId === row.id) this.queue.remove(o);
      }
      this.host.cancelMovesInto(accountId, row.id);
      this.removeLocal(row);
      this.changed(accountId);
      this.notify(accountId, 'rename', leafOf(fromPath, delimiter), 'gone');
      return 'done';
    }
    this.finish(op);
    if (res.to !== toPath) {
      this.rewritePaths(accountId, toPath, res.to, delimiter);
      this.ctx.folders.renamePath(accountId, toPath, res.to, delimiter);
      this.changed(accountId);
      this.notify(accountId, 'rename', leafOf(toPath, delimiter), 'exists', leafOf(res.to, delimiter));
    }
    return 'done';
  }

  private async execDelete(accountId: string, op: FolderDeleteOp): Promise<FolderOutcome> {
    await this.host.withRetry(() =>
      this.sessions.get(accountId).run('user', async (c) => {
        const all = await c.list();
        if (!all.some((e) => e.path === op.p.path)) return; // already gone
        await c.mailboxDelete(op.p.path);
      }),
    );
    this.finish(op);
    void this.sessions.get(accountId).discoverFolders().catch(() => undefined);
    return 'done';
  }

  private async execEmpty(accountId: string, op: FolderEmptyOp): Promise<FolderOutcome> {
    const row = this.ctx.folders.row(op.p.folderId);
    if (!row) {
      this.finish(op);
      return 'done';
    }
    const path = this.queue.serverPath(accountId, row.path, row.delimiter);
    const exists = await this.host.withRetry(() =>
      this.sessions.get(accountId).run('user', async (c) => {
        const all = await c.list();
        if (!all.some((e) => e.path === path)) return false;
        const mb = await c.mailboxOpen(path);
        if (mb.exists > 0) this.host.requireOk(c, await c.messageDelete('1:*'), 'delete');
        return true;
      }),
    );
    this.finish(op);
    // The hidden rows are really gone now. Mail that arrived meanwhile stays until the next sync.
    this.ctx.messages.deleteMany(op.p.ids);
    this.ctx.folders.recomputeCounts(row.id);
    this.ctx.hub.changed({ folderIds: [row.id], removed: op.p.ids });
    if (!exists) this.notify(accountId, 'empty', row.name, 'gone');
    return 'done';
  }
}
