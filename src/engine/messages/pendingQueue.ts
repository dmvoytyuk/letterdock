// The queue of changes that are done locally but not yet on the server (ARCHITECTURE 5.6).
//
// Every read / flag / move / delete is written here FIRST (table `pending_op`), then sent to the
// server by ActionService, which removes the entry when the server confirmed. If the PC is offline
// or the server is down, the entry simply stays: it survives an app restart and is sent in the
// original order when the account is back online.
//
// This file only holds the data and the merge rules. It does no network work.
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
}

/** Delete one message for good. */
export interface DeletePayload {
  msgId: number;
  mid: string | null;
  folderId: number;
  uv: number | null;
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
export type PendingOp = FlagOp | MoveOp | DeleteOp;

const MAX_BATCH = 500;

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
      if (!p || (r.kind !== 'flag' && r.kind !== 'move' && r.kind !== 'delete')) {
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

  hasInFlight(accountId: string, msgIds: number[]): boolean {
    const set = new Set(msgIds);
    return (this.ops.get(accountId) ?? []).some((o) => o.inFlight && set.has(o.p.msgId));
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
  }
}
