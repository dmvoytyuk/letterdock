import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  Account,
  AppError,
  DiscoverRes,
  NewAccountInput,
  ProviderId,
  ServerEndpoint,
  TestAccountReq,
  TestAccountRes,
  UpdateAccountReq,
} from '../../shared/ipc';
import { AppException, toAppError } from '../../shared/errors';
import { domainOf, findProviderByDomain, findProviderByHost, resolveUsername } from '../../shared/providers';
import type { EngineContext } from '../context';
import type { Credential } from '../../shared/internal';
import { createImapClient } from '../imap/connectionPool';
import { pruneToWindow, setWidenPending } from '../imap/history';
import { createSmtpTransport } from '../smtp/transport';
import { mapNetworkError } from '../imap/errors';
import type { SessionManager } from '../imap/sessionManager';
import { defaultBadge } from '../db/repos/accountRepo';
import { discoverConfig, isValidEmail, type DiscoverDeps } from './autodiscover';

/** Light-mode palette from DESIGN-SPEC 1.7; auto-assigned in order. */
export const ACCOUNT_COLORS = [
  '#0F6CBD',
  '#0E7C7B',
  '#107C10',
  '#5E7C00',
  '#9A6700',
  '#C74B00',
  '#C42B1C',
  '#C239B3',
  '#5B4BD1',
  '#3B4BA8',
  '#8A5A44',
  '#5B6670',
];

export function pickColor(used: (string | null)[]): string {
  const usedSet = new Set(used.filter(Boolean).map((c) => c!.toUpperCase()));
  const free = ACCOUNT_COLORS.find((c) => !usedSet.has(c));
  return free ?? ACCOUNT_COLORS[used.length % ACCOUNT_COLORS.length];
}

/** 1-2 visible characters, or null when empty. */
export function normalizeBadge(raw: string | undefined | null): string | null {
  const chars = [...(raw ?? '').trim()].slice(0, 2).join('');
  return chars ? chars.toUpperCase() : null;
}

function guessProvider(email: string, imapHost: string): ProviderId {
  return findProviderByHost(imapHost)?.id ?? findProviderByDomain(domainOf(email))?.id ?? 'generic';
}

function validateEndpoint(e: ServerEndpoint, label: string): void {
  if (!e.host.trim() || /[\s/]/.test(e.host)) {
    throw new AppException('INVALID_INPUT', `Enter a valid ${label} server name.`);
  }
  if (!Number.isInteger(e.port) || e.port < 1 || e.port > 65535) {
    throw new AppException('INVALID_INPUT', `Enter a valid ${label} port.`);
  }
}

export class AccountService {
  constructor(
    private readonly ctx: EngineContext,
    private readonly sessions: SessionManager,
    private readonly discoverDeps: DiscoverDeps,
  ) {}

  list(): Account[] {
    return this.ctx.accounts.list();
  }

  async discover(email: string): Promise<DiscoverRes> {
    return { config: await discoverConfig(email, this.discoverDeps) };
  }

  /** Work out the credential and login name for a test / add request. */
  private async credentialFor(
    i: Pick<
      NewAccountInput,
      'authType' | 'password' | 'oauthSessionId' | 'oauthProvider' | 'username' | 'email'
    >,
  ): Promise<{ cred: Credential; username: string; oauthEmail?: string }> {
    if (i.authType === 'password') {
      if (!i.password) throw new AppException('INVALID_INPUT', 'Enter the password.');
      return {
        cred: { kind: 'password', password: i.password },
        username: resolveUsername(i.username, i.email),
      };
    }
    if (i.oauthProvider !== undefined && i.oauthProvider !== 'microsoft') {
      throw new AppException('UNSUPPORTED', 'Only Sign in with Microsoft is available.');
    }
    if (!i.oauthSessionId) {
      throw new AppException('INVALID_INPUT', 'Sign in with Microsoft first.');
    }
    const info = await this.ctx.secrets.peekOAuthSession(i.oauthSessionId);
    return {
      cred: { kind: 'oauth', accessToken: info.accessToken, expiresAt: info.expiresAt },
      username: resolveUsername(i.username, info.email),
      oauthEmail: info.email,
    };
  }

  /** Test IMAP login + LIST and SMTP verify, independently. Never throws for server problems. */
  async test(req: TestAccountReq): Promise<TestAccountRes> {
    const i = req.input;
    let who: Awaited<ReturnType<AccountService['credentialFor']>>;
    try {
      who = await this.credentialFor(i);
    } catch (e) {
      const err = toAppError(e);
      return { imap: { ok: false, error: err }, smtp: { ok: false, error: err } };
    }
    const [imap, smtp] = await Promise.all([
      this.testImap(who.username, who.cred, i.imap),
      this.testSmtp(who.username, who.cred, i.smtp),
    ]);
    return { imap, smtp };
  }

  private async testImap(
    username: string,
    cred: Credential,
    endpoint: ServerEndpoint,
  ): Promise<{ ok: boolean; error?: AppError }> {
    const client = createImapClient(
      { imap: endpoint, username },
      cred,
      this.ctx.log,
      this.ctx.imapTrustedCa,
    );
    try {
      await client.connect();
      await client.list({ listOnly: true });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: mapNetworkError(e, 'imap') };
    } finally {
      try {
        await client.logout();
      } catch {
        client.close();
      }
    }
  }

  private async testSmtp(
    username: string,
    cred: Credential,
    endpoint: ServerEndpoint,
  ): Promise<{ ok: boolean; error?: AppError }> {
    const transport = createSmtpTransport(endpoint, username, cred, this.ctx);
    try {
      await transport.verify();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: mapNetworkError(e, 'smtp') };
    } finally {
      transport.close();
    }
  }

  async add(input: NewAccountInput): Promise<Account> {
    const email = input.email.trim();
    if (!isValidEmail(email))
      throw new AppException('INVALID_INPUT', 'Enter a valid email address.');
    validateEndpoint(input.imap, 'incoming (IMAP)');
    validateEndpoint(input.smtp, 'outgoing (SMTP)');
    const oauth = input.authType === 'oauth2';
    const who = await this.credentialFor({ ...input, email });
    if (oauth && who.oauthEmail && who.oauthEmail.toLowerCase() !== email.toLowerCase()) {
      throw new AppException(
        'INVALID_INPUT',
        `You signed in as ${who.oauthEmail}, but the address you entered is ${email}. Enter the same address.`,
      );
    }
    const username = who.username;
    if (this.ctx.accounts.list().some((a) => a.email.toLowerCase() === email.toLowerCase())) {
      throw new AppException('INVALID_INPUT', 'This account has already been added.');
    }

    // Never save an account whose login does not work.
    const imapResult = await this.testImap(username, who.cred, input.imap);
    if (!imapResult.ok)
      throw new AppException(imapResult.error!.code, imapResult.error!.message, imapResult.error);

    const existing = this.ctx.accounts.list();
    const displayName = input.displayName.trim() || email;
    const account: Account = {
      id: randomUUID(),
      email,
      displayName,
      color: input.color ?? pickColor(existing.map((a) => a.color)),
      provider: guessProvider(email, input.imap.host),
      authType: oauth ? 'oauth2' : 'password',
      oauthProvider: oauth ? 'microsoft' : null,
      imap: input.imap,
      smtp: input.smtp,
      username,
      syncDays: input.syncDays ?? 90,
      signature: null,
      enabled: true,
      sortOrder: this.ctx.accounts.nextSortOrder(),
      badge: normalizeBadge(input.badge) ?? defaultBadge(displayName),
    };
    if (oauth) {
      // Main moves the tokens from the sign-in session to this account.
      await this.ctx.secrets.adoptOAuthSession(input.oauthSessionId!, account.id);
    } else {
      await this.ctx.secrets.set(account.id, { password: input.password });
    }
    try {
      this.ctx.accounts.insert(account, this.ctx.now());
    } catch (e) {
      await this.ctx.secrets.delete(account.id).catch(() => undefined);
      throw new AppException('DB_ERROR', 'Could not save the account.', { details: String(e) });
    }
    this.sessions.addAndStart(account);
    this.ctx.hub.emit({ type: 'accounts:changed' });
    return account;
  }

  async update(req: UpdateAccountReq): Promise<Account> {
    const cur = this.ctx.accounts.get(req.accountId);
    if (!cur) throw new AppException('NOT_FOUND', 'Account not found.');
    const p = req.patch;
    if (p.imap) validateEndpoint(p.imap, 'incoming (IMAP)');
    if (p.smtp) validateEndpoint(p.smtp, 'outgoing (SMTP)');
    if (
      p.syncDays !== undefined &&
      (!Number.isInteger(p.syncDays) || p.syncDays < 1 || p.syncDays > 3650)
    ) {
      throw new AppException('INVALID_INPUT', 'Sync days must be between 1 and 3650.');
    }
    if (p.badge !== undefined) {
      const badge = normalizeBadge(p.badge);
      if (!badge) throw new AppException('INVALID_INPUT', 'Enter one or two characters for the badge.');
      p.badge = badge;
    }
    const next = this.ctx.accounts.update(req.accountId, p)!;
    const connectionChanged =
      p.imap !== undefined || p.username !== undefined || p.enabled !== undefined;
    const days = p.syncDays !== undefined && p.syncDays !== cur.syncDays;
    if (days && next.syncDays < cur.syncDays) {
      // Narrower window: forget older mail on this PC only (never on the server). Done before the
      // session is restarted, so no running sync can add it back.
      setWidenPending(this.ctx, next.id, false);
      this.sessions.updateAccount(next);
      // With a session, this waits for a widening that is running (and stops it) first.
      if (this.sessions.has(next.id)) await this.sessions.get(next.id).pruneHistory(next.syncDays);
      else await pruneToWindow(this.ctx, next.id, next.syncDays);
    } else if (days) {
      // Wider window: the session fetches the older headers once it can reach the server.
      setWidenPending(this.ctx, next.id, true);
    }
    if (connectionChanged) await this.sessions.applyUpdate(next);
    else if (days) {
      this.sessions.updateAccount(next);
      if (next.syncDays > cur.syncDays && this.sessions.has(next.id)) {
        void this.sessions.get(next.id).widenHistory();
      }
    }
    this.ctx.hub.emit({ type: 'accounts:changed' });
    return next;
  }

  async updateCredentials(accountId: string, password: string): Promise<void> {
    const a = this.ctx.accounts.get(accountId);
    if (!a) throw new AppException('NOT_FOUND', 'Account not found.');
    if (a.authType === 'oauth2') {
      throw new AppException(
        'UNSUPPORTED',
        'This account signs in with Microsoft. Use "Sign in again" instead.',
      );
    }
    if (!password) throw new AppException('INVALID_INPUT', 'Enter the password.');
    const test = await this.testImap(resolveUsername(a.username, a.email), { kind: 'password', password }, a.imap);
    if (!test.ok) throw new AppException(test.error!.code, test.error!.message, test.error);
    await this.ctx.secrets.set(accountId, { password });
    await this.sessions.restart(accountId);
  }

  async remove(accountId: string): Promise<void> {
    const a = this.ctx.accounts.get(accountId);
    if (!a) throw new AppException('NOT_FOUND', 'Account not found.');
    await this.sessions.remove(accountId);
    const outboxFiles = this.ctx.db
      .prepare('SELECT raw_path FROM outbox WHERE account_id = ?')
      .all(accountId) as { raw_path: string }[];
    for (const f of outboxFiles) await rm(f.raw_path, { force: true }).catch(() => undefined);
    const ids = this.ctx.messages.idsForAccount(accountId);
    this.ctx.accounts.remove(accountId); // cascades folders, messages, bodies, attachments
    this.ctx.messages.ftsDeleteMany(ids);
    this.ctx.contacts.removeAccount(accountId);
    this.ctx.pendingOps?.forgetAccount(accountId);
    await this.ctx.secrets.delete(accountId).catch(() => undefined);
    await rm(join(this.ctx.dataDir, 'attachments', accountId), { recursive: true, force: true });
    this.ctx.hub.emit({ type: 'accounts:changed' });
    this.ctx.hub.changed({ removed: ids });
  }

  reorder(orderedIds: string[]): void {
    this.ctx.accounts.reorder(orderedIds);
    this.ctx.hub.emit({ type: 'accounts:changed' });
  }
}
