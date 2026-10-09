// Scheduled sends (DESIGN-SPEC 3.11). The message itself is a file; this table holds the plan.
import type { ScheduledStatus } from '../../../shared/ipc';
import type { Db } from '../connection';

export interface ScheduledRow {
  id: number;
  account_id: string;
  draft_id: string;
  subject: string;
  to_json: string;
  cc_json: string;
  snippet: string;
  has_attachments: number;
  send_at: number;
  created_at: number;
  status: ScheduledStatus;
  last_error: string | null;
  attempt: number;
  raw_path: string;
  meta_json: string;
  message_id: string;
  outbox_id: number | null;
  sending_since: number | null;
  /** Outbox tries and last error the message had when the app stopped (see migration 010). */
  resume_attempts: number;
  resume_error: string | null;
}

export interface NewScheduled {
  accountId: string;
  draftId: string;
  subject: string;
  toJson: string;
  ccJson: string;
  snippet: string;
  hasAttachments: boolean;
  sendAt: number;
  createdAt: number;
  metaJson: string;
  messageId: string;
}

export class ScheduledRepo {
  constructor(private readonly db: Db) {}

  insert(n: NewScheduled): number {
    const r = this.db
      .prepare(
        `INSERT INTO scheduled_send (account_id, draft_id, subject, to_json, cc_json, snippet, has_attachments,
           send_at, created_at, meta_json, message_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        n.accountId,
        n.draftId,
        n.subject,
        n.toJson,
        n.ccJson,
        n.snippet,
        n.hasAttachments ? 1 : 0,
        n.sendAt,
        n.createdAt,
        n.metaJson,
        n.messageId,
      );
    return Number(r.lastInsertRowid);
  }

  get(id: number): ScheduledRow | null {
    return (
      (this.db.prepare('SELECT * FROM scheduled_send WHERE id = ?').get(id) as ScheduledRow | undefined) ??
      null
    );
  }

  list(accountId?: string): ScheduledRow[] {
    return (
      accountId
        ? this.db
            .prepare('SELECT * FROM scheduled_send WHERE account_id = ? ORDER BY send_at, id')
            .all(accountId)
        : this.db.prepare('SELECT * FROM scheduled_send ORDER BY send_at, id').all()
    ) as ScheduledRow[];
  }

  byStatus(status: ScheduledStatus): ScheduledRow[] {
    return this.db
      .prepare('SELECT * FROM scheduled_send WHERE status = ? ORDER BY send_at, id')
      .all(status) as ScheduledRow[];
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM scheduled_send').get() as { n: number }).n;
  }

  setRawPath(id: number, path: string): void {
    this.db.prepare('UPDATE scheduled_send SET raw_path = ? WHERE id = ?').run(path, id);
  }

  update(
    id: number,
    p: Partial<
      Pick<
        ScheduledRow,
        'status' | 'send_at' | 'last_error' | 'attempt' | 'outbox_id' | 'sending_since'
      >
    >,
  ): void {
    const cur = this.get(id);
    if (!cur) return;
    const n = { ...cur, ...p };
    this.db
      .prepare(
        `UPDATE scheduled_send SET status=?, send_at=?, last_error=?, attempt=?, outbox_id=?, sending_since=?
          WHERE id=?`,
      )
      .run(n.status, n.send_at, n.last_error, n.attempt, n.outbox_id, n.sending_since, id);
  }

  setResume(id: number, attempts: number, error: string | null): void {
    this.db
      .prepare('UPDATE scheduled_send SET resume_attempts = ?, resume_error = ? WHERE id = ?')
      .run(attempts, error, id);
  }

  delete(id: number): void {
    this.db.prepare('DELETE FROM scheduled_send WHERE id = ?').run(id);
  }

  byOutbox(outboxId: number): ScheduledRow | null {
    return (
      (this.db.prepare('SELECT * FROM scheduled_send WHERE outbox_id = ?').get(outboxId) as
        ScheduledRow | undefined) ?? null
    );
  }
}
