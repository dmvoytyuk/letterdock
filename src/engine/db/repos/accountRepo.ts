import type { Account, Security } from '../../../shared/ipc';
import type { Db } from '../connection';
import { hasEmailPlaceholder, resolveUsername } from '../../../shared/providers';

interface AccountRow {
  id: string;
  email: string;
  display_name: string;
  color: string | null;
  provider: Account['provider'];
  auth_type: Account['authType'];
  oauth_provider: Account['oauthProvider'];
  imap_host: string;
  imap_port: number;
  imap_security: Security;
  smtp_host: string;
  smtp_port: number;
  smtp_security: Security;
  username: string;
  sync_days: number;
  signature: string | null;
  enabled: number;
  sort_order: number;
  badge: string | null;
}

/** First letter of the name, upper case (DESIGN-SPEC 1.7). */
export function defaultBadge(name: string): string {
  const ch = [...name.trim()][0];
  return ch ? ch.toUpperCase() : '?';
}

function toAccount(r: AccountRow): Account {
  return {
    id: r.id,
    email: r.email,
    displayName: r.display_name,
    color: r.color,
    provider: r.provider,
    authType: r.auth_type,
    oauthProvider: r.oauth_provider,
    imap: { host: r.imap_host, port: r.imap_port, security: r.imap_security },
    smtp: { host: r.smtp_host, port: r.smtp_port, security: r.smtp_security },
    username: r.username,
    syncDays: r.sync_days,
    signature: r.signature,
    enabled: r.enabled === 1,
    sortOrder: r.sort_order,
    badge: r.badge ?? defaultBadge(r.display_name || r.email),
  };
}

export class AccountRepo {
  constructor(private readonly db: Db) {}

  /** Repair a saved login name that still holds a raw %EMAILADDRESS%-style placeholder. */
  private repair(r: AccountRow): AccountRow {
    if (!hasEmailPlaceholder(r.username)) return r;
    const username = resolveUsername(r.username, r.email);
    this.db.prepare('UPDATE account SET username = ? WHERE id = ?').run(username, r.id);
    return { ...r, username };
  }

  list(): Account[] {
    const rows = this.db
      .prepare('SELECT * FROM account ORDER BY sort_order, created_at')
      .all() as AccountRow[];
    return rows.map((r) => toAccount(this.repair(r)));
  }

  get(id: string): Account | null {
    const r = this.db.prepare('SELECT * FROM account WHERE id = ?').get(id) as
      AccountRow | undefined;
    return r ? toAccount(this.repair(r)) : null;
  }

  insert(a: Account, createdAt: number): void {
    this.db
      .prepare(
        `INSERT INTO account (id,email,display_name,color,provider,auth_type,oauth_provider,
          imap_host,imap_port,imap_security,smtp_host,smtp_port,smtp_security,username,
          sync_days,signature,enabled,sort_order,created_at,badge)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        a.id,
        a.email,
        a.displayName,
        a.color,
        a.provider,
        a.authType,
        a.oauthProvider,
        a.imap.host,
        a.imap.port,
        a.imap.security,
        a.smtp.host,
        a.smtp.port,
        a.smtp.security,
        a.username,
        a.syncDays,
        a.signature,
        a.enabled ? 1 : 0,
        a.sortOrder,
        createdAt,
        a.badge,
      );
  }

  update(id: string, p: Partial<Account>): Account | null {
    const cur = this.get(id);
    if (!cur) return null;
    const n: Account = { ...cur, ...p, imap: p.imap ?? cur.imap, smtp: p.smtp ?? cur.smtp };
    this.db
      .prepare(
        `UPDATE account SET display_name=?, color=?, signature=?, sync_days=?, enabled=?, sort_order=?, badge=?,
          imap_host=?, imap_port=?, imap_security=?, smtp_host=?, smtp_port=?, smtp_security=?, username=?
         WHERE id=?`,
      )
      .run(
        n.displayName,
        n.color,
        n.signature,
        n.syncDays,
        n.enabled ? 1 : 0,
        n.sortOrder,
        n.badge,
        n.imap.host,
        n.imap.port,
        n.imap.security,
        n.smtp.host,
        n.smtp.port,
        n.smtp.security,
        n.username,
        id,
      );
    return n;
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM account WHERE id = ?').run(id);
  }

  nextSortOrder(): number {
    const r = this.db
      .prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM account')
      .get() as { n: number };
    return r.n;
  }

  reorder(orderedIds: string[]): void {
    const stmt = this.db.prepare('UPDATE account SET sort_order = ? WHERE id = ?');
    this.db.transaction(() => orderedIds.forEach((id, i) => stmt.run(i, id)))();
  }
}
