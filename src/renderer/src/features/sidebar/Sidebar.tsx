import { useMemo, useRef, useState, type KeyboardEvent as RKE } from 'react';
import type { Account, Folder, FolderRole } from '../../../../shared/ipc';
import { Icon, type IconName } from '../../components/Icon';
import { AccountAvatar, Button, IconButton, openMenuAt, useMenu, type MenuEntry } from '../../components/ui';
import { SyncGlyph, syncText, useSyncKind } from '../../components/Sync';
import { accountInbox, totalOfFolder, unreadOfFolder, useApp } from '../../store/app';
import { useUi, type View } from '../../store/ui';
import { useAccountColor } from '../../lib/hooks';
import { badgeOf } from '../../lib/format';
import { call } from '../../lib/api';
import { reportActionError, toast } from '../../store/toasts';
import { markAllRead, moveMessages, newMessage } from '../../lib/actions';
import { getDrag } from '../../lib/dnd';
import { useOutbox } from '../../store/outbox';

const ROLE_ORDER: FolderRole[] = ['inbox', 'drafts', 'sent', 'archive', 'all', 'junk', 'trash'];
const ROLE_ICON: Record<FolderRole, IconName> = {
  inbox: 'inbox',
  drafts: 'draft',
  sent: 'send',
  archive: 'archive',
  all: 'archive',
  junk: 'spam',
  trash: 'trash',
  flagged: 'flag',
};

export function orderFolders(folders: Folder[]): { main: Folder[]; more: Folder[] } {
  const main: Folder[] = [];
  const seen = new Set<number>();
  for (const role of ROLE_ORDER) {
    const f = folders.find((x) => x.role === role && !seen.has(x.id));
    if (f) {
      main.push(f);
      seen.add(f.id);
    }
  }
  const more = folders
    .filter((f) => !seen.has(f.id))
    .sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: 'base' }));
  return { main, more };
}

function depthOf(f: Folder): number {
  if (!f.delimiter) return 0;
  return Math.max(0, f.path.split(f.delimiter).length - 1);
}

const TOTAL_ROLES: ReadonlyArray<FolderRole | null> = ['drafts', 'trash', 'junk'];

/** Drafts, Trash and Spam show how many messages they hold; every other folder shows unread. */
function folderCount(counts: ReturnType<typeof useApp.getState>['counts'], f: Folder): { n: number; total: boolean } {
  const total = TOTAL_ROLES.includes(f.role);
  return { n: total ? totalOfFolder(counts, f) : unreadOfFolder(counts, f), total };
}

function fmtCount(n: number): string {
  return n > 999 ? '999+' : String(n);
}

function countWord(f: Folder, total: boolean, n: number): string {
  if (!total) return 'unread';
  return f.role === 'drafts' ? (n === 1 ? 'draft' : 'drafts') : n === 1 ? 'message' : 'messages';
}

export function folderLabel(f: Folder): string {
  const names: Record<string, string> = {
    inbox: 'Inbox',
    drafts: 'Drafts',
    sent: 'Sent',
    archive: 'Archive',
    all: 'All Mail',
    junk: 'Spam',
    trash: 'Trash',
  };
  return (f.role && names[f.role]) || f.name;
}

import { SidebarToggle } from './SidebarToggle';

export function Sidebar({ variant }: { variant: 'full' | 'rail' | 'drawer' }) {
  const accounts = useApp((s) => s.accounts);
  const counts = useApp((s) => s.counts);
  const view = useUi((s) => s.view);
  const sidebarW = useUi((s) => s.sidebarW);
  const colorOf = useAccountColor();
  const [filter, setFilter] = useState('');

  const unifiedUnread = counts?.unifiedInboxUnread ?? 0;
  const visibleAccounts = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return f ? accounts.filter((a) => (a.displayName + a.email).toLowerCase().includes(f)) : accounts;
  }, [accounts, filter]);

  const go = (v: View) => useUi.getState().setView(v);

  const addAccount = () => useUi.getState().set({ addAccount: {}, drawerOpen: false });
  const openSettings = () => useUi.getState().openSettings('accounts', null);

  if (variant === 'rail') {
    return (
      <Rail
        accounts={accounts}
        unifiedUnread={unifiedUnread}
        colorOf={colorOf}
        addAccount={addAccount}
        openSettings={openSettings}
        go={go}
      />
    );
  }

  const onNavKey = (e: RKE<HTMLElement>) => {
    const t = e.target as HTMLElement;
    if (!t.matches('[data-nav]')) return;
    const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-nav]')];
    const i = items.indexOf(t);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      items[Math.min(items.length - 1, i + 1)]?.focus();
    } else if (e.key === 'ArrowUp' && !e.altKey) {
      e.preventDefault();
      items[Math.max(0, i - 1)]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      items[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      items[items.length - 1]?.focus();
    }
  };

  return (
    <nav
      className={`sidebar ${variant === 'drawer' ? 'drawer' : ''}`}
      style={variant === 'full' ? { width: sidebarW } : undefined}
      aria-label="Mail folders"
      onKeyDown={onNavKey}
    >
      <div className="sbhead">
        <SidebarToggle forceExpanded />
        <Button variant="primary" className="newmail" icon="edit" onClick={newMessage}>
          New mail
        </Button>
      </div>
      <div role="tree" aria-label="Mail folders" style={{ display: 'contents' }}>
        <div
          role="treeitem"
          aria-level={1}
          aria-selected={view.kind === 'all'}
          tabIndex={0}
          data-nav
          className={`srow top inset-focus ${view.kind === 'all' ? 'sel' : ''}`}
          aria-label={`All inboxes${unifiedUnread ? `, ${unifiedUnread} unread` : ''}`}
          onClick={() => go({ kind: 'all' })}
          onKeyDown={(e) => e.key === 'Enter' || e.key === ' ' ? (e.preventDefault(), go({ kind: 'all' })) : undefined}
        >
          <Icon name="stack" size={20} />
          <span className="nm">All inboxes</span>
          {unifiedUnread > 0 ? <span className="cnt">{unifiedUnread}</span> : null}
        </div>
        <div
          role="treeitem"
          aria-level={2}
          aria-selected={view.kind === 'unread'}
          tabIndex={0}
          data-nav
          className={`srow sub inset-focus ${view.kind === 'unread' ? 'sel' : ''}`}
          onClick={() => go({ kind: 'unread' })}
          onKeyDown={(e) => e.key === 'Enter' || e.key === ' ' ? (e.preventDefault(), go({ kind: 'unread' })) : undefined}
        >
          <Icon name="unread" />
          <span className="nm">Unread</span>
        </div>
        <div
          role="treeitem"
          aria-level={2}
          aria-selected={view.kind === 'flagged'}
          tabIndex={0}
          data-nav
          className={`srow sub inset-focus ${view.kind === 'flagged' ? 'sel' : ''}`}
          onClick={() => go({ kind: 'flagged' })}
          onKeyDown={(e) => e.key === 'Enter' || e.key === ' ' ? (e.preventDefault(), go({ kind: 'flagged' })) : undefined}
        >
          <Icon name="flag" />
          <span className="nm">Flagged</span>
        </div>
        <div className="sec">
          ACCOUNTS
          <IconButton icon="plus" label="Add account (Ctrl+Shift+A)" size="sm" onClick={addAccount} />
        </div>
        {accounts.length > 8 ? (
          <div style={{ padding: '0 0 6px' }}>
            <input
              className="inp"
              placeholder="Filter accounts"
              aria-label="Filter accounts"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>
        ) : null}
        <div className="scroll" style={{ flex: 1 }}>
          {accounts.length === 0 ? (
            <div className="acct-note" style={{ paddingLeft: 8 }}>
              No accounts yet.
            </div>
          ) : null}
          {visibleAccounts.map((a, idx) => (
            <AccountBlock key={a.id} account={a} index={idx} accountsTotal={accounts.length} color={colorOf(a.id)} />
          ))}
        </div>
      </div>
      <div className="sbot">
        <button type="button" className="srow inset-focus" onClick={addAccount}>
          <Icon name="plus" size={20} />
          <span className="nm">Add account</span>
        </button>
        <button type="button" className="srow inset-focus" onClick={openSettings}>
          <Icon name="gear" size={20} />
          <span className="nm">Settings</span>
        </button>
      </div>
    </nav>
  );
}

/** Collapsed sidebar: a 48px icon rail (DESIGN-SPEC 2.3). One tab stop, Up/Down/Home/End move between items. */
function Rail({
  accounts,
  unifiedUnread,
  colorOf,
  addAccount,
  openSettings,
  go,
}: {
  accounts: Account[];
  unifiedUnread: number;
  colorOf: (id: string) => string;
  addAccount: () => void;
  openSettings: () => void;
  go: (v: View) => void;
}) {
  const view = useUi((s) => s.view);
  const folders = useApp((s) => s.folders);
  const counts = useApp((s) => s.counts);
  const [active, setActive] = useState('new');
  const outboxItems = useOutbox((s) => s.items);

  const onKey = (e: RKE<HTMLElement>) => {
    const t = e.target as HTMLElement;
    if (!t.matches('[data-rail]')) return;
    const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-rail]')];
    const i = items.indexOf(t);
    let next: HTMLElement | undefined;
    if (e.key === 'ArrowDown') next = items[Math.min(items.length - 1, i + 1)];
    else if (e.key === 'ArrowUp') next = items[Math.max(0, i - 1)];
    else if (e.key === 'Home') next = items[0];
    else if (e.key === 'End') next = items[items.length - 1];
    if (next) {
      e.preventDefault();
      next.focus();
    }
  };
  const roving = (key: string): RovingProps => ({
    'data-rail': key,
    tabIndex: active === key ? 0 : -1,
    onFocus: () => setActive(key),
  });

  return (
    <nav className="sidebar rail" aria-label="Mail folders" onKeyDown={onKey}>
      <SidebarToggle className="rail-toggle" {...roving('toggle')} />
      <button
        type="button"
        className="rail-new"
        title="New mail (Ctrl+N)"
        aria-label="New mail"
        onClick={newMessage}
        {...roving('new')}
      >
        <Icon name="edit" size={20} />
      </button>
      <div className="rail-sep" role="separator" />
      <button
        type="button"
        className={`rail-tile ${view.kind === 'all' ? 'sel' : ''}`}
        title={`All inboxes${unifiedUnread ? `, ${unifiedUnread} unread` : ''}`}
        aria-label={`All inboxes${unifiedUnread ? `, ${unifiedUnread} unread` : ''}`}
        aria-current={view.kind === 'all' ? 'page' : undefined}
        onClick={() => go({ kind: 'all' })}
        {...roving('all')}
      >
        <Icon name="stack" size={20} />
        {unifiedUnread > 0 ? <span className="udot" /> : null}
      </button>
      <button
        type="button"
        className={`rail-tile ${view.kind === 'unread' ? 'sel' : ''}`}
        title="Unread (all)"
        aria-label="Unread (all)"
        aria-current={view.kind === 'unread' ? 'page' : undefined}
        onClick={() => go({ kind: 'unread' })}
        {...roving('unread')}
      >
        <Icon name="unread" size={20} />
      </button>
      <button
        type="button"
        className={`rail-tile ${view.kind === 'flagged' ? 'sel' : ''}`}
        title="Flagged (all)"
        aria-label="Flagged (all)"
        aria-current={view.kind === 'flagged' ? 'page' : undefined}
        onClick={() => go({ kind: 'flagged' })}
        {...roving('flagged')}
      >
        <Icon name="flag" size={20} />
      </button>
      <div className="rail-sep" role="separator" />
      <div className="rail-accts scroll">
        {accounts.map((a) => (
          <RailAccount
            key={a.id}
            account={a}
            color={colorOf(a.id)}
            folders={folders}
            counts={counts}
            outbox={outboxItems.filter((i) => i.accountId === a.id).length}
            roving={roving(`acct-${a.id}`)}
          />
        ))}
        <button type="button" className="rail-add" title="Add account" aria-label="Add account" onClick={addAccount} {...roving('add')}>
          <Icon name="plus" size={16} />
        </button>
      </div>
      <div className="sbot">
        <button type="button" className="rail-tile" title="Settings (Ctrl+,)" aria-label="Settings" onClick={openSettings} {...roving('settings')}>
          <Icon name="gear" size={20} />
        </button>
      </div>
    </nav>
  );
}

type RovingProps = { 'data-rail': string; tabIndex: number; onFocus: () => void };

function RailAccount({
  account: a,
  color,
  folders,
  counts,
  outbox,
  roving,
}: {
  account: Account;
  color: string;
  folders: Folder[];
  counts: ReturnType<typeof useApp.getState>['counts'];
  outbox: number;
  roving: RovingProps;
}) {
  const view = useUi((s) => s.view);
  const status = useApp((s) => s.statuses[a.id]);
  const kind = useSyncKind(a.id);
  const inbox = accountInbox(folders, a.id);
  const unread = inbox ? unreadOfFolder(counts, inbox) : 0;
  const selected =
    (view.kind === 'account' && view.accountId === a.id) ||
    (view.kind === 'folder' && folders.find((f) => f.id === view.folderId)?.accountId === a.id);
  const state = kind === 'idle' ? '' : syncText(kind, status);
  const label = [a.displayName, unread ? `${unread} unread` : '', state, outbox ? `${outbox} in Outbox` : '']
    .filter(Boolean)
    .join(', ');
  const open = () =>
    useUi.getState().setView(inbox ? { kind: 'folder', folderId: inbox.id } : { kind: 'account', accountId: a.id });
  const menu = (el: HTMLElement) => {
    const { main } = orderFolders(folders.filter((f) => f.accountId === a.id));
    const items: MenuEntry[] = main.map((f) => {
      const c = folderCount(counts, f);
      return {
      label: folderLabel(f),
      hint: c.n > 0 ? fmtCount(c.n) : undefined,
      icon: f.role ? ROLE_ICON[f.role] : 'folder',
      disabled: !f.selectable,
      onSelect: () => useUi.getState().setView({ kind: 'folder', folderId: f.id }),
      };
    });
    if (outbox > 0) items.push({ label: `Outbox (${outbox})`, icon: 'send', onSelect: () => useUi.getState().setView({ kind: 'outbox' }) });
    if (items.length) openMenuAt(el, items);
  };
  return (
    <button
      type="button"
      className={`rail-tile ${selected ? 'sel' : ''}`}
      title={label}
      aria-label={label}
      aria-current={selected ? 'page' : undefined}
      aria-haspopup="menu"
      onClick={open}
      onContextMenu={(e) => {
        e.preventDefault();
        menu(e.currentTarget);
      }}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight' || e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
          e.preventDefault();
          menu(e.currentTarget);
        }
      }}
      {...roving}
    >
      <AccountAvatar color={color} letter={badgeOf(a)} size={24} />
      {unread > 0 ? <span className="udot" /> : null}
      {kind !== 'idle' ? (
        <span className="rglyph" aria-hidden="true">
          <SyncGlyph accountId={a.id} />
        </span>
      ) : null}
      {outbox > 0 ? (
        <span className="obadge" aria-hidden="true">
          {outbox > 9 ? '9+' : outbox}
        </span>
      ) : null}
    </button>
  );
}

function AccountBlock({
  account: a,
  index,
  accountsTotal,
  color,
}: {
  account: Account;
  index: number;
  accountsTotal: number;
  color: string;
}) {
  const folders = useApp((s) => s.folders);
  const counts = useApp((s) => s.counts);
  const view = useUi((s) => s.view);
  const expandedMap = useUi((s) => s.expanded);
  const moreOpen = useUi((s) => !!s.moreOpen[a.id]);
  const progress = useApp((s) => s.progress[a.id]);
  const kind = useSyncKind(a.id);
  const accounts = useApp((s) => s.accounts);
  const [dropId, setDropId] = useState<number | null>(null);
  const springRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const outboxCount = useOutbox((s) => s.items.filter((i) => i.accountId === a.id).length);
  const outboxFailed = useOutbox((s) => s.items.some((i) => i.accountId === a.id && i.state === 'failed'));

  const mine = useMemo(() => folders.filter((f) => f.accountId === a.id), [folders, a.id]);
  const { main, more } = useMemo(() => orderFolders(mine), [mine]);
  const inbox = mine.find((f) => f.role === 'inbox');
  const unread = inbox ? unreadOfFolder(counts, inbox) : 0;
  // Default: first account open, unless there are more than 5 accounts.
  const expanded = expandedMap[a.id] ?? (index === 0 && accountsTotal <= 5);

  const selectedFolderId = view.kind === 'folder' ? view.folderId : null;

  const openAccount = () => {
    const ui = useUi.getState();
    ui.toggleExpanded(a.id, true);
    ui.setView(inbox ? { kind: 'folder', folderId: inbox.id } : { kind: 'account', accountId: a.id });
  };

  const syncNow = () => {
    call('sync.account', { accountId: a.id }).catch((e) => reportActionError(e));
    toast(`Checking ${a.displayName}...`);
  };

  const accountMenu = (): MenuEntry[] => [
    { label: 'Mark all as read', icon: 'check', onSelect: () => void markAllRead({ kind: 'account', accountId: a.id }, a.displayName) },
    { label: 'Sync now', icon: 'sync', hint: 'F9', onSelect: syncNow },
    {
      label: 'New folder',
      icon: 'plus',
      onSelect: () =>
        useUi.getState().set({
          folderDialog: { kind: 'create', accountId: a.id, parentPath: null, parentName: null },
        }),
    },
    'sep',
    {
      label: 'Account settings',
      icon: 'gear',
      onSelect: () => useUi.getState().openSettings('accounts', a.id),
    },
    ...(kind === 'auth'
      ? ([
          {
            label: 'Sign in again',
            icon: 'key',
            onSelect: () => useUi.getState().set({ addAccount: { reauthAccountId: a.id } }),
          },
        ] as MenuEntry[])
      : []),
    {
      label: 'Remove account...',
      icon: 'trash',
      danger: true,
      onSelect: () => useUi.getState().set({ removeAccountId: a.id }),
    },
  ];

  const move = (dir: -1 | 1) => {
    const ids = accounts.map((x) => x.id);
    const i = ids.indexOf(a.id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    call('accounts.reorder', { orderedIds: ids })
      .then(() => useApp.getState().refetchAccounts())
      .catch((e) => reportActionError(e));
  };

  const onRowKey = (e: RKE<HTMLElement>) => {
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      move(e.key === 'ArrowUp' ? -1 : 1);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      useUi.getState().toggleExpanded(a.id, true);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      useUi.getState().toggleExpanded(a.id, false);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openAccount();
    } else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      e.preventDefault();
      openMenuAt(e.currentTarget, accountMenu());
    }
  };

  const syncingNote =
    mine.length === 0 && (kind === 'syncing' || kind === 'idle' || kind === 'pending') ? (
      <div className="acct-note" role="status">
        <i className="spin" />
        {progress && progress.total
          ? `Getting your mail... ${progress.done} of ~${progress.total}`
          : 'Getting your mail...'}
      </div>
    ) : mine.length === 0 && kind === 'error' ? (
      <div className="acct-note warnT">Can&apos;t connect yet. Will retry.</div>
    ) : null;

  const renderFolder = (f: Folder) => {
    const { n, total: isTotal } = folderCount(counts, f);
    const sel = selectedFolderId === f.id;
    const label = folderLabel(f);
    const canEdit = f.role === null;
    const folderMenu = (): MenuEntry[] => [
      {
        label: 'Mark all as read',
        icon: 'check',
        disabled: !f.selectable,
        onSelect: () => void markAllRead({ kind: 'folder', folderId: f.id }, label),
      },
      ...(f.role === 'trash' || f.role === 'junk'
        ? ([
            {
              label: f.role === 'trash' ? 'Empty Trash...' : 'Empty Spam...',
              icon: 'trash',
              danger: true,
              onSelect: () => useUi.getState().set({ emptyFolderId: f.id }),
            },
          ] as MenuEntry[])
        : []),
      {
        label: 'Sync folder',
        icon: 'sync',
        disabled: !f.selectable,
        onSelect: () => {
          call('sync.folder', { folderId: f.id }).catch((e) => reportActionError(e));
        },
      },
      {
        label: 'New subfolder',
        icon: 'plus',
        onSelect: () =>
          useUi.getState().set({
            folderDialog: { kind: 'create', accountId: a.id, parentPath: f.path, parentName: f.name },
          }),
      },
      ...(canEdit
        ? ([
            'sep',
            {
              label: 'Rename',
              icon: 'pencil',
              onSelect: () => useUi.getState().set({ folderDialog: { kind: 'rename', folderId: f.id } }),
            },
            {
              label: 'Delete folder...',
              icon: 'trash',
              danger: true,
              onSelect: () => useUi.getState().set({ folderDialog: { kind: 'delete', folderId: f.id } }),
            },
          ] as MenuEntry[])
        : []),
    ];
    const open = () => {
      if (f.selectable) useUi.getState().setView({ kind: 'folder', folderId: f.id });
    };
    return (
      <div
        key={f.id}
        role="treeitem"
        aria-level={2}
        aria-selected={sel}
        aria-label={n > 0 ? `${label}, ${n} ${countWord(f, isTotal, n)}` : label}
        title={n > 0 ? `${label}, ${n} ${countWord(f, isTotal, n)}` : undefined}
        tabIndex={0}
        data-nav
        className={`srow f inset-focus ${sel ? 'sel' : ''} ${dropId === f.id ? 'drop-ok' : ''} ${dropId === -f.id ? 'drop-no' : ''}`}
        style={{ paddingLeft: 36 + (f.role ? 0 : depthOf(f) * 14), opacity: f.selectable ? 1 : 0.7 }}
        onClick={open}
        onDragOver={(e) => {
          const d = getDrag();
          if (!d) return;
          const ok = f.selectable && d.accountIds.size === 1 && d.accountIds.has(a.id);
          e.dataTransfer.dropEffect = ok ? 'move' : 'none';
          if (ok) e.preventDefault();
          setDropId(ok ? f.id : -f.id);
        }}
        onDragLeave={() => setDropId((cur) => (cur === f.id || cur === -f.id ? null : cur))}
        onDrop={(e) => {
          const d = getDrag();
          setDropId(null);
          if (!d || !f.selectable || d.accountIds.size !== 1 || !d.accountIds.has(a.id)) return;
          e.preventDefault();
          void moveMessages(d.ids, f.id);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          useMenu.getState().open(e.clientX, e.clientY, folderMenu());
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            open();
          } else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
            e.preventDefault();
            openMenuAt(e.currentTarget, folderMenu());
          }
        }}
      >
        <Icon name={f.role ? ROLE_ICON[f.role] : 'folder'} />
        <span className="nm">{label}</span>
        {n > 0 ? <span className={`cnt ${isTotal ? 'tot' : ''}`} aria-hidden="true">{fmtCount(n)}</span> : null}
      </div>
    );
  };

  return (
    <div>
      <div
        role="treeitem"
        aria-level={1}
        aria-expanded={expanded}
        aria-selected={false}
        aria-label={`${a.displayName}${unread ? `, ${unread} unread` : ''}`}
        tabIndex={0}
        data-nav
        className="srow inset-focus"
        title={a.email}
        onDragEnter={() => {
          if (!expanded && getDrag()) {
            springRef.current = setTimeout(() => useUi.getState().toggleExpanded(a.id, true), 700);
          }
        }}
        onDragLeave={() => {
          if (springRef.current) clearTimeout(springRef.current);
        }}
        onClick={openAccount}
        onDoubleClick={() => useUi.getState().openSettings('accounts', a.id)}
        onKeyDown={onRowKey}
        onContextMenu={(e) => {
          e.preventDefault();
          useMenu.getState().open(e.clientX, e.clientY, accountMenu());
        }}
      >
        <span
          className={`chev ${expanded ? 'open' : ''}`}
          onClick={(e) => {
            e.stopPropagation();
            useUi.getState().toggleExpanded(a.id);
          }}
          aria-hidden="true"
        >
          <Icon name="chev-r" />
        </span>
        <AccountAvatar color={color} letter={badgeOf(a)} />
        <span className="nm">{a.displayName}</span>
        <SyncGlyph accountId={a.id} />
        {unread > 0 ? <span className="cnt">{fmtCount(unread)}</span> : null}
      </div>
      {expanded ? (
        <div role="group">
          {syncingNote}
          {main.map(renderFolder)}
          {outboxCount > 0 ? (
            <div
              role="treeitem"
              aria-level={2}
              aria-selected={view.kind === 'outbox'}
              aria-label={`Outbox, ${outboxCount} ${outboxFailed ? 'including a message that failed' : 'waiting'}`}
              tabIndex={0}
              data-nav
              className={`srow f inset-focus ${view.kind === 'outbox' ? 'sel' : ''}`}
              style={{ paddingLeft: 36 }}
              onClick={() => useUi.getState().setView({ kind: 'outbox' })}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  useUi.getState().setView({ kind: 'outbox' });
                }
              }}
            >
              <Icon name="send" />
              <span className="nm">Outbox</span>
              <span className={`cnt ${outboxFailed ? 'bad-cnt' : ''}`}>{outboxCount}</span>
            </div>
          ) : null}
          {more.length > 0 ? (
            <>
              <div
                role="treeitem"
                aria-level={2}
                aria-expanded={moreOpen}
                aria-selected={false}
                aria-label={`More folders, ${more.length} ${more.length === 1 ? 'folder' : 'folders'}, ${moreOpen ? 'expanded' : 'collapsed'}`}
                tabIndex={0}
                data-nav
                className="srow f inset-focus"
                onClick={() => useUi.setState((s) => ({ moreOpen: { ...s.moreOpen, [a.id]: !s.moreOpen[a.id] } }))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    useUi.setState((s) => ({ moreOpen: { ...s.moreOpen, [a.id]: !s.moreOpen[a.id] } }));
                  }
                }}
              >
                <span className={`chev ${moreOpen ? 'open' : ''}`} aria-hidden="true">
                  <Icon name="chev-r" />
                </span>
                <span className="nm">
                  More folders <span style={{ color: 'var(--t2)' }}>({more.length})</span>
                </span>
              </div>
              {moreOpen ? more.map(renderFolder) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
