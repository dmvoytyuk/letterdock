import type {
  Address,
  AttachmentInfo,
  DraftSyncState,
  FolderId,
  ListMessagesReq,
  ListScope,
  MessageHeader,
  MessageId,
} from '../../../shared/ipc';
import type { ContactSource } from '../../contacts/contactService';
import { ftsText } from '../../messages/bodyUtils';
import type { Db } from '../connection';

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
}

export interface ScopeFilter {
  from: string;
  where: string;
  params: Record<string, unknown>;
}

/** Translate a ListScope to SQL fragments (all queries alias message as m, folder as f). */
export function scopeFilter(scope: ListScope, unreadOnly: boolean): ScopeFilter {
  const base = 'FROM message m JOIN folder f ON f.id = m.folder_id';
  const conds = ['m.flag_deleted = 0'];
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
  constructor(private readonly db: Db) {}

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
         flag_seen,flag_flagged,flag_answered,flag_draft,flag_deleted,keywords_json,modseq,has_attachments)
       VALUES (@accountId,@folderId,@uid,@messageId,@inReplyTo,@references,@threadKey,@subject,
         @fromName,@fromAddr,@to,@cc,@bcc,@replyTo,@dateMs,@internalMs,@size,
         @seen,@flagged,@answered,@draft,@deleted,@keywords,@modseq,@hasAttachments)`,
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
        const res = insert.run({
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
        del.run(r.id);
      }
      this.ftsDelete(ids);
    })();
    return ids;
  }

  deleteById(id: MessageId): void {
    this.db.transaction(() => {
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
      this.db.prepare('DELETE FROM message WHERE folder_id = ?').run(folderId);
      this.ftsDelete(ids);
    })();
    return ids;
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
    nextCursor: { date: number; id: number } | null;
    total: number | null;
  } {
    const limit = Math.min(Math.max(req.limit || 50, 1), 200);
    const f = scopeFilter(req.scope, !!req.unreadOnly);
    const params: Record<string, unknown> = { ...f.params, limit: limit + 1 };
    let where = f.where;
    if (req.cursor) {
      where += ' AND (m.date_ms < :cDate OR (m.date_ms = :cDate AND m.id < :cId))';
      params.cDate = req.cursor.date;
      params.cId = req.cursor.id;
    }
    const rows = this.db
      .prepare(
        `SELECT m.* ${f.from} WHERE ${where} ORDER BY m.date_ms DESC, m.id DESC LIMIT :limit`,
      )
      .all(params) as MessageRow[];
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    let total: number | null = null;
    if (!req.cursor) {
      const t = this.db
        .prepare(`SELECT COUNT(*) AS n ${f.from} WHERE ${f.where}`)
        .get(f.params) as { n: number };
      total = t.n;
    }
    return {
      items: page.map(rowToHeader),
      nextCursor: hasMore && last ? { date: last.date_ms, id: last.id } : null,
      total,
    };
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
        const res = this.db
          .prepare(
            `INSERT INTO message (account_id,folder_id,uid,message_id,in_reply_to,references_h,thread_key,subject,
               from_name,from_addr,to_json,cc_json,bcc_json,date_ms,internal_ms,snippet,
               flag_seen,flag_draft,has_attachments,draft_sync)
             VALUES (@accountId,@folderId,
               -(SELECT COALESCE(MAX(id),0)+1 FROM message),
               @messageId,@inReplyTo,@references,@threadKey,@subject,
               @fromName,@fromAddr,@to,@cc,@bcc,@dateMs,@dateMs,@snippet,1,1,@hasAttachments,@sync)`,
          )
          .run({
            ...cols,
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
            `UPDATE message SET subject=@subject, from_name=@fromName, from_addr=@fromAddr, to_json=@to,
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
  serverRowsByMessageId(folderId: FolderId, messageIdHeader: string): { id: MessageId; uid: number }[] {
    return this.db
      .prepare('SELECT id, uid FROM message WHERE folder_id = ? AND message_id = ? AND uid > 0')
      .all(folderId, messageIdHeader) as { id: number; uid: number }[];
  }

  /** Move a row to another folder/uid, keeping its id (and cached body, search entry). */
  relocate(id: MessageId, folderId: FolderId, uid: number): void {
    this.db.prepare('UPDATE message SET folder_id = ?, uid = ? WHERE id = ?').run(folderId, uid, id);
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
      this.db
        .prepare(`SELECT m.id ${f.from} WHERE ${f.where} AND m.uid > 0`)
        .all(f.params) as { id: number }[]
    ).map((r) => r.id);
  }

  setFlagColumn(
    ids: MessageId[],
    column: 'flag_seen' | 'flag_flagged' | 'flag_answered' | 'flag_deleted',
    value: boolean,
  ): MessageId[] {
    const changed: MessageId[] = [];
    const stmt = this.db.prepare(
      `UPDATE message SET ${column} = ? WHERE id = ? AND ${column} != ? RETURNING id`,
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
          `INSERT INTO body (message_pk, text_plain, html, fetched_at, size_bytes) VALUES (?,?,?,?,?)
           ON CONFLICT(message_pk) DO UPDATE SET text_plain=excluded.text_plain, html=excluded.html,
             fetched_at=excluded.fetched_at, size_bytes=excluded.size_bytes`,
        )
        .run(id, body.text, body.html, now, (body.text?.length ?? 0) + (body.html?.length ?? 0));
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
    const b = this.db.prepare('SELECT COALESCE(SUM(size_bytes),0) AS n FROM body').get() as { n: number };
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
                b.size_bytes + COALESCE((SELECT SUM(a.size) FROM attachment a
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
  pruneOlderThan(accountId: string, cutoffMs: number, keep: Set<MessageId>): Map<FolderId, MessageId[]> {
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

  /** Oldest synced UID info for load-older decisions. */
  countInFolder(folderId: FolderId): number {
    return (
      this.db.prepare('SELECT COUNT(*) AS n FROM message WHERE folder_id = ?').get(folderId) as {
        n: number;
      }
    ).n;
  }
}
