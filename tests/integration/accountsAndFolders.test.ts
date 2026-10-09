// Engine integration: accounts, folder discovery, folder create/rename/delete — real IMAP over a socket.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AccountStatus } from '../../src/shared/ipc';
import { createHarness, waitFor, type Harness } from '../fakes/engineHarness';
import { rawMessage, startFakeImap, type FakeImapServer } from '../fakes/fakeImapServer';

let server: FakeImapServer;
let h: Harness;

beforeEach(async () => {
  server = await startFakeImap({ inbox: [{ raw: rawMessage({ subject: 'First' }) }] });
  h = await createHarness(server);
});
afterEach(async () => {
  await h.cleanup();
  await server.close();
});

const status = (accountId: string): AccountStatus =>
  h.engine.sessions.statuses().find((s) => s.accountId === accountId)!;

describe('add account', () => {
  it('accepts a correct login, saves the account and goes online', async () => {
    const acc = await h.addAccount();
    expect(acc.email).toBe('me@example.com');
    expect(await h.engine.handle('accounts.list', undefined)).toHaveLength(1);
    expect(h.secrets.get(acc.id)).toBeTruthy();
    await waitFor('account online', () => ['online', 'syncing'].includes(status(acc.id).state));
  });

  it('rejects a wrong password with AUTH_FAILED and saves nothing', async () => {
    await expect(h.addAccount({ password: 'nope' })).rejects.toMatchObject({
      appError: { code: 'AUTH_FAILED' },
    });
    expect(await h.engine.handle('accounts.list', undefined)).toEqual([]);
    expect(h.secrets.size).toBe(0);
  });

  it('accounts.test reports IMAP success and failure separately', async () => {
    const base = {
      email: 'me@example.com',
      authType: 'password' as const,
      username: 'testuser',
      imap: { host: server.host, port: server.port, security: 'ssl' as const },
      smtp: { host: server.host, port: 1, security: 'ssl' as const },
    };
    const ok = await h.engine.handle('accounts.test', { input: { ...base, password: 'testpass' } });
    expect(ok).toMatchObject({ imap: { ok: true } });
    const bad = await h.engine.handle('accounts.test', { input: { ...base, password: 'wrong' } });
    expect(bad).toMatchObject({ imap: { ok: false, error: { code: 'AUTH_FAILED' } } });
  });

  it('reports HOST_UNREACHABLE when nothing listens on the port', async () => {
    await expect(
      h.addAccount({ imap: { host: '127.0.0.1', port: 1, security: 'ssl' } }),
    ).rejects.toMatchObject({ appError: { code: 'HOST_UNREACHABLE' } });
  });

  it('refuses a server certificate it does not trust (TLS verification stays on)', async () => {
    const strict = await createHarness({ ...server, ca: '' } as FakeImapServer);
    try {
      await expect(strict.addAccount()).rejects.toMatchObject({ appError: { code: 'TLS_ERROR' } });
    } finally {
      await strict.cleanup();
    }
  });

  it('moves to auth_failed when the stored password stops working', async () => {
    const acc = await h.addAccount();
    await waitFor('online', () => ['online', 'syncing'].includes(status(acc.id).state));
    // Password changed on the server: the saved one no longer works after a reconnect.
    h.secrets.set(acc.id, 'changed-elsewhere');
    server.dropConnections();
    await waitFor('auth_failed', () => status(acc.id).state === 'auth_failed', 15_000);
    expect(status(acc.id).error?.code).toBe('AUTH_FAILED');
    expect(h.eventsOfType('account:authRequired').length).toBeGreaterThan(0);
  });
});

describe('discover then add (known-provider style config)', () => {
  it('uses the discovered username, not a raw placeholder, and logs in', async () => {
    const cfg = (await h.engine.handle('accounts.discover', { email: 'me@gmail.com' })) as {
      config: { usernameTemplate: string } | null;
    };
    expect(cfg.config!.usernameTemplate).toBe('me@gmail.com');
    // Same shape the UI sends: discovered username, user-supplied server (the fake one).
    const acc = await h.addAccount({
      email: 'me@example.com',
      username: cfg.config!.usernameTemplate.replace('gmail.com', 'example.com'),
    });
    expect(acc.username).toBe('me@example.com');
  });

  it('substitutes a leaked placeholder in accounts.add / accounts.test', async () => {
    const acc = await h.addAccount({ username: '%EMAILADDRESS%' });
    expect(acc.username).toBe('me@example.com');
    const t = await h.engine.handle('accounts.test', {
      input: {
        email: 'me@example.com',
        authType: 'password',
        username: '%EMAILADDRESS%',
        password: 'testpass',
        imap: { host: server.host, port: server.port, security: 'ssl' },
        smtp: { host: server.host, port: 1, security: 'ssl' },
      },
    });
    expect(t).toMatchObject({ imap: { ok: true } });
  });

  it('repairs an already-saved account with a raw placeholder username on load', async () => {
    const acc = await h.addAccount();
    h.engine.ctx.db.prepare('UPDATE account SET username = ? WHERE id = ?').run('%EMAILADDRESS%', acc.id);
    expect(h.engine.ctx.accounts.get(acc.id)!.username).toBe('me@example.com');
    const row = h.engine.ctx.db.prepare('SELECT username FROM account WHERE id = ?').get(acc.id) as {
      username: string;
    };
    expect(row.username).toBe('me@example.com');
  });
});

describe('folder discovery', () => {
  it('lists folders and maps SPECIAL-USE roles', async () => {
    const acc = await h.addAccount();
    await waitFor('folders listed', () => h.engine.ctx.folders.rowsForAccount(acc.id).length >= 7);
    const folders = (await h.engine.handle('folders.list', { accountId: acc.id })) as {
      path: string;
      role: string | null;
    }[];
    const roleOf = (p: string) => folders.find((f) => f.path === p)?.role;
    expect(roleOf('INBOX')).toBe('inbox');
    expect(roleOf('Sent')).toBe('sent');
    expect(roleOf('Drafts')).toBe('drafts');
    expect(roleOf('Trash')).toBe('trash');
    expect(roleOf('Junk')).toBe('junk');
    expect(roleOf('Archive')).toBe('archive');
    expect(folders.find((f) => f.path === 'Projects')?.role).toBeNull();
  });

  it('uses the server hierarchy delimiter', async () => {
    const acc = await h.addAccount();
    await waitFor('folders listed', () => h.engine.ctx.folders.rowsForAccount(acc.id).length >= 7);
    expect(h.folderByPath(acc.id, 'Projects').delimiter).toBe('/');
  });
});

describe('folder create / rename / delete', () => {
  it('creates a folder on the server and locally', async () => {
    const acc = await h.addAccount();
    await waitFor('folders listed', () => h.engine.ctx.folders.rowsForAccount(acc.id).length >= 7);
    const f = (await h.engine.handle('folders.create', {
      accountId: acc.id,
      parentPath: null,
      name: 'Work',
    })) as { path: string };
    expect(f.path).toBe('Work');
    expect(server.raw.getMailbox('Work')).toBeDefined();
    expect(h.folderByPath(acc.id, 'Work')).toBeTruthy();
  });

  it('creates a nested folder under a parent', async () => {
    const acc = await h.addAccount();
    await waitFor('folders listed', () => h.engine.ctx.folders.rowsForAccount(acc.id).length >= 7);
    const f = (await h.engine.handle('folders.create', {
      accountId: acc.id,
      parentPath: 'Projects',
      name: 'Alpha',
    })) as { path: string };
    expect(f.path).toBe('Projects/Alpha');
    expect(server.raw.getMailbox('Projects/Alpha')).toBeDefined();
  });

  it('renames a folder on the server and keeps the local row id', async () => {
    const acc = await h.addAccount();
    await waitFor('folders listed', () => h.engine.ctx.folders.rowsForAccount(acc.id).length >= 7);
    const created = (await h.engine.handle('folders.create', {
      accountId: acc.id,
      parentPath: null,
      name: 'Work',
    })) as { id: number };
    const renamed = (await h.engine.handle('folders.rename', {
      folderId: created.id,
      newName: 'Office',
    })) as { id: number; path: string };
    expect(renamed.path).toBe('Office');
    expect(renamed.id).toBe(created.id);
    expect(server.raw.getMailbox('Office')).toBeDefined();
    expect(server.raw.getMailbox('Work')).toBeUndefined();
    expect(h.engine.ctx.folders.rowByPath(acc.id, 'Work')).toBeNull();
  });

  it('deletes a folder on the server and locally', async () => {
    const acc = await h.addAccount();
    await waitFor('folders listed', () => h.engine.ctx.folders.rowsForAccount(acc.id).length >= 7);
    const created = (await h.engine.handle('folders.create', {
      accountId: acc.id,
      parentPath: null,
      name: 'Temp',
    })) as { id: number };
    await h.engine.handle('folders.delete', { folderId: created.id });
    expect(server.raw.getMailbox('Temp')).toBeUndefined();
    expect(h.engine.ctx.folders.rowByPath(acc.id, 'Temp')).toBeNull();
  });

  it('refuses to rename or delete special folders', async () => {
    const acc = await h.addAccount();
    await waitFor('folders listed', () => h.engine.ctx.folders.rowsForAccount(acc.id).length >= 7);
    const sent = h.folderByRole(acc.id, 'sent');
    await expect(
      h.engine.handle('folders.rename', { folderId: sent.id, newName: 'X' }),
    ).rejects.toMatchObject({ appError: { code: 'INVALID_INPUT' } });
    await expect(h.engine.handle('folders.delete', { folderId: sent.id })).rejects.toMatchObject({
      appError: { code: 'INVALID_INPUT' },
    });
  });
});
