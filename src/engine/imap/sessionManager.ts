import type { Account, AccountStatus } from '../../shared/ipc';
import { AppException } from '../../shared/errors';
import { pendingTotal, type EngineContext } from '../context';
import { AccountSession, type SessionShared } from './accountSession';
import { IdleBudget, Semaphore } from './connectionPool';

const MAX_TOTAL_IDLE = 40; // "maxTotalConnections" in ARCHITECTURE 5.4 (IDLE slots)
const MAX_CONCURRENT_WORK = 12;
const START_STAGGER_MS = 200;

export class SessionManager {
  private sessions = new Map<string, AccountSession>();
  private shared: SessionShared = {
    semaphore: new Semaphore(MAX_CONCURRENT_WORK),
    idleBudget: new IdleBudget(MAX_TOTAL_IDLE),
  };
  private online = true;
  private startTimers: ReturnType<typeof setTimeout>[] = [];

  constructor(private readonly ctx: EngineContext) {}

  /** Start every enabled account, staggered so we do not open all connections at once. */
  startAll(): void {
    const accounts = this.ctx.accounts.list();
    accounts.forEach((a, i) => {
      const session = this.ensure(a);
      if (!a.enabled) return;
      this.startTimers.push(
        setTimeout(() => {
          if (this.online) session.start();
        }, i * START_STAGGER_MS),
      );
    });
  }

  private ensure(a: Account): AccountSession {
    let s = this.sessions.get(a.id);
    if (!s) {
      s = new AccountSession(this.ctx, a, this.shared);
      this.sessions.set(a.id, s);
    } else {
      s.setAccount(a);
    }
    return s;
  }

  get(accountId: string): AccountSession {
    const s = this.sessions.get(accountId);
    if (!s) throw new AppException('NOT_FOUND', 'Account not found.');
    return s;
  }

  has(accountId: string): boolean {
    return this.sessions.has(accountId);
  }

  addAndStart(a: Account): void {
    const s = this.ensure(a);
    if (a.enabled && this.online) s.start();
  }

  /** Apply an account edit: restart the connection if anything connection-related changed. */
  async applyUpdate(a: Account): Promise<void> {
    const s = this.ensure(a);
    await s.stop(a.enabled ? 'connecting' : 'disabled');
    if (a.enabled && this.online) s.start();
  }

  /** Take over an edited account without touching its connection. */
  updateAccount(a: Account): void {
    this.ensure(a);
  }

  async restart(accountId: string): Promise<void> {
    const a = this.ctx.accounts.get(accountId);
    if (a) await this.applyUpdate(a);
  }

  async remove(accountId: string): Promise<void> {
    const s = this.sessions.get(accountId);
    if (!s) return;
    await s.stop('disabled');
    this.sessions.delete(accountId);
  }

  statuses(): AccountStatus[] {
    return this.ctx.accounts.list().map((a) => {
      const s = this.sessions.get(a.id);
      return (
        s?.getStatus() ?? {
          accountId: a.id,
          state: a.enabled ? 'connecting' : 'disabled',
          lastSyncAt: null,
          error: null,
          nextRetryAt: null,
          pendingCount: pendingTotal(this.ctx, a.id),
        }
      );
    });
  }

  /** The renderer / main report network changes (ARCHITECTURE 5.4). */
  async setOnline(online: boolean): Promise<void> {
    if (online === this.online) return;
    this.online = online;
    const sessions = [...this.sessions.values()];
    if (!online) {
      for (const s of sessions) {
        const a = this.ctx.accounts.get(s.id);
        if (a?.enabled) await s.stop('offline');
      }
      return;
    }
    sessions.forEach((s, i) => {
      const a = this.ctx.accounts.get(s.id);
      if (!a?.enabled) return;
      this.startTimers.push(setTimeout(() => s.start(), i * START_STAGGER_MS));
    });
  }

  async syncAll(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((s) => s.syncAll().catch(() => undefined)));
  }

  async shutdown(): Promise<void> {
    for (const t of this.startTimers) clearTimeout(t);
    await Promise.all([...this.sessions.values()].map((s) => s.stop('disabled')));
  }
}
