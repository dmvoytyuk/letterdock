// search.local (SQLite FTS5 over headers + downloaded bodies, all accounts) and
// search.server (IMAP SEARCH on the server, results merged into the local database).
import type { ImapFlow } from 'imapflow';
import type {
  MessageHeader,
  SearchReq,
  SearchRes,
  ServerSearchReq,
  ServerSearchRes,
} from '../../shared/ipc';
import { AppException, toAppError } from '../../shared/errors';
import { findProviderByHost } from '../../shared/providers';
import type { EngineContext } from '../context';
import type { FolderRow } from '../db/repos/folderRepo';
import { rowToHeader, type MessageRow } from '../db/repos/messageRepo';
import type { SessionManager } from '../imap/sessionManager';
import { fetchedToHeader } from '../imap/parse';
import { fetchHeaders, learnContacts } from '../imap/syncFolder';
import { chunk } from '../imap/syncDiff';
import { buildMatch, parseQuery, type ParsedQuery } from './queryParser';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const SERVER_HITS_PER_FOLDER = 100;
const SERVER_TOTAL = 300;

type Row = MessageRow & { rank: number };

export class SearchService {
  constructor(
    private readonly ctx: EngineContext,
    private readonly sessions: SessionManager,
  ) {}

  // ---------- local ----------

  local(req: SearchReq): SearchRes {
    const q = parseQuery(req.query);
    const limit = Math.min(Math.max(req.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const offset = Math.max(req.offset ?? 0, 0);
    const coverage = this.coverage(req.accountId);
    const empty: SearchRes = {
      items: [],
      parsedFilters: q.chips,
      totalApprox: 0,
      coverage,
    };

    const hasCriteria =
      q.terms.length > 0 ||
      q.unread !== null ||
      q.flagged ||
      q.hasAttachment ||
      q.after !== null ||
      q.before !== null ||
      q.accountTerms.length > 0 ||
      q.folderTerms.length > 0;
    if (!hasCriteria) return empty; // an empty box lists nothing

    // Account / folder filters resolve to ids first.
    const accountIds = this.resolveAccounts(q, req.accountId);
    if (accountIds !== null && accountIds.length === 0) return empty;
    const folderIds = this.resolveFolders(q, accountIds);
    if (folderIds !== null && folderIds.length === 0) return empty;

    const run = (match: string | null) => this.query(q, match, accountIds, folderIds, limit, offset);
    let match = buildMatch(q);
    let res: { rows: Row[]; total: number };
    try {
      res = run(match);
    } catch {
      // The index rejected the expression: look for the whole text as one phrase instead.
      match = buildMatch(q, true);
      try {
        res = run(match);
      } catch (e) {
        throw new AppException('INVALID_INPUT', 'This search could not be understood.', {
          details: String(e),
        });
      }
    }
    return {
      items: res.rows.map((r) => ({ ...rowToHeader(r), rank: r.rank })),
      parsedFilters: q.chips,
      totalApprox: res.total,
      coverage,
    };
  }

  private coverage(accountId?: string): SearchRes['coverage'] {
    const where = accountId ? 'WHERE account_id = ? AND uid > 0' : 'WHERE uid > 0';
    const args = accountId ? [accountId] : [];
    const a = this.ctx.db.prepare(`SELECT COUNT(*) AS n FROM message ${where}`).get(...args) as { n: number };
    const b = this.ctx.db
      .prepare(`SELECT COUNT(*) AS n FROM message ${where} AND body_state = 'cached'`)
      .get(...args) as { n: number };
    return { messagesIndexed: a.n, bodiesIndexed: b.n };
  }

  /** null = no account filter. */
  private resolveAccounts(q: ParsedQuery, only?: string): string[] | null {
    let ids: string[] | null = only ? [only] : null;
    for (const term of q.accountTerms) {
      const hits = this.ctx.accounts
        .list()
        .filter((a) => `${a.email} ${a.displayName}`.toLowerCase().includes(term))
        .map((a) => a.id);
      ids = ids ? ids.filter((id) => hits.includes(id)) : hits;
    }
    return ids;
  }

  /** null = no folder filter. */
  private resolveFolders(q: ParsedQuery, accountIds: string[] | null): number[] | null {
    if (q.folderTerms.length === 0) return null;
    let rows = this.ctx.folders.list();
    if (accountIds) rows = rows.filter((f) => accountIds.includes(f.accountId));
    let ids = rows.map((f) => f.id);
    for (const term of q.folderTerms) {
      const hits = new Set(
        rows
          .filter(
            (f) =>
              f.role === term ||
              f.name.toLowerCase() === term ||
              f.path.toLowerCase() === term ||
              f.name.toLowerCase().includes(term),
          )
          .map((f) => f.id),
      );
      ids = ids.filter((id) => hits.has(id));
    }
    return ids;
  }

  private query(
    q: ParsedQuery,
    match: string | null,
    accountIds: string[] | null,
    folderIds: number[] | null,
    limit: number,
    offset: number,
  ): { rows: Row[]; total: number } {
    const conds = ['m.flag_deleted = 0', 'm.uid > 0'];
    const params: Record<string, unknown> = {};
    if (accountIds) {
      conds.push(`m.account_id IN (${accountIds.map((_, i) => `:acc${i}`).join(',')})`);
      accountIds.forEach((id, i) => (params[`acc${i}`] = id));
    }
    if (folderIds) {
      conds.push(`m.folder_id IN (${folderIds.map((_, i) => `:fld${i}`).join(',')})`);
      folderIds.forEach((id, i) => (params[`fld${i}`] = id));
    } else {
      // Like most mail apps: Trash and Junk are searched only when asked for with folder:.
      conds.push("(f.role IS NULL OR f.role NOT IN ('trash','junk'))");
    }
    if (q.unread !== null) conds.push(q.unread ? 'm.flag_seen = 0' : 'm.flag_seen = 1');
    if (q.flagged) conds.push('m.flag_flagged = 1');
    if (q.hasAttachment) conds.push('m.has_attachments = 1');
    if (q.after !== null) {
      conds.push('m.date_ms >= :after');
      params.after = q.after;
    }
    if (q.before !== null) {
      conds.push('m.date_ms < :before');
      params.before = q.before;
    }
    // The same message can sit in several folders (Gmail: INBOX plus All Mail). Show one copy per
    // account and Message-ID: prefer INBOX, then other folders, then the "All Mail" folder.
    // A copy only hides another one if it is itself a hit (same folder / Trash filters, same words),
    // so the copies are ranked among the hits only.
    const where = conds.join(' AND ');
    const preferF = "CASE f.role WHEN 'inbox' THEN 0 WHEN 'all' THEN 2 ELSE 1 END";

    if (match) {
      // The hits are collected ONCE (a few ms for thousands of rows). Duplicates are then removed with
      // a window function over those hits, not with a per-hit sub-query (that was quadratic: ~56 s for
      // 9 000 hits on a 50 000-message mailbox). Only the requested page is read from `message`.
      const cte = `WITH fts AS MATERIALIZED (
             SELECT rowid AS id, bm25(message_fts, 5.0, 3.0, 1.0, 1.0, 1.0) AS rank
               FROM message_fts WHERE message_fts MATCH :match),
           hits AS MATERIALIZED (
             SELECT m.id AS id, m.date_ms AS date_ms, fts.rank AS rank,
                    CASE WHEN m.message_id IS NULL OR m.message_id = '' THEN 1
                         ELSE ROW_NUMBER() OVER (PARTITION BY m.account_id, m.message_id
                                                 ORDER BY ${preferF}, m.id) END AS rn
               FROM fts JOIN message m ON m.id = fts.id JOIN folder f ON f.id = m.folder_id
              WHERE ${where})`;
      const rows = this.ctx.db
        .prepare(
          `${cte}
           SELECT m.*, x.rank AS rank
             FROM (SELECT id, rank, date_ms FROM hits WHERE rn = 1
                    ORDER BY rank, date_ms DESC, id DESC LIMIT :limit OFFSET :offset) x
             JOIN message m ON m.id = x.id
            ORDER BY x.rank, x.date_ms DESC, x.id DESC`,
        )
        .all({ ...params, match, limit, offset }) as Row[];
      const total = this.ctx.db
        .prepare(`${cte} SELECT COUNT(*) AS n FROM hits WHERE rn = 1`)
        .get({ ...params, match }) as { n: number };
      return { rows, total: total.n };
    }

    // No words: the filters alone pick the rows (newest first). The copy check uses the Message-ID index.
    const dup = ['d.account_id = m.account_id', 'd.message_id = m.message_id', 'd.id <> m.id', 'd.uid > 0', 'd.flag_deleted = 0'];
    if (accountIds) dup.push(`d.account_id IN (${accountIds.map((_, i) => `:acc${i}`).join(',')})`);
    if (folderIds) dup.push(`d.folder_id IN (${folderIds.map((_, i) => `:fld${i}`).join(',')})`);
    else dup.push("(df.role IS NULL OR df.role NOT IN ('trash','junk'))");
    const prefer = (a: string) => `CASE ${a}.role WHEN 'inbox' THEN 0 WHEN 'all' THEN 2 ELSE 1 END`;
    const where2 = `${where} AND (m.message_id IS NULL OR m.message_id = '' OR NOT EXISTS (
         SELECT 1 FROM message d INDEXED BY idx_msg_msgid JOIN folder df ON df.id = d.folder_id
          WHERE ${dup.join(' AND ')}
            AND (${prefer('df')} < ${prefer('f')} OR (${prefer('df')} = ${prefer('f')} AND d.id < m.id))))`;
    const from = 'FROM message m JOIN folder f ON f.id = m.folder_id';
    const rows = this.ctx.db
      .prepare(
        `SELECT m.*, 0 AS rank ${from} WHERE ${where2}
         ORDER BY m.date_ms DESC, m.id DESC LIMIT :limit OFFSET :offset`,
      )
      .all({ ...params, limit, offset }) as Row[];
    const total = this.ctx.db
      .prepare(`SELECT COUNT(*) AS n ${from} WHERE ${where2}`)
      .get(params) as { n: number };
    return { rows, total: total.n };
  }

  // ---------- server ----------

  private foldersToSearch(accountId: string, q: ParsedQuery): FolderRow[] {
    const rows = this.ctx.folders
      .rowsForAccount(accountId)
      .filter((f) => f.selectable === 1 && f.role !== 'trash' && f.role !== 'junk' && f.role !== 'flagged');
    if (q.folderTerms.length > 0) {
      return rows.filter((f) =>
        q.folderTerms.every((t) => f.role === t || f.name.toLowerCase().includes(t)),
      );
    }
    // Gmail: "All Mail" holds everything, so search only there.
    const all = rows.find((f) => f.role === 'all');
    if (all && findProviderByHost(this.ctx.accounts.get(accountId)?.imap.host ?? '')?.id === 'gmail') {
      return [all];
    }
    if (all && this.ctx.accounts.get(accountId)?.provider === 'gmail') return [all];
    return rows.filter((f) => f.role !== 'all');
  }

  /** The IMAP SEARCH criteria for the parsed query. */
  static criteria(q: ParsedQuery): Record<string, unknown> {
    const c: Record<string, unknown> = {};
    const text: string[] = [];
    for (const t of q.terms) {
      if (t.column === 'from_text') c.from = t.text;
      else if (t.column === 'to_text') c.to = t.text;
      else if (t.column === 'subject') c.subject = t.text;
      else text.push(t.text);
    }
    if (text.length > 0) c.text = text.join(' ');
    if (q.unread !== null) c.seen = !q.unread;
    if (q.flagged) c.flagged = true;
    if (q.after !== null) c.since = new Date(q.after);
    if (q.before !== null) c.before = new Date(q.before);
    return Object.keys(c).length > 0 ? c : { all: true };
  }

  async server(req: ServerSearchReq): Promise<ServerSearchRes> {
    const q = parseQuery(req.query);
    if (q.terms.length === 0 && q.unread === null && !q.flagged && q.after === null && q.before === null) {
      return { added: 0, items: [] };
    }
    const criteria = SearchService.criteria(q);
    const accounts = this.ctx.accounts
      .list()
      .filter((a) => a.enabled && (!req.accountIds || req.accountIds.includes(a.id)));
    const found: number[] = [];
    let added = 0;
    const touched = new Set<number>();
    const addedIds: number[] = [];

    await Promise.all(
      accounts.map(async (a) => {
        let session;
        try {
          session = this.sessions.get(a.id);
        } catch {
          return;
        }
        for (const folder of this.foldersToSearch(a.id, q)) {
          try {
            const res = await session.run('user', (c) => this.searchFolder(c, folder, criteria));
            found.push(...res.ids);
            added += res.added.length;
            addedIds.push(...res.added);
            if (res.ids.length) touched.add(folder.id);
          } catch (e) {
            this.ctx.log.debug({ code: toAppError(e).code }, 'server search failed for a folder');
          }
          if (found.length >= SERVER_TOTAL) break;
        }
      }),
    );
    if (addedIds.length > 0) {
      for (const f of touched) this.ctx.folders.recomputeCounts(f);
      this.ctx.hub.changed({ folderIds: [...touched], added: addedIds });
    }
    const headers: MessageHeader[] = this.ctx.messages
      .headers(found)
      .sort((x, y) => y.date - x.date || y.id - x.id)
      .slice(0, SERVER_TOTAL);
    return { added, items: headers };
  }

  private async searchFolder(
    c: ImapFlow,
    folder: FolderRow,
    criteria: Record<string, unknown>,
  ): Promise<{ ids: number[]; added: number[] }> {
    await c.mailboxOpen(folder.path, { readOnly: true });
    const hits = ((await c.search(criteria as never, { uid: true })) || [])
      .slice()
      .sort((x, y) => y - x)
      .slice(0, SERVER_HITS_PER_FOLDER);
    const ids: number[] = [];
    const missing: number[] = [];
    for (const uid of hits) {
      const id = this.ctx.messages.idAt(folder.id, uid);
      if (id !== null) ids.push(id);
      else missing.push(uid);
    }
    const added: number[] = [];
    for (const part of chunk(missing, 100)) {
      const fetched = await fetchHeaders(c, part);
      const res = this.ctx.messages.upsertHeaders(
        fetched.map((m) => fetchedToHeader(folder.account_id, folder.id, m)),
      );
      learnContacts(this.ctx, res.added);
      added.push(...res.added);
      ids.push(...res.added, ...res.updated);
    }
    return { ids, added };
  }
}
