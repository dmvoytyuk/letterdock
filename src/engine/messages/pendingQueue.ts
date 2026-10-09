// The queue of changes that are done locally but not yet on the server (ARCHITECTURE 5.6).
//
// Every read / flag / move / delete is written here FIRST (table `pending_op`), then sent to the
// server by ActionService, which removes the entry when the server confirmed. If the PC is offline
// or the server is down, the entry simply stays: it survives an app restart and is sent in the
// original order when the account is back online.
//
// This file only holds the data and the merge rules. It does no network work.
import type { AppError } from '../../shared/ipc';
import type { Db } from '../db/connection';

export type FlagColumn = 'flag_seen' | 'flag_flagged';

/** Set a flag on one message. The message is found again by id when the op runs. */
export interface FlagPayload {
  msgId: number;
  /** RFC Message-ID header, used to find the row again if its id is gone. */
  mid: string | null;
  folderId: number;
  col: FlagColumn;
  value: boolean;
  /** Value before the first queued change = what the server still has. */
  prev: boolean;
}

/** Move one message. `origUid`/`srcFolderId` describe where it is on the SERVER. */
export interface MovePayload {
  msgId: number;
  mid: string | null;
  srcFolderId: number;
  destFolderId: number;
  origUid: number;
  /** UIDVALIDITY of the source folder when the op was queued. */
  srcUv: number | null;
  /** Set when the source folder was deleted on this PC after the move was queued: its server path. */
  srcPath?: string;
}

/** Delete one message for good. */
export interface DeletePayload {
  msgId: number;
  mid: string | null;
  folderId: number;
  uv: number | null;
}

/** Create a folder. The local row (`folderId`) already exists; `path` is what to create on the server. */
export interface FolderCreatePayload {
  folderId: number;
  path: string;
}

/** Rename a folder. `fromPath` is what the server has when this op runs, `toPath` the wanted path. */
export interface FolderRenamePayload {
  folderId: number;
  fromPath: string;
  toPath: string;
}

/** Delete a folder. The local row is already gone; `path` is the folder on the server. */
export interface FolderDeletePayload {
  path: string;
  delimiter: string | null;
}

/** Delete every message of a folder (Trash / Junk). The local rows are hidden until it ran. */
export interface FolderEmptyPayload {
  folderId: number;
  /** The rows that were hidden when the op was queued (they are removed when it ran). */
  ids: number[];
}

/** Set the Answered or Forwarded flag on the source of a reply or forward. Best effort. */
export interface RepliedPayload {
  msgId: number;
  mid: string | null;
  folderId: number;
  flag: '\\Answered' | '$Forwarded';
}

interface Base {
  id: number;
  accountId: string;
  createdAt: number;
  attempts: number;
  lastError: string | null;
  /** Being sent to the server right now. Never changed or merged while true. */
  inFlight: boolean;
}
export type FlagOp = Base & { kind: 'flag'; p: FlagPayload };
export type MoveOp = Base & { kind: 'move'; p: MovePayload };
export type DeleteOp = Base & { kind: 'delete'; p: DeletePayload };
export type FolderCreateOp = Base & { kind: 'folderCreate'; p: FolderCreatePayload };
export type FolderRenameOp = Base & { kind: 'folderRename'; p: FolderRenamePayload };
export type FolderDeleteOp = Base & { kind: 'folderDelete'; p: FolderDeletePayload };
export type FolderEmptyOp = Base & { kind: 'folderEmpty'; p: FolderEmptyPayload };
export type RepliedOp = Base & { kind: 'replied'; p: RepliedPayload };
export type FolderOp = FolderCreateOp | FolderRenameOp | FolderDeleteOp | FolderEmptyOp;
export type PendingOp = FlagOp | MoveOp | DeleteOp | RepliedOp | FolderOp;

const KINDS = new Set<string>([
  'flag',
  'move',
  'delete',
  'replied',
  'folderCreate',
  'folderRename',
  'folderDelete',
  'folderEmpty',
]);

export function isFolderOp(o: PendingOp): o is FolderOp {
  return o.kind.startsWith('folder');
}

/** The message an op is about (folder ops have none). */
function msgIdOf(o: PendingOp): number | null {
  switch (o.kind) {
    case 'flag':
    case 'move':
    case 'delete':
    case 'replied':
      return o.p.msgId;
    default:
      return null;
  }
}

const MAX_BATCH = 500;

/** Errors that mean "the user must fix something": keep the changes and wait, never revert. */
const WAIT_CODES = new Set(['AUTH_FAILED', 'OAUTH_REAUTH_REQUIRED', 'OAUTH_NOT_CONFIGURED', 'TLS_ERROR']);
/** An unknown (INTERNAL) error that keeps coming back is treated as final after this many tries. */
const MAX_UNKNOWN_TRIES = 6;

/** A failed send: keep the changes and try again later (true), or is the refusal final (false)? */
export function shouldKeep(err: AppError, ops: readonly { attempts: number }[]): boolean {
  return (
    WAIT_CODES.has(err.code) ||
    (err.retryable && !(err.code === 'INTERNAL' && ops.some((o) => o.attempts + 1 >= MAX_UNKNOWN_TRIES)))
  );
}

export class PendingQueue {
  private ops = new Map<string, PendingOp[]>();

  constructor(
    private readonly db: Db,
    private readonly now: () => number,
    private readonly onChange: (accountId: string) => void = () => undefined,
  ) {
    this.load();
  }

  private load(): void {
    const rows = this.db
      .prepare(
        'SELECT id, account_id, kind, payload_json, created_at, attempts, last_error FROM pending_op ORDER BY id',
      )
      .all() as {
      id: number;
      account_id: string;
      kind: string;
      payload_json: string;
      created_at: number;
      attempts: number;
      last_error: string | null;
    }[];
    const del = this.db.prepare('DELETE FROM pending_op WHERE id = ?');
    for (const r of rows) {
      let p: unknown;
      try {
        p = JSON.parse(r.payload_json);
      } catch {
        p = null;
      }
      if (!p || !KINDS.has(r.kind)) {
        del.run(r.id); // unreadable leftover (older version): drop it
        continue;
      }
      const op = {
        id: r.id,
        accountId: r.account_id,
        kind: r.kind,
        p,
        createdAt: r.created_at,
        attempts: r.attempts,
        lastError: r.last_error,
        inFlight: false,
      } as PendingOp;
      this.list(r.account_id).push(op);
    }
  }

  // ---------- reading ----------

  /** The live list of an account (oldest first). Do not change it from outside. */
  private list(accountId: string): PendingOp[] {
    let l = this.ops.get(accountId);
    if (!l) {
      l = [];
      this.ops.set(accountId, l);
    }
    return l;
  }

  forAccount(accountId: string): readonly PendingOp[] {
    return this.ops.get(accountId) ?? [];
  }

  count(accountId: string): number {
    return this.ops.get(accountId)?.length ?? 0;
  }

  /** Accounts that have queued changes. */
  accountsWithOps(): string[] {
    return [...this.ops.entries()].filter(([, l]) => l.length > 0).map(([a]) => a);
  }

  /** Message ids with a queued flag change (a sync must not overwrite those flags). */
  messageIdsWithFlagOps(accountId: string): Set<number> {
    const s = new Set<number>();
    for (const op of this.ops.get(accountId) ?? []) if (op.kind === 'flag') s.add(op.p.msgId);
    return s;
  }

  /** A move that has not started yet for this message, if any. */
  findMove(accountId: string, msgId: number): MoveOp | undefined {
    return (this.ops.get(accountId) ?? []).find(
      (o): o is MoveOp => o.kind === 'move' && !o.inFlight && o.p.msgId === msgId,
    );
  }

  /** The move of this message that is waiting or running, if any. */
  findAnyMove(accountId: string, msgId: number): MoveOp | undefined {
    return (this.ops.get(accountId) ?? []).find(
      (o): o is MoveOp => o.kind === 'move' && o.p.msgId === msgId,
    );
  }

  /**
   * The path the SERVER has for a local folder path right now. A folder renamed on this PC keeps
   * its old name on the server until the rename op ran, and ops queued before that rename must
   * still use the old name. Waiting renames are undone, newest first.
   */
  serverPath(accountId: string, path: string, delimiter: string | null): string {
    const renames = (this.ops.get(accountId) ?? []).filter(
      (o): o is FolderRenameOp => o.kind === 'folderRename',
    );
    let cur = path;
    for (let i = renames.length - 1; i >= 0; i--) {
      const { fromPath, toPath } = renames[i]!.p;
      if (cur === toPath) cur = fromPath;
      else if (delimiter && cur.startsWith(toPath + delimiter)) {
        cur = fromPath + cur.slice(toPath.length);
      }
    }
    return cur;
  }

  hasInFlight(accountId: string, msgIds: number[]): boolean {
    const set = new Set(msgIds);
    return (this.ops.get(accountId) ?? []).some((o) => {
      const m = msgIdOf(o);
      return o.inFlight && m !== null && set.has(m);
    });
  }

  // ---------- adding (with merging) ----------

  /**
   * Queue "set flag". An earlier waiting change of the same flag on the same message is merged:
   * - back to what the server has            -> both disappear ("cancelled")
   * - another value                          -> the waiting op takes the new value ("merged")
   */
  addFlag(accountId: string, p: FlagPayload): 'added' | 'merged' | 'cancelled' {
    const l = this.list(accountId);
    const same = l.find(
      (o): o is FlagOp =>
        o.kind === 'flag' && !o.inFlight && o.p.msgId === p.msgId && o.p.col === p.col,
    );
    if (same) {
      if (same.p.prev === p.value) {
        this.remove(same);
        return 'cancelled';
      }
      same.p = { ...same.p, value: p.value, folderId: p.folderId };
      this.persistPayload(same);
      this.onChange(accountId);
      return 'merged';
    }
    this.insert(accountId, 'flag', p);
    return 'added';
  }

  addMove(accountId: string, p: MovePayload): MoveOp {
    return this.insert(accountId, 'move', p) as MoveOp;
  }

  /** Queue "delete for good". Waiting flag changes of that message are pointless now: drop them. */
  addDelete(accountId: string, p: DeletePayload): DeleteOp {
    const l = this.list(accountId);
    const stale = l.filter((o) => o.kind === 'flag' && !o.inFlight && o.p.msgId === p.msgId);
    for (const o of stale) this.removeQuiet(o);
    const op = this.insert(accountId, 'delete', p) as DeleteOp;
    return op;
  }

  /** Queue a folder change or a "replied" mark. Merging is done by the caller (FolderOps). */
  addRaw<K extends 'folderCreate' | 'folderRename' | 'folderDelete' | 'folderEmpty' | 'replied'>(
    accountId: string,
    kind: K,
    p: Extract<PendingOp, { kind: K }>['p'],
  ): Extract<PendingOp, { kind: K }> {
    return this.insert(accountId, kind, p) as Extract<PendingOp, { kind: K }>;
  }

  /** Waiting folder ops (not started), oldest first. */
  folderOps(accountId: string): FolderOp[] {
    return (this.ops.get(accountId) ?? []).filter((o): o is FolderOp => isFolderOp(o));
  }

  /** The newest folder op of the account (only a waiting one may be merged into). */
  lastFolderOp(accountId: string): FolderOp | undefined {
    return this.folderOps(accountId).at(-1);
  }

  private insert(accountId: string, kind: PendingOp['kind'], p: PendingOp['p']): PendingOp {
    const createdAt = this.now();
    const res = this.db
      .prepare(
        'INSERT INTO pending_op (account_id, kind, payload_json, created_at) VALUES (?, ?, ?, ?)',
      )
      .run(accountId, kind, JSON.stringify(p), createdAt);
    const op = {
      id: Number(res.lastInsertRowid),
      accountId,
      kind,
      p,
      createdAt,
      attempts: 0,
      lastError: null,
      inFlight: false,
    } as PendingOp;
    this.list(accountId).push(op);
    this.onChange(accountId);
    return op;
  }

  // ---------- changing ----------

  /** Save a changed payload (e.g. a move whose destination was changed before it ran). */
  persistPayload(op: PendingOp): void {
    this.db.prepare('UPDATE pending_op SET payload_json = ? WHERE id = ?').run(JSON.stringify(op.p), op.id);
  }

  private removeQuiet(op: PendingOp): void {
    this.db.prepare('DELETE FROM pending_op WHERE id = ?').run(op.id);
    const l = this.ops.get(op.accountId);
    if (!l) return;
    const i = l.indexOf(op);
    if (i >= 0) l.splice(i, 1);
  }

  remove(op: PendingOp): void {
    this.removeQuiet(op);
    this.onChange(op.accountId);
  }

  removeMany(ops: readonly PendingOp[]): void {
    if (ops.length === 0) return;
    this.db.transaction(() => {
      for (const o of ops) this.removeQuiet(o);
    })();
    for (const a of new Set(ops.map((o) => o.accountId))) this.onChange(a);
  }

  setInFlight(ops: readonly PendingOp[], value: boolean): void {
    for (const o of ops) o.inFlight = value;
  }

  /** A try failed for a temporary reason: count it and keep the op. */
  noteFailure(ops: readonly PendingOp[], message: string): void {
    const upd = this.db.prepare('UPDATE pending_op SET attempts = ?, last_error = ? WHERE id = ?');
    for (const o of ops) {
      o.attempts += 1;
      o.lastError = message;
      upd.run(o.attempts, message, o.id);
    }
  }

  /** Forget everything of an account (the account was removed; the table rows cascade away). */
  dropAccount(accountId: string): void {
    this.ops.delete(accountId);
  }

  // ---------- batching ----------

  /**
   * The next group of ops to send together: the first op that is not running plus the ops right
   * behind it that can share one server command. Order is never changed.
   */
  nextBatch(accountId: string): PendingOp[] {
    const l = this.ops.get(accountId) ?? [];
    const first = l[0];
    if (!first || first.inFlight) return [];
    const batch: PendingOp[] = [first];
    for (let i = 1; i < l.length && batch.length < MAX_BATCH; i++) {
      const o = l[i]!;
      if (o.inFlight || !sameBatch(first, o)) break;
      batch.push(o);
    }
    return batch;
  }
}

function sameBatch(a: PendingOp, b: PendingOp): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'flag': {
      const x = b as FlagOp;
      return a.p.col === x.p.col && a.p.value === x.p.value;
    }
    case 'move': {
      const x = b as MoveOp;
      return (
        a.p.srcFolderId === x.p.srcFolderId &&
        a.p.destFolderId === x.p.destFolderId &&
        a.p.srcUv === x.p.srcUv
      );
    }
    case 'delete':
      return true;
    default:
      return false; // folder changes and "replied" marks are sent one at a time
  }
}
