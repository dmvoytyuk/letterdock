import type { Folder, FolderId, FolderRole } from '../../../shared/ipc';
import type { Db } from '../connection';

export interface FolderRow {
  id: number;
  account_id: string;
  path: string;
  delimiter: string | null;
  name: string;
  role: FolderRole | null;
  subscribed: number;
  selectable: number;
  uidvalidity: number | null;
  uidnext: number | null;
  highestmodseq: string | null;
  server_exists: number | null;
  last_sync_at: number | null;
  total_count: number;
  unread_count: number;
  oldest_synced_uid: number | null;
  history_complete: number;
}

export function toFolder(r: FolderRow): Folder {
  return {
    id: r.id,
    accountId: r.account_id,
    path: r.path,
    name: r.name,
    role: r.role,
    delimiter: r.delimiter,
    unreadCount: r.unread_count,
    totalCount: r.total_count,
    selectable: r.selectable === 1,
  };
}

export interface ListedFolder {
  path: string;
  name: string;
  delimiter: string | null;
  role: FolderRole | null;
  subscribed: boolean;
  selectable: boolean;
}

export interface SyncState {
  uidvalidity: number | null;
  uidnext: number | null;
  highestmodseq: string | null;
  serverExists: number | null;
  lastSyncAt: number | null;
  oldestSyncedUid: number | null;
  historyComplete: boolean;
}

export class FolderRepo {
  constructor(private readonly db: Db) {}

  row(id: FolderId): FolderRow | null {
    return (this.db.prepare('SELECT * FROM folder WHERE id = ?').get(id) as FolderRow) ?? null;
  }

  get(id: FolderId): Folder | null {
    const r = this.row(id);
    return r ? toFolder(r) : null;
  }

  rowByPath(accountId: string, path: string): FolderRow | null {
    return (
      (this.db
        .prepare('SELECT * FROM folder WHERE account_id = ? AND path = ?')
        .get(accountId, path) as FolderRow) ?? null
    );
  }

  rowByRole(accountId: string, role: FolderRole): FolderRow | null {
    return (
      (this.db
        .prepare('SELECT * FROM folder WHERE account_id = ? AND role = ? ORDER BY id LIMIT 1')
        .get(accountId, role) as FolderRow) ?? null
    );
  }

  rowsForAccount(accountId: string): FolderRow[] {
    return this.db
      .prepare('SELECT * FROM folder WHERE account_id = ? ORDER BY id')
      .all(accountId) as FolderRow[];
  }

  list(accountId?: string): Folder[] {
    const rows = accountId
      ? this.rowsForAccount(accountId)
      : (this.db.prepare('SELECT * FROM folder ORDER BY account_id, id').all() as FolderRow[]);
    return rows.map(toFolder);
  }

  /** Insert/update from a server LIST. Returns true if the set of folders changed. */
  syncListed(accountId: string, listed: ListedFolder[]): boolean {
    let changed = false;
    const tx = this.db.transaction(() => {
      const existing = new Map(this.rowsForAccount(accountId).map((r) => [r.path, r]));
      const seen = new Set<string>();
      for (const f of listed) {
        seen.add(f.path);
        const cur = existing.get(f.path);
        if (!cur) {
          this.db
            .prepare(
              `INSERT INTO folder (account_id,path,delimiter,name,role,subscribed,selectable)
               VALUES (?,?,?,?,?,?,?)`,
            )
            .run(
              accountId,
              f.path,
              f.delimiter,
              f.name,
              f.role,
              f.subscribed ? 1 : 0,
              f.selectable ? 1 : 0,
            );
          changed = true;
        } else if (
          cur.name !== f.name ||
          cur.role !== f.role ||
          cur.delimiter !== f.delimiter ||
          cur.selectable !== (f.selectable ? 1 : 0) ||
          cur.subscribed !== (f.subscribed ? 1 : 0)
        ) {
          this.db
            .prepare(
              'UPDATE folder SET name=?, role=?, delimiter=?, selectable=?, subscribed=? WHERE id=?',
            )
            .run(f.name, f.role, f.delimiter, f.selectable ? 1 : 0, f.subscribed ? 1 : 0, cur.id);
          changed = true;
        }
      }
      for (const [path, r] of existing) {
        if (!seen.has(path)) {
          this.db.prepare('DELETE FROM folder WHERE id = ?').run(r.id);
          changed = true;
        }
      }
    });
    tx();
    return changed;
  }

  syncState(id: FolderId): SyncState | null {
    const r = this.row(id);
    if (!r) return null;
    return {
      uidvalidity: r.uidvalidity,
      uidnext: r.uidnext,
      highestmodseq: r.highestmodseq,
      serverExists: r.server_exists,
      lastSyncAt: r.last_sync_at,
      oldestSyncedUid: r.oldest_synced_uid,
      historyComplete: r.history_complete === 1,
    };
  }

  saveSyncState(id: FolderId, s: Partial<SyncState>): void {
    const cur = this.syncState(id);
    if (!cur) return;
    const n = { ...cur, ...s };
    this.db
      .prepare(
        `UPDATE folder SET uidvalidity=?, uidnext=?, highestmodseq=?, server_exists=?, last_sync_at=?,
           oldest_synced_uid=?, history_complete=? WHERE id=?`,
      )
      .run(
        n.uidvalidity,
        n.uidnext,
        n.highestmodseq,
        n.serverExists,
        n.lastSyncAt,
        n.oldestSyncedUid,
        n.historyComplete ? 1 : 0,
        id,
      );
  }

  /** Reset sync cursors (UIDVALIDITY change). */
  resetSyncState(id: FolderId): void {
    this.db
      .prepare(
        `UPDATE folder SET uidvalidity=NULL, uidnext=NULL, highestmodseq=NULL, server_exists=NULL, last_sync_at=NULL,
           oldest_synced_uid=NULL, history_complete=0 WHERE id=?`,
      )
      .run(id);
  }

  /** Recompute total/unread from the message table. Returns the new counts. */
  recomputeCounts(id: FolderId): { unread: number; total: number } {
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN flag_seen=0 THEN 1 ELSE 0 END),0) AS unread
         FROM message WHERE folder_id=? AND flag_deleted=0 AND snoozed_until IS NULL`,
      )
      .get(id) as { total: number; unread: number };
    this.db
      .prepare('UPDATE folder SET total_count=?, unread_count=? WHERE id=?')
      .run(r.total, r.unread, id);
    return r;
  }

  /** Recompute the counts of every folder from the message table (repairs numbers that went wrong). */
  recomputeAll(): void {
    // One pass over the messages (grouped by folder) instead of one query per folder.
    const ids = this.db.prepare('SELECT id FROM folder').all() as { id: number }[];
    const per = new Map<number, { total: number; unread: number }>();
    for (const r of this.db
      .prepare(
        `SELECT folder_id, COUNT(*) AS total, COALESCE(SUM(CASE WHEN flag_seen=0 THEN 1 ELSE 0 END),0) AS unread
         FROM message WHERE flag_deleted=0 AND snoozed_until IS NULL GROUP BY folder_id`,
      )
      .all() as { folder_id: number; total: number; unread: number }[]) {
      per.set(r.folder_id, r);
    }
    const upd = this.db.prepare('UPDATE folder SET total_count=?, unread_count=? WHERE id=?');
    this.db.transaction(() => {
      for (const { id } of ids) {
        const c = per.get(id);
        upd.run(c?.total ?? 0, c?.unread ?? 0, id);
      }
    })();
  }

  counts(): {
    unifiedInboxUnread: number;
    perFolder: { folderId: number; unread: number; total: number }[];
  } {
    const per = this.db
      .prepare('SELECT id, unread_count, total_count FROM folder WHERE selectable=1')
      .all() as { id: number; unread_count: number; total_count: number }[];
    const u = this.db
      .prepare("SELECT COALESCE(SUM(unread_count),0) AS n FROM folder WHERE role='inbox'")
      .get() as { n: number };
    return {
      unifiedInboxUnread: u.n,
      perFolder: per.map((p) => ({ folderId: p.id, unread: p.unread_count, total: p.total_count })),
    };
  }

  /** After a server rename: move the folder and its children to new paths, keeping messages. */
  renamePath(accountId: string, oldPath: string, newPath: string, delimiter: string | null): void {
    const tx = this.db.transaction(() => {
      const rows = this.rowsForAccount(accountId);
      for (const r of rows) {
        let target: string | null = null;
        if (r.path === oldPath) target = newPath;
        else if (delimiter && r.path.startsWith(oldPath + delimiter)) {
          target = newPath + r.path.slice(oldPath.length);
        }
        if (target === null) continue;
        const leaf = delimiter ? target.split(delimiter).pop()! : target;
        this.db.prepare('UPDATE folder SET path=?, name=? WHERE id=?').run(target, leaf, r.id);
      }
    });
    tx();
  }

  /** A folder that exists on this PC only so far (its create waits in the offline queue). */
  insertLocal(
    accountId: string,
    f: { path: string; name: string; delimiter: string | null; role: FolderRole | null },
  ): FolderRow {
    const res = this.db
      .prepare(
        `INSERT INTO folder (account_id,path,delimiter,name,role,subscribed,selectable)
         VALUES (?,?,?,?,?,1,1)`,
      )
      .run(accountId, f.path, f.delimiter, f.name, f.role);
    return this.row(Number(res.lastInsertRowid))!;
  }

  delete(id: FolderId): void {
    this.db.prepare('DELETE FROM folder WHERE id = ?').run(id);
  }
}
