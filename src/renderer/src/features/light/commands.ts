// The command table of the command box (DESIGN-SPEC 3.13.5). Built from the stores already in memory when
// the box opens: no database query, no network. This file loads with the box (dynamic import).
import type { Account, Folder, MessageHeader } from '../../../../shared/ipc';
import type { IconName } from '../../components/Icon';
import { useApp, accountInbox } from '../../store/app';
import { useList, type ListItem } from '../../store/list';
import { useUi, type SettingsSection, type View } from '../../store/ui';
import { useThemeState } from '../../lib/hooks';
import { call } from '../../lib/api';
import {
  applyToMessages,
  composeFrom,
  currentAccountId,
  deleteMessages,
  deleteMessagesPermanently,
  newMessage,
  openInWindow,
  roleOf,
} from '../../lib/actions';
import {
  allMuted,
  allPinned,
  canMute,
  canSnoozeRole,
  openSnoozeMenu,
  setMuted,
  setPinned,
  snoozeAnchor,
  unsnoozeMessages,
} from '../../lib/light';
import { canPinHere } from '../../lib/pinRules';
import { printOpenMessage } from '../../lib/print';
import { toast } from '../../store/toasts';
import { canMakeRuleFrom, createRuleFromSender } from '../rules/ruleActions';
import { syncAll } from '../shell/SyncPopover';
import { toggleSidebar } from '../sidebar/SidebarToggle';

export interface Command {
  /** Stable key, also what "Recent" stores. */
  id: string;
  label: string;
  icon: IconName;
  /** Shortcut or other small text on the right. */
  hint?: string;
  /** Account whose letter badge shows on the right (folders). */
  account?: Account;
  run: () => void;
}

const SETTINGS_PAGES: [SettingsSection, string, string][] = [
  ['accounts', 'Accounts', ''],
  ['general', 'General', ''],
  ['appearance', 'Appearance', ''],
  ['mail', 'Mail', ''],
  ['rules', 'Rules', ''],
  ['notifications', 'Notifications', ''],
  ['keys', 'Advanced (sign-in keys)', ''],
  ['shortcuts', 'Shortcuts', ''],
  ['about', 'About', ''],
];

const ROLE_ICON: Record<string, IconName> = {
  inbox: 'inbox',
  drafts: 'draft',
  sent: 'send',
  archive: 'archive',
  trash: 'trash',
  junk: 'spam',
  all: 'stack',
  flagged: 'flag',
};

/** "Work / Projects / 2026" from a folder path. */
export function folderPathLabel(f: Folder): string {
  if (f.role === 'inbox') return 'Inbox';
  const parts = f.delimiter ? f.path.split(f.delimiter) : [f.path];
  return parts.join(' / ');
}

function focusList(): void {
  const el = document.querySelector<HTMLElement>('#pane-list [role=listbox]') ?? document.querySelector<HTMLElement>('#pane-list');
  el?.focus();
}

function go(view: View): () => void {
  return () => {
    useUi.getState().setView(view);
    setTimeout(focusList, 60);
  };
}

/** The list rows the message commands act on: the selection, in a mail view. */
function selection(): ListItem[] {
  const ui = useUi.getState();
  if (ui.page !== 'mail' || ui.view.kind === 'outbox' || ui.view.kind === 'scheduled') return [];
  const list = useList.getState();
  const ids = new Set(list.selectedIds);
  return list.items.filter((m) => ids.has(m.id));
}

function messageCommands(): Command[] {
  const rows = selection();
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const one = rows.length === 1 ? rows[0]! : null;
  const ui = useUi.getState();
  const out: Command[] = [];
  const add = (c: Command) => out.push(c);
  const drafts = rows.some((r) => r.draft || roleOf(r) === 'drafts');
  const sameAccount = new Set(rows.map((r) => r.accountId)).size === 1;

  if (ui.view.kind === 'snoozed') {
    add({ id: 'unsnooze', label: 'Unsnooze now', icon: 'alarm', run: () => void unsnoozeMessages(ids) });
  }
  if (one && !drafts) {
    add({ id: 'reply', label: 'Reply', icon: 'reply', hint: 'Ctrl+R', run: () => composeFrom('reply', one.id) });
    add({ id: 'replyAll', label: 'Reply all', icon: 'replyall', hint: 'Ctrl+Shift+R', run: () => composeFrom('replyAll', one.id) });
    add({ id: 'forward', label: 'Forward', icon: 'fwd', hint: 'Ctrl+F', run: () => composeFrom('forward', one.id) });
  }
  if (!drafts && rows.every((r) => roleOf(r) !== 'archive')) {
    add({ id: 'archive', label: 'Archive', icon: 'archive', hint: 'E', run: () => void applyToMessages(ids, { type: 'archive' }) });
  }
  add({ id: 'delete', label: 'Delete', icon: 'trash', hint: 'Delete', run: () => deleteMessages(ids) });
  add({ id: 'deletePermanent', label: 'Delete permanently...', icon: 'trash', hint: 'Shift+Delete', run: () => deleteMessagesPermanently(ids) });
  if (sameAccount) add({ id: 'move', label: 'Move to...', icon: 'folder', hint: 'Ctrl+Shift+M', run: () => useUi.getState().set({ moveDialog: ids }) });
  if (rows.some((r) => !r.seen)) {
    add({ id: 'markRead', label: 'Mark as read', icon: 'mail-open', hint: 'Ctrl+Q', run: () => void applyToMessages(ids, { type: 'markRead', read: true }) });
  }
  if (rows.some((r) => r.seen)) {
    add({ id: 'markUnread', label: 'Mark as unread', icon: 'unread', hint: 'Ctrl+U', run: () => void applyToMessages(ids, { type: 'markRead', read: false }) });
  }
  const flagged = rows.every((r) => r.flagged);
  add({ id: 'flag', label: flagged ? 'Unflag' : 'Flag', icon: 'flag', hint: 'Insert', run: () => void applyToMessages(ids, { type: 'flag', flagged: !flagged }) });
  if (!drafts && canPinHere(ui.view, ui.unreadOnly)) {
    const pinned = allPinned(ids);
    add({ id: 'pin', label: pinned ? 'Unpin' : 'Pin to top', icon: 'pin', hint: 'Alt+P', run: () => void setPinned(ids, !pinned) });
  }
  if (!drafts && rows.every((r) => roleOf(r) !== 'sent') && (rows.every((r) => canMute(r)) || allMuted(ids))) {
    const muted = allMuted(ids);
    add({ id: 'mute', label: muted ? 'Unmute conversation' : 'Mute conversation', icon: 'bell-off', hint: 'Alt+M', run: () => void setMuted(ids, !muted) });
  }
  if (!drafts && (ui.view.kind === 'snoozed' || rows.every((r) => canSnoozeRole(roleOf(r))))) {
    add({
      id: 'snooze',
      label: 'Snooze...',
      icon: 'alarm',
      hint: 'H',
      run: () => {
        const a = snoozeAnchor();
        openSnoozeMenu(ids, a.x, a.y, ui.view.kind === 'snoozed');
      },
    });
  }
  if (one && !drafts) {
    add({
      id: 'unsubscribe',
      label: 'Unsubscribe',
      icon: 'bell-off',
      run: () => {
        const h: MessageHeader = one;
        void call('unsubscribe.info', { messageId: h.id })
          .then((info) => {
            if (!info.available) {
              toast("That isn't available now.");
              return;
            }
            return import('./unsubscribeFlow').then((m) => m.beginUnsubscribe({ header: h, info, onBusy: () => undefined, onDone: () => undefined }));
          })
          .catch(() => toast("That isn't available now."));
      },
    });
    add({ id: 'openWindow', label: 'Open in new window', icon: 'open-window', hint: 'Enter', run: () => openInWindow(one) });
    add({ id: 'print', label: 'Print', icon: 'print', hint: 'Ctrl+P', run: () => printOpenMessage(one.id) });
    if (canMakeRuleFrom(one) && one.from) {
      add({ id: 'rule', label: 'Create rule from this sender...', icon: 'rules', run: () => createRuleFromSender(one.accountId, one.from) });
    }
  }
  return out;
}

function goCommands(): Command[] {
  const app = useApp.getState();
  const out: Command[] = [];
  const accounts = app.accounts;
  const cur = accounts.find((a) => a.id === currentAccountId()) ?? accounts[0];
  const role = (r: Folder['role'], label: string) => {
    const f = cur ? app.folders.find((x) => x.accountId === cur.id && x.role === r) : undefined;
    if (f) {
      out.push({ id: `go:${r}`, label: `Go to ${label}`, icon: ROLE_ICON[r ?? ''] ?? 'folder', ...(accounts.length > 1 && cur ? { account: cur } : {}), run: go({ kind: 'folder', folderId: f.id }) });
    }
  };
  out.push({ id: 'go:all', label: 'Go to All inboxes', icon: 'stack', run: go({ kind: 'all' }) });
  role('inbox', 'Inbox');
  role('drafts', 'Drafts');
  role('sent', 'Sent');
  role('archive', 'Archive');
  role('trash', 'Trash');
  role('junk', 'Spam');
  out.push({ id: 'go:outbox', label: 'Go to Outbox', icon: 'send', run: go({ kind: 'outbox' }) });
  out.push({ id: 'go:scheduled', label: 'Go to Scheduled', icon: 'clock', run: go({ kind: 'scheduled', accountId: cur && accounts.length === 1 ? cur.id : null }) });
  out.push({ id: 'go:snoozed', label: 'Go to Snoozed (all accounts)', icon: 'alarm', run: go({ kind: 'snoozed', accountId: null }) });
  out.push({ id: 'go:flagged', label: 'Go to Flagged', icon: 'flag', run: go({ kind: 'flagged' }) });
  out.push({ id: 'go:unread', label: 'Go to Unread', icon: 'unread', run: go({ kind: 'unread' }) });
  return out;
}

function folderCommands(): Command[] {
  const { accounts, folders } = useApp.getState();
  const out: Command[] = [];
  for (const a of accounts) {
    const inbox = accountInbox(folders, a.id);
    out.push({
      id: `go:acct:${a.id}`,
      label: `Go to ${a.displayName} Inbox`,
      icon: 'inbox',
      account: a,
      run: go(inbox ? { kind: 'folder', folderId: inbox.id } : { kind: 'account', accountId: a.id }),
    });
    for (const f of folders.filter((x) => x.accountId === a.id && x.selectable)) {
      out.push({
        id: `go:folder:${f.id}`,
        label: `Go to ${a.displayName} / ${folderPathLabel(f)}`,
        icon: f.role ? (ROLE_ICON[f.role] ?? 'folder') : 'folder',
        account: a,
        run: go({ kind: 'folder', folderId: f.id }),
      });
    }
  }
  return out;
}

/** Every command that is possible right now, in the fixed order used to break ties. */
export function buildCommands(): Command[] {
  const ui = useUi.getState();
  const app = useApp.getState();
  const dark = useThemeState.getState().dark;
  const syncing = Object.values(app.progress).some((p) => p.phase !== 'idle');
  const out: Command[] = [];
  if (app.accounts.length > 0) {
    out.push({ id: 'new', label: 'New message', icon: 'edit', hint: 'Ctrl+N', run: newMessage });
    out.push(...messageCommands());
    out.push({ id: 'check', label: syncing ? 'Checking...' : 'Check mail', icon: 'sync', hint: 'F9', run: syncAll });
  }
  out.push({
    id: 'darkMode',
    label: dark ? 'Switch to light mode' : 'Switch to dark mode',
    icon: dark ? 'sun' : 'moon',
    run: () => void useApp.getState().updateSettings({ theme: dark ? 'light' : 'dark' }),
  });
  if (app.settings?.theme && app.settings.theme !== 'system') {
    out.push({ id: 'systemTheme', label: 'Use system theme', icon: 'gear', run: () => void useApp.getState().updateSettings({ theme: 'system' }) });
  }
  const sidebarShown = ui.mode === 'wide' ? !ui.sidebarCollapsed : ui.drawerOpen;
  out.push({ id: 'sidebar', label: sidebarShown ? 'Hide sidebar' : 'Show sidebar', icon: 'panel-left-close', hint: 'Ctrl+B', run: toggleSidebar });
  out.push({
    id: 'statusBar',
    label: ui.showStatusBar ? 'Hide status bar' : 'Show status bar',
    icon: 'list',
    run: () => useUi.getState().set({ showStatusBar: !ui.showStatusBar }),
  });
  out.push({ id: 'settings', label: 'Open Settings', icon: 'gear', hint: 'Ctrl+,', run: () => useUi.getState().openSettings() });
  for (const [id, name] of SETTINGS_PAGES) {
    out.push({ id: `settings:${id}`, label: `Open Settings > ${name}`, icon: 'gear', run: () => useUi.getState().openSettings(id, null) });
  }
  out.push({ id: 'addAccount', label: 'Add account', icon: 'plus', hint: 'Ctrl+Shift+A', run: () => useUi.getState().set({ addAccount: {} }) });
  out.push({ id: 'cheatsheet', label: 'Show keyboard shortcuts', icon: 'key', hint: 'Ctrl+/', run: () => useUi.getState().set({ cheatsheetOpen: true }) });
  if (app.accounts.length > 0) out.push(...goCommands(), ...folderCommands());
  return out;
}

/** Shown with an empty box, after "Recent" (DESIGN-SPEC 3.13.5). */
export const SUGGESTION_IDS = ['new', 'check', 'go:all', 'settings'] as const;
