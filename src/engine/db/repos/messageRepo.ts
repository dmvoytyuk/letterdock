import type {
  Address,
  AttachmentInfo,
  DraftSyncState,
  FolderId,
  ListMessagesReq,
  ListScope,
  MessageHeader,
  MessageId,
  PageCursor,
} from '../../../shared/ipc';
import { AppException } from '../../../shared/errors';
import type { ContactSource } from '../../contacts/contactService';
import { ftsText } from '../../messages/bodyUtils';
import { normalizeSubject } from '../../messages/threading';
import type { Statement } from 'better-sqlite3';
import type { Db } from '../connection';
import { ThreadRepo, type ThreadKey } from './threadRepo';

export interface FlagSet {
  seen: boolean;
  flagged: boolean;
  answered: boolean;
  draft: boolean;
  deleted: boolean;
  keywords: string[];
}

export interface HeaderInput {
  accountId: string;
  folderId: FolderId;
  uid: number;
  messageId: string | null;
  inReplyTo: string | null;
  references: string | null;
  subject: string;
  from: Address | null;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  replyTo: Address[];
  dateMs: number;
  internalMs: number;
  size: number | null;
  flags: FlagSet;
  modseq: string | null;
  hasAttachments: boolean;
  /** The server's conversation id (Gmail X-GM-THRID), when it gave one. */
  gmThrid?: string | null;
}

export interface LocalFlagRow extends FlagSet {
  id: MessageId;
  uid: number;
}

export interface MessageRow {
  id: number;
  account_id: string;
  folder_id: number;
  uid: number;
  message_id: string | null;
  in_reply_to: string | null;
  references_h: string | null;
  subject: string;
  from_name: string | null;
  from_addr: string | null;
  to_json: string;
  cc_json: string;
  bcc_json: string;
  reply_to_json: string;
  date_ms: number;
  internal_ms: number;
  size: number | null;
  snippet: string;
  flag_seen: number;
  flag_flagged: number;
  flag_answered: number;
  flag_draft: number;
  flag_deleted: number;
  keywords_json: string;
  has_attachments: number;
  body_state: 'none' | 'cached';
  /** Drafts only: 'saving' | 'queued' | 'failed' while the server copy is not up to date; else null. */
  draft_sync: string | null;
  /** Conversation (DESIGN-SPEC 3.10). */
  thread_id: string | null;
  subject_norm: string | null;
  /** 1 once the rules looked at this message (DESIGN-SPEC 3.12). */
  rules_done?: number;
  /** DESIGN-SPEC 3.13: pin time, muted flag, hidden-until time, time it came back from snooze. */
  pinned_at: number | null;
  muted: number;
  snoozed_until: number | null;
  snooze_returned_at: number | null;
}

interface ContactRow {
  id: number;
  account_id: string;
  role: string | null;
  from_name: string | null;
  from_addr: string | null;
  to_json: string;
  cc_json: string;
  bcc_json: string;
  reply_to_json: string;
  date_ms: number;
  message_id: string | null;
}

function toContactSource(r: ContactRow): { id: number; source: ContactSource } {
  return {
    id: r.id,
    source: {
      accountId: r.account_id,
      role: r.role,
      fromName: r.from_name,
      fromAddr: r.from_addr,
      to: parseAddrs(r.to_json),
      cc: parseAddrs(r.cc_json),
      bcc: parseAddrs(r.bcc_json),
      replyTo: parseAddrs(r.reply_to_json),
      dateMs: r.date_ms,
      messageId: r.message_id,
    },
  };
}

function parseAddrs(json: string): Address[] {
  try {
    return JSON.parse(json) as Address[];
  } catch {
    return [];
  }
}

export function rowToHeader(r: MessageRow): MessageHeader {
  const draftExtra: Pick<MessageHeader, 'localOnly' | 'draftSync'> =
    r.flag_draft === 1
      ? {
          localOnly: r.draft_sync !== null,
          draftSync: (r.draft_sync as DraftSyncState | null) ?? 'saved',
        }
      : {};
  return {
    ...draftExtra,
    id: r.id,
    accountId: r.account_id,
    folderId: r.folder_id,
    uid: r.uid,
    messageIdHeader: r.message_id,
    subject: r.subject,
    from: r.from_addr ? { name: r.from_name ?? undefined, address: r.from_addr } : null,
    to: parseAddrs(r.to_json),
    cc: parseAddrs(r.cc_json),
    date: r.date_ms,
    snippet: r.snippet,
    seen: r.flag_seen === 1,
    flagged: r.flag_flagged === 1,
    answered: r.flag_answered === 1,
    draft: r.flag_draft === 1,
    hasAttachments: r.has_attachments === 1,
    size: r.size,
    bodyCached: r.body_state === 'cached',
    ...(r.thread_id ? { threadId: r.thread_id } : {}),
    // Tiny flags, only present when set (DESIGN-SPEC 3.13: a few integers per row, nothing else).
    ...(r.pinned_at ? { pinned: true } : {}),
    ...(r.muted === 1 ? { muted: true } : {}),
    ...(r.snooze_returned_at ? { snoozeReturnedAt: r.snooze_returned_at } : {}),
    ...(r.snoozed_until ? { snoozedUntil: r.snoozed_until } : {}),
  };
}

/** Normalized root id for later threading: first References id, else In-Reply-To, else own id. */
export function threadKey(h: {
  messageId: string | null;
  inReplyTo: string | null;
  references: string | null;
}): string | null {
  const first = h.references?.match(/<[^>]+>/)?.[0];
  return (first ?? h.inReplyTo ?? h.messageId)?.toLowerCase() ?? null;
}

export interface BodyInput {
  text: string | null;
  html: string | null;
  snippet: string;
  attachments: {
    partId: string;
    filename: string | null;
    contentType: string;
    size: number;
    contentId: string | null;
    inline: boolean;
    cachedPath?: string | null;
  }[];
  ftsBodyText: string;
  /** The whole source, compressed (see messageService); stored next to the body. */
  rawZ?: Buffer | null;
}

export interface ScopeFilter {
  from: string;
  where: string;
  params: Record<string, unknown>;
}

/** Translate a ListScope to SQL fragments (all queries alias message as m, folder as f). */
export function scopeFilter(scope: ListScope, unreadOnly: boolean): ScopeFilter {
  const base = 'FROM message m JOIN folder f ON f.id = m.folder_id';
  // Snoozed messages are hidden everywhere (DESIGN-SPEC 3.13.2).
  const conds = ['m.flag_deleted = 0', 'm.snoozed_until IS NULL'];
  const params: Record<string, unknown> = {};
  switch (scope.kind) {
    case 'unifiedInbox':
      conds.push("f.role = 'inbox'");
      break;
    case 'unifiedUnread':
      conds.push("f.role = 'inbox'", 'm.flag_seen = 0');
      break;
    case 'unifiedFlagged':
      conds.push('m.flag_flagged = 1', "(f.role IS NULL OR f.role NOT IN ('trash','junk'))");
      break;
    case 'folder':
      conds.push('m.folder_id = :folderId');
      params.folderId = scope.folderId;
      break;
    case 'accountInbox':
      conds.push("f.role = 'inbox'", 'm.account_id = :accountId');
      params.accountId = scope.accountId;
      break;
  }
  if (unreadOnly) conds.push('m.flag_seen = 0');
  return { from: base, where: conds.join(' AND '), params };
}

export class MessageRepo {
  readonly threads: ThreadRepo;
  /**
   * Conversations that changed since the last `drainTouchedThreads` (rows added or deleted, threads
   * merged). The event hub turns these into `conversations:changed`.
   */
  private touched = new Map<string, Set<string>>();

  constructor(private readonly db: Db) {
    this.threads = new ThreadRepo(db);
  }

  /** Remember that these conversations changed. */
  touchThreads(keys: ThreadKey[]): void {
    for (const k of keys) {
      let set = this.touched.get(k.accountId);
      if (!set) this.touched.set(k.accountId, (set = new Set()));
      if (set.size < 2000) set.add(k.threadId);
    }
  }

  /** Conversations that changed, then forget them. */
  drainTouchedThreads(): Map<string, Set<string>> {
    const out = this.touched;
    this.touched = new Map();
    return out;
  }

  /** Conversation of each message id (rows that exist), grouped by account. */
  threadKeysOf(ids: MessageId[]): ThreadKey[] {
    const out: ThreadKey[] = [];
    const stmt = this.db.prepare('SELECT account_id, thread_id FROM message WHERE id = ?');
    for (const id of ids) {
      const r = stmt.get(id) as { account_id: string; thread_id: string | null } | undefined;
      if (r?.thread_id) out.push({ accountId: r.account_id, threadId: r.thread_id });
    }
    return out;
  }

  /** Called before rows are deleted: their conversations still change. */
  private captureThreads(ids: MessageId[]): void {
    if (ids.length === 0) return;
    this.touchThreads(this.threadKeysOf(ids));
  }

  // ---------- FTS (regular table; rowid == message.id) ----------
  private ftsReplace(
    id: number,
    f: { subject: string; from: string; to: string; snippet: string; body: string },
  ): void {
    this.db.prepare('DELETE FROM message_fts WHERE rowid = ?').run(id);
    this.db
      .prepare(
        'INSERT INTO message_fts(rowid, subject, from_text, to_text, snippet, body_text) VALUES (?,?,?,?,?,?)',
      )
      .run(id, f.subject, f.from, f.to, f.snippet, f.body);
  }

  private ftsDelete(ids: number[]): void {
    const stmt = this.db.prepare('DELETE FROM message_fts WHERE rowid = ?');
    for (const id of ids) stmt.run(id);
  }

  // ---------- headers ----------
  /** Insert or update headers by (folder, uid). Returns ids split into added/updated. */
  upsertHeaders(rows: HeaderInput[]): { added: MessageId[]; updated: MessageId[] } {
    const added: MessageId[] = [];
    const updated: MessageId[] = [];
    const find = this.db.prepare('SELECT id FROM message WHERE folder_id = ? AND uid = ?');
    const insert = this.db.prepare(
      `INSERT INTO message (account_id,folder_id,uid,message_id,in_reply_to,references_h,thread_key,subject,
         from_name,from_addr,to_json,cc_json,bcc_json,reply_to_json,date_ms,internal_ms,size,
         flag_seen,flag_flagged,flag_answered,flag_draft,flag_deleted,keywords_json,modseq,has_attachments,
         thread_id,subject_norm)
       VALUES (@accountId,@folderId,@uid,@messageId,@inReplyTo,@references,@threadKey,@subject,
         @fromName,@fromAddr,@to,@cc,@bcc,@replyTo,@dateMs,@internalMs,@size,
         @seen,@flagged,@answered,@draft,@deleted,@keywords,@modseq,@hasAttachments,
         @threadId,@subjectNorm)`,
    );
    const updateFlags = this.db.prepare(
      `UPDATE message SET flag_seen=?, flag_flagged=?, flag_answered=?, flag_draft=?, flag_deleted=?,
         keywords_json=?, modseq=? WHERE id=?`,
    );
    const tx = this.db.transaction(() => {
      for (const h of rows) {
        const existing = find.get(h.folderId, h.uid) as { id: number } | undefined;
        if (existing) {
          updateFlags.run(
            h.flags.seen ? 1 : 0,
            h.flags.flagged ? 1 : 0,
            h.flags.answered ? 1 : 0,
            h.flags.draft ? 1 : 0,
            h.flags.deleted ? 1 : 0,
            JSON.stringify(h.flags.keywords),
            h.modseq,
            existing.id,
          );
          updated.push(existing.id);
          continue;
        }
        const thread = this.threads.resolve({
          accountId: h.accountId,
          messageId: h.messageId,
          inReplyTo: h.inReplyTo,
          references: h.references,
          subject: h.subject,
          fromAddr: h.from?.address ?? null,
          to: h.to,
          cc: h.cc,
          dateMs: h.dateMs,
          gmThrid: h.gmThrid ?? null,
        });
        this.touchThreads([
          { accountId: h.accountId, threadId: thread.threadId },
          ...thread.merged.map((t) => ({ accountId: h.accountId, threadId: t })),
        ]);
        const res = insert.run({
          threadId: thread.threadId,
          subjectNorm: thread.subjectNorm,
          accountId: h.accountId,
          folderId: h.folderId,
          uid: h.uid,
          messageId: h.messageId,
          inReplyTo: h.inReplyTo,
          references: h.references,
          threadKey: threadKey(h),
          subject: h.subject,
          fromName: h.from?.name ?? null,
          fromAddr: h.from?.address ?? null,
          to: JSON.stringify(h.to),
          cc: JSON.stringify(h.cc),
          bcc: JSON.stringify(h.bcc),
          replyTo: JSON.stringify(h.replyTo),
          dateMs: h.dateMs,
          internalMs: h.internalMs,
          size: h.size,
          seen: h.flags.seen ? 1 : 0,
          flagged: h.flags.flagged ? 1 : 0,
          answered: h.flags.answered ? 1 : 0,
          draft: h.flags.draft ? 1 : 0,
          deleted: h.flags.deleted ? 1 : 0,
          keywords: JSON.stringify(h.flags.keywords),
          modseq: h.modseq,
          hasAttachments: h.hasAttachments ? 1 : 0,
        });
        const id = Number(res.lastInsertRowid);
        added.push(id);
        this.ftsReplace(id, {
          subject: h.subject,
          from: [h.from?.name, h.from?.address].filter(Boolean).join(' '),
          to: h.to.map((a) => `${a.name ?? ''} ${a.address}`).join(' '),
          snippet: '',
          body: '',
        });
      }
    });
    tx();
    return { added, updated };
  }

  /** Store list snippets taken from a partial body fetch (does not mark the body as cached). */
  setSnippets(items: { id: MessageId; snippet: string }[]): void {
    const upd = this.db.prepare("UPDATE message SET snippet=? WHERE id=? AND body_state='none'");
    this.db.transaction(() => {
      for (const it of items) upd.run(it.snippet, it.id);
    })();
  }

  /** Newest rows of a folder that still have no snippet, no cached body and were never tried. */
  snippetTodo(folderId: FolderId, limit: number): { id: MessageId; uid: number }[] {
    return this.db
      .prepare(
        `SELECT id, uid FROM message
         WHERE folder_id = ? AND snippet = '' AND snippet_checked = 0 AND body_state = 'none'
         ORDER BY date_ms DESC, id DESC LIMIT ?`,
      )
      .all(folderId, limit) as { id: number; uid: number }[];
  }

  /** Remember that these rows were tried, so the backfill never asks for them again. */
  markSnippetChecked(ids: MessageId[]): void {
    const upd = this.db.prepare('UPDATE message SET snippet_checked=1 WHERE id=?');
    this.db.transaction(() => {
      for (const id of ids) upd.run(id);
    })();
  }

  /** Flags of local rows with uid >= fromUid (for diffing against the server). */
  flagRows(folderId: FolderId, fromUid = 0): LocalFlagRow[] {
    const rows = this.db
      .prepare(
        `SELECT id, uid, flag_seen, flag_flagged, flag_answered, flag_draft, flag_deleted, keywords_json
         FROM message WHERE folder_id = ? AND uid >= ? ORDER BY uid`,
      )
      .all(folderId, fromUid) as {
      id: number;
      uid: number;
      flag_seen: number;
      flag_flagged: number;
      flag_answered: number;
      flag_draft: number;
      flag_deleted: number;
      keywords_json: string;
    }[];
    return rows.map((r) => ({
      id: r.id,
      uid: r.uid,
      seen: r.flag_seen === 1,
      flagged: r.flag_flagged === 1,
      answered: r.flag_answered === 1,
      draft: r.flag_draft === 1,
      deleted: r.flag_deleted === 1,
      keywords: JSON.parse(r.keywords_json) as string[],
    }));
  }

  applyFlags(
    folderId: FolderId,
    changes: { uid: number; flags: FlagSet; modseq?: string | null }[],
  ): MessageId[] {
    const ids: MessageId[] = [];
    const stmt = this.db.prepare(
      `UPDATE message SET flag_seen=?, flag_flagged=?, flag_answered=?, flag_draft=?, flag_deleted=?,
         keywords_json=?, modseq=COALESCE(?, modseq) WHERE folder_id=? AND uid=? RETURNING id`,
    );
    this.db.transaction(() => {
      for (const c of changes) {
        const r = stmt.get(
          c.flags.seen ? 1 : 0,
          c.flags.flagged ? 1 : 0,
          c.flags.answered ? 1 : 0,
          c.flags.draft ? 1 : 0,
          c.flags.deleted ? 1 : 0,
          JSON.stringify(c.flags.keywords),
          c.modseq ?? null,
          folderId,
          c.uid,
        ) as { id: number } | undefined;
        if (r) ids.push(r.id);
      }
    })();
    return ids;
  }

  deleteByUids(folderId: FolderId, uids: number[]): MessageId[] {
    const ids: MessageId[] = [];
    const find = this.db.prepare('SELECT id FROM message WHERE folder_id = ? AND uid = ?');
    const del = this.db.prepare('DELETE FROM message WHERE id = ?');
    this.db.transaction(() => {
      for (const uid of uids) {
        const r = find.get(folderId, uid) as { id: number } | undefined;
        if (!r) continue;
        ids.push(r.id);
        this.captureThreads([r.id]);
        del.run(r.id);
      }
      this.ftsDelete(ids);
    })();
    return ids;
  }

  deleteById(id: MessageId): void {
    this.db.transaction(() => {
      this.captureThreads([id]);
      this.db.prepare('DELETE FROM message WHERE id = ?').run(id);
      this.ftsDelete([id]);
    })();
  }

  /** Delete every message of a folder (UIDVALIDITY reset). Returns removed ids. */
  purgeFolder(folderId: FolderId): MessageId[] {
    const ids = (
      this.db.prepare('SELECT id FROM message WHERE folder_id = ?').all(folderId) as {
        id: number;
      }[]
    ).map((r) => r.id);
    this.db.transaction(() => {
      this.captureThreads(ids);
      this.db.prepare('DELETE FROM message WHERE folder_id = ?').run(folderId);
      this.ftsDelete(ids);
    })();
    return ids;
  }

  /** Delete these rows (and their search entries). Ids that do not exist are ignored. */
  deleteMany(ids: MessageId[]): void {
    if (ids.length === 0) return;
    this.db.transaction(() => {
      const del = this.db.prepare('DELETE FROM message WHERE id = ?');
      this.captureThreads(ids);
      for (const id of ids) del.run(id);
      this.ftsDelete(ids);
    })();
  }

  /** FTS cleanup for messages cascaded away with an account/folder delete. */
  ftsDeleteMany(ids: number[]): void {
    this.db.transaction(() => this.ftsDelete(ids))();
  }

  idsForAccount(accountId: string): number[] {
    return (
      this.db.prepare('SELECT id FROM message WHERE account_id = ?').all(accountId) as {
        id: number;
      }[]
    ).map((r) => r.id);
  }

  idsForFolder(folderId: FolderId): number[] {
    return (
      this.db.prepare('SELECT id FROM message WHERE folder_id = ?').all(folderId) as {
        id: number;
      }[]
    ).map((r) => r.id);
  }

  // ---------- reads ----------
  row(id: MessageId): MessageRow | null {
    return (this.db.prepare('SELECT * FROM message WHERE id = ?').get(id) as MessageRow) ?? null;
  }

  headers(ids: MessageId[]): MessageHeader[] {
    if (ids.length === 0) return [];
    const out: MessageHeader[] = [];
    const stmt = this.db.prepare('SELECT * FROM message WHERE id = ?');
    for (const id of ids) {
      const r = stmt.get(id) as MessageRow | undefined;
      if (r) out.push(rowToHeader(r));
    }
    return out;
  }

  list(req: ListMessagesReq): {
    items: MessageHeader[];
    nextCursor: PageCursor | null;
    total: number | null;
    pinned?: MessageHeader[];
  } {
    const limit = Math.min(Math.max(req.limit || 50, 1), 200);
    const sort = req.sort ?? 'date';
    const asc = (req.direction ?? (sort === 'date' ? 'desc' : 'asc')) === 'asc';
    const f = scopeFilter(req.scope, !!req.unreadOnly);
    const params: Record<string, unknown> = { ...f.params, limit: limit + 1 };
    let where = f.where;
    let order: string;
    // The key is the same SQL text for the WHERE of the next page and for the cursor, so the
    // comparison is like with like. Equal keys: newest first, whatever the direction.
    const keyExpr =
      sort === 'sender'
        ? "SUBSTR(LOWER(COALESCE(NULLIF(m.from_name, ''), m.from_addr, '')), 1, 200)"
        : "SUBSTR(COALESCE(m.subject_norm, LOWER(m.subject), ''), 1, 200)";
    if (sort === 'date') {
      order = asc ? 'm.date_ms ASC, m.id ASC' : 'm.date_ms DESC, m.id DESC';
      if (req.cursor) {
        where += asc
          ? ' AND (m.date_ms > :cDate OR (m.date_ms = :cDate AND m.id > :cId))'
          : ' AND (m.date_ms < :cDate OR (m.date_ms = :cDate AND m.id < :cId))';
      }
    } else {
      order = `${keyExpr} ${asc ? 'ASC' : 'DESC'}, m.date_ms DESC, m.id DESC`;
      if (req.cursor) {
        if (typeof req.cursor.key !== 'string') {
          throw new AppException(
            'INVALID_INPUT',
            'The page position does not match the sort order.',
          );
        }
        where += ` AND (${keyExpr} ${asc ? '>' : '<'} :cKey OR (${keyExpr} = :cKey AND (m.date_ms < :cDate OR (m.date_ms = :cDate AND m.id < :cId))))`;
        params.cKey = req.cursor.key;
      }
    }
    if (req.cursor) {
      params.cDate = req.cursor.date;
      params.cId = req.cursor.id;
    }
    // Pinned messages and messages that came back from snooze are served by their own small indexed
    // queries (page 1) and left out of the paged query, so ORDER BY keeps using the date index.
    // While nobody has pinned or snoozed anything, the main query is exactly as before.
    const topSets = this.topSets(req, sort, asc, f, order, keyExpr);
    where += topSets.extraWhere;
    const rows = this.db
      .prepare(
        `SELECT m.*, ${keyExpr} AS sort_key ${f.from} WHERE ${where} ORDER BY ${order} LIMIT :limit`,
      )
      .all(params) as (MessageRow & { sort_key: string })[];
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    let total: number | null = null;
    if (!req.cursor) {
      total = this.countFromFolders(req) ?? (
        this.db.prepare(`SELECT COUNT(*) AS n ${f.from} WHERE ${f.where}`).get(f.params) as { n: number }
      ).n;
    }
    return {
      items: [...topSets.returned.map(rowToHeader), ...page.map(rowToHeader)],
      nextCursor:
        hasMore && last
          ? {
              date: last.date_ms,
              id: last.id,
              ...(sort !== 'date' ? { key: last.sort_key ?? '' } : {}),
            }
          : null,
      total,
      ...(topSets.pinned.length > 0 ? { pinned: topSets.pinned.map(rowToHeader) } : {}),
    };
  }

  /**
   * The folders keep their message counts up to date (total without deleted and snoozed mail, and
   * unread), so the size of a folder or Inbox view is a sum over a few rows instead of a scan of
   * every message. Other views are counted from the messages.
   */
  private countFromFolders(req: ListMessagesReq): number | null {
    const col = req.unreadOnly || req.scope.kind === 'unifiedUnread' ? 'unread_count' : 'total_count';
    const s = req.scope;
    const row =
      s.kind === 'folder'
        ? this.db.prepare(`SELECT ${col} AS n FROM folder WHERE id = ?`).get(s.folderId)
        : s.kind === 'accountInbox'
          ? this.db
              .prepare(`SELECT COALESCE(SUM(${col}),0) AS n FROM folder WHERE role = 'inbox' AND account_id = ?`)
              .get(s.accountId)
          : s.kind === 'unifiedInbox' || s.kind === 'unifiedUnread'
            ? this.db.prepare(`SELECT COALESCE(SUM(${col}),0) AS n FROM folder WHERE role = 'inbox'`).get()
            : undefined;
    return row ? (row as { n: number }).n : null;
  }

  private stmtAnyPinned?: Statement;
  private stmtAnyReturned?: Statement;

  /**
   * DESIGN-SPEC 3.13.6 / 3.13.2. Folder and Inbox views (no unread filter) show pinned messages
   * first (any sort) and, in date order newest first, mail that came back from snooze before the
   * rest. Both sets are tiny (pins max 10 per folder; returned ones are cleared when read).
   * Returns the extra WHERE for the paged query and the rows for page 1.
   */
  private topSets(
    req: ListMessagesReq,
    sort: string,
    asc: boolean,
    f: ScopeFilter,
    order: string,
    keyExpr: string,
  ): { extraWhere: string; pinned: MessageRow[]; returned: MessageRow[] } {
    const none = { extraWhere: '', pinned: [] as MessageRow[], returned: [] as MessageRow[] };
    const k = req.scope.kind;
    if (req.unreadOnly || (k !== 'folder' && k !== 'accountInbox' && k !== 'unifiedInbox')) return none;
    let extraWhere = '';
    let pinned: MessageRow[] = [];
    let returned: MessageRow[] = [];
    this.stmtAnyPinned ??= this.db.prepare('SELECT 1 FROM message WHERE pinned_at IS NOT NULL LIMIT 1');
    if (this.stmtAnyPinned.get() !== undefined) {
      extraWhere += ' AND m.pinned_at IS NULL';
      if (!req.cursor) {
        pinned = this.db
          .prepare(
            `SELECT m.*, ${keyExpr} AS sort_key ${f.from} WHERE ${f.where} AND m.pinned_at IS NOT NULL
             ORDER BY ${order} LIMIT 200`,
          )
          .all(f.params) as MessageRow[];
      }
    }
    if (sort === 'date' && !asc) {
      this.stmtAnyReturned ??= this.db.prepare(
        'SELECT 1 FROM message WHERE snooze_returned_at IS NOT NULL LIMIT 1',
      );
      if (this.stmtAnyReturned.get() !== undefined) {
        extraWhere += ' AND (m.snooze_returned_at IS NULL OR m.pinned_at IS NOT NULL)';
        if (!req.cursor) {
          returned = this.db
            .prepare(
              `SELECT m.* ${f.from} WHERE ${f.where} AND m.snooze_returned_at IS NOT NULL AND m.pinned_at IS NULL
               ORDER BY m.snooze_returned_at DESC, m.id DESC LIMIT 100`,
            )
            .all(f.params) as MessageRow[];
        }
      }
    }
    return { extraWhere, pinned, returned };
  }

  /** Rows in the shape the contacts index reads (id order, ids above `afterId`). */
  contactSources(afterId: number, limit: number): { id: number; source: ContactSource }[] {
    const rows = this.db
      .prepare(
        `SELECT m.id, m.account_id, f.role, m.from_name, m.from_addr, m.to_json, m.cc_json, m.bcc_json,
                m.reply_to_json, m.date_ms, m.message_id
           FROM message m JOIN folder f ON f.id = m.folder_id
          WHERE m.id > ? AND m.flag_deleted = 0 AND m.uid > 0
          ORDER BY m.id LIMIT ?`,
      )
      .all(afterId, limit) as ContactRow[];
    return rows.map(toContactSource);
  }

  /** Same for specific ids (rows just added by a sync). */
  contactSourcesByIds(ids: MessageId[]): ContactSource[] {
    const out: ContactSource[] = [];
    const stmt = this.db.prepare(
      `SELECT m.id, m.account_id, f.role, m.from_name, m.from_addr, m.to_json, m.cc_json, m.bcc_json,
              m.reply_to_json, m.date_ms, m.message_id
         FROM message m JOIN folder f ON f.id = m.folder_id
        WHERE m.id = ? AND m.flag_deleted = 0`,
    );
    for (const id of ids) {
      const r = stmt.get(id) as ContactRow | undefined;
      if (r) out.push(toContactSource(r).source);
    }
    return out;
  }

  // ---------- local drafts (rows that exist before the server has the draft) ----------
  /**
   * Create or update the row that shows a draft in the Drafts folder. A new row gets a placeholder
   * UID (minus its own id, like a row that is being moved) until the server copy is known.
   */
  upsertLocalDraft(
    id: MessageId | null,
    d: {
      accountId: string;
      folderId: FolderId;
      messageId: string;
      inReplyTo: string | null;
      references: string | null;
      subject: string;
      from: Address | null;
      to: Address[];
      cc: Address[];
      bcc: Address[];
      dateMs: number;
      hasAttachments: boolean;
      snippet: string;
      html: string;
      sync: DraftSyncState | null;
    },
    now: number,
  ): { id: MessageId; created: boolean } {
    const cols = {
      subject: d.subject,
      subjectNorm: normalizeSubject(d.subject),
      fromName: d.from?.name ?? null,
      fromAddr: d.from?.address ?? null,
      to: JSON.stringify(d.to),
      cc: JSON.stringify(d.cc),
      bcc: JSON.stringify(d.bcc),
      dateMs: d.dateMs,
      hasAttachments: d.hasAttachments ? 1 : 0,
      snippet: d.snippet,
      sync: d.sync === 'saved' ? null : d.sync,
      inReplyTo: d.inReplyTo,
      references: d.references,
    };
    let out!: { id: MessageId; created: boolean };
    this.db.transaction(() => {
      let rowId = id !== null && this.row(id) ? id : null;
      let created = false;
      if (rowId === null) {
        const thread = this.threads.resolve({
          accountId: d.accountId,
          messageId: d.messageId,
          inReplyTo: d.inReplyTo,
          references: d.references,
          subject: d.subject,
          fromAddr: d.from?.address ?? null,
          to: d.to,
          cc: d.cc,
          dateMs: d.dateMs,
        });
        this.touchThreads([
          { accountId: d.accountId, threadId: thread.threadId },
          ...thread.merged.map((t) => ({ accountId: d.accountId, threadId: t })),
        ]);
        const res = this.db
          .prepare(
            `INSERT INTO message (account_id,folder_id,uid,message_id,in_reply_to,references_h,thread_key,subject,
               from_name,from_addr,to_json,cc_json,bcc_json,date_ms,internal_ms,snippet,
               flag_seen,flag_draft,has_attachments,draft_sync,thread_id,subject_norm)
             VALUES (@accountId,@folderId,
               -(SELECT COALESCE(MAX(id),0)+1 FROM message),
               @messageId,@inReplyTo,@references,@threadKey,@subject,
               @fromName,@fromAddr,@to,@cc,@bcc,@dateMs,@dateMs,@snippet,1,1,@hasAttachments,@sync,
               @threadId,@subjectNorm)`,
          )
          .run({
            ...cols,
            threadId: thread.threadId,
            subjectNorm: thread.subjectNorm,
            accountId: d.accountId,
            folderId: d.folderId,
            messageId: d.messageId,
            threadKey: threadKey({
              messageId: d.messageId,
              inReplyTo: d.inReplyTo,
              references: d.references,
            }),
          });
        rowId = Number(res.lastInsertRowid);
        this.db.prepare('UPDATE message SET uid = ? WHERE id = ?').run(-rowId, rowId);
        created = true;
      } else {
        this.db
          .prepare(
            `UPDATE message SET subject=@subject, subject_norm=@subjectNorm, from_name=@fromName, from_addr=@fromAddr, to_json=@to,
               cc_json=@cc, bcc_json=@bcc, date_ms=@dateMs, internal_ms=@dateMs, snippet=@snippet,
               has_attachments=@hasAttachments, draft_sync=@sync, flag_draft=1, flag_seen=1,
               in_reply_to=@inReplyTo, references_h=@references
             WHERE id=@id`,
          )
          .run({ ...cols, id: rowId });
      }
      // The text is kept here, so the draft opens at once without asking the server.
      this.saveBody(
        rowId,
        {
          text: null,
          html: d.html,
          snippet: d.snippet,
          attachments: [],
          ftsBodyText: ftsText(null, d.html),
        },
        now,
      );
      this.db
        .prepare('UPDATE message SET has_attachments=? WHERE id=?')
        .run(cols.hasAttachments, rowId);
      out = { id: rowId, created };
    })();
    return out;
  }

  /** Change the upload state of draft rows (null or 'saved' = the server has the latest text). */
  setDraftSync(ids: MessageId[], state: DraftSyncState | null): void {
    const upd = this.db.prepare('UPDATE message SET draft_sync = ? WHERE id = ?');
    this.db.transaction(() => {
      for (const id of ids) upd.run(state === 'saved' ? null : state, id);
    })();
  }

  /** Real (server) rows of a folder with this Message-ID. */
  serverRowsByMessageId(
    folderId: FolderId,
    messageIdHeader: string,
  ): { id: MessageId; uid: number }[] {
    return this.db
      .prepare('SELECT id, uid FROM message WHERE folder_id = ? AND message_id = ? AND uid > 0')
      .all(folderId, messageIdHeader) as { id: number; uid: number }[];
  }

  /** Move a row to another folder/uid, keeping its id (and cached body, search entry). */
  relocate(id: MessageId, folderId: FolderId, uid: number): void {
    // A pin belongs to the folder it was made in; a snooze to the view it hid the message from
    // (DESIGN-SPEC 3.13): both end when the message goes to another folder.
    this.db
      .prepare(
        `UPDATE message SET
           pinned_at = CASE WHEN folder_id = @f THEN pinned_at END,
           snoozed_until = CASE WHEN folder_id = @f THEN snoozed_until END,
           folder_id = @f, uid = @u WHERE id = @id`,
      )
      .run({ f: folderId, u: uid, id });
  }

  idAt(folderId: FolderId, uid: number): MessageId | null {
    const r = this.db
      .prepare('SELECT id FROM message WHERE folder_id = ? AND uid = ?')
      .get(folderId, uid) as { id: number } | undefined;
    return r?.id ?? null;
  }

  /** Rows of a folder with this RFC Message-ID header (used when a move gave no new UID). */
  idsByMessageId(folderId: FolderId, messageIdHeader: string): MessageId[] {
    return (
      this.db
        .prepare('SELECT id FROM message WHERE folder_id = ? AND message_id = ? AND uid > 0')
        .all(folderId, messageIdHeader) as { id: number }[]
    ).map((r) => r.id);
  }

  /** Ids of unread messages behind a scope (or a whole account). */
  unreadIds(scope: ListScope | { kind: 'account'; accountId: string }): MessageId[] {
    if (scope.kind === 'account') {
      return (
        this.db
          .prepare(
            'SELECT id FROM message WHERE account_id = ? AND flag_seen = 0 AND flag_deleted = 0 AND uid > 0',
          )
          .all(scope.accountId) as { id: number }[]
      ).map((r) => r.id);
    }
    const f = scopeFilter(scope, true);
    return (
      this.db.prepare(`SELECT m.id ${f.from} WHERE ${f.where} AND m.uid > 0`).all(f.params) as {
        id: number;
      }[]
    ).map((r) => r.id);
  }

  setFlagColumn(
    ids: MessageId[],
    column: 'flag_seen' | 'flag_flagged' | 'flag_answered' | 'flag_deleted',
    value: boolean,
  ): MessageId[] {
    const changed: MessageId[] = [];
    // Reading a message ends its "came back from snooze" chip (DESIGN-SPEC 3.13.2).
    const extra = column === 'flag_seen' && value ? ', snooze_returned_at = NULL' : '';
    const stmt = this.db.prepare(
      `UPDATE message SET ${column} = ?${extra} WHERE id = ? AND ${column} != ? RETURNING id`,
    );
    this.db.transaction(() => {
      for (const id of ids) {
        const r = stmt.get(value ? 1 : 0, id, value ? 1 : 0) as { id: number } | undefined;
        if (r) changed.push(r.id);
      }
    })();
    return changed;
  }

  // ---------- per-sender image allow list ----------
  senderImagesAllowed(address: string | null): boolean {
    if (!address) return false;
    return (
      this.db.prepare('SELECT 1 FROM image_allow WHERE address = ?').get(address.toLowerCase()) !==
      undefined
    );
  }

  setSenderImagesAllowed(address: string, allow: boolean): void {
    const a = address.trim().toLowerCase();
    if (allow) this.db.prepare('INSERT OR IGNORE INTO image_allow (address) VALUES (?)').run(a);
    else this.db.prepare('DELETE FROM image_allow WHERE address = ?').run(a);
  }

  listAllowedSenders(): string[] {
    return (
      this.db.prepare('SELECT address FROM image_allow ORDER BY address').all() as {
        address: string;
      }[]
    ).map((r) => r.address);
  }

  // ---------- body & attachments ----------
  saveBody(id: MessageId, body: BodyInput, now: number): void {
    const row = this.row(id);
    if (!row) return;
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO body (message_pk, text_plain, html, fetched_at, size_bytes, raw_z, raw_bytes)
           VALUES (?,?,?,?,?,?,?)
           ON CONFLICT(message_pk) DO UPDATE SET text_plain=excluded.text_plain, html=excluded.html,
             fetched_at=excluded.fetched_at, size_bytes=excluded.size_bytes,
             raw_z=excluded.raw_z, raw_bytes=excluded.raw_bytes`,
        )
        .run(
          id,
          body.text,
          body.html,
          now,
          (body.text?.length ?? 0) + (body.html?.length ?? 0),
          body.rawZ ?? null,
          body.rawZ?.length ?? 0,
        );
      this.db.prepare('DELETE FROM attachment WHERE message_pk = ?').run(id);
      const ins = this.db.prepare(
        `INSERT INTO attachment (message_pk, part_id, filename, content_type, size, content_id, inline, cached_path)
         VALUES (?,?,?,?,?,?,?,?)`,
      );
      for (const a of body.attachments) {
        ins.run(
          id,
          a.partId,
          a.filename,
          a.contentType,
          a.size,
          a.contentId,
          a.inline ? 1 : 0,
          a.cachedPath ?? null,
        );
      }
      this.db
        .prepare("UPDATE message SET body_state='cached', snippet=?, has_attachments=? WHERE id=?")
        .run(body.snippet, body.attachments.some((a) => !a.inline) ? 1 : row.has_attachments, id);
      this.ftsReplace(id, {
        subject: row.subject,
        from: [row.from_name, row.from_addr].filter(Boolean).join(' '),
        to: parseAddrs(row.to_json)
          .map((a) => `${a.name ?? ''} ${a.address}`)
          .join(' '),
        snippet: body.snippet,
        body: body.ftsBodyText,
      });
    })();
  }

  /** Total size of downloaded bodies plus attachment files kept on disk (bytes). */
  bodyCacheBytes(): number {
    const b = this.db
      .prepare('SELECT COALESCE(SUM(size_bytes + raw_bytes),0) AS n FROM body')
      .get() as { n: number };
    const a = this.db
      .prepare('SELECT COALESCE(SUM(size),0) AS n FROM attachment WHERE cached_path IS NOT NULL')
      .get() as { n: number };
    return b.n + a.n;
  }

  /** Cached bodies, least recently opened first, with the bytes each one keeps (body + files). */
  cachedBodiesOldestFirst(limit: number): { id: MessageId; accountId: string; bytes: number }[] {
    const rows = this.db
      .prepare(
        `SELECT b.message_pk AS id, m.account_id AS accountId,
                b.size_bytes + b.raw_bytes + COALESCE((SELECT SUM(a.size) FROM attachment a
                                         WHERE a.message_pk = b.message_pk AND a.cached_path IS NOT NULL), 0) AS bytes
         FROM body b JOIN message m ON m.id = b.message_pk
         ORDER BY b.fetched_at ASC, b.message_pk ASC LIMIT ?`,
      )
      .all(limit) as { id: number; accountId: string; bytes: number }[];
    return rows;
  }

  /** Mark a cached body as just opened (the cache removes the least recently opened first). */
  touchBody(id: MessageId, now: number): void {
    this.db.prepare('UPDATE body SET fetched_at = ? WHERE message_pk = ?').run(now, id);
  }

  /**
   * Forget the downloaded body and attachment rows of these messages. The header, the snippet and
   * the header search entry stay; opening the message downloads it again.
   */
  evictBodies(ids: MessageId[]): void {
    this.db.transaction(() => {
      for (const id of ids) {
        const row = this.row(id);
        this.db.prepare('DELETE FROM body WHERE message_pk = ?').run(id);
        this.db.prepare('DELETE FROM attachment WHERE message_pk = ?').run(id);
        if (!row) continue;
        this.db.prepare("UPDATE message SET body_state='none' WHERE id = ?").run(id);
        this.ftsReplace(id, {
          subject: row.subject,
          from: [row.from_name, row.from_addr].filter(Boolean).join(' '),
          to: parseAddrs(row.to_json)
            .map((a) => `${a.name ?? ''} ${a.address}`)
            .join(' '),
          snippet: row.snippet,
          body: '',
        });
      }
    })();
  }

  /**
   * Remove this account's local rows received before `cutoffMs` (INTERNALDATE, the same clock the
   * first sync uses). PC only: nothing is sent to the server. Skips messages that are being moved
   * (placeholder UID) and ones with a waiting change. Returns folder id -> removed ids.
   */
  pruneOlderThan(
    accountId: string,
    cutoffMs: number,
    keep: Set<MessageId>,
  ): Map<FolderId, MessageId[]> {
    const rows = this.db
      .prepare(
        'SELECT id, folder_id AS folderId FROM message WHERE account_id = ? AND internal_ms < ? AND uid > 0',
      )
      .all(accountId, cutoffMs) as { id: number; folderId: number }[];
    const out = new Map<FolderId, MessageId[]>();
    const del = this.db.prepare('DELETE FROM message WHERE id = ?');
    this.db.transaction(() => {
      const gone: number[] = [];
      for (const r of rows) {
        if (keep.has(r.id)) continue;
        this.captureThreads([r.id]);
        del.run(r.id);
        gone.push(r.id);
        const list = out.get(r.folderId) ?? [];
        list.push(r.id);
        out.set(r.folderId, list);
      }
      this.ftsDelete(gone);
    })();
    return out;
  }

  /** Lowest real UID still stored in a folder, or null when it has none. */
  minUid(folderId: FolderId): number | null {
    const r = this.db
      .prepare('SELECT MIN(uid) AS u FROM message WHERE folder_id = ? AND uid > 0')
      .get(folderId) as { u: number | null };
    return r.u;
  }

  getBody(id: MessageId): { text: string | null; html: string | null } | null {
    const r = this.db.prepare('SELECT text_plain, html FROM body WHERE message_pk = ?').get(id) as
      { text_plain: string | null; html: string | null } | undefined;
    return r ? { text: r.text_plain, html: r.html } : null;
  }

  /** The stored compressed raw source of a cached message, or null when there is none. */
  getRawZ(id: MessageId): Buffer | null {
    const r = this.db.prepare('SELECT raw_z FROM body WHERE message_pk = ?').get(id) as
      { raw_z: Buffer | null } | undefined;
    return r?.raw_z ?? null;
  }

  extraHeaders(id: MessageId): {
    bcc: Address[];
    replyTo: Address[];
    inReplyTo: string | null;
    references: string | null;
  } | null {
    const r = this.row(id);
    if (!r) return null;
    return {
      bcc: parseAddrs(r.bcc_json),
      replyTo: parseAddrs(r.reply_to_json),
      inReplyTo: r.in_reply_to,
      references: r.references_h,
    };
  }

  attachments(messageId: MessageId): AttachmentInfo[] {
    const rows = this.db
      .prepare('SELECT * FROM attachment WHERE message_pk = ? ORDER BY id')
      .all(messageId) as {
      id: number;
      filename: string | null;
      content_type: string | null;
      size: number | null;
      content_id: string | null;
      inline: number;
    }[];
    return rows.map((r) => ({
      id: r.id,
      filename: r.filename,
      contentType: r.content_type ?? 'application/octet-stream',
      size: r.size ?? 0,
      contentId: r.content_id,
      inline: r.inline === 1,
    }));
  }

  attachmentRow(id: number): {
    id: number;
    message_pk: number;
    part_id: string;
    filename: string | null;
    content_type: string | null;
    size: number | null;
    content_id: string | null;
    cached_path: string | null;
  } | null {
    return (
      (this.db.prepare('SELECT * FROM attachment WHERE id = ?').get(id) as {
        id: number;
        message_pk: number;
        part_id: string;
        filename: string | null;
        content_type: string | null;
        size: number | null;
        content_id: string | null;
        cached_path: string | null;
      }) ?? null
    );
  }

  attachmentByContentId(messageId: MessageId, contentId: string) {
    const norm = contentId.replace(/^<|>$/g, '');
    return (
      (this.db
        .prepare(
          "SELECT * FROM attachment WHERE message_pk = ? AND (content_id = ? OR content_id = '<' || ? || '>')",
        )
        .get(messageId, norm, norm) as
        { id: number; cached_path: string | null; content_type: string | null } | undefined) ?? null
    );
  }

  setAttachmentPath(id: number, path: string): void {
    this.db.prepare('UPDATE attachment SET cached_path = ? WHERE id = ?').run(path, id);
  }

  // ---------- unsubscribe headers (DESIGN-SPEC 3.13.1) ----------
  /** The headers kept when the body was downloaded (JSON), null if not read yet, undefined if no body. */
  listHeaders(id: MessageId): string | null | undefined {
    const r = this.db.prepare('SELECT list_headers FROM body WHERE message_pk = ?').get(id) as
      | { list_headers: string | null }
      | undefined;
    return r === undefined ? undefined : r.list_headers;
  }

  setListHeaders(id: MessageId, json: string): void {
    this.db.prepare('UPDATE body SET list_headers = ? WHERE message_pk = ?').run(json, id);
  }

  /** Messages from this sender in the account, outside Trash, Junk, Drafts and Sent (for "Move all from this sender to Trash"). */
  idsFromSender(accountId: string, address: string): MessageId[] {
    return (
      this.db
        .prepare(
          `SELECT m.id FROM message m JOIN folder f ON f.id = m.folder_id
            WHERE m.account_id = ? AND m.from_addr = ? COLLATE NOCASE AND m.flag_deleted = 0 AND m.flag_draft = 0
              AND (f.role IS NULL OR f.role NOT IN ('trash','junk','drafts','sent'))`,
        )
        .all(accountId, address.trim()) as { id: number }[]
    ).map((r) => r.id);
  }

  /** Oldest synced UID info for load-older decisions. */
  countInFolder(folderId: FolderId): number {
    return (
      this.db.prepare('SELECT COUNT(*) AS n FROM message WHERE folder_id = ?').get(folderId) as {
        n: number;
      }
    ).n;
  }
}
