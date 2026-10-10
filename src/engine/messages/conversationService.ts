// Conversations (DESIGN-SPEC 3.10): list rows, open a conversation, act on it.
//
// Which messages count (3.10.1):
//   - Inbox, All inboxes, Unread, Flagged: the conversation's messages in Inbox, Sent and Archive of the
//     same account (plus the messages that make the conversation match the view, e.g. a flagged one in
//     a custom folder). Gmail's "All Mail" counts as Archive. A message that is in two folders (Gmail
//     labels) is counted once: Message-ID decides.
//   - Every other folder: only the messages in that folder.
//   - Actions change only the messages that are in the folder being viewed.
import type {
  ConversationActReq,
  ConversationActRes,
  ConversationMessage,
  ConversationParticipant,
  ConversationSort,
  ConversationRow,
  FolderRole,
  GetConversationReq,
  GetConversationRes,
  ListConversationsReq,
  ListConversationsRes,
  ListScope,
  MessageId,
} from '../../shared/ipc';
import { AppException } from '../../shared/errors';
import type { EngineContext } from '../context';
import { rowToHeader, scopeFilter, type MessageRow } from '../db/repos/messageRepo';
import type { ActionService } from './actionService';
import type { MessageService } from './messageService';
import { displaySubject, normalizeMessageId } from './threading';

const INCLUDED_ROLES = ['inbox', 'sent', 'archive', 'all'];

interface Resolved {
  scope: ListScope;
  /** WHERE (aliases m, f) for the messages that are "in the view". */
  memberWhere: string;
  /** WHERE for the messages that may belong to a row of the view. */
  inclusion: string;
  params: Record<string, unknown>;
  /** Folder-only view (everything except Inbox-like views). */
  folderOnly: boolean;
}

type JoinedRow = MessageRow & { frole: FolderRole | null; fname: string };

export class ConversationService {
  constructor(
    private readonly ctx: EngineContext,
    private readonly messages: MessageService,
    private readonly actions: ActionService,
  ) {}

  // ---------- views ----------

  private resolve(scope: ListScope, unreadOnly: boolean): Resolved {
    let eff = scope;
    if (scope.kind === 'folder') {
      const f = this.ctx.folders.row(scope.folderId);
      if (!f) throw new AppException('NOT_FOUND', 'Folder not found.');
      // The Inbox of one account behaves like every Inbox view.
      if (f.role === 'inbox') eff = { kind: 'accountInbox', accountId: f.account_id };
    }
    const member = scopeFilter(eff, unreadOnly);
    const base = scopeFilter(eff, false);
    if (eff.kind === 'folder') {
      return {
        scope: eff,
        memberWhere: member.where,
        inclusion: 'm.flag_deleted = 0 AND m.folder_id = :folderId',
        params: member.params,
        folderOnly: true,
      };
    }
    const roles = INCLUDED_ROLES.map((r) => `'${r}'`).join(',');
    return {
      scope: eff,
      memberWhere: member.where,
      inclusion: `m.flag_deleted = 0 AND ((f.role IN (${roles}) AND m.flag_draft = 0) OR (${base.where}))`,
      params: member.params,
      folderOnly: false,
    };
  }

  /** The same test as `memberWhere`, for a row we already have. */
  private inView(r: Resolved, unreadOnly: boolean, row: JoinedRow): boolean {
    if (row.flag_deleted === 1) return false;
    if (unreadOnly && row.flag_seen === 1) return false;
    const s = r.scope;
    switch (s.kind) {
      case 'unifiedInbox':
        return row.frole === 'inbox';
      case 'unifiedUnread':
        return row.frole === 'inbox' && row.flag_seen === 0;
      case 'unifiedFlagged':
        return row.flag_flagged === 1 && row.frole !== 'trash' && row.frole !== 'junk';
      case 'folder':
        return row.folder_id === s.folderId;
      case 'accountInbox':
        return row.frole === 'inbox' && row.account_id === s.accountId;
    }
  }

  private ownAddresses(): Set<string> {
    return new Set(this.ctx.accounts.list().map((a) => a.email.toLowerCase()));
  }

  // ---------- list ----------

  list(req: ListConversationsReq): ListConversationsRes {
    const limit = Math.min(Math.max(req.limit || 50, 1), 200);
    const unreadOnly = !!req.unreadOnly;
    const sort: ConversationSort = req.sort ?? 'date';
    const direction = req.direction ?? (sort === 'date' ? 'desc' : 'asc');
    const r = this.resolve(req.scope, unreadOnly);
    const db = this.ctx.db;
    if (sort !== 'date' && req.cursor && typeof req.cursor.key !== 'string') {
      throw new AppException('INVALID_INPUT', 'The page position does not match the sort order.');
    }

    const params: Record<string, unknown> = { ...r.params, limit: limit + 1 };
    const asc = direction === 'asc';
    let groups: { a: string; t: string; ld: number; mx: number; k?: string }[];
    if (sort === 'date') {
      groups =
        (!asc ? this.walkNewest(r, limit, req.cursor) : null) ??
        this.dateGroups(r, params, asc, req.cursor);
    } else {
      // The key comes from the LATEST message of the conversation (rn = 1): the sender as shown
      // (name, else address) or the subject without Re:/Fwd: prefixes. The same SQL text gives the
      // key that goes into the cursor, so the next page compares like with like. Equal keys: newest
      // conversation first, whatever the direction.
      const keyExpr =
        sort === 'sender'
          ? "LOWER(COALESCE(NULLIF(m.from_name, ''), m.from_addr, ''))"
          : "COALESCE(m.subject_norm, LOWER(m.subject), '')";
      let after = '';
      if (req.cursor) {
        after = `WHERE (k ${asc ? '>' : '<'} :cKey OR (k = :cKey AND (ld < :cDate OR (ld = :cDate AND mx < :cId))))`;
        params.cKey = req.cursor.key;
        params.cDate = req.cursor.date;
        params.cId = req.cursor.id;
      }
      groups = db
        .prepare(
          `WITH g AS (
             SELECT m.account_id AS a, m.thread_id AS t,
                    MAX(m.date_ms) OVER (PARTITION BY m.account_id, m.thread_id) AS ld,
                    MAX(m.id) OVER (PARTITION BY m.account_id, m.thread_id) AS mx,
                    ROW_NUMBER() OVER (PARTITION BY m.account_id, m.thread_id
                                       ORDER BY m.date_ms DESC, m.id DESC) AS rn,
                    SUBSTR(${keyExpr}, 1, 200) AS k
               FROM message m JOIN folder f ON f.id = m.folder_id
              WHERE ${r.inclusion}),
              ok AS (SELECT m.account_id AS a, m.thread_id AS t
                       FROM message m JOIN folder f ON f.id = m.folder_id
                      WHERE ${r.memberWhere} GROUP BY m.account_id, m.thread_id)
           SELECT a, t, ld, mx, k FROM g
            ${after ? `${after} AND rn = 1` : 'WHERE rn = 1'}
              AND EXISTS (SELECT 1 FROM ok WHERE ok.a = g.a AND ok.t = g.t)
            ORDER BY k ${asc ? 'ASC' : 'DESC'}, ld DESC, mx DESC
            LIMIT :limit`,
        )
        .all(params) as typeof groups;
    }

    const more = groups.length > limit;
    const page = more ? groups.slice(0, limit) : groups;
    const own = this.ownAddresses();
    const items = page.map((g) => this.buildRow(r, unreadOnly, g.a, g.t, own));
    const last = page[page.length - 1];

    const total = req.cursor ? null : this.totalThreads(r);
    const nextCursor =
      more && last
        ? { date: last.ld, id: last.mx, ...(sort !== 'date' ? { key: last.k ?? '' } : {}) }
        : null;
    return {
      items: items.filter((x): x is ConversationRow => x !== null),
      nextCursor,
      canLoadOlderFromServer: nextCursor === null && this.messages.canLoadOlder(req.scope),
      total,
    };
  }

  /** Counting every conversation of a big view takes tens of ms: remember it until anything is written. */
  private totalCache = new Map<string, { changes: number; n: number }>();

  private totalThreads(r: Resolved): number {
    const db = this.ctx.db;
    const changes = (db.prepare('SELECT total_changes() AS c').get() as { c: number }).c;
    const key = `${r.memberWhere}|${JSON.stringify(r.params)}`;
    const hit = this.totalCache.get(key);
    if (hit && hit.changes === changes) return hit.n;
    const t = db
      .prepare(
        `SELECT COUNT(*) AS n FROM (
           SELECT 1 FROM message m JOIN folder f ON f.id = m.folder_id
            WHERE ${r.memberWhere} GROUP BY m.account_id, m.thread_id)`,
      )
      .get(r.params) as { n: number };
    if (this.totalCache.size > 50) this.totalCache.clear();
    this.totalCache.set(key, { changes, n: t.n });
    return t.n;
  }

  /** One pass over the view's messages, grouped by conversation (any order, any cursor). */
  private dateGroups(
    r: Resolved,
    params: Record<string, unknown>,
    asc: boolean,
    cursor: ListConversationsReq['cursor'],
  ): { a: string; t: string; ld: number; mx: number }[] {
    let having = `HAVING MAX(CASE WHEN ${r.memberWhere} THEN 1 ELSE 0 END) = 1`;
    if (cursor) {
      having += asc
        ? ' AND (ld > :cDate OR (ld = :cDate AND mx > :cId))'
        : ' AND (ld < :cDate OR (ld = :cDate AND mx < :cId))';
      params.cDate = cursor.date;
      params.cId = cursor.id;
    }
    return this.ctx.db
      .prepare(
        `SELECT m.account_id AS a, m.thread_id AS t, MAX(m.date_ms) AS ld, MAX(m.id) AS mx
           FROM message m JOIN folder f ON f.id = m.folder_id
          WHERE ${r.inclusion}
          GROUP BY m.account_id, m.thread_id
          ${having}
          ORDER BY ld ${asc ? 'ASC' : 'DESC'}, mx ${asc ? 'ASC' : 'DESC'}
          LIMIT :limit`,
      )
      .all(params) as { a: string; t: string; ld: number; mx: number }[];
  }

  /**
   * Newest conversations first without looking at the whole mailbox. The view's messages are read from
   * the newest down; the first message of a conversation that we meet carries its latest date. The walk
   * stops as soon as `limit + 1` conversations are known and no unseen one can be newer than the last of
   * them. Returns null when the view is too sparse for this (the caller then groups everything).
   */
  private walkNewest(
    r: Resolved,
    limit: number,
    cursor: ListConversationsReq['cursor'],
  ): { a: string; t: string; ld: number; mx: number }[] | null {
    const MAX_THREADS_LOOKED_AT = 1500;
    const db = this.ctx.db;
    const walk = db.prepare(
      `SELECT m.account_id AS a, m.thread_id AS t, m.date_ms AS d
         FROM message m JOIN folder f ON f.id = m.folder_id
        WHERE ${r.inclusion}${cursor ? ' AND m.date_ms <= :cDate' : ''}
        ORDER BY m.date_ms DESC, m.id DESC`,
    );
    const agg = db.prepare(
      `SELECT MAX(m.date_ms) AS ld, MAX(m.id) AS mx,
              MAX(CASE WHEN ${r.memberWhere} THEN 1 ELSE 0 END) AS mem
         FROM message m JOIN folder f ON f.id = m.folder_id
        WHERE m.account_id = :tAcc AND m.thread_id = :tThr AND ${r.inclusion}`,
    );
    const seen = new Set<string>();
    const found: { a: string; t: string; ld: number; mx: number }[] = [];
    const newestFirst = (x: { ld: number; mx: number }, y: { ld: number; mx: number }) =>
      y.ld - x.ld || y.mx - x.mx;
    let sorted = true;
    const params: Record<string, unknown> = { ...r.params };
    if (cursor) params.cDate = cursor.date;
    for (const row of walk.iterate(params) as Iterable<{ a: string; t: string; d: number }>) {
      if (found.length > limit) {
        if (!sorted) {
          found.sort(newestFirst);
          sorted = true;
        }
        if (row.d < found[limit]!.ld) break;
      }
      const key = `${row.a} ${row.t}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (seen.size > MAX_THREADS_LOOKED_AT && found.length <= limit) return null;
      const g = agg.get({ ...r.params, tAcc: row.a, tThr: row.t }) as {
        ld: number;
        mx: number;
        mem: number;
      };
      if (!g.mem) continue;
      if (cursor && !(g.ld < cursor.date || (g.ld === cursor.date && g.mx < cursor.id))) continue;
      found.push({ a: row.a, t: row.t, ld: g.ld, mx: g.mx });
      sorted = false;
    }
    found.sort(newestFirst);
    return found.slice(0, limit + 1);
  }

  private threadRows(r: Resolved, accountId: string, threadId: string): JoinedRow[] {
    return this.ctx.db
      .prepare(
        `SELECT m.*, f.role AS frole, f.name AS fname
           FROM message m JOIN folder f ON f.id = m.folder_id
          WHERE m.account_id = :accountId AND m.thread_id = :threadId AND ${r.inclusion}
          ORDER BY m.date_ms ASC, m.id ASC`,
      )
      .all({ ...r.params, accountId, threadId }) as JoinedRow[];
  }

  /** One row per Message-ID; the copy in the viewed folder wins, else the first one. */
  private dedupe(rows: JoinedRow[], inView: (row: JoinedRow) => boolean): JoinedRow[] {
    const byMid = new Map<string, JoinedRow>();
    const out: JoinedRow[] = [];
    for (const row of rows) {
      const mid = normalizeMessageId(row.message_id);
      if (!mid) {
        out.push(row);
        continue;
      }
      const cur = byMid.get(mid);
      if (!cur) {
        byMid.set(mid, row);
        out.push(row);
      } else if (!inView(cur) && inView(row)) {
        out[out.indexOf(cur)] = row;
        byMid.set(mid, row);
      }
    }
    return out;
  }

  private buildRow(
    r: Resolved,
    unreadOnly: boolean,
    accountId: string,
    threadId: string,
    own: Set<string>,
  ): ConversationRow | null {
    const all = this.threadRows(r, accountId, threadId);
    if (all.length === 0) return null;
    const view = (row: JoinedRow) => this.inView(r, unreadOnly, row);
    const msgs = this.dedupe(all, (row) => this.inView(r, false, row));
    const folderMessageIds = all.filter(view).map((row) => row.id);
    const latest = msgs[msgs.length - 1]!;

    const people = new Map<string, ConversationParticipant>();
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]!;
      const address = (m.from_addr ?? '').toLowerCase();
      if (!address) continue;
      let p = people.get(address);
      if (!p) {
        p = { name: m.from_name, address, isMe: own.has(address), hasUnread: false };
        people.set(address, p);
      }
      if (!p.name && m.from_name) p.name = m.from_name;
      if (m.flag_seen === 0) p.hasUnread = true;
    }
    // Several of the user's own addresses are one person ("me").
    const participants: ConversationParticipant[] = [];
    let me: ConversationParticipant | null = null;
    for (const p of people.values()) {
      if (!p.isMe) {
        participants.push(p);
      } else if (!me) {
        me = { ...p };
        participants.push(me);
      } else {
        me.hasUnread = me.hasUnread || p.hasUnread;
      }
    }

    return {
      threadId,
      accountId,
      count: msgs.length,
      unreadCount: msgs.filter((m) => m.flag_seen === 0).length,
      hasFlag: msgs.some((m) => m.flag_flagged === 1),
      hasAttachment: msgs.some((m) => m.has_attachments === 1),
      participants,
      latest: {
        id: latest.id,
        subject: latest.subject,
        title: displaySubject(latest.subject),
        snippet: latest.snippet,
        date: latest.date_ms,
        fromMe: own.has((latest.from_addr ?? '').toLowerCase()),
        from: latest.from_addr
          ? { name: latest.from_name ?? undefined, address: latest.from_addr }
          : null,
      },
      folderMessageIds,
      messageIds: msgs.map((m) => m.id),
    };
  }

  // ---------- open ----------

  get(req: GetConversationReq): GetConversationRes {
    const scope: ListScope = req.scope ?? { kind: 'accountInbox', accountId: req.accountId };
    const r = this.resolve(scope, false);
    // Drafts of the conversation are shown too (as collapsed cards).
    const rows = this.ctx.db
      .prepare(
        `SELECT m.*, f.role AS frole, f.name AS fname
           FROM message m JOIN folder f ON f.id = m.folder_id
          WHERE m.account_id = :accountId AND m.thread_id = :threadId AND m.flag_deleted = 0
            AND ((${r.inclusion.replace(/^m\.flag_deleted = 0 AND /, '')}) OR f.role = 'drafts')
          ORDER BY m.date_ms ASC, m.id ASC`,
      )
      .all({ ...r.params, accountId: req.accountId, threadId: req.threadId }) as JoinedRow[];
    if (rows.length === 0) {
      throw new AppException('NOT_FOUND', 'This conversation was moved or deleted.');
    }
    const inScope = (row: JoinedRow) => this.inView(r, false, row);
    const msgs = this.dedupe(rows, inScope);
    const own = this.ownAddresses();
    const messages: ConversationMessage[] = msgs.map((row) => ({
      header: rowToHeader(row),
      folderId: row.folder_id,
      folderRole: row.frole,
      folderName: row.fname,
      inCurrentFolder: req.scope ? inScope(row) : false,
      isDraft: row.flag_draft === 1 || row.frole === 'drafts',
      fromMe: own.has((row.from_addr ?? '').toLowerCase()),
    }));
    const counted = messages.filter((m) => !m.isDraft);
    const latest = (counted.length > 0 ? counted : messages)[(counted.length > 0 ? counted : messages).length - 1]!;
    return {
      threadId: req.threadId,
      accountId: req.accountId,
      title: displaySubject(latest.header.subject),
      count: counted.length,
      messages,
    };
  }

  // ---------- act ----------

  async act(req: ConversationActReq): Promise<ConversationActRes> {
    const r = this.resolve(req.scope, false);
    const ids = new Set<MessageId>();
    let threadCount = 0;
    for (const threadId of new Set(req.threadIds)) {
      const rows = this.ctx.db
        .prepare(
          `SELECT m.*, f.role AS frole, f.name AS fname
             FROM message m JOIN folder f ON f.id = m.folder_id
            WHERE m.thread_id = :threadId AND ${r.memberWhere}
            ORDER BY m.date_ms ASC, m.id ASC`,
        )
        .all({ ...r.params, threadId }) as JoinedRow[];
      if (rows.length === 0) continue;
      threadCount++;
      const a = req.action;
      let pick: JoinedRow[];
      if (a.type === 'markRead') {
        pick = a.read ? rows.filter((x) => x.flag_seen === 0) : [rows[rows.length - 1]!];
      } else if (a.type === 'flag') {
        pick = a.flagged ? [rows[rows.length - 1]!] : rows.filter((x) => x.flag_flagged === 1);
      } else {
        pick = rows;
      }
      for (const row of pick) ids.add(row.id);
    }
    if (ids.size === 0) {
      return { succeeded: [], failed: [], threadCount, messageCount: 0 };
    }
    if (req.action.type === 'deletePermanent' && req.confirm !== true) {
      // Nothing is changed yet. The UI asks "Delete N messages permanently?" and calls again.
      return {
        succeeded: [],
        failed: [],
        requiresConfirm: true,
        permanent: true,
        threadCount,
        messageCount: ids.size,
      };
    }
    const res = await this.actions.apply({
      messageIds: [...ids],
      action: req.action,
      confirm: req.confirm,
    });
    return { ...res, threadCount, messageCount: res.succeeded.length };
  }
}
