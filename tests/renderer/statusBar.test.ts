// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { Account, AccountStatus, Folder, OutboxItem } from '../../src/shared/ipc';
import { leftModel, middleText, nextOutboxReveal, outboxVisible, rightItems, tierOf, type LeftInput, type MiddleInput } from '../../src/renderer/src/lib/statusBar';

const NOW = new Date(2026, 9, 9, 10, 42, 30).getTime();

function account(id: string, name: string, enabled = true): Account {
  return { id, displayName: name, email: `${id}@x.example`, enabled } as Account;
}
function status(id: string, patch: Partial<AccountStatus> = {}): AccountStatus {
  return { accountId: id, state: 'online', lastSyncAt: NOW - 120_000, error: null, nextRetryAt: null, pendingCount: 0, ...patch };
}
function left(over: Partial<LeftInput> & { st?: AccountStatus[]; accts?: Account[] } = {}) {
  const accts = over.accts ?? [account('a', 'Alter'), account('b', 'Old Hotmail')];
  const st = over.st ?? accts.map((a) => status(a.id));
  return leftModel({
    accounts: accts,
    statuses: Object.fromEntries(st.map((s) => [s.accountId, s])),
    authRequired: {},
    online: true,
    progress: {},
    now: NOW,
    ...over,
  });
}

describe('tierOf', () => {
  it('follows the spec breakpoints', () => {
    expect([1440, 1100, 1099, 900, 899, 700, 699, 560, 559, 480].map(tierOf)).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 4, 4]);
  });
});

describe('leftModel', () => {
  it('up to date, several accounts: time of the last check', () => {
    const m = left({ st: [status('a', { lastSyncAt: NOW - 120_000 }), status('b', { lastSyncAt: NOW - 30_000 })] });
    expect(m.kind).toBe('idle');
    expect(m.text).toBe('All accounts up to date');
    expect(m.checked).toBe('checked just now');
    expect(m.announce).toBe('All accounts up to date');
  });
  it('up to date, one account names it', () => {
    const a = account('a', 'Alter');
    expect(left({ accts: [a], st: [status('a')] }).text).toBe('Alter is up to date');
  });
  it('ignores turned-off accounts', () => {
    const m = left({ accts: [account('a', 'Alter'), account('b', 'Off', false)], st: [status('a'), status('b', { state: 'disabled' })] });
    expect(m.text).toBe('Alter is up to date');
  });
  it('syncing with a known total shows the numbers quietly', () => {
    const a = account('a', 'Alter');
    const m = left({
      accts: [a],
      st: [status('a', { state: 'syncing' })],
      progress: { a: { folderId: 1, phase: 'initial', done: 120, total: 500 } },
    });
    expect(m.text).toBe('Syncing Alter...');
    expect(m.progress).toBe('120 of 500');
    expect(m.announce).toBe('Syncing Alter');
  });
  it('syncing with no total, and several accounts', () => {
    expect(left({ accts: [account('a', 'Alter')], st: [status('a', { state: 'syncing' })] }).progress).toBeNull();
    const m = left({ st: [status('a', { state: 'syncing' }), status('b', { state: 'connecting' })] });
    expect(m.text).toBe('Syncing 2 accounts...');
  });
  it('sign-in beats everything and names one account', () => {
    const m = left({ st: [status('a', { state: 'syncing' }), status('b', { state: 'needs_reauth' })] });
    expect(m.kind).toBe('auth');
    expect(m.text).toBe('Old Hotmail needs you to sign in again');
    expect(m.reauthAccountId).toBe('b');
    expect(m.tone).toBe('danger');
  });
  it('several accounts that need sign-in open the popover (no direct sign-in)', () => {
    const m = left({ st: [status('a', { state: 'needs_reauth' }), status('b', { state: 'auth_failed' })] });
    expect(m.text).toBe('2 accounts need you to sign in');
    expect(m.reauthAccountId).toBeNull();
  });
  it('error: names the account and the retry time', () => {
    const m = left({ st: [status('a'), status('b', { state: 'retrying', nextRetryAt: NOW + 60_000 })] });
    expect(m.text).toBe("Can't connect to Old Hotmail. Retrying in 1 min");
    expect(m.tone).toBe('warn');
    expect(m.announce).toBe("Can't connect to Old Hotmail");
  });
  it('offline adds the waiting changes of all accounts', () => {
    const m = left({ online: false, st: [status('a', { pendingCount: 2 }), status('b', { pendingCount: 1 })] });
    expect(m.kind).toBe('offline');
    expect(m.text).toBe('Offline. 3 changes waiting to sync');
    expect(left({ online: false }).text).toBe('Offline. Showing saved mail');
  });
  it('changes waiting (online)', () => {
    expect(left({ st: [status('a', { pendingCount: 1 }), status('b')] }).text).toBe('1 change waiting to sync');
  });
  it('priority: error beats offline beats syncing', () => {
    expect(left({ st: [status('a', { state: 'syncing' }), status('b', { state: 'offline' })] }).kind).toBe('offline');
    expect(left({ st: [status('a', { state: 'offline' }), status('b', { state: 'retrying' })] }).kind).toBe('error');
  });
  it('short words for narrow windows', () => {
    expect(left().short).toBe('Up to date');
    expect(left({ online: false }).short).toBe('Offline');
    expect(left({ st: [status('a', { state: 'needs_reauth' }), status('b')] }).short).toBe('Sign in needed');
  });
});

function folder(id: number, role: Folder['role'], name = 'X', total = 0, unread = 0, accountId = 'a'): Folder {
  return { id, accountId, path: name, name, role, delimiter: '/', unreadCount: unread, totalCount: total, selectable: true };
}
function middle(over: Partial<MiddleInput> = {}): string {
  return middleText({
    page: 'mail',
    view: { kind: 'all' },
    accounts: [account('a', 'Alter')],
    folders: [folder(1, 'inbox', 'INBOX', 1204, 36), folder(2, 'trash', 'Trash', 12), folder(3, null, 'Projects', 1, 0)],
    counts: { unifiedInboxUnread: 36, perFolder: [] },
    outboxCount: 0,
    list: { scopeKind: 'unifiedInbox', isSearch: false, loading: false, total: null, itemCount: 50, selectedCount: 0 },
    ...over,
  });
}

describe('middleText', () => {
  it('folders and unified views', () => {
    expect(middle()).toBe(`All inboxes · ${(1204).toLocaleString()} messages, 36 unread`);
    expect(middle({ view: { kind: 'unread' } })).toBe('Unread · 36 messages');
    expect(middle({ view: { kind: 'folder', folderId: 1 } })).toBe(`Inbox · ${(1204).toLocaleString()} messages, 36 unread`);
    expect(middle({ view: { kind: 'folder', folderId: 2 } })).toBe('Trash · 12 messages');
    expect(middle({ view: { kind: 'folder', folderId: 3 } })).toBe('Projects · 1 message');
  });
  it('flagged uses the loaded list', () => {
    expect(middle({ view: { kind: 'flagged' }, list: { scopeKind: 'unifiedFlagged', isSearch: false, loading: false, total: 8, itemCount: 8, selectedCount: 0 } })).toBe('Flagged · 8 messages');
  });
  it('selection replaces the text; select all says All', () => {
    const l = { scopeKind: 'unifiedInbox', isSearch: false, loading: false, total: 248, itemCount: 248, selectedCount: 12 };
    expect(middle({ list: l })).toBe('12 selected');
    expect(middle({ list: { ...l, selectedCount: 248 } })).toBe('All 248 selected');
    expect(middle({ list: { ...l, selectedCount: 1 } })).toContain('All inboxes');
  });
  it('search', () => {
    const s = { scopeKind: null, isSearch: true, loading: false, total: 34, itemCount: 34, selectedCount: 0 };
    const v = { kind: 'search', query: 'x', accountId: null } as const;
    expect(middle({ view: v, list: s })).toBe('Search: 34 results');
    expect(middle({ view: v, list: { ...s, loading: true } })).toBe('Searching...');
    expect(middle({ view: v, list: { ...s, total: 0, itemCount: 0 } })).toBe('Search: no results');
  });
  it('settings page is empty', () => {
    expect(middle({ page: 'settings' })).toBe('');
  });
});

function item(over: Partial<OutboxItem>): OutboxItem {
  return { id: 1, accountId: 'a', subject: 's', state: 'queued', lastError: null, sendAt: NOW - 1000, attempts: 0, ...over };
}

describe('right side', () => {
  it('hides mail that is still in the undo wait', () => {
    const waiting = item({ sendAt: NOW + 4000 });
    expect(outboxVisible([waiting], NOW)).toEqual([]);
    expect(nextOutboxReveal([waiting], NOW)).toBe(4000);
    expect(outboxVisible([item({ sendAt: NOW + 4000, attempts: 1 })], NOW)).toHaveLength(1);
    expect(rightItems(null, [waiting], NOW)).toEqual([]);
  });
  it('outbox: failed beats sending beats queued', () => {
    const all = [item({ id: 1 }), item({ id: 2, state: 'sending' }), item({ id: 3, state: 'failed' })];
    expect(rightItems(null, all, NOW)[0]!.text).toBe("1 message couldn't be sent");
    expect(rightItems(null, all.slice(0, 2), NOW)[0]!.text).toBe('Sending 1 message...');
    expect(rightItems(null, [item({}), item({ id: 2 })], NOW)[0]!.text).toBe('2 messages waiting in Outbox');
  });
  it('update ready, then outbox; two items at most', () => {
    const r = rightItems({ state: 'ready', currentVersion: '0.2.7', newVersion: '0.2.8' }, [item({ state: 'sending' })], NOW);
    expect(r.map((x) => x.id)).toEqual(['ready', 'outbox']);
    expect(r[0]!.text).toBe('Letterdock 0.2.8 ready');
    expect(r[0]).toMatchObject({ tip: 'You have version 0.2.7' });
  });
  it('download shows the percent but never announces it', () => {
    const r = rightItems({ state: 'downloading', currentVersion: '0.2.7', newVersion: '0.2.8', percent: 41.6 }, [], NOW);
    expect(r[0]!.text).toBe('Downloading update 42%');
    expect(r[0]!.announce).not.toMatch(/\d/);
  });
  it('update errors and checks are not shown', () => {
    expect(rightItems({ state: 'error', currentVersion: '1', error: { code: 'INTERNAL', message: 'm', retryable: true } }, [], NOW)).toEqual([]);
    expect(rightItems({ state: 'checking', currentVersion: '1' }, [], NOW)).toEqual([]);
  });
});
