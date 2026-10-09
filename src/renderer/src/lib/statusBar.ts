// Text and priorities for the bottom status bar (DESIGN-SPEC 4.8). Pure functions: the component
// only draws what these return, so the wording and the rules can be tested without a screen.
import type { Account, AccountId, AccountStatus, Folder, FolderCounts, OutboxItem, UpdateStatus } from '../../../shared/ipc';
import { syncKindOf, type SyncKind } from '../components/Sync';
import { totalOfFolder, unreadOfFolder, type SyncProgress } from '../store/app';
import type { View } from '../store/ui';

// ---------- width tiers ----------
/** 0 = full, 1 = below 1100, 2 = below 900, 3 = below 700, 4 = below 560. */
export type Tier = 0 | 1 | 2 | 3 | 4;
export function tierOf(width: number): Tier {
  if (width >= 1100) return 0;
  if (width >= 900) return 1;
  if (width >= 700) return 2;
  if (width >= 560) return 3;
  return 4;
}

// ---------- small helpers ----------
const num = (n: number) => n.toLocaleString();
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** "checked 10:42" or "checked just now" (time format follows the system locale). */
export function checkedText(ms: number | null, now = Date.now()): string | null {
  if (!ms) return null;
  if (now - ms < 60_000) return 'checked just now';
  return `checked ${new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
}

function retryWhen(nextRetryAt: number | null, now: number): string {
  if (!nextRetryAt) return 'soon';
  const secs = Math.max(0, Math.round((nextRetryAt - now) / 1000));
  if (secs < 60) return secs <= 5 ? 'a moment' : `${secs} sec`;
  return `${Math.round(secs / 60)} min`;
}

// ---------- LEFT: connection and sync ----------
const PRIORITY: SyncKind[] = ['auth', 'error', 'offline', 'syncing', 'pending', 'idle'];

export interface LeftInput {
  accounts: Account[];
  statuses: Record<AccountId, AccountStatus>;
  authRequired: Record<AccountId, 'password' | 'oauth'>;
  online: boolean;
  progress: Record<AccountId, SyncProgress>;
  now: number;
}
export interface LeftModel {
  kind: SyncKind;
  /** Main phrase, for example "Syncing Alter...". */
  text: string;
  /** Quiet extra part: "120 of 500". Hidden below 1100. */
  progress: string | null;
  /** Quiet extra part: "checked 10:42". Hidden below 1100. */
  checked: string | null;
  /** Very short word for windows narrower than 560. */
  short: string;
  /** What a screen reader hears: no numbers or times that change all the time. */
  announce: string;
  /** Click: one account that needs sign-in starts that sign-in, else the sync popover. */
  reauthAccountId: AccountId | null;
  /** The phrase gets a state color: danger (sign-in) or warning (connection error). */
  tone: 'normal' | 'danger' | 'warn';
}

export function leftModel(i: LeftInput): LeftModel {
  const live = i.accounts.filter((a) => a.enabled);
  const kinds = live.map((a) => ({ a, kind: syncKindOf(i.statuses[a.id], !!i.authRequired[a.id], i.online) }));
  const kind = PRIORITY.find((k) => kinds.some((x) => x.kind === k)) ?? 'idle';
  const group = kinds.filter((x) => x.kind === kind);
  const first = group[0]?.a;
  const n = group.length;
  const name = first?.displayName ?? '';
  const waiting = live.reduce((sum, a) => sum + (i.statuses[a.id]?.pendingCount ?? 0), 0);
  const base = { progress: null, checked: null, reauthAccountId: null, tone: 'normal' as const };

  switch (kind) {
    case 'auth':
      return {
        ...base,
        kind,
        text: n === 1 ? `${name} needs you to sign in again` : `${n} accounts need you to sign in`,
        short: 'Sign in needed',
        announce: n === 1 ? `${name} needs you to sign in again` : `${n} accounts need you to sign in`,
        reauthAccountId: n === 1 && first ? first.id : null,
        tone: 'danger',
      };
    case 'error': {
      const st = first ? i.statuses[first.id] : undefined;
      return {
        ...base,
        kind,
        text: n === 1 ? `Can't connect to ${name}. Retrying in ${retryWhen(st?.nextRetryAt ?? null, i.now)}` : `${n} accounts can't connect`,
        short: "Can't connect",
        announce: n === 1 ? `Can't connect to ${name}` : `${n} accounts can't connect`,
        tone: 'warn',
      };
    }
    case 'offline':
      return {
        ...base,
        kind,
        text: waiting > 0 ? `Offline. ${waiting} ${plural(waiting, 'change', 'changes')} waiting to sync` : 'Offline. Showing saved mail',
        short: 'Offline',
        announce: 'Offline',
        reauthAccountId: null,
      };
    case 'syncing': {
      const p = n === 1 && first ? i.progress[first.id] : undefined;
      const known = p && p.phase !== 'idle' && p.total !== null && p.total > 0 ? `${num(Math.min(p.done, p.total))} of ${num(p.total)}` : null;
      const text = n === 1 ? `Syncing ${name}...` : `Syncing ${n} accounts...`;
      return { ...base, kind, text, progress: known, short: 'Syncing...', announce: text.replace(/\.\.\.$/, '') };
    }
    case 'pending':
      return {
        ...base,
        kind,
        text: `${waiting} ${plural(waiting, 'change', 'changes')} waiting to sync`,
        short: 'Changes waiting',
        announce: 'Changes waiting to sync',
      };
    default: {
      const last = live.reduce<number | null>((m, a) => {
        const t = i.statuses[a.id]?.lastSyncAt ?? null;
        return t && (m === null || t > m) ? t : m;
      }, null);
      const text = live.length === 1 ? `${live[0]!.displayName} is up to date` : 'All accounts up to date';
      return { ...base, kind: 'idle', text, checked: checkedText(last, i.now), short: 'Up to date', announce: text };
    }
  }
}

// ---------- MIDDLE: what the user is looking at ----------
export interface MiddleInput {
  page: 'mail' | 'settings';
  view: View;
  accounts: Account[];
  folders: Folder[];
  counts: FolderCounts | null;
  outboxCount: number;
  list: {
    scopeKind: string | null;
    isSearch: boolean;
    loading: boolean;
    total: number | null;
    itemCount: number;
    selectedCount: number;
    /** The list shows conversations (DESIGN-SPEC 3.10): the middle text counts conversations. */
    grouped?: boolean;
  };
}

const FOLDER_NAMES: Record<string, string> = {
  inbox: 'Inbox',
  drafts: 'Drafts',
  sent: 'Sent',
  archive: 'Archive',
  all: 'All Mail',
  junk: 'Spam',
  trash: 'Trash',
};
const TOTAL_ONLY = new Set(['drafts', 'trash', 'junk', 'sent']);

function messages(n: number): string {
  return `${num(n)} ${plural(n, 'message', 'messages')}`;
}

export function middleText(i: MiddleInput): string {
  if (i.page === 'settings') return '';
  const { view, list } = i;
  if (view.kind === 'outbox') return i.outboxCount > 0 ? `Outbox · ${messages(i.outboxCount)}` : 'Outbox';

  const shown = list.total ?? list.itemCount;
  if (list.isSearch || view.kind === 'search') {
    if (list.loading) return 'Searching...';
    return shown === 0 ? 'Search: no results' : `Search: ${num(shown)} ${plural(shown, 'result', 'results')}`;
  }
  if (list.selectedCount >= 2) {
    return list.selectedCount >= list.itemCount && list.itemCount === shown
      ? `All ${num(list.selectedCount)} selected`
      : `${num(list.selectedCount)} selected`;
  }

  const enabled = new Set(i.accounts.filter((a) => a.enabled).map((a) => a.id));
  if (list.grouped && (view.kind === 'all' || view.kind === 'unread' || view.kind === 'flagged' || view.kind === 'account' || view.kind === 'folder')) {
    // With conversations on, the sidebar counts stay in messages, so the bar counts only conversations.
    if (list.loading && list.itemCount === 0) return '';
    const n = shown;
    const conv = `${num(n)} ${plural(n, 'conversation', 'conversations')}`;
    switch (view.kind) {
      case 'all':
        return `All inboxes · ${conv}`;
      case 'unread':
        return `Unread · ${conv}`;
      case 'flagged':
        return `Flagged · ${conv}`;
      case 'account': {
        const a = i.accounts.find((x) => x.id === view.accountId);
        return a ? `${a.displayName} · ${conv}` : '';
      }
      case 'folder': {
        const f = i.folders.find((x) => x.id === view.folderId);
        return f ? `${(f.role && FOLDER_NAMES[f.role]) || f.name} · ${conv}` : '';
      }
    }
  }
  const withUnread = (name: string, total: number, unread: number) =>
    `${name} · ${messages(total)}${unread > 0 ? `, ${num(unread)} unread` : ''}`;

  switch (view.kind) {
    case 'all': {
      const total = i.folders.filter((f) => f.role === 'inbox' && enabled.has(f.accountId)).reduce((s, f) => s + totalOfFolder(i.counts, f), 0);
      return withUnread('All inboxes', total, i.counts?.unifiedInboxUnread ?? 0);
    }
    case 'unread':
      return `Unread · ${messages(i.counts?.unifiedInboxUnread ?? 0)}`;
    case 'flagged':
      return list.scopeKind === 'unifiedFlagged' && !list.loading ? `Flagged · ${messages(shown)}` : '';
    case 'account': {
      const inbox = i.folders.find((f) => f.accountId === view.accountId && f.role === 'inbox');
      const a = i.accounts.find((x) => x.id === view.accountId);
      return inbox && a ? withUnread(a.displayName, totalOfFolder(i.counts, inbox), unreadOfFolder(i.counts, inbox)) : '';
    }
    case 'folder': {
      const f = i.folders.find((x) => x.id === view.folderId);
      if (!f) return '';
      const name = (f.role && FOLDER_NAMES[f.role]) || f.name;
      const total = totalOfFolder(i.counts, f);
      return f.role && TOTAL_ONLY.has(f.role) ? `${name} · ${messages(total)}` : withUnread(name, total, unreadOfFolder(i.counts, f));
    }
    default:
      return '';
  }
}

// ---------- RIGHT: updates and Outbox ----------
export type RightItem =
  | { id: 'ready'; text: string; version: string; tip: string; announce: string }
  | { id: 'downloading'; text: string; percent: number; tip: string; announce: string }
  | { id: 'outbox'; state: 'failed' | 'sending' | 'queued'; text: string; announce: string };

/** Mail still inside the "Undo send" wait is not shown (DESIGN-SPEC 4.8). */
export function outboxVisible(items: OutboxItem[], now: number): OutboxItem[] {
  return items.filter((it) => !(it.state === 'queued' && it.attempts === 0 && it.sendAt > now));
}

/** Time until the first hidden item becomes visible, or null. */
export function nextOutboxReveal(items: OutboxItem[], now: number): number | null {
  const waits = items.filter((it) => it.state === 'queued' && it.attempts === 0 && it.sendAt > now).map((it) => it.sendAt - now);
  return waits.length ? Math.min(...waits) : null;
}

export function rightItems(update: UpdateStatus | null, outbox: OutboxItem[], now: number): RightItem[] {
  const out: RightItem[] = [];
  if (update?.state === 'ready') {
    out.push({
      id: 'ready',
      text: `Letterdock ${update.newVersion} ready`,
      version: update.newVersion,
      tip: `You have version ${update.currentVersion}`,
      announce: `Update ready: Letterdock ${update.newVersion}`,
    });
  } else if (update?.state === 'downloading') {
    out.push({
      id: 'downloading',
      text: `Downloading update ${Math.round(update.percent)}%`,
      percent: Math.round(update.percent),
      tip: `You have version ${update.currentVersion}`,
      announce: 'Downloading an update',
    });
  }
  const items = outboxVisible(outbox, now);
  const failed = items.filter((x) => x.state === 'failed').length;
  const sending = items.filter((x) => x.state === 'sending').length;
  const queued = items.filter((x) => x.state === 'queued').length;
  if (failed > 0) {
    out.push({ id: 'outbox', state: 'failed', text: `${failed} ${plural(failed, 'message', 'messages')} couldn't be sent`, announce: `${failed} ${plural(failed, 'message', 'messages')} couldn't be sent` });
  } else if (sending > 0) {
    out.push({ id: 'outbox', state: 'sending', text: `Sending ${sending} ${plural(sending, 'message', 'messages')}...`, announce: `Sending ${sending} ${plural(sending, 'message', 'messages')}` });
  } else if (queued > 0) {
    out.push({ id: 'outbox', state: 'queued', text: `${queued} ${plural(queued, 'message', 'messages')} waiting in Outbox`, announce: `${queued} ${plural(queued, 'message', 'messages')} waiting in Outbox` });
  }
  return out.slice(0, 2);
}
