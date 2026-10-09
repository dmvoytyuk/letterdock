// Rules and their activity list (DESIGN-SPEC 3.12).
import type { Rule, RuleCondition } from '../../../shared/ipc';
import type { Db } from '../connection';

export interface RuleRow {
  id: number;
  name: string;
  enabled: number;
  account_id: string | null;
  position: number;
  match_mode: 'all' | 'any';
  conditions_json: string;
  move_folder_id: number | null;
  move_folder_path: string | null;
  mark_read: number;
  flag: number;
  delete_to_trash: number;
  stop: number;
  run_on: 'inbox' | 'anyFolder';
  warning: string | null;
  created_at: number;
}

export interface ActivityRow {
  id: number;
  ts: number;
  rule_id: number | null;
  rule_name: string;
  account_id: string;
  count: number;
  subject: string | null;
  sender: string | null;
  summary: string;
  undo_json: string;
  undone: number;
  run_now: number;
  kind: 'change' | 'warning';
}

/** What one entry changed, per message: enough to reverse it and to see that nothing changed since. */
export interface UndoItem {
  id: number;
  /** The folder the message was in before. */
  fromFolderId: number;
  /** The folder the rule moved it to (null: not moved). */
  movedToFolderId: number | null;
  /** The rule marked it read (it was unread). */
  readChanged: boolean;
  /** The rule flagged it (it was not flagged). */
  flagChanged: boolean;
}

export function rowToRule(r: RuleRow): Rule {
  let conditions: RuleCondition[] = [];
  try {
    conditions = JSON.parse(r.conditions_json) as RuleCondition[];
  } catch {
    /* unreadable: no conditions, the rule never matches */
  }
  return {
    id: r.id,
    name: r.name,
    enabled: r.enabled === 1,
    accountId: r.account_id,
    position: r.position,
    matchMode: r.match_mode,
    conditions,
    actions: {
      moveToFolderId: r.move_folder_id,
      moveToFolderPath: r.move_folder_path,
      markRead: r.mark_read === 1,
      flag: r.flag === 1,
      delete: r.delete_to_trash === 1,
      stop: r.stop === 1,
    },
    trigger: r.run_on,
    createdAt: r.created_at,
    warning: r.warning
      ? { kind: 'folderMissing', message: r.warning, folderPath: r.move_folder_path }
      : null,
  };
}

export class RulesRepo {
  constructor(private readonly db: Db) {}

  // ---------- rules ----------
  rows(): RuleRow[] {
    return this.db.prepare('SELECT * FROM rules ORDER BY position, id').all() as RuleRow[];
  }

  list(): Rule[] {
    return this.rows().map(rowToRule);
  }

  row(id: number): RuleRow | null {
    return (this.db.prepare('SELECT * FROM rules WHERE id = ?').get(id) as RuleRow | undefined) ?? null;
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM rules').get() as { n: number }).n;
  }

  countForAccount(accountId: string): number {
    return (
      this.db.prepare('SELECT COUNT(*) AS n FROM rules WHERE account_id = ?').get(accountId) as {
        n: number;
      }
    ).n;
  }

  insert(r: Omit<RuleRow, 'id'> & { id?: number }): number {
    const res = this.db
      .prepare(
        `INSERT INTO rules (id, name, enabled, account_id, position, match_mode, conditions_json, move_folder_id,
           move_folder_path, mark_read, flag, delete_to_trash, stop, run_on, warning, created_at)
         VALUES (@id, @name, @enabled, @account_id, @position, @match_mode, @conditions_json, @move_folder_id,
           @move_folder_path, @mark_read, @flag, @delete_to_trash, @stop, @run_on, @warning, @created_at)`,
      )
      .run({ ...r, id: r.id ?? null });
    return Number(res.lastInsertRowid);
  }

  save(r: RuleRow): void {
    this.db
      .prepare(
        `UPDATE rules SET name=@name, enabled=@enabled, account_id=@account_id, position=@position,
           match_mode=@match_mode, conditions_json=@conditions_json, move_folder_id=@move_folder_id,
           move_folder_path=@move_folder_path, mark_read=@mark_read, flag=@flag,
           delete_to_trash=@delete_to_trash, stop=@stop, run_on=@run_on, warning=@warning
         WHERE id=@id`,
      )
      .run(r);
  }

  delete(id: number): void {
    this.db.prepare('DELETE FROM rules WHERE id = ?').run(id);
  }

  /** Positions 1..n in the given order (ids not listed keep their relative order at the end). */
  setOrder(ids: number[]): void {
    const upd = this.db.prepare('UPDATE rules SET position = ? WHERE id = ?');
    this.db.transaction(() => {
      let p = 1;
      for (const id of ids) upd.run(p++, id);
    })();
  }

  renumber(): void {
    this.setOrder(this.rows().map((r) => r.id));
  }

  // ---------- activity ----------
  activity(): ActivityRow[] {
    return this.db
      .prepare('SELECT * FROM rule_activity ORDER BY ts DESC, id DESC')
      .all() as ActivityRow[];
  }

  activityRow(id: number): ActivityRow | null {
    return (
      (this.db.prepare('SELECT * FROM rule_activity WHERE id = ?').get(id) as ActivityRow | undefined) ?? null
    );
  }

  insertActivity(a: Omit<ActivityRow, 'id'>): number {
    const res = this.db
      .prepare(
        `INSERT INTO rule_activity (ts, rule_id, rule_name, account_id, count, subject, sender, summary,
           undo_json, undone, run_now, kind)
         VALUES (@ts, @rule_id, @rule_name, @account_id, @count, @subject, @sender, @summary,
           @undo_json, @undone, @run_now, @kind)`,
      )
      .run(a);
    // Keep the last 50.
    this.db
      .prepare(
        'DELETE FROM rule_activity WHERE id NOT IN (SELECT id FROM rule_activity ORDER BY ts DESC, id DESC LIMIT 50)',
      )
      .run();
    return Number(res.lastInsertRowid);
  }

  updateActivity(id: number, p: Partial<Pick<ActivityRow, 'count' | 'subject' | 'sender' | 'summary' | 'undo_json' | 'undone'>>): void {
    const cur = this.activityRow(id);
    if (!cur) return;
    const n = { ...cur, ...p };
    this.db
      .prepare(
        'UPDATE rule_activity SET count=?, subject=?, sender=?, summary=?, undo_json=?, undone=? WHERE id=?',
      )
      .run(n.count, n.subject, n.sender, n.summary, n.undo_json, n.undone, id);
  }

  deleteActivity(ids: number[]): void {
    const del = this.db.prepare('DELETE FROM rule_activity WHERE id = ?');
    this.db.transaction(() => {
      for (const id of ids) del.run(id);
    })();
  }

  clearActivity(): void {
    this.db.prepare('DELETE FROM rule_activity').run();
  }

  /** Recent entries of a rule that can still be merged into a burst. */
  recentOfRule(ruleId: number, accountId: string, sinceMs: number): ActivityRow[] {
    return this.db
      .prepare(
        `SELECT * FROM rule_activity
          WHERE rule_id = ? AND account_id = ? AND ts >= ? AND undone = 0 AND run_now = 0 AND kind = 'change'
          ORDER BY id`,
      )
      .all(ruleId, accountId, sinceMs) as ActivityRow[];
  }
}
