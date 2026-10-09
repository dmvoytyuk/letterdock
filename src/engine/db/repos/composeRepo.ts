// Outbox, local draft state and picked compose files.
import type { Db } from '../connection';

export interface OutboxRow {
  id: number;
  account_id: string;
  raw_path: string;
  created_at: number;
  attempts: number;
  last_error: string | null;
  state: 'queued' | 'sending' | 'failed';
  subject: string;
  send_after: number;
  meta_json: string | null;
}

export interface DraftStateRow {
  draft_id: string;
  account_id: string;
  mode: string;
  source_message_pk: number | null;
  in_reply_to: string | null;
  references_h: string | null;
  message_id: string;
  content_json: string | null;
  server_folder_id: number | null;
  updated_at: number;
  /** Row in the Drafts folder that shows this draft. */
  local_message_pk: number | null;
  /** 1 while the server copy is older than the local text. */
  server_dirty: number;
  /** Counts saves. */
  rev: number;
}

export interface ComposeFileRow {
  token: string;
  path: string;
  filename: string;
  size: number;
  content_type: string;
  created_at: number;
}

export class ComposeRepo {
  constructor(private readonly db: Db) {}

  // ---------- outbox ----------
  insertOutbox(r: {
    accountId: string;
    subject: string;
    sendAfter: number;
    metaJson: string;
    createdAt: number;
  }): number {
    const res = this.db
      .prepare(
        `INSERT INTO outbox (account_id, raw_path, created_at, attempts, state, subject, send_after, meta_json)
         VALUES (?, '', ?, 0, 'queued', ?, ?, ?)`,
      )
      .run(r.accountId, r.createdAt, r.subject, r.sendAfter, r.metaJson);
    return Number(res.lastInsertRowid);
  }

  setOutboxPath(id: number, path: string): void {
    this.db.prepare('UPDATE outbox SET raw_path = ? WHERE id = ?').run(path, id);
  }

  outbox(id: number): OutboxRow | null {
    return (this.db.prepare('SELECT * FROM outbox WHERE id = ?').get(id) as OutboxRow) ?? null;
  }

  listOutbox(): OutboxRow[] {
    return this.db.prepare('SELECT * FROM outbox ORDER BY id').all() as OutboxRow[];
  }

  updateOutbox(
    id: number,
    p: Partial<Pick<OutboxRow, 'state' | 'attempts' | 'last_error' | 'send_after'>>,
  ): void {
    const cur = this.outbox(id);
    if (!cur) return;
    const n = { ...cur, ...p };
    this.db
      .prepare('UPDATE outbox SET state=?, attempts=?, last_error=?, send_after=? WHERE id=?')
      .run(n.state, n.attempts, n.last_error, n.send_after, id);
  }

  deleteOutbox(id: number): void {
    this.db.prepare('DELETE FROM outbox WHERE id = ?').run(id);
  }

  // ---------- draft state ----------
  draft(draftId: string): DraftStateRow | null {
    return (
      (this.db.prepare('SELECT * FROM draft_state WHERE draft_id = ?').get(draftId) as
        DraftStateRow | undefined) ?? null
    );
  }

  upsertDraft(d: DraftStateRow): void {
    this.db
      .prepare(
        `INSERT INTO draft_state (draft_id, account_id, mode, source_message_pk, in_reply_to, references_h,
           message_id, content_json, server_folder_id, updated_at, local_message_pk, server_dirty, rev)
         VALUES (@draft_id,@account_id,@mode,@source_message_pk,@in_reply_to,@references_h,
           @message_id,@content_json,@server_folder_id,@updated_at,@local_message_pk,@server_dirty,@rev)
         ON CONFLICT(draft_id) DO UPDATE SET account_id=excluded.account_id, mode=excluded.mode,
           source_message_pk=excluded.source_message_pk, in_reply_to=excluded.in_reply_to,
           references_h=excluded.references_h, message_id=excluded.message_id,
           content_json=excluded.content_json, server_folder_id=excluded.server_folder_id,
           updated_at=excluded.updated_at, local_message_pk=excluded.local_message_pk,
           server_dirty=excluded.server_dirty, rev=excluded.rev`,
      )
      .run(d);
  }

  /** The draft shown by this Drafts-folder row. */
  draftByRow(messageId: number): DraftStateRow | null {
    return (
      (this.db.prepare('SELECT * FROM draft_state WHERE local_message_pk = ?').get(messageId) as
        DraftStateRow | undefined) ?? null
    );
  }

  /** Drafts of one account with this Message-ID. */
  draftsByMessageId(accountId: string, messageId: string): DraftStateRow[] {
    return this.db
      .prepare('SELECT * FROM draft_state WHERE account_id = ? AND message_id = ?')
      .all(accountId, messageId) as DraftStateRow[];
  }

  /** Drafts whose server copy is not up to date (oldest first). */
  dirtyDrafts(): DraftStateRow[] {
    return this.db
      .prepare('SELECT * FROM draft_state WHERE server_dirty = 1 ORDER BY updated_at')
      .all() as DraftStateRow[];
  }

  /** The upload of save number `rev` finished; a newer save keeps the draft dirty. */
  markClean(draftId: string, rev: number, serverFolderId: number): boolean {
    const r = this.db
      .prepare(
        'UPDATE draft_state SET server_dirty = 0, server_folder_id = ? WHERE draft_id = ? AND rev = ?',
      )
      .run(serverFolderId, draftId, rev);
    return r.changes > 0;
  }

  setLocalRow(draftId: string, messageId: number | null): void {
    this.db.prepare('UPDATE draft_state SET local_message_pk = ? WHERE draft_id = ?').run(messageId, draftId);
  }

  setServerFolder(draftId: string, folderId: number): void {
    this.db.prepare('UPDATE draft_state SET server_folder_id = ? WHERE draft_id = ?').run(folderId, draftId);
  }

  deleteDraft(draftId: string): void {
    this.db.prepare('DELETE FROM draft_state WHERE draft_id = ?').run(draftId);
  }

  // ---------- compose files ----------
  insertFile(f: ComposeFileRow): void {
    this.db
      .prepare(
        'INSERT INTO compose_file (token, path, filename, size, content_type, created_at) VALUES (?,?,?,?,?,?)',
      )
      .run(f.token, f.path, f.filename, f.size, f.content_type, f.created_at);
  }

  file(token: string): ComposeFileRow | null {
    return (
      (this.db.prepare('SELECT * FROM compose_file WHERE token = ?').get(token) as
        ComposeFileRow | undefined) ?? null
    );
  }

  deleteFile(token: string): void {
    this.db.prepare('DELETE FROM compose_file WHERE token = ?').run(token);
  }

  filesOlderThan(ms: number): ComposeFileRow[] {
    return this.db
      .prepare('SELECT * FROM compose_file WHERE created_at < ?')
      .all(ms) as ComposeFileRow[];
  }
}
