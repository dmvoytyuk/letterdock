// Pin and Mute (DESIGN-SPEC 3.13.6).
//  - Pin keeps a message (or the messages of a conversation in that folder) at the top of the folder
//    list. PC only. Max 10 per folder. The pin ends when the message leaves the folder
//    (MessageRepo.relocate clears it).
//  - Mute archives the messages of a conversation that are in the current folder and archives new
//    ones that arrive, quietly. The only cost at sync time is one primary-key lookup per new Inbox
//    message in `muted_threads`, and none while that table is empty (an in-memory count).
import type {
  AccountId,
  MessageId,
  MuteSetReq,
  MuteSetRes,
  PinSetReq,
  PinSetRes,
} from '../../shared/ipc';
import { MAX_MUTED_PER_ACCOUNT, MAX_PINS_PER_FOLDER } from '../../shared/ipc';
import { AppException } from '../../shared/errors';
import type { EngineContext } from '../context';
import type { FolderRow } from '../db/repos/folderRepo';
import { scopeFilter, type MessageRow } from '../db/repos/messageRepo';
import type { ActionService } from './actionService';
import { foldersOf, resolveTargets, type LightRow, type LightUndo } from './lightShared';

const YEAR_MS = 365 * 24 * 3600_000;
/** Folders whose messages are not archived by Mute (nothing to archive or no Inbox mail there). */
const NO_ARCHIVE_ROLES = new Set(['sent', 'drafts', 'trash', 'junk', 'archive', 'all']);

export class PinMuteService {
  /** Rows in muted_threads (in memory; the new-mail step skips its lookups at 0). */
  private mutedCount = 0;

  constructor(
    private readonly ctx: EngineContext,
    private readonly actions: ActionService,
    private readonly undo: LightUndo,
  ) {}

  start(): void {
    this.mutedCount = (
      this.ctx.db.prepare('SELECT COUNT(*) AS n FROM muted_threads').get() as { n: number }
    ).n;
  }

  // ---------- pin ----------

  set(req: PinSetReq): PinSetRes {
    const rows = resolveTargets(this.ctx, req);
    if (rows.length === 0) return { ok: true, changed: [] };
    const prev = rows.map((r) => ({ id: r.id, pinned: r.pinned_at }));
    if (req.pinned) {
      // Limit: pinned conversations per folder (a conversation counts once, however many of its
      // messages are in the folder).
      const countStmt = this.ctx.db.prepare(
        'SELECT COUNT(DISTINCT COALESCE(thread_id, id)) AS n FROM message WHERE folder_id = ? AND pinned_at IS NOT NULL',
      );
      const pinnedThreadsStmt = this.ctx.db.prepare(
        'SELECT DISTINCT COALESCE(thread_id, id) AS t FROM message WHERE folder_id = ? AND pinned_at IS NOT NULL',
      );
      for (const folderId of foldersOf(rows)) {
        const already = new Set(
          (pinnedThreadsStmt.all(folderId) as { t: string | number }[]).map((x) => String(x.t)),
        );
        const adding = new Set(
          rows.filter((r) => r.folder_id === folderId).map((r) => String(r.thread_id ?? r.id)),
        );
        let extra = 0;
        for (const t of adding) if (!already.has(t)) extra++;
        const n = (countStmt.get(folderId) as { n: number }).n;
        if (n + extra > MAX_PINS_PER_FOLDER) return { ok: false, limit: MAX_PINS_PER_FOLDER, changed: [] };
      }
    }
    const now = this.ctx.now();
    const value = req.pinned ? now : null;
    this.writePins(rows.map((r) => ({ id: r.id, pinned: value })), rows);
    const undoToken = this.undo.add(async () => {
      const cur = prev.map((p) => this.ctx.messages.row(p.id)).filter((r): r is MessageRow => !!r);
      this.writePins(prev.filter((p) => cur.some((r) => r.id === p.id)), cur);
      return cur.map((r) => r.id);
    });
    return { ok: true, changed: rows.map((r) => r.id), undoToken };
  }

  private writePins(items: { id: MessageId; pinned: number | null }[], rows: { folder_id: number }[]): void {
    const upd = this.ctx.db.prepare('UPDATE message SET pinned_at = ? WHERE id = ?');
    this.ctx.db.transaction(() => {
      for (const i of items) upd.run(i.pinned, i.id);
    })();
    this.ctx.hub.changed({ folderIds: foldersOf(rows), updated: items.map((i) => i.id) });
  }

  // ---------- mute ----------

  /** Which conversations (account + thread id) a mute request means. */
  private threadsOf(req: MuteSetReq): { accountId: AccountId; threadId: string; rows: LightRow[] }[] {
    const rows = resolveTargets(this.ctx, { messageIds: req.messageIds });
    const out = new Map<string, { accountId: AccountId; threadId: string; rows: LightRow[] }>();
    for (const r of rows) {
      if (!r.thread_id) continue;
      if (req.muted && !r.message_id && !r.in_reply_to && !r.references_h) {
        throw new AppException('INVALID_INPUT', "This message isn't part of a conversation.");
      }
      const k = `${r.account_id}\u0000${r.thread_id}`;
      const e = out.get(k) ?? { accountId: r.account_id, threadId: r.thread_id, rows: [] };
      e.rows.push(r);
      out.set(k, e);
    }
    for (const t of req.threads ?? []) {
      const k = `${t.accountId}\u0000${t.threadId}`;
      if (!out.has(k)) out.set(k, { accountId: t.accountId, threadId: t.threadId, rows: [] });
    }
    return [...out.values()];
  }

  async setMuted(req: MuteSetReq): Promise<MuteSetRes> {
    const threads = this.threadsOf(req);
    if (threads.length === 0) return { ok: true, archivedCount: 0, changed: [] };
    if (!req.muted) return this.unmute(threads);

    // Which existing messages get archived: the conversation's messages in the current view.
    const toArchive = new Set<MessageId>();
    for (const t of threads) {
      for (const r of this.archivable(t, req)) toArchive.add(r.id);
    }
    const now = this.ctx.now();
    const changed = this.writeMuted(threads, true, now);
    let archived: MessageId[] = [];
    let archiveToken: string | undefined;
    if (toArchive.size > 0) {
      const res = await this.actions.apply({ messageIds: [...toArchive], action: { type: 'archive' } });
      archived = res.succeeded;
      archiveToken = res.undoToken;
    }
    const undoToken = this.undo.add(async () => {
      this.writeMuted(threads, false, this.ctx.now());
      if (archiveToken) await this.actions.undo(archiveToken).catch(() => undefined);
      return changed;
    });
    return { ok: true, archivedCount: archived.length, changed, undoToken };
  }

  /** Messages of the conversation that Mute archives now. */
  private archivable(t: { accountId: AccountId; threadId: string; rows: LightRow[] }, req: MuteSetReq): LightRow[] {
    let rows: LightRow[];
    if (req.scope) {
      const f = scopeFilter(req.scope, false);
      rows = this.ctx.db
        .prepare(
          `SELECT m.*, f.role AS frole FROM message m JOIN folder f ON f.id = m.folder_id
            WHERE m.account_id = :accountId AND m.thread_id = :threadId AND m.flag_draft = 0 AND ${f.where}`,
        )
        .all({ ...f.params, accountId: t.accountId, threadId: t.threadId }) as LightRow[];
    } else {
      // The folder(s) of the given messages, else the account's Inbox.
      const folders = new Set(t.rows.map((r) => r.folder_id));
      if (folders.size === 0) {
        const inbox = this.ctx.folders.rowByRole(t.accountId, 'inbox');
        if (inbox) folders.add(inbox.id);
      }
      const stmt = this.ctx.db.prepare(
        `SELECT m.*, f.role AS frole FROM message m JOIN folder f ON f.id = m.folder_id
          WHERE m.account_id = ? AND m.thread_id = ? AND m.folder_id = ? AND m.flag_draft = 0
            AND m.flag_deleted = 0 AND m.snoozed_until IS NULL`,
      );
      rows = [...folders].flatMap((fid) => stmt.all(t.accountId, t.threadId, fid) as LightRow[]);
    }
    return rows.filter((r) => !NO_ARCHIVE_ROLES.has(r.frole ?? '') && r.snoozed_until === null);
  }

  private unmute(threads: { accountId: AccountId; threadId: string }[]): MuteSetRes {
    const changed = this.writeMuted(threads, false, this.ctx.now());
    const undoToken = this.undo.add(async () => {
      this.writeMuted(threads, true, this.ctx.now());
      return changed;
    });
    return { ok: true, archivedCount: 0, changed, undoToken };
  }

  /** Write (or remove) the records and the flag on the messages. Returns the changed message ids. */
  private writeMuted(threads: { accountId: AccountId; threadId: string }[], muted: boolean, now: number): MessageId[] {
    const db = this.ctx.db;
    const ids: MessageId[] = [];
    const folderIds = new Set<number>();
    db.transaction(() => {
      for (const t of threads) {
        if (muted) {
          db.prepare(
            `INSERT INTO muted_threads (account_id, thread_key, muted_at, last_hit_at) VALUES (?,?,?,?)
             ON CONFLICT(account_id, thread_key) DO UPDATE SET last_hit_at = excluded.last_hit_at`,
          ).run(t.accountId, t.threadId, now, now);
          this.trim(t.accountId, now);
        } else {
          db.prepare('DELETE FROM muted_threads WHERE account_id = ? AND thread_key = ?').run(t.accountId, t.threadId);
        }
        const rows = db
          .prepare('UPDATE message SET muted = ? WHERE account_id = ? AND thread_id = ? AND muted != ? RETURNING id, folder_id')
          .all(muted ? 1 : 0, t.accountId, t.threadId, muted ? 1 : 0) as { id: number; folder_id: number }[];
        for (const r of rows) {
          ids.push(r.id);
          folderIds.add(r.folder_id);
        }
      }
    })();
    this.mutedCount = (db.prepare('SELECT COUNT(*) AS n FROM muted_threads').get() as { n: number }).n;
    if (ids.length > 0) this.ctx.hub.changed({ folderIds: [...folderIds], updated: ids });
    return ids;
  }

  /** Keep at most 500 per account (drop the least recently active) and forget records unused for a year. */
  private trim(accountId: string, now: number): void {
    const db = this.ctx.db;
    const drop = (rows: { thread_key: string }[]) => {
      for (const r of rows) {
        db.prepare('DELETE FROM muted_threads WHERE account_id = ? AND thread_key = ?').run(accountId, r.thread_key);
        db.prepare('UPDATE message SET muted = 0 WHERE account_id = ? AND thread_id = ?').run(accountId, r.thread_key);
      }
    };
    drop(
      db
        .prepare('SELECT thread_key FROM muted_threads WHERE account_id = ? AND last_hit_at < ?')
        .all(accountId, now - YEAR_MS) as { thread_key: string }[],
    );
    const n = (db.prepare('SELECT COUNT(*) AS n FROM muted_threads WHERE account_id = ?').get(accountId) as { n: number }).n;
    if (n > MAX_MUTED_PER_ACCOUNT) {
      drop(
        db
          .prepare('SELECT thread_key FROM muted_threads WHERE account_id = ? ORDER BY last_hit_at ASC LIMIT ?')
          .all(accountId, n - MAX_MUTED_PER_ACCOUNT) as { thread_key: string }[],
      );
    }
  }

  // ---------- new mail ----------

  /**
   * After a sync stored new mail (after the rules): new messages of a muted conversation that are in
   * the Inbox are flagged and archived. Nothing runs while no conversation is muted.
   */
  async onNewMail(folder: FolderRow, res: { kind: string; added: number[] }): Promise<void> {
    if (this.mutedCount === 0 || folder.role !== 'inbox') return;
    if (res.kind !== 'incremental' || res.added.length === 0) return;
    const look = this.ctx.db.prepare('SELECT 1 FROM muted_threads WHERE account_id = ? AND thread_key = ?');
    const hit: number[] = [];
    const hitThreads = new Map<string, string>();
    for (const id of res.added) {
      const r = this.ctx.messages.row(id);
      // The rules may have moved it already; a snoozed conversation comes back first.
      if (!r || !r.thread_id || r.folder_id !== folder.id || r.flag_deleted === 1 || r.snoozed_until !== null) continue;
      if (look.get(r.account_id, r.thread_id) === undefined) continue;
      hit.push(id);
      hitThreads.set(`${r.account_id}\u0000${r.thread_id}`, r.account_id);
    }
    if (hit.length === 0) return;
    const now = this.ctx.now();
    const mark = this.ctx.db.prepare('UPDATE message SET muted = 1 WHERE id = ?');
    const touch = this.ctx.db.prepare('UPDATE muted_threads SET last_hit_at = ? WHERE account_id = ? AND thread_key = ?');
    this.ctx.db.transaction(() => {
      for (const id of hit) mark.run(id);
      for (const k of hitThreads.keys()) {
        const [a, t] = k.split('\u0000') as [string, string];
        touch.run(now, a, t);
      }
    })();
    await this.actions.applyQuiet(hit, { type: 'archive' });
  }
}
