// Contacts for recipient autocomplete (ARCHITECTURE 6.4).
//
// Durable data: table `contact` (per account). Search data: an in-memory index built from that table at
// start, so a keystroke is answered in a few milliseconds even with 50 000 contacts (one pass over the
// entries, only a small top-N list is kept). Learning:
//   - header sync    : observe(rows) for every newly added message
//   - sending        : recordSent(...) after a successful SMTP send
//   - first start    : backfill() walks the already-synced headers once, in small chunks
import type { Address, ContactInfo, ContactSuggestion } from '../../shared/ipc';
import type { EngineContext } from '../context';
import { AppException } from '../../shared/errors';
import { cleanAddress, cleanName, fold, isNoReply, tokenize } from './text';

const DAY_MS = 86_400_000;
const BACKFILL_CHUNK = 1500;
const BACKFILL_KEY = 'contacts.backfill';
/** Bump to run the backfill again (it resets the counters first). */
const BACKFILL_VERSION = '1';
const SENT_MID_KEEP_MS = 14 * DAY_MS;

/** One message as the contacts index sees it. */
export interface ContactSource {
  accountId: string;
  /** Role of the folder the message is in. */
  role: string | null;
  fromName: string | null;
  fromAddr: string | null;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  replyTo: Address[];
  dateMs: number;
  messageId: string | null;
}

interface Stat {
  accountId: string;
  sent: number;
  recv: number;
  lastSent: number;
  lastSeen: number;
}

interface Entry {
  address: string;
  name: string | null;
  nameMs: number;
  tokens: string[];
  /** First word of the name and of the address local part (a start-of-word match ranks higher). */
  heads: string[];
  stats: Stat[];
  // Totals over all accounts.
  sent: number;
  recv: number;
  lastSent: number;
  lastSeen: number;
  lnSent: number;
  lnRecv: number;
}

interface Delta {
  accountId: string;
  address: string;
  name: string | null;
  nameMs: number;
  sent: number;
  recv: number;
  lastSent: number;
  lastSeen: number;
}

const SKIP_ROLES = new Set(['trash', 'junk', 'drafts']);

function recencyScore(ageMs: number, weight: number, halfLifeDays: number): number {
  return weight / (1 + Math.max(0, ageMs) / (halfLifeDays * DAY_MS));
}

export class ContactService {
  private mem = new Map<string, Entry>();
  private forgottenSet = new Set<string>();
  /** The index is read from the database on first use (not at engine start: about 60 ms for 5 000 people). */
  private loaded = false;
  private warmTimer: ReturnType<typeof setTimeout> | null = null;
  private backfilling = false;
  private stopped = false;
  private ownCache: { key: string; set: Set<string> } | null = null;

  constructor(private readonly ctx: EngineContext) {}

  private get entries(): Map<string, Entry> {
    this.ensureLoaded();
    return this.mem;
  }

  private get forgotten(): Set<string> {
    this.ensureLoaded();
    return this.forgottenSet;
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    this.load();
  }

  /** Read the index a moment after start, so the first suggestion or sync does not pay for it. */
  warmSoon(delayMs = 1500): void {
    if (this.loaded || this.warmTimer) return;
    this.warmTimer = setTimeout(() => {
      this.warmTimer = null;
      if (this.stopped) return;
      try {
        this.ensureLoaded();
      } catch (e) {
        this.ctx.log.warn({ err: String((e as Error)?.message ?? e) }, 'contacts index load failed');
      }
    }, delayMs);
    this.warmTimer.unref?.();
  }

  // ---------- loading ----------

  private load(): void {
    const db = this.ctx.db;
    for (const r of db.prepare('SELECT address FROM contact_forgotten').all() as { address: string }[]) {
      this.forgottenSet.add(r.address);
    }
    const rows = db
      .prepare(
        `SELECT account_id, address, name, name_ms, sent_count, recv_count, last_sent_ms, last_seen_ms
           FROM contact`,
      )
      .all() as {
      account_id: string;
      address: string;
      name: string | null;
      name_ms: number;
      sent_count: number;
      recv_count: number;
      last_sent_ms: number;
      last_seen_ms: number;
    }[];
    for (const r of rows) {
      this.applyToMemory({
        accountId: r.account_id,
        address: r.address,
        name: r.name,
        nameMs: r.name_ms,
        sent: r.sent_count,
        recv: r.recv_count,
        lastSent: r.last_sent_ms,
        lastSeen: r.last_seen_ms,
      });
    }
  }

  get size(): number {
    return this.entries.size;
  }

  // ---------- own addresses ----------

  /**
   * Addresses that belong to the user: the configured accounts' own email addresses, nothing else.
   * The login name is NOT used: it may be another person's or a different identity, and the app cannot
   * know. Letterdock has no alias list yet. It is recomputed from the accounts table whenever it changes,
   * so nothing about "own" is ever stored in the contact rows.
   */
  private ownAddresses(): Set<string> {
    const accounts = this.ctx.accounts.list();
    const key = accounts.map((a) => `${a.id}:${a.email}`).join('|');
    if (this.ownCache?.key === key) return this.ownCache.set;
    const set = new Set<string>();
    for (const a of accounts) {
      const e = cleanAddress(a.email);
      if (e) set.add(e);
    }
    this.ownCache = { key, set };
    return set;
  }

  // ---------- learning ----------

  /** Counts the people in newly synced messages. No-op while the first-run backfill is running. */
  observe(sources: ContactSource[]): void {
    if (this.backfilling || this.stopped || sources.length === 0) return;
    this.apply(this.collect(sources));
  }

  /** Builds the changes for a batch of messages (also clears the "already counted" marks). */
  private collect(sources: ContactSource[]): Map<string, Delta> {
    const deltas = new Map<string, Delta>();
    const mids = this.ctx.db.prepare(
      'SELECT 1 FROM contact_sent_mid WHERE account_id = ? AND message_id = ?',
    );
    const dropMid = this.ctx.db.prepare(
      'DELETE FROM contact_sent_mid WHERE account_id = ? AND message_id = ?',
    );
    const add = (
      accountId: string,
      raw: string | null | undefined,
      rawName: string | null | undefined,
      kind: 'sent' | 'recv',
      ms: number,
    ) => {
      const address = cleanAddress(raw);
      if (!address || isNoReply(address) || this.forgotten.has(address)) return;
      const key = `${accountId}\u0000${address}`;
      let d = deltas.get(key);
      if (!d) {
        d = { accountId, address, name: null, nameMs: 0, sent: 0, recv: 0, lastSent: 0, lastSeen: 0 };
        deltas.set(key, d);
      }
      const name = cleanName(rawName, address);
      if (name && ms >= d.nameMs) {
        d.name = name;
        d.nameMs = ms;
      }
      if (kind === 'sent') {
        d.sent += 1;
        d.lastSent = Math.max(d.lastSent, ms);
      } else {
        d.recv += 1;
        d.lastSeen = Math.max(d.lastSeen, ms);
      }
    };
    for (const s of sources) {
      if (s.role && SKIP_ROLES.has(s.role)) continue;
      const ms = s.dateMs > 0 ? s.dateMs : this.ctx.now();
      if (s.role === 'sent') {
        const mid = s.messageId;
        if (mid && mids.get(s.accountId, mid)) {
          // We counted this one when it was sent. Only remember the names and stop.
          dropMid.run(s.accountId, mid);
          continue;
        }
        for (const a of [...s.to, ...s.cc, ...s.bcc]) add(s.accountId, a.address, a.name, 'sent', ms);
      } else {
        add(s.accountId, s.fromAddr, s.fromName, 'recv', ms);
        for (const a of [...s.to, ...s.cc, ...s.replyTo]) add(s.accountId, a.address, a.name, 'recv', ms);
      }
    }
    return deltas;
  }

  /** Called after a successful send: the recipients become (more) important at once. */
  recordSent(accountId: string, recipients: Address[], messageId: string | null): void {
    const now = this.ctx.now();
    const own = this.ownAddresses();
    const deltas = new Map<string, Delta>();
    for (const r of recipients) {
      const address = cleanAddress(r.address);
      if (!address || isNoReply(address) || own.has(address)) continue;
      // Sending to someone is a clear wish: it undoes an earlier "forget".
      if (this.forgotten.delete(address)) {
        this.ctx.db.prepare('DELETE FROM contact_forgotten WHERE address = ?').run(address);
      }
      const key = `${accountId}\u0000${address}`;
      const d = deltas.get(key) ?? {
        accountId,
        address,
        name: null,
        nameMs: 0,
        sent: 0,
        recv: 0,
        lastSent: 0,
        lastSeen: 0,
      };
      const name = cleanName(r.name, address);
      if (name) {
        d.name = name;
        d.nameMs = now;
      }
      d.sent += 1;
      d.lastSent = now;
      deltas.set(key, d);
    }
    if (deltas.size === 0) return;
    this.apply(deltas);
    if (messageId) {
      this.ctx.db
        .prepare(
          'INSERT OR REPLACE INTO contact_sent_mid (account_id, message_id, created_at) VALUES (?, ?, ?)',
        )
        .run(accountId, messageId, now);
    }
    this.ctx.db
      .prepare('DELETE FROM contact_sent_mid WHERE created_at < ?')
      .run(now - SENT_MID_KEEP_MS);
  }

  /** Persist and apply a batch of changes. */
  private apply(deltas: Map<string, Delta>): void {
    if (deltas.size === 0) return;
    const upsert = this.ctx.db.prepare(
      `INSERT INTO contact (account_id, address, name, name_ms, sent_count, recv_count, last_sent_ms, last_seen_ms)
       VALUES (@accountId, @address, @name, @nameMs, @sent, @recv, @lastSent, @lastSeen)
       ON CONFLICT(account_id, address) DO UPDATE SET
         sent_count   = sent_count + excluded.sent_count,
         recv_count   = recv_count + excluded.recv_count,
         last_sent_ms = max(last_sent_ms, excluded.last_sent_ms),
         last_seen_ms = max(last_seen_ms, excluded.last_seen_ms),
         name    = CASE WHEN excluded.name IS NOT NULL AND excluded.name_ms >= name_ms THEN excluded.name ELSE name END,
         name_ms = CASE WHEN excluded.name IS NOT NULL AND excluded.name_ms >= name_ms THEN excluded.name_ms ELSE name_ms END`,
    );
    this.ctx.db.transaction(() => {
      for (const d of deltas.values()) upsert.run(d);
    })();
    for (const d of deltas.values()) this.applyToMemory(d);
  }

  private applyToMemory(d: Delta): void {
    let e = this.entries.get(d.address);
    if (!e) {
      e = {
        address: d.address,
        name: null,
        nameMs: 0,
        tokens: [],
        heads: [],
        stats: [],
        sent: 0,
        recv: 0,
        lastSent: 0,
        lastSeen: 0,
        lnSent: 0,
        lnRecv: 0,
      };
      this.entries.set(d.address, e);
    }
    let st = e.stats.find((s) => s.accountId === d.accountId);
    if (!st) {
      st = { accountId: d.accountId, sent: 0, recv: 0, lastSent: 0, lastSeen: 0 };
      e.stats.push(st);
    }
    st.sent += d.sent;
    st.recv += d.recv;
    st.lastSent = Math.max(st.lastSent, d.lastSent);
    st.lastSeen = Math.max(st.lastSeen, d.lastSeen);
    e.sent += d.sent;
    e.recv += d.recv;
    e.lastSent = Math.max(e.lastSent, d.lastSent);
    e.lastSeen = Math.max(e.lastSeen, d.lastSeen);
    e.lnSent = Math.log(1 + e.sent);
    e.lnRecv = Math.log(1 + e.recv);
    if (d.name && d.nameMs >= e.nameMs) {
      e.name = d.name;
      e.nameMs = d.nameMs;
      this.retoken(e);
    } else if (e.tokens.length === 0) {
      this.retoken(e);
    }
  }

  private retoken(e: Entry): void {
    const at = e.address.lastIndexOf('@');
    const local = at > 0 ? e.address.slice(0, at) : e.address;
    const nameTokens = e.name ? tokenize(e.name) : [];
    const localTokens = tokenize(local);
    e.tokens = [...new Set([...nameTokens, ...localTokens, ...tokenize(e.address.slice(at + 1))])];
    e.heads = [...new Set([nameTokens[0], localTokens[0]].filter((t): t is string => !!t))];
  }

  // ---------- forgetting ----------

  forget(rawAddress: string): void {
    const address = cleanAddress(rawAddress) ?? rawAddress.trim().toLowerCase();
    if (!address) return;
    if (this.ownAddresses().has(address)) throw new AppException('INVALID_INPUT', 'Your own addresses cannot be removed from suggestions.');
    this.ctx.db.transaction(() => {
      this.ctx.db.prepare('DELETE FROM contact WHERE address = ?').run(address);
      this.ctx.db
        .prepare('INSERT OR REPLACE INTO contact_forgotten (address, forgotten_at) VALUES (?, ?)')
        .run(address, this.ctx.now());
    })();
    this.forgotten.add(address);
    this.entries.delete(address);
  }

  /** What is known about one address (always answers; an unknown address has zero counts). */
  get(rawAddress: string): ContactInfo {
    const address = cleanAddress(rawAddress) ?? rawAddress.trim().toLowerCase();
    const isOwn = this.ownAddresses().has(address);
    const forgotten = this.forgotten.has(address);
    const e = this.entries.get(address);
    if (!e) {
      return {
        address,
        name: null,
        known: false,
        sentCount: 0,
        receivedCount: 0,
        lastUsed: 0,
        accountIds: [],
        isOwn,
        forgotten,
      };
    }
    const accountIds = [...e.stats]
      .sort((a, b) => b.sent - a.sent || b.recv - a.recv || b.lastSeen - a.lastSeen)
      .map((st) => st.accountId);
    return {
      address,
      name: e.name,
      known: true,
      sentCount: e.sent,
      receivedCount: e.recv,
      lastUsed: e.sent > 0 ? e.lastSent : e.lastSeen,
      accountIds,
      isOwn,
      forgotten,
    };
  }

  /** An account was removed: its rows are gone from the database (cascade); drop them from memory. */
  removeAccount(accountId: string): void {
    for (const [addr, e] of this.entries) {
      if (!e.stats.some((s) => s.accountId === accountId)) continue;
      e.stats = e.stats.filter((s) => s.accountId !== accountId);
      if (e.stats.length === 0) {
        this.entries.delete(addr);
        continue;
      }
      e.sent = e.stats.reduce((n, s) => n + s.sent, 0);
      e.recv = e.stats.reduce((n, s) => n + s.recv, 0);
      e.lastSent = Math.max(...e.stats.map((s) => s.lastSent));
      e.lastSeen = Math.max(...e.stats.map((s) => s.lastSeen));
      e.lnSent = Math.log(1 + e.sent);
      e.lnRecv = Math.log(1 + e.recv);
    }
    this.ownCache = null;
  }

  // ---------- search ----------

  suggest(query: string, accountId?: string, limit = 8): ContactSuggestion[] {
    const max = Math.min(50, Math.max(1, limit | 0));
    const qTokens = tokenize(query);
    const own = this.ownAddresses();
    const now = this.ctx.now();
    // With an account and the setting on, contacts known only through other accounts follow the
    // account's own matches (ARCHITECTURE 6.6).
    const withOthers = accountId !== undefined && this.ctx.settings().suggestFromAllAccounts !== false;
    type Item = { score: number; e: Entry; sent: number; last: number; own: boolean; other?: string };
    // Small sorted lists of the best matches so far (best first).
    const top: Item[] = [];
    const topOther: Item[] = [];
    let worst = -Infinity;
    let worstOther = -Infinity;

    const rank = (
      e: Entry,
      sent: number,
      lnSent: number,
      lnRecv: number,
      lastSent: number,
      lastSeen: number,
    ): { score: number; isOwn: boolean } => {
      // Sent-to addresses come first; then how often and how recently.
      let score = 0;
      if (sent > 0) score += 60 + 20 * lnSent + recencyScore(now - lastSent, 25, 60);
      score += 8 * lnRecv + recencyScore(now - lastSeen, 8, 90);
      if (qTokens.length > 0 && e.heads.some((h) => h.startsWith(qTokens[0]!))) score += 6;
      const isOwn = own.has(e.address);
      if (isOwn) score -= 1000;
      return { score, isOwn };
    };
    const insert = (list: Item[], item: Item, cap: number): void => {
      let i = list.length;
      while (i > 0 && list[i - 1]!.score < item.score) i--;
      list.splice(i, 0, item);
      if (list.length > cap) list.pop();
    };

    outer: for (const e of this.entries.values()) {
      // Every typed word must be the start of one of the contact's words.
      for (const q of qTokens) {
        let hit = false;
        for (const t of e.tokens) {
          if (t.startsWith(q)) {
            hit = true;
            break;
          }
        }
        if (!hit) continue outer;
      }
      let sent: number;
      let lnSent: number;
      let lnRecv: number;
      let lastSent: number;
      let lastSeen: number;
      let other: string | undefined;
      if (accountId === undefined) {
        ({ sent, lnSent, lnRecv, lastSent, lastSeen } = e);
      } else {
        const st = e.stats.find((s) => s.accountId === accountId);
        if (st) {
          ({ sent, lastSent, lastSeen } = st);
          lnSent = Math.log(1 + sent);
          lnRecv = Math.log(1 + st.recv);
        } else {
          if (!withOthers || e.stats.length === 0) continue;
          // Known only through other accounts: use the account that knows it best.
          let best = e.stats[0]!;
          for (const s of e.stats) {
            if (s.sent > best.sent || (s.sent === best.sent && s.recv > best.recv)) best = s;
          }
          ({ sent, lastSent, lastSeen } = best);
          lnSent = Math.log(1 + sent);
          lnRecv = Math.log(1 + best.recv);
          other = best.accountId;
        }
      }
      const { score, isOwn } = rank(e, sent, lnSent, lnRecv, lastSent, lastSeen);
      const item: Item = { score, e, sent, last: sent > 0 ? lastSent : lastSeen, own: isOwn };
      if (other !== undefined) {
        item.other = other;
        if (topOther.length >= max && score <= worstOther) continue;
        insert(topOther, item, max);
        worstOther = topOther.length >= max ? topOther[topOther.length - 1]!.score : -Infinity;
      } else {
        if (top.length >= max && score <= worst) continue;
        insert(top, item, max);
        worst = top.length >= max ? top[top.length - 1]!.score : -Infinity;
      }
    }
    // This account first, then the others; the user's own addresses last of all.
    const all = [...top, ...topOther];
    const merged = [...all.filter((t) => !t.own), ...all.filter((t) => t.own)].slice(0, max);
    return merged.map((t) => ({
      address: t.e.address,
      name: t.e.name,
      sentCount: t.sent,
      lastUsed: t.last,
      isOwn: t.own,
      ...(t.other !== undefined ? { otherAccountId: t.other } : {}),
    }));
  }

  // ---------- first-run backfill ----------

  /** True when the one-time backfill still has to run. */
  needsBackfill(): boolean {
    const r = this.ctx.db.prepare('SELECT v FROM kv WHERE k = ?').get(BACKFILL_KEY) as
      | { v: string }
      | undefined;
    return r?.v !== BACKFILL_VERSION;
  }

  /**
   * Learns from every message already in the database, once. Runs in chunks and gives the engine
   * room to breathe between them. Resolves when finished (or stopped).
   */
  async backfill(): Promise<void> {
    if (this.backfilling || this.stopped || !this.needsBackfill()) return;
    this.backfilling = true;
    try {
      // Start clean so a re-run (after a version bump) does not count twice.
      this.ctx.db.exec('DELETE FROM contact; DELETE FROM contact_sent_mid;');
      this.ensureLoaded(); // the "forgotten" list must be there; the counters are cleared below
      this.mem.clear();
      let cursor = 0;
      for (;;) {
        if (this.stopped) return;
        const rows = this.ctx.messages.contactSources(cursor, BACKFILL_CHUNK);
        if (rows.length === 0) break;
        cursor = rows[rows.length - 1]!.id;
        this.apply(this.collect(rows.map((r) => r.source)));
        await new Promise<void>((res) => setTimeout(res, 0));
      }
      this.ctx.db
        .prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
        .run(BACKFILL_KEY, BACKFILL_VERSION);
    } finally {
      this.backfilling = false;
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.warmTimer) clearTimeout(this.warmTimer);
    this.warmTimer = null;
  }
}

export { fold };
