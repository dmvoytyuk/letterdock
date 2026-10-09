import { ImapFlow } from 'imapflow';
import type { Account } from '../../shared/ipc';
import type { Credential } from '../../shared/internal';
import type { Logger } from '../logger';

export type Priority = 'user' | 'sync' | 'background';

export function createImapClient(
  account: Pick<Account, 'imap' | 'username'>,
  cred: Credential,
  log?: Logger,
  /** Test-only: extra trusted CA (e.g. a fixture server's self-signed cert). Verification stays on. */
  trustedCa?: string | Buffer,
  /** Quiet time before imapflow enters IDLE (its default is 15 s). */
  autoIdleDelayMs?: number,
): ImapFlow {
  const auth =
    cred.kind === 'password'
      ? { user: account.username, pass: cred.password }
      : { user: account.username, accessToken: cred.accessToken };
  const client = new ImapFlow({
    host: account.imap.host,
    port: account.imap.port,
    secure: account.imap.security === 'ssl',
    // STARTTLS is mandatory when security is 'starttls' (no downgrade to cleartext).
    doSTARTTLS: account.imap.security === 'starttls' ? true : undefined,
    auth,
    logger: false,
    ...(autoIdleDelayMs !== undefined ? { autoIdleDelay: autoIdleDelayMs } : {}),
    connectionTimeout: 20_000,
    greetingTimeout: 16_000,
    socketTimeout: 5 * 60_000,
    // Certificates are always verified (ARCHITECTURE 5.2: never silently ignore TLS errors).
    tls: trustedCa ? { rejectUnauthorized: true, ca: trustedCa } : { rejectUnauthorized: true },
  });
  // imapflow emits 'error' on socket problems; an unhandled one would crash the process.
  client.on('error', (err: Error) => log?.debug({ err: err.message }, 'imap client error'));
  return client;
}

/** Counting semaphore for the global limit of simultaneous work connections. */
export class Semaphore {
  private waiters: (() => void)[] = [];
  private used = 0;
  constructor(private readonly max: number) {}

  async acquire(): Promise<() => void> {
    if (this.used >= this.max) await new Promise<void>((res) => this.waiters.push(res));
    this.used++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.used--;
      this.waiters.shift()?.();
    };
  }
}

/** Caps how many accounts keep a dedicated IDLE connection (the rest fall back to polling). */
export class IdleBudget {
  private used = new Set<string>();
  constructor(public max: number) {}
  tryAcquire(accountId: string): boolean {
    if (this.used.has(accountId)) return true;
    if (this.used.size >= this.max) return false;
    this.used.add(accountId);
    return true;
  }
  release(accountId: string): void {
    this.used.delete(accountId);
  }
}

interface Job {
  priority: Priority;
  run: (c: ImapFlow) => Promise<unknown>;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

const PRIORITY_ORDER: Priority[] = ['user', 'sync', 'background'];

/**
 * Per-account pool of work connections. Jobs run with exclusive use of one client.
 * FIFO within a priority; `user` jobs jump ahead of `sync`, which jump ahead of `background`.
 */
export class WorkPool {
  private idle: { client: ImapFlow; timer: ReturnType<typeof setTimeout> }[] = [];
  private active = 0;
  private queues: Record<Priority, Job[]> = { user: [], sync: [], background: [] };
  private closed = false;

  constructor(
    private readonly create: () => Promise<ImapFlow>,
    private readonly maxSize: () => number,
    private readonly global: Semaphore,
    private readonly idleCloseMs = 60_000,
  ) {}

  run<T>(priority: Priority, fn: (c: ImapFlow) => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('pool closed'));
    return new Promise<T>((resolve, reject) => {
      this.queues[priority].push({
        priority,
        run: fn as Job['run'],
        resolve: resolve as Job['resolve'],
        reject,
      });
      this.pump();
    });
  }

  private next(): Job | undefined {
    for (const p of PRIORITY_ORDER) {
      const j = this.queues[p].shift();
      if (j) return j;
    }
    return undefined;
  }

  private pump(): void {
    while (!this.closed && this.active < this.maxSize()) {
      const job = this.next();
      if (!job) return;
      this.active++;
      void this.execute(job);
    }
  }

  private async execute(job: Job): Promise<void> {
    const release = await this.global.acquire();
    let client: ImapFlow | null = null;
    try {
      const pooled = this.idle.pop();
      if (pooled) {
        clearTimeout(pooled.timer);
        client = pooled.client;
      }
      if (client && !client.usable) client = null;
      if (!client) client = await this.create();
      const result = await job.run(client);
      job.resolve(result);
      this.giveBack(client);
    } catch (e) {
      if (client) this.discard(client);
      job.reject(e);
    } finally {
      release();
      this.active--;
      this.pump();
    }
  }

  private giveBack(client: ImapFlow): void {
    if (this.closed || !client.usable) {
      this.discard(client);
      return;
    }
    const timer = setTimeout(() => {
      this.idle = this.idle.filter((i) => i.client !== client);
      client.logout().catch(() => client.close());
    }, this.idleCloseMs);
    this.idle.push({ client, timer });
  }

  private discard(client: ImapFlow): void {
    try {
      client.close();
    } catch {
      /* already closed */
    }
  }

  /** Close everything; queued jobs are rejected. */
  async close(): Promise<void> {
    this.closed = true;
    for (const p of PRIORITY_ORDER) {
      for (const j of this.queues[p].splice(0)) j.reject(new Error('pool closed'));
    }
    for (const i of this.idle.splice(0)) {
      clearTimeout(i.timer);
      this.discard(i.client);
    }
  }
}
