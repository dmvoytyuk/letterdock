// Snooze (DESIGN-SPEC 3.13.2). Hides messages on this PC until a chosen time, then brings them back
// to the top as unread. The server is not told about the hiding (the message stays in the Inbox
// there); only the "unread" on return goes through the normal action queue.
//
// Cost model: no polling. ONE timer for the nearest wake time (re-armed after every change), one
// indexed check at start and one when the PC wakes up / unlocks. Wake times are absolute, so clock
// or time-zone changes are safe: a time in the past wakes at the next check.
import type {
  AccountId,
  LightTargets,
  MessageHeader,
  MessageId,
  SnoozeClearRes,
  SnoozeCount,
  SnoozedItem,
  SnoozeSetReq,
  SnoozeSetRes,
} from '../../shared/ipc';
import { AppException, toAppError } from '../../shared/errors';
import type { EngineContext } from '../context';
import { rowToHeader, type MessageRow } from '../db/repos/messageRepo';
import type { ActionService } from './actionService';
import { accountsOf, foldersOf, resolveTargets, type LightUndo } from './lightShared';

const MAX_AHEAD_MS = 366 * 24 * 3600_000;
/** setTimeout cannot wait longer than 2^31-1 ms; wait at most a day and look again. */
const MAX_TIMER_MS = 24 * 3600_000;
/** Snooze works in the Inbox and in the user's own folders. */
const SNOOZE_ROLES = new Set<string | null>([null, 'inbox']);
const NOTIFY_MAX = 50;

export class SnoozeService {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  /** How many messages are snoozed (kept in memory; the new-mail step reads it for free). */
  private count = 0;
  private waking = false;

  constructor(
    private readonly ctx: EngineContext,
    private readonly actions: ActionService,
    private readonly undo: LightUndo,
  ) {}

  /** App start: count what is snoozed, wake what is overdue, arm the timer. */
  start(): void {
    this.refreshCount();
    if (this.count === 0) return;
    void this.wakeDue();
    this.arm();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** The PC woke up or was unlocked, or a test wants to look now. */
  async recheck(): Promise<void> {
    if (this.stopped) return;
    this.refreshCount();
    if (this.count === 0) return;
    await this.wakeDue();
    this.arm();
  }

  hasSnoozed(): boolean {
    return this.count > 0;
  }

  private refreshCount(): void {
    this.count = (
      this.ctx.db.prepare('SELECT COUNT(*) AS n FROM message WHERE snoozed_until IS NOT NULL').get() as {
        n: number;
      }
    ).n;
  }

  // ---------- the one timer ----------

  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.stopped || this.count === 0) return;
    const next = (
      this.ctx.db.prepare('SELECT MIN(snoozed_until) AS t FROM message WHERE snoozed_until IS NOT NULL').get() as {
        t: number | null;
      }
    ).t;
    if (next === null) return;
    const delay = Math.min(Math.max(next - this.ctx.now(), 0) + 25, MAX_TIMER_MS);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.wakeDue().finally(() => this.arm());
    }, delay);
    this.timer.unref?.();
  }

  // ---------- set / clear ----------

  set(req: SnoozeSetReq): SnoozeSetRes {
    const now = this.ctx.now();
    if (!Number.isFinite(req.until) || req.until <= now) {
      throw new AppException('INVALID_INPUT', 'Pick a time in the future.');
    }
    if (req.until > now + MAX_AHEAD_MS) {
      throw new AppException('INVALID_INPUT', 'You can snooze for up to one year.');
    }
    const rows = resolveTargets(this.ctx, req);
    const res: SnoozeSetRes = { snoozed: [], failed: [] };
    const ok: (MessageRow & { frole: string | null })[] = [];
    for (const r of rows) {
      if (!SNOOZE_ROLES.has(r.frole)) {
        res.failed.push({
          id: r.id,
          error: toAppError(
            new AppException('INVALID_INPUT', 'Snooze works in the Inbox and in your own folders.'),
          ),
        });
      } else ok.push(r);
    }
    for (const id of new Set(req.messageIds ?? [])) {
      if (!rows.some((r) => r.id === id)) {
        res.failed.push({ id, error: toAppError(new AppException('NOT_FOUND', 'Message not found.')) });
      }
    }
    if (ok.length === 0) return res;
    const prev = ok.map((r) => ({ id: r.id, until: r.snoozed_until, returned: r.snooze_returned_at }));
    this.writeSnooze(ok.map((r) => ({ id: r.id, until: req.until, returned: null })), ok);
    res.snoozed = ok.map((r) => r.id);
    res.undoToken = this.undo.add(async () => {
      const rowsNow = prev
        .map((p) => this.ctx.messages.row(p.id))
        .filter((r): r is MessageRow => !!r);
      this.writeSnooze(prev.filter((p) => rowsNow.some((r) => r.id === p.id)), rowsNow);
      return rowsNow.map((r) => r.id);
    });
    return res;
  }

  /** Set the snooze columns of these rows and tell everyone. */
  private writeSnooze(
    items: { id: MessageId; until: number | null; returned: number | null }[],
    rows: MessageRow[],
  ): void {
    const upd = this.ctx.db.prepare('UPDATE message SET snoozed_until = ?, snooze_returned_at = ? WHERE id = ?');
    this.ctx.db.transaction(() => {
      for (const i of items) upd.run(i.until, i.returned, i.id);
    })();
    this.refreshCount();
    const folderIds = foldersOf(rows);
    for (const f of folderIds) this.ctx.folders.recomputeCounts(f);
    const hidden = items.filter((i) => i.until !== null).map((i) => i.id);
    const shown = items.filter((i) => i.until === null).map((i) => i.id);
    this.ctx.hub.changed({ folderIds, removed: hidden, added: shown });
    for (const a of accountsOf(rows)) this.ctx.hub.emit({ type: 'snooze:changed', accountId: a });
    this.arm();
  }

  /** "Unsnooze now": back at once, unread, at the top. */
  async clear(req: LightTargets): Promise<SnoozeClearRes> {
    const rows = resolveTargets(this.ctx, req, { includeSnoozed: true }).filter((r) => r.snoozed_until !== null);
    if (rows.length === 0) return { cleared: [] };
    const prev = rows.map((r) => ({ id: r.id, until: r.snoozed_until, returned: r.snooze_returned_at, seen: r.flag_seen }));
    await this.wake(rows, false);
    const undoToken = this.undo.add(async () => {
      const now = prev
        .map((p) => this.ctx.messages.row(p.id))
        .filter((r): r is MessageRow => !!r);
      this.writeSnooze(
        prev.filter((p) => now.some((r) => r.id === p.id)).map((p) => ({ id: p.id, until: p.until, returned: p.returned })),
        now,
      );
      const wasSeen = prev.filter((p) => p.seen === 1 && now.some((r) => r.id === p.id)).map((p) => p.id);
      if (wasSeen.length > 0) await this.actions.applyQuiet(wasSeen, { type: 'markRead', read: true });
      return now.map((r) => r.id);
    });
    return { cleared: rows.map((r) => r.id), undoToken };
  }

  // ---------- waking ----------

  /** Everything whose time has come. */
  private async wakeDue(): Promise<void> {
    if (this.waking) return;
    this.waking = true;
    try {
      const rows = this.ctx.db
        .prepare('SELECT * FROM message WHERE snoozed_until IS NOT NULL AND snoozed_until <= ?')
        .all(this.ctx.now()) as MessageRow[];
      if (rows.length > 0) await this.wake(rows, true);
    } catch (e) {
      this.ctx.log.warn({ err: String((e as Error)?.message ?? e) }, 'snooze wake failed');
    } finally {
      this.waking = false;
    }
  }

  /** A reply came in: bring back the snoozed messages of these conversations at once. */
  async wakeThreads(accountId: string, threadIds: string[]): Promise<void> {
    if (this.count === 0 || threadIds.length === 0) return;
    const stmt = this.ctx.db.prepare(
      'SELECT * FROM message WHERE account_id = ? AND thread_id = ? AND snoozed_until IS NOT NULL',
    );
    const rows: MessageRow[] = [];
    for (const t of new Set(threadIds)) rows.push(...(stmt.all(accountId, t) as MessageRow[]));
    if (rows.length > 0) await this.wake(rows, false);
  }

  /**
   * Show these messages again: clear `snoozed_until`, remember the return time (the list puts them
   * on top; the chip shows), make them unread (here and on the server through the action queue).
   */
  private async wake(rows: MessageRow[], notify: boolean): Promise<void> {
    const now = this.ctx.now();
    const upd = this.ctx.db.prepare(
      'UPDATE message SET snoozed_until = NULL, snooze_returned_at = ? WHERE id = ? AND snoozed_until IS NOT NULL',
    );
    this.ctx.db.transaction(() => {
      for (const r of rows) upd.run(now, r.id);
    })();
    this.refreshCount();
    const unread = rows.filter((r) => r.flag_seen === 1).map((r) => r.id);
    if (unread.length > 0) {
      await this.actions.applyQuiet(unread, { type: 'markRead', read: false }).catch((e) =>
        this.ctx.log.warn({ err: String((e as Error)?.message ?? e) }, 'snooze: could not mark unread'),
      );
    }
    const folderIds = foldersOf(rows);
    for (const f of folderIds) this.ctx.folders.recomputeCounts(f);
    this.ctx.hub.changed({ folderIds, added: rows.map((r) => r.id) });
    for (const a of accountsOf(rows)) {
      this.ctx.hub.emit({ type: 'snooze:changed', accountId: a });
      if (!notify) continue;
      const ids = rows.filter((r) => r.account_id === a).map((r) => r.id).slice(0, NOTIFY_MAX);
      const messages: MessageHeader[] = this.ctx.messages.headers(ids);
      if (messages.length > 0) this.ctx.hub.emit({ type: 'snooze:returned', accountId: a, messages });
    }
    this.arm();
  }

  // ---------- reads ----------

  list(accountId?: AccountId): SnoozedItem[] {
    const rows = (
      accountId
        ? this.ctx.db
            .prepare('SELECT * FROM message WHERE account_id = ? AND snoozed_until IS NOT NULL AND flag_deleted = 0 ORDER BY snoozed_until, id')
            .all(accountId)
        : this.ctx.db
            .prepare('SELECT * FROM message WHERE snoozed_until IS NOT NULL AND flag_deleted = 0 ORDER BY snoozed_until, id')
            .all()
    ) as MessageRow[];
    return rows.map((r) => ({ header: rowToHeader(r), snoozedUntil: r.snoozed_until! }));
  }

  countAll(): SnoozeCount {
    const per = this.ctx.db
      .prepare(
        `SELECT account_id AS accountId, COUNT(*) AS total, MIN(snoozed_until) AS next
           FROM message WHERE snoozed_until IS NOT NULL AND flag_deleted = 0 GROUP BY account_id`,
      )
      .all() as { accountId: string; total: number; next: number }[];
    return {
      total: per.reduce((n, p) => n + p.total, 0),
      nextWakeAt: per.length > 0 ? Math.min(...per.map((p) => p.next)) : null,
      perAccount: per.map((p) => ({ accountId: p.accountId, total: p.total })),
    };
  }
}
