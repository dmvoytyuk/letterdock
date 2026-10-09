// Conversation assignment (DESIGN-SPEC 3.10.1). Every message gets a `thread_id` when it is stored:
//   1. Gmail: the server's X-GM-THRID.
//   2. Else the union of Message-ID / In-Reply-To / References links (table thread_mid). A message
//      that links two conversations merges them, so a parent that arrives late joins its children.
//   3. Else (no links at all): same account + same subject without "Re:" + one shared person + 30 days.
// A conversation never crosses accounts.
import { randomBytes } from 'node:crypto';
import type { Address } from '../../../shared/ipc';
import {
  GMAIL_THREAD_PREFIX,
  SUBJECT_WINDOW_MS,
  extractMessageIds,
  gmailThreadId,
  normalizeMessageId,
  normalizeSubject,
  participantSet,
  sharesParticipant,
} from '../../messages/threading';
import type { Db } from '../connection';

export interface ThreadInput {
  accountId: string;
  messageId: string | null;
  inReplyTo: string | null;
  references: string | null;
  subject: string;
  fromAddr: string | null;
  to: Address[];
  cc: Address[];
  dateMs: number;
  /** The server's own conversation id (Gmail X-GM-THRID), when it has one. */
  gmThrid?: string | null;
  /** The row that is being assigned (never its own candidate). */
  selfPk?: number;
}

export interface ThreadResult {
  threadId: string;
  subjectNorm: string;
  /** Conversation ids that were merged into `threadId`. */
  merged: string[];
}

export interface ThreadKey {
  accountId: string;
  threadId: string;
}

function parse(json: string): Address[] {
  try {
    return JSON.parse(json) as Address[];
  } catch {
    return [];
  }
}

const isGmail = (t: string) => t.startsWith(GMAIL_THREAD_PREFIX);

export class ThreadRepo {
  constructor(private readonly db: Db) {}

  private ownAddresses(): Set<string> {
    const rows = this.db.prepare('SELECT email FROM account').all() as { email: string }[];
    return new Set(rows.map((r) => r.email.toLowerCase()));
  }

  private newId(): string {
    return `t:${randomBytes(9).toString('base64url')}`;
  }

  /** Find (or make) the conversation of a message. Writes thread_mid and merges; the caller stores the id on the row. */
  resolve(i: ThreadInput): ThreadResult {
    const own = normalizeMessageId(i.messageId);
    const subjectNorm = normalizeSubject(i.subject);
    const upsertMid = this.db.prepare(
      `INSERT INTO thread_mid (account_id, mid, thread_id) VALUES (?,?,?)
       ON CONFLICT(account_id, mid) DO UPDATE SET thread_id = excluded.thread_id`,
    );

    if (i.gmThrid) {
      const threadId = gmailThreadId(i.accountId, i.gmThrid);
      if (own) upsertMid.run(i.accountId, own, threadId);
      return { threadId, subjectNorm, merged: [] };
    }

    // Direct parent first, then the other ancestors from the nearest to the oldest.
    const parent = normalizeMessageId(i.inReplyTo);
    const refs = extractMessageIds(i.references).reverse();
    const links = [...new Set([...(parent ? [parent] : []), ...refs])];
    const lookup = [...new Set([...links, ...(own ? [own] : [])])];

    const candidates: string[] = [];
    if (lookup.length > 0) {
      const marks = lookup.map(() => '?').join(',');
      const rows = this.db
        .prepare(`SELECT mid, thread_id FROM thread_mid WHERE account_id = ? AND mid IN (${marks})`)
        .all(i.accountId, ...lookup) as { mid: string; thread_id: string }[];
      const byMid = new Map(rows.map((r) => [r.mid, r.thread_id]));
      // Ancestors in order of closeness, then children that arrived before this message.
      for (const m of lookup) {
        const t = byMid.get(m);
        if (t && !candidates.includes(t)) candidates.push(t);
      }
    }

    let threadId: string;
    const merged: string[] = [];
    if (candidates.length === 0) {
      const joined = links.length === 0 ? this.bySubject(i, subjectNorm) : null;
      threadId = joined ?? this.newId();
    } else {
      // A Gmail conversation wins; two different Gmail conversations are never merged.
      threadId = candidates.find(isGmail) ?? [...candidates].sort()[0]!;
      const losers = candidates.filter((c) => c !== threadId && !isGmail(c));
      if (losers.length > 0) {
        const marks = losers.map(() => '?').join(',');
        this.db
          .prepare(`UPDATE message SET thread_id = ? WHERE account_id = ? AND thread_id IN (${marks})`)
          .run(threadId, i.accountId, ...losers);
        this.db
          .prepare(`UPDATE thread_mid SET thread_id = ? WHERE account_id = ? AND thread_id IN (${marks})`)
          .run(threadId, i.accountId, ...losers);
        merged.push(...losers);
      }
    }
    for (const m of lookup) upsertMid.run(i.accountId, m, threadId);
    return { threadId, subjectNorm, merged };
  }

  /** No header links: a recent message with the same subject and one shared person. */
  private bySubject(i: ThreadInput, subjectNorm: string): string | null {
    if (!subjectNorm) return null;
    const own = this.ownAddresses();
    const mine = participantSet(i.fromAddr, i.to, i.cc, own);
    if (mine.size === 0) return null;
    const rows = this.db
      .prepare(
        `SELECT thread_id, from_addr, to_json, cc_json FROM message
          WHERE account_id = ? AND subject_norm = ? AND date_ms BETWEEN ? AND ? AND id != ?
          ORDER BY date_ms DESC LIMIT 100`,
      )
      .all(
        i.accountId,
        subjectNorm,
        i.dateMs - SUBJECT_WINDOW_MS,
        i.dateMs + SUBJECT_WINDOW_MS,
        i.selfPk ?? -1,
      ) as { thread_id: string; from_addr: string | null; to_json: string; cc_json: string }[];
    for (const r of rows) {
      const theirs = participantSet(r.from_addr, parse(r.to_json), parse(r.cc_json), own);
      if (sharesParticipant(mine, theirs)) return r.thread_id;
    }
    return null;
  }

  // ---------- background passes ----------

  /**
   * Join rows stored before conversations existed (thread_id still "m:<id>"), in id order.
   * Returns the last id looked at, how many rows it handled and the conversations that changed.
   */
  backfillChunk(
    afterId: number,
    limit: number,
  ): { lastId: number; handled: number; touched: ThreadKey[]; done: boolean } {
    const rows = this.db
      .prepare(
        `SELECT id, account_id, message_id, in_reply_to, references_h, subject, from_addr, to_json, cc_json,
                date_ms, thread_id
           FROM message WHERE id > ? ORDER BY id LIMIT ?`,
      )
      .all(afterId, limit) as {
      id: number;
      account_id: string;
      message_id: string | null;
      in_reply_to: string | null;
      references_h: string | null;
      subject: string;
      from_addr: string | null;
      to_json: string;
      cc_json: string;
      date_ms: number;
      thread_id: string | null;
    }[];
    const touched: ThreadKey[] = [];
    let handled = 0;
    this.db.transaction(() => {
      for (const r of rows) {
        const todo = r.thread_id === null || r.thread_id.startsWith('m:');
        if (!todo) continue;
        const res = this.resolve({
          accountId: r.account_id,
          messageId: r.message_id,
          inReplyTo: r.in_reply_to,
          references: r.references_h,
          subject: r.subject,
          fromAddr: r.from_addr,
          to: parse(r.to_json),
          cc: parse(r.cc_json),
          dateMs: r.date_ms,
          selfPk: r.id,
        });
        this.db
          .prepare('UPDATE message SET thread_id = ?, subject_norm = ? WHERE id = ?')
          .run(res.threadId, res.subjectNorm, r.id);
        handled++;
        touched.push({ accountId: r.account_id, threadId: res.threadId });
        if (r.thread_id) touched.push({ accountId: r.account_id, threadId: r.thread_id });
        for (const m of res.merged) touched.push({ accountId: r.account_id, threadId: m });
      }
    })();
    return {
      lastId: rows.length > 0 ? rows[rows.length - 1]!.id : afterId,
      handled,
      touched,
      done: rows.length < limit,
    };
  }

  /** Rows of a folder that still wait for their Gmail conversation id (real UIDs only). */
  gmailTodo(folderId: number, limit: number, belowUid = Number.MAX_SAFE_INTEGER): { id: number; uid: number }[] {
    return this.db
      .prepare(
        `SELECT id, uid FROM message WHERE folder_id = ? AND uid > 0 AND uid < ? AND thread_id NOT LIKE 'g:%'
          ORDER BY uid DESC LIMIT ?`,
      )
      .all(folderId, belowUid, limit) as { id: number; uid: number }[];
  }

  /** The server told us the Gmail conversation of these rows. */
  setGmailThreads(accountId: string, items: { id: number; gmThrid: string }[]): ThreadKey[] {
    const touched: ThreadKey[] = [];
    const sel = this.db.prepare('SELECT thread_id, message_id FROM message WHERE id = ?');
    const upd = this.db.prepare('UPDATE message SET thread_id = ? WHERE id = ?');
    const mid = this.db.prepare(
      `INSERT INTO thread_mid (account_id, mid, thread_id) VALUES (?,?,?)
       ON CONFLICT(account_id, mid) DO UPDATE SET thread_id = excluded.thread_id`,
    );
    this.db.transaction(() => {
      for (const it of items) {
        const cur = sel.get(it.id) as { thread_id: string | null; message_id: string | null } | undefined;
        if (!cur) continue;
        const next = gmailThreadId(accountId, it.gmThrid);
        if (cur.thread_id === next) continue;
        upd.run(next, it.id);
        const own = normalizeMessageId(cur.message_id);
        if (own) mid.run(accountId, own, next);
        touched.push({ accountId, threadId: next });
        if (cur.thread_id) touched.push({ accountId, threadId: cur.thread_id });
      }
    })();
    return touched;
  }
}
