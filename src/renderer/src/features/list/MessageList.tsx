import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as RKE, type MouseEvent as RME } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { Account, DraftSyncState, Folder } from '../../../../shared/ipc';
import { Icon } from '../../components/Icon';
import {
  AccountBadge,
  Banner,
  Button,
  EmptyState,
  IconButton,
  Skeleton,
  openMenuAt,
  useMenu,
  type MenuEntry,
} from '../../components/ui';
import { useApp } from '../../store/app';
import { useList, type ListItem } from '../../store/list';
import { ROW_HEIGHT, isUnified, useUi, type Density, type View } from '../../store/ui';
import { useAccountColor, useAccountMap } from '../../lib/hooks';
import {
  applyToMessages,
  composeFrom,
  deleteMessages,
  editDraft,
  markAllRead,
  moveMessages,
  openInWindow,
  roleOf,
} from '../../lib/actions';
import { call } from '../../lib/api';
import { endDrag, startDrag } from '../../lib/dnd';
import { groupLabel, isValidEmail, listDate, fullDate, senderName } from '../../lib/format';
import { Highlight, searchTerms } from '../../lib/search';
import { reportActionError, toastError } from '../../store/toasts';
import { folderLabel } from '../sidebar/Sidebar';
import { SidebarToggle } from '../sidebar/SidebarToggle';
import { SearchEmpty, SearchHeader, SearchNotes } from './SearchBits';
import { ConversationParticipants, participantText } from './ConversationBits';

type Flat =
  | { type: 'header'; key: string; label: string; count: number; collapsed: boolean }
  | { type: 'row'; key: string; msg: ListItem; index: number; label: string };

export function viewTitle(view: View, accounts: Account[], folders: Folder[]): string {
  switch (view.kind) {
    case 'all':
      return 'All inboxes';
    case 'unread':
      return 'Unread (all accounts)';
    case 'flagged':
      return 'Flagged (all accounts)';
    case 'account': {
      const a = accounts.find((x) => x.id === view.accountId);
      return `${a?.displayName ?? 'Account'} / Inbox`;
    }
    case 'folder': {
      const f = folders.find((x) => x.id === view.folderId);
      const a = accounts.find((x) => x.id === f?.accountId);
      return f ? `${a?.displayName ?? ''} / ${folderLabel(f)}` : 'Folder';
    }
    case 'outbox':
      return 'Outbox';
    case 'scheduled': {
      if (view.accountId === null) return 'Scheduled · all accounts';
      const a = accounts.find((x) => x.id === view.accountId);
      return `${a?.displayName ?? 'Account'} / Scheduled`;
    }
    case 'search':
      return `Results for "${view.query}"`;
  }
}

export function MessageList({ className }: { className?: string }) {
  const view = useUi((s) => s.view);
  const mode = useUi((s) => s.mode);
  const unreadOnly = useUi((s) => s.unreadOnly);
  const density = useUi((s) => s.density);
  const accounts = useApp((s) => s.accounts);
  const folders = useApp((s) => s.folders);
  const epoch = useApp((s) => s.epoch);
  const loaded = useApp((s) => s.loaded);
  const items = useList((s) => s.items);
  const loading = useList((s) => s.loading);
  const refreshing = useList((s) => s.refreshing);
  const loadingMore = useList((s) => s.loadingMore);
  const error = useList((s) => s.error);
  const nextCursor = useList((s) => s.nextCursor);
  const canLoadOlder = useList((s) => s.canLoadOlder);
  const endReached = useList((s) => s.endReached);
  const selectedIds = useList((s) => s.selectedIds);
  const focusId = useList((s) => s.focusId);
  const selectMode = useList((s) => s.selectMode);
  const search = useList((s) => s.search);
  const searchSort = useList((s) => s.searchSort);
  const terms = useMemo(() => (search ? searchTerms(search.query) : []), [search]);
  const accountMap = useAccountMap();
  const colorOf = useAccountColor();
  const folderMap = useMemo(() => new Map(folders.map((f) => [f.id, f])), [folders]);
  const groupSetting = useApp((s) => !!s.settings?.groupConversations);
  const unified = isUnified(view);
  const alwaysBadge = useUi((s) => s.showAccountBadge);
  // "Always" means on every row, even with one account. Otherwise only in combined views with 2+ accounts.
  const showBadge = alwaysBadge || (unified && accountMap.size >= 2);
  const rowH = ROW_HEIGHT[density];

  // (Re)load whenever the view, the filter, or the whole data set changes.
  useEffect(() => {
    if (!loaded) return;
    void useList.getState().load(view, unreadOnly);
  }, [view, unreadOnly, loaded, epoch, groupSetting]);

  // ----- scope accounts, for banners and sync state -----
  const scopeAccountIds = useMemo(() => {
    if (view.kind === 'account') return [view.accountId];
    if (view.kind === 'folder') {
      const f = folderMap.get(view.folderId);
      return f ? [f.accountId] : [];
    }
    return accounts.filter((a) => a.enabled).map((a) => a.id);
  }, [view, accounts, folderMap]);

  // ----- flatten groups + rows -----
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const flat = useMemo<Flat[]>(() => {
    const out: Flat[] = [];
    const now = Date.now();
    if (search && searchSort === 'rank') {
      // Best-match order: no date groups.
      items.forEach((m, index) => out.push({ type: 'row', key: `m:${m.id}`, msg: m, index, label: '' }));
      return out;
    }
    const groups = new Map<string, ListItem[]>();
    const order: string[] = [];
    items.forEach((m) => {
      const label = groupLabel(m.date, now);
      if (!groups.has(label)) {
        groups.set(label, []);
        order.push(label);
      }
      groups.get(label)!.push(m);
    });
    let index = 0;
    for (const label of order) {
      const list = groups.get(label)!;
      const isCollapsed = !!collapsed[label];
      out.push({ type: 'header', key: `h:${label}`, label, count: list.length, collapsed: isCollapsed });
      for (const m of list) {
        if (!isCollapsed) out.push({ type: 'row', key: `m:${m.id}`, msg: m, index, label });
        index++;
      }
    }
    return out;
  }, [items, collapsed, search, searchSort]);

  const scrollRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: flat.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (flat[i]?.type === 'header' ? 28 : rowH),
    getItemKey: (i) => flat[i]?.key ?? i,
    overscan: 8,
  });
  // Re-measure when the row height changes (density setting).
  useEffect(() => {
    virtualizer.measure();
  }, [rowH, virtualizer]);

  const vItems = virtualizer.getVirtualItems();
  const [scrollTop, setScrollTop] = useState(0);

  // Load the next page when the user is near the end.
  const lastVisible = vItems.length ? vItems[vItems.length - 1]!.index : -1;
  useEffect(() => {
    if (flat.length === 0) return;
    if (lastVisible >= flat.length - 12) void useList.getState().loadMore();
  }, [lastVisible, flat.length]);

  // Fill the screen if the first page is short but more exists.
  const hasMore = !!nextCursor || (canLoadOlder && !endReached);

  const idToFlat = useMemo(() => {
    const m = new Map<number, number>();
    flat.forEach((f, i) => {
      if (f.type === 'row') m.set(f.msg.id, i);
    });
    return m;
  }, [flat]);

  const moveFocus = useCallback(
    (delta: number | 'first' | 'last', extend: boolean) => {
      const st = useList.getState();
      const list = st.items;
      if (list.length === 0) return;
      const cur = list.findIndex((m) => m.id === (st.focusId ?? st.selectedIds[st.selectedIds.length - 1]));
      let next: number;
      if (delta === 'first') next = 0;
      else if (delta === 'last') next = list.length - 1;
      else next = cur < 0 ? (delta > 0 ? 0 : list.length - 1) : Math.max(0, Math.min(list.length - 1, cur + delta));
      const target = list[next]!;
      if (extend) st.rangeTo(target.id);
      else st.selectOnly(target.id);
      const fi = idToFlat.get(target.id);
      if (fi !== undefined) virtualizer.scrollToIndex(fi, { align: 'auto' });
    },
    [idToFlat, virtualizer],
  );

  const onKeyDown = (e: RKE<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const page = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? 400) / rowH) - 1);
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        moveFocus(1, e.shiftKey);
        break;
      case 'ArrowUp':
        e.preventDefault();
        moveFocus(-1, e.shiftKey);
        break;
      case 'Home':
        e.preventDefault();
        moveFocus('first', e.shiftKey);
        break;
      case 'End':
        e.preventDefault();
        moveFocus('last', e.shiftKey);
        break;
      case 'PageDown':
        e.preventDefault();
        moveFocus(page, e.shiftKey);
        break;
      case 'PageUp':
        e.preventDefault();
        moveFocus(-page, e.shiftKey);
        break;
      case ' ':
        if (useList.getState().selectMode && useList.getState().focusId !== null) {
          e.preventDefault();
          useList.getState().toggle(useList.getState().focusId!);
        }
        break;
      default:
        break;
    }
  };

  // Open a message asked for by the main process (notification click).
  const pendingId = useUi((s) => s.pendingOpenMessageId);
  useEffect(() => {
    if (pendingId === null || loading) return;
    const st = useList.getState();
    if (st.items.some((m) => m.id === pendingId)) {
      st.selectOnly(pendingId);
      useUi.setState({ pendingOpenMessageId: null, readerOpen: true });
      const fi = idToFlat.get(pendingId);
      if (fi !== undefined) virtualizer.scrollToIndex(fi);
      return;
    }
    call('messages.getHeaders', { messageIds: [pendingId] })
      .then((h) => {
        const hdr = h[0];
        if (hdr) {
          useUi.getState().setView({ kind: 'folder', folderId: hdr.folderId });
        } else useUi.setState({ pendingOpenMessageId: null });
      })
      .catch(() => useUi.setState({ pendingOpenMessageId: null }));
  }, [pendingId, loading, items, idToFlat, virtualizer]);

  // Sticky group label: the group of the item at the top of the scroller.
  const sticky = useMemo(() => {
    if (scrollTop <= 0) return null;
    const top = vItems.find((v) => v.end > scrollTop);
    if (!top) return null;
    const f = flat[top.index];
    if (!f) return null;
    if (f.type === 'header' && top.start >= scrollTop) return null;
    return f.label;
  }, [scrollTop, vItems, flat]);

  const onRowClick = useCallback(
    (e: RME, m: ListItem) => {
      const st = useList.getState();
      if (e.shiftKey) st.rangeTo(m.id);
      else if (e.ctrlKey || e.metaKey || st.selectMode) st.toggle(m.id);
      else st.selectOnly(m.id);
      if (!e.shiftKey && !e.ctrlKey && !e.metaKey) useUi.setState({ readerOpen: true });
      scrollRef.current?.focus({ preventScroll: true });
    },
    [],
  );

  const onRowMenu = useCallback((x: number, y: number, m: ListItem) => {
    const st = useList.getState();
    if (!st.selectedIds.includes(m.id)) st.selectOnly(m.id);
    const ids = useList.getState().selectedIds;
    useMenu.getState().open(x, y, messageMenu(m, ids));
  }, []);

  const onRowOpen = useCallback((m: ListItem) => {
    openInWindow(m);
  }, []);

  const headerTitle = viewTitle(view, accounts, folders);
  const viewFolder = view.kind === 'folder' ? folderMap.get(view.folderId) : undefined;
  const firstSyncAccount = scopeAccountIds
    .map((id) => useApp.getState().progress[id])
    .find((p) => p && p.phase === 'initial' && p.total);
  const progressMap = useApp((s) => s.progress);
  const syncingProgress = scopeAccountIds
    .map((id) => progressMap[id])
    .find((p) => p && p.phase === 'initial' && p.total);
  void firstSyncAccount;
  const anySyncing = scopeAccountIds.some((id) => {
    const p = progressMap[id];
    if (!p) return false;
    // Only foreground work counts: first sync of the folder being viewed.
    if (p.phase !== 'initial' && p.phase !== 'folders') return false;
    if (p.total !== null && p.done >= p.total) return false;
    return view.kind !== 'folder' || p.folderId === view.folderId || p.phase === 'folders';
  });

  const showSelectionBar = selectedIds.length >= 2 || (selectMode && selectedIds.length > 0);

  return (
    <section className={`list ${className ?? ''} ${useUiInactive() ? 'list-inactive' : ''}`} aria-label="Messages" id="pane-list">
      {showSelectionBar ? (
        <SelectionBar count={selectedIds.length} ids={selectedIds} items={items} />
      ) : search ? (
        <SearchHeader count={items.length} />
      ) : (
        <div className="lhead">
          {mode === 'narrow' ? <SidebarToggle className="lhead-toggle" /> : null}
          <h2>{headerTitle}</h2>
          <IconButton
            icon="check-sq"
            label="Select messages"
            size="sm"
            pressed={selectMode}
            onClick={() => useList.getState().setSelectMode(!selectMode)}
          />
          <FilterButton />
          <IconButton
            icon="more"
            label="More list actions"
            size="sm"
            aria-haspopup="menu"
            onClick={(e) => openMenuAt(e.currentTarget, listMenu(view, viewFolder, accounts, folderMap))}
          />
        </div>
      )}
      {viewFolder && (viewFolder.role === 'trash' || viewFolder.role === 'junk') && items.length > 0 ? (
        <div className="empty-bar">
          <span>
            {viewFolder.role === 'trash'
              ? 'Messages in Trash are removed for good after a while.'
              : 'Spam is cleared by your mail provider from time to time.'}
          </span>
          <button
            type="button"
            className="link"
            onClick={() => useUi.getState().set({ emptyFolderId: viewFolder.id })}
          >
            {viewFolder.role === 'trash' ? 'Empty Trash' : 'Empty Spam'}
          </button>
        </div>
      ) : null}
      <div className={`lbar ${loading || refreshing || loadingMore || anySyncing ? 'on' : ''}`} role="progressbar" aria-hidden={!(loading || anySyncing)} />
      {syncingProgress && syncingProgress.total ? (
        <div className="hint" style={{ padding: '4px 16px' }} role="status">
          Getting your mail... {syncingProgress.done} of ~{syncingProgress.total}
        </div>
      ) : null}
      <ListBanners accountIds={scopeAccountIds} />
      {search && !error ? <SearchNotes /> : null}
      {error ? (
        <div style={{ padding: 12 }}>
          <Banner
            tone="danger"
            actions={
              <Button size="sm" onClick={() => void useList.getState().load(view, unreadOnly)}>
                Retry
              </Button>
            }
          >
            Couldn&apos;t load your messages. {error.message}
          </Banner>
        </div>
      ) : null}
      {!error && loading && items.length === 0 ? (
        <SkeletonRows height={rowH} />
      ) : !error && !loading && items.length === 0 ? (
        search ? (
          <SearchEmpty />
        ) : (
          <ListEmpty view={view} unreadOnly={unreadOnly} accounts={accounts} syncing={anySyncing} />
        )
      ) : (
        <div
          ref={scrollRef}
          className={`msg-scroll scroll ${selectMode ? 'select-mode' : ''}`}
          role="listbox"
          aria-label="Messages"
          aria-multiselectable="true"
          aria-activedescendant={focusId !== null ? `msg-${focusId}` : undefined}
          tabIndex={0}
          onKeyDown={onKeyDown}
          onScroll={(e) => setScrollTop((e.target as HTMLElement).scrollTop)}
          onFocus={() => {
            const st = useList.getState();
            if (st.focusId === null && st.items.length > 0) st.setFocus(st.selectedIds[0] ?? st.items[0]!.id);
          }}
        >
          {sticky ? (
            <div style={{ position: 'sticky', top: 0, height: 0, zIndex: 3 }}>
              <button
                type="button"
                className="ghead"
                style={{ borderBottom: '1px solid var(--border)' }}
                onClick={() => {
                  setCollapsed((c) => ({ ...c, [sticky]: true }));
                  scrollRef.current?.scrollTo({ top: 0 });
                }}
                aria-label={`${sticky}, collapse group`}
              >
                <span className="chev open">
                  <Icon name="chev-r" />
                </span>
                {sticky}
              </button>
            </div>
          ) : null}
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
            {vItems.map((v) => {
              const f = flat[v.index];
              if (!f) return null;
              return (
                <div
                  key={f.key}
                  className="vrow"
                  style={{ height: v.size, transform: `translateY(${v.start}px)` }}
                >
                  {f.type === 'header' ? (
                    <div role="group" aria-label={`${f.label}, ${f.count} messages`}>
                      <button
                        type="button"
                        className="ghead"
                        aria-expanded={!f.collapsed}
                        onClick={() => setCollapsed((c) => ({ ...c, [f.label]: !c[f.label] }))}
                      >
                        <span className={`chev ${f.collapsed ? '' : 'open'}`}>
                          <Icon name="chev-r" />
                        </span>
                        {f.label}
                      </button>
                    </div>
                  ) : (
                    <MessageRow
                      msg={f.msg}
                      posinset={f.index + 1}
                      setsize={items.length}
                      account={accountMap.get(f.msg.accountId)}
                      color={colorOf(f.msg.accountId)}
                      folder={folderMap.get(f.msg.folderId)}
                      selected={selectedIds.includes(f.msg.id)}
                      focused={focusId === f.msg.id}
                      showBadge={showBadge}
                      density={density}
                      terms={terms}
                      onClick={onRowClick}
                      onMenu={onRowMenu}
                      onOpen={onRowOpen}
                    />
                  )}
                </div>
              );
            })}
          </div>
          <div className="list-foot" role="status">
            {loadingMore || (hasMore && !endReached) ? (
              <>
                <i className="spin" />
                Loading older messages...
              </>
            ) : (
              'No more messages'
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function useUiInactive(): boolean {
  // The "inactive selection" tint is used while focus is outside the list.
  const [inactive, setInactive] = useState(false);
  useEffect(() => {
    const on = () => setInactive(!document.querySelector('#pane-list:focus-within'));
    document.addEventListener('focusin', on);
    document.addEventListener('focusout', () => setTimeout(on, 0));
    return () => document.removeEventListener('focusin', on);
  }, []);
  return inactive;
}

// ---------- list header pieces ----------
function FilterButton() {
  const unreadOnly = useUi((s) => s.unreadOnly);
  const view = useUi((s) => s.view);
  const disabled = view.kind === 'unread' || view.kind === 'flagged';
  return (
    <button
      type="button"
      className="tbtn"
      title="Filter messages"
      aria-haspopup="menu"
      disabled={disabled}
      onClick={(e) =>
        openMenuAt(e.currentTarget, [
          { label: `${!unreadOnly ? '✓  ' : '    '}All messages`, onSelect: () => useUi.setState({ unreadOnly: false }) },
          { label: `${unreadOnly ? '✓  ' : '    '}Unread only`, onSelect: () => useUi.setState({ unreadOnly: true }) },
        ])
      }
    >
      {unreadOnly ? 'Unread' : 'Filter'} <Icon name="chev-d" />
    </button>
  );
}

function SelectionBar({ count, ids, items }: { count: number; ids: number[]; items: ListItem[] }) {
  const sel = items.filter((m) => ids.includes(m.id));
  const sameAccount = new Set(sel.map((m) => m.accountId)).size <= 1;
  const allRead = sel.every((m) => m.seen);
  const allFlagged = sel.every((m) => m.flagged);
  const inJunk = sel.length > 0 && sel.every((m) => roleOf(m) === 'junk');
  return (
    <div className="sel-bar" role="toolbar" aria-label="Actions for selected messages">
      <IconButton icon="x" label="Clear selection" size="sm" onClick={() => useList.getState().setSelectMode(false)} />
      <span className="cntl" role="status">{count} selected</span>
      <IconButton icon="trash" label="Delete" size="sm" onClick={() => deleteMessages(ids)} />
      <IconButton icon="archive" label="Archive" size="sm" onClick={() => void applyToMessages(ids, { type: 'archive' })} />
      <IconButton
        icon="folder"
        label={sameAccount ? 'Move to...' : 'Messages are in different accounts'}
        size="sm"
        disabled={!sameAccount}
        onClick={() => useUi.getState().set({ moveDialog: ids })}
      />
      <IconButton
        icon="spam"
        label={inJunk ? 'Not spam' : 'Report spam'}
        size="sm"
        onClick={() => void applyToMessages(ids, { type: inJunk ? 'notSpam' : 'spam' })}
      />
      <IconButton
        icon={allRead ? 'unread' : 'mail-open'}
        label={allRead ? 'Mark as unread' : 'Mark as read'}
        size="sm"
        onClick={() => void applyToMessages(ids, { type: 'markRead', read: !allRead })}
      />
      <IconButton
        icon="flag"
        label={allFlagged ? 'Unflag' : 'Flag'}
        size="sm"
        onClick={() => void applyToMessages(ids, { type: 'flag', flagged: !allFlagged })}
      />
    </div>
  );
}

/** The "..." menu in the list header. */
function listMenu(
  view: View,
  folder: Folder | undefined,
  accounts: Account[],
  folderMap: Map<number, Folder>,
): MenuEntry[] {
  const out: MenuEntry[] = [];
  const markScope = (): [Parameters<typeof markAllRead>[0], string] | null => {
    switch (view.kind) {
      case 'all':
        return [{ kind: 'unifiedInbox' }, 'all inboxes'];
      case 'unread':
        return [{ kind: 'unifiedUnread' }, 'Unread'];
      case 'flagged':
        return [{ kind: 'unifiedFlagged' }, 'Flagged'];
      case 'account':
        return [
          { kind: 'accountInbox', accountId: view.accountId },
          accounts.find((a) => a.id === view.accountId)?.displayName ?? 'this account',
        ];
      case 'folder': {
        const f = folderMap.get(view.folderId);
        return [{ kind: 'folder', folderId: view.folderId }, f ? folderLabel(f) : 'this folder'];
      }
      default:
        return null;
    }
  };
  const ms = markScope();
  if (ms) out.push({ label: 'Mark all as read', icon: 'check', onSelect: () => void markAllRead(ms[0], ms[1]) });
  if (view.kind === 'folder' && folder?.selectable) {
    out.push({
      label: 'Check this folder for new mail',
      icon: 'sync',
      onSelect: () => void call('sync.folder', { folderId: folder.id }).catch(reportActionError),
    });
  }
  if (folder && (folder.role === 'trash' || folder.role === 'junk')) {
    out.push('sep', {
      label: folder.role === 'trash' ? 'Empty Trash...' : 'Empty Spam...',
      icon: 'trash',
      danger: true,
      onSelect: () => useUi.getState().set({ emptyFolderId: folder.id }),
    });
  }
  return out;
}

function SkeletonRows({ height }: { height: number }) {
  return (
    <div aria-busy="true" aria-label="Loading messages">
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className="skel-row" style={{ height }}>
          <Skeleton w="45%" h={12} />
          <Skeleton w="80%" h={12} />
          <Skeleton w="95%" h={10} />
        </div>
      ))}
    </div>
  );
}

function ListEmpty({
  view,
  unreadOnly,
  accounts,
  syncing,
}: {
  view: View;
  unreadOnly: boolean;
  accounts: Account[];
  syncing: boolean;
}) {
  const folders = useApp((s) => s.folders);
  if (accounts.length === 0) return <EmptyState icon="mail" title="No accounts yet" />;
  if (syncing)
    return <EmptyState icon="sync" title="Getting your mail..." text="Your messages will appear here in a moment." />;
  if (unreadOnly)
    return (
      <EmptyState
        icon="mail"
        title="No unread messages"
        action={<Button size="sm" onClick={() => useUi.setState({ unreadOnly: false })}>Show all</Button>}
      />
    );
  switch (view.kind) {
    case 'all':
      return <EmptyState icon="mail" title="All inboxes are empty" text="Nothing new in any account." />;
    case 'unread':
      return (
        <EmptyState
          icon="mail"
          title="No unread messages"
          action={<Button size="sm" onClick={() => useUi.getState().setView({ kind: 'all' })}>Show all</Button>}
        />
      );
    case 'flagged':
      return <EmptyState icon="flag" title="No flagged messages" text="Flag a message to find it quickly." />;
    case 'account':
      return <EmptyState icon="mail" title="You're all caught up" text="No messages in Inbox." />;
    case 'folder': {
      const f = folders.find((x) => x.id === view.folderId);
      if (f?.role === 'inbox') return <EmptyState icon="mail" title="You're all caught up" text="No messages in Inbox." />;
      return (
        <EmptyState
          icon="mail"
          title="Nothing here"
          text={f?.role === 'trash' ? 'Messages you delete appear here.' : undefined}
        />
      );
    }
  }
}

function ListBanners({ accountIds }: { accountIds: string[] }) {
  const accounts = useApp((s) => s.accounts);
  const statuses = useApp((s) => s.statuses);
  const authRequired = useApp((s) => s.authRequired);
  const online = useApp((s) => s.online);
  const [dismissed, setDismissed] = useState<Record<string, boolean>>({});
  const needAuth = accountIds.filter((id) => {
    const st = statuses[id];
    return !dismissed[id] && (authRequired[id] || st?.state === 'auth_failed' || st?.state === 'needs_reauth');
  });
  const failing = accountIds.filter((id) => statuses[id]?.state === 'retrying' && !dismissed['e' + id]);
  const out: React.ReactNode[] = [];
  needAuth.slice(0, 2).forEach((id) => {
    const a = accounts.find((x) => x.id === id);
    if (!a) return;
    out.push(
      <Banner
        key={'auth' + id}
        tone="danger"
        onDismiss={() => setDismissed((d) => ({ ...d, [id]: true }))}
        actions={
          <button type="button" className="link" onClick={() => signInAgain(a)}>
            Sign in again
          </button>
        }
      >
        <b>{a.displayName}</b> needs you to sign in again.
      </Banner>,
    );
  });
  if (needAuth.length > 2) {
    out.push(
      <Banner key="authmore" tone="danger">
        {needAuth.length - 2} more accounts need you to sign in again.
      </Banner>,
    );
  }
  if (online && failing.length === 1) {
    const a = accounts.find((x) => x.id === failing[0]);
    out.push(
      <Banner
        key="fail"
        tone="warning"
        onDismiss={() => setDismissed((d) => ({ ...d, ['e' + failing[0]!]: true }))}
        actions={
          <button type="button" className="link" onClick={() => void call('sync.account', { accountId: failing[0]! }).catch(reportActionError)}>
            Retry
          </button>
        }
      >
        Can&apos;t connect to {a?.displayName}. Showing saved mail.
      </Banner>,
    );
  } else if (online && failing.length > 1) {
    out.push(
      <Banner key="fails" tone="warning">
        {failing.length} accounts can&apos;t sync.
      </Banner>,
    );
  }
  return <>{out}</>;
}

export function signInAgain(a: Account): void {
  useUi.getState().set({ addAccount: { reauthAccountId: a.id } });
}

// ---------- row ----------
interface RowProps {
  msg: ListItem;
  posinset: number;
  setsize: number;
  account: Account | undefined;
  color: string;
  folder: Folder | undefined;
  selected: boolean;
  focused: boolean;
  showBadge: boolean;
  density: Density;
  terms: string[];
  onClick: (e: RME, m: ListItem) => void;
  onMenu: (x: number, y: number, m: ListItem) => void;
  onOpen: (m: ListItem) => void;
}

const MessageRow = memo(function MessageRow({
  msg: m,
  posinset,
  setsize,
  account,
  color,
  folder,
  selected,
  focused,
  showBadge,
  density,
  terms,
  onClick,
  onMenu,
  onOpen,
}: RowProps) {
  // A conversation with 2 or more messages (DESIGN-SPEC 3.10.2). With one message it is a normal row.
  const conv = m.conv && m.conv.count > 1 ? m.conv : null;
  const outgoing = !conv && (folder?.role === 'sent' || folder?.role === 'drafts' || m.draft);
  // Half-typed text in an old draft ("To: dm") is not a recipient.
  const firstTo = outgoing ? m.to.find((a) => isValidEmail(a.address)) : undefined;
  const who = conv
    ? participantText(conv.participants)
    : outgoing
      ? firstTo
        ? `To: ${senderName(firstTo)}`
        : '(no recipient)'
      : senderName(m.from);
  const date = listDate(m.date);
  const label = [
    m.seen ? 'Read' : 'Unread',
    m.flagged ? 'Flagged' : '',
    m.hasAttachments ? 'Has attachment' : '',
  ]
    .filter(Boolean)
    .join(', ');
  const aria = conv
    ? `${m.seen ? 'Read' : 'Unread'}, ${m.flagged ? 'Flagged, ' : ''}${m.hasAttachments ? 'Has attachment, ' : ''}conversation with ${who}, ${conv.count} messages${conv.unreadCount > 0 ? `, ${conv.unreadCount} unread` : ''}, ${m.subject || '(no subject)'}, ${date}${account ? `, account ${account.displayName}` : ''}. ${conv.latest.fromMe ? 'You: ' : ''}${m.snippet}`
    : `${label}, from ${who}, ${m.subject || '(no subject)'}, ${date}${account ? `, account ${account.displayName}` : ''}. ${m.snippet}`;
  const youPrefix = conv?.latest.fromMe ? 'You: ' : '';
  const scopeWord = conv ? `conversation (${conv.count} messages)` : '';
  return (
    <div
      id={`msg-${m.id}`}
      role="option"
      aria-selected={selected}
      aria-posinset={posinset}
      aria-setsize={setsize}
      aria-label={aria}
      aria-busy={m.draftSync === 'saving' ? true : undefined}
      className={`row d-${density} ${m.seen ? '' : 'unread'} ${selected ? 'sel' : ''} ${focused ? 'focus' : ''}`}
      onClick={(e) => onClick(e, m)}
      onDoubleClick={() => onOpen(m)}
      draggable
      onDragStart={(e) => {
        const st = useList.getState();
        if (!st.selectedIds.includes(m.id)) st.selectOnly(m.id);
        const ids = useList.getState().selectedIds;
        const picked = useList.getState().items.filter((x) => ids.includes(x.id));
        startDrag(e.nativeEvent, ids, picked.map((x) => x.accountId), m.subject);
      }}
      onDragEnd={endDrag}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(e.clientX, e.clientY, m);
      }}
    >
      {!m.seen ? <i className="ud" /> : null}
      <span className="slot">
        <button
          type="button"
          className={`cb ${selected ? 'checked' : ''}`}
          tabIndex={-1}
          aria-label={selected ? 'Deselect message' : 'Select message'}
          onClick={(e) => {
            e.stopPropagation();
            useList.getState().toggle(m.id);
          }}
        >
          {selected ? <Icon name="check" /> : null}
        </button>
      </span>
      <div className="l1">
        <span className={`snd ${conv ? 'conv' : ''}`} title={conv ? who : outgoing ? undefined : m.from?.address}>
          {conv ? <ConversationParticipants conv={conv} /> : <Highlight text={who} terms={terms} />}
        </span>
        <span className="ico">
          {m.hasAttachments ? <Icon name="clip" /> : null}
          {m.flagged ? (
            <span className="flg">
              <Icon name="flag" filled />
            </span>
          ) : null}
        </span>
        <DraftSyncHint key={m.draftSync ?? 'none'} sync={m.draftSync} />
        <span className="tm" title={fullDate(m.date)}>
          {date}
        </span>
      </div>
      <div className="sub2">
        <span className="t">
          <Highlight text={m.subject || '(no subject)'} terms={terms} />
        </span>
        {density === 'compact' && showBadge && account ? (
          <AccountBadge color={color} name={account.displayName} letter={account.badge} />
        ) : null}
      </div>
      {density !== 'compact' ? (
        <div className="snp">
          <span className="t">
            {youPrefix ? <span className="you">{youPrefix}</span> : null}
            <Highlight text={m.snippet} terms={terms} />
          </span>
          {showBadge && account ? (
            <>
              {density === 'roomy' ? <span className="an">{account.displayName}</span> : null}
              <AccountBadge color={color} name={account.displayName} letter={account.badge} />
            </>
          ) : null}
        </div>
      ) : null}
      <div className="hov" role="group" aria-label={conv ? `Quick actions for the conversation with ${who}` : `Quick actions for ${who}`}>
        <IconButton
          icon="trash"
          label={conv ? 'Delete conversation' : `Delete message from ${who}`}
          size="sm"
          tabIndex={-1}
          onClick={(e) => {
            e.stopPropagation();
            deleteMessages([m.id]);
          }}
        />
        <IconButton
          icon="archive"
          label={conv ? `Archive ${scopeWord}` : 'Archive'}
          size="sm"
          tabIndex={-1}
          onClick={(e) => {
            e.stopPropagation();
            void applyToMessages([m.id], { type: 'archive' });
          }}
        />
        <IconButton
          icon="flag"
          label={`${m.flagged ? 'Unflag' : 'Flag'}${conv ? ' conversation' : ''}`}
          size="sm"
          tabIndex={-1}
          pressed={m.flagged}
          onClick={(e) => {
            e.stopPropagation();
            void applyToMessages([m.id], { type: 'flag', flagged: !m.flagged });
          }}
        />
        <IconButton
          icon={m.seen ? 'unread' : 'mail-open'}
          label={conv ? `Mark conversation as ${m.seen ? 'unread' : 'read'}` : m.seen ? 'Mark as unread' : 'Mark as read'}
          size="sm"
          tabIndex={-1}
          onClick={(e) => {
            e.stopPropagation();
            void applyToMessages([m.id], { type: 'markRead', read: !m.seen });
          }}
        />
      </div>
    </div>
  );
});

/** Server-save state of a draft row (DESIGN-SPEC 3.7). "Saving" shows only after 1 s so quick saves do not flicker. */
function DraftSyncHint({ sync }: { sync: DraftSyncState | undefined }) {
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (sync !== 'saving') return;
    const t = setTimeout(() => setLate(true), 1000);
    return () => clearTimeout(t);
  }, [sync]);
  if (sync === 'saving' && late)
    return (
      <span className="dsync" aria-hidden="true">
        <i className="spin" />
        Saving...
      </span>
    );
  if (sync === 'queued')
    return (
      <span className="dsync" aria-label="Waiting to sync" role="img">
        <Icon name="pending" />
        Waiting to sync
      </span>
    );
  if (sync === 'failed')
    return (
      <span
        className="dsync fail"
        title="The draft is saved on this PC and will retry automatically."
        aria-label="Not saved to server. The draft is saved on this PC and will retry automatically."
        role="img"
      >
        <Icon name="warn" />
        Not saved to server
      </span>
    );
  return null;
}

function messageMenu(m: ListItem, ids: number[]): MenuEntry[] {
  const multi = ids.length > 1;
  const st = useList.getState();
  const sel = st.items.filter((x) => ids.includes(x.id));
  const sameAccount = new Set(sel.map((x) => x.accountId)).size <= 1;
  const inJunk = sel.length > 0 && sel.every((x) => roleOf(x) === 'junk');
  const isDraft = m.draft || roleOf(m) === 'drafts';
  const folders = useApp.getState().folders;
  const recent = (useUi.getState().recentFolders[m.accountId] ?? [])
    .map((id) => folders.find((f) => f.id === id))
    .filter((f): f is Folder => !!f && f.id !== m.folderId)
    .slice(0, 3);
  const moveEntries: MenuEntry[] = sameAccount
    ? [
        ...recent.map(
          (f): MenuEntry => ({
            label: `Move to ${folderLabel(f)}`,
            icon: 'folder',
            onSelect: () => void moveMessages(ids, f.id),
          }),
        ),
        { label: 'Move to...', icon: 'folder', hint: 'Ctrl+Shift+M', onSelect: () => useUi.getState().set({ moveDialog: ids }) },
      ]
    : [{ label: 'Move to... (different accounts)', icon: 'folder', disabled: true, onSelect: () => undefined }];
  return [
    ...(isDraft && !multi
      ? ([
          { label: 'Edit draft', icon: 'pencil', hint: 'Enter', onSelect: () => editDraft(m.id) },
          ...(m.draftSync === 'failed'
            ? ([
                {
                  label: 'Retry now',
                  icon: 'sync',
                  onSelect: () => void call('drafts.retrySave', { messageId: m.id }).catch((e) => reportActionError(e)),
                },
              ] as MenuEntry[])
            : []),
          'sep',
        ] as MenuEntry[])
      : []),
    ...(!isDraft
      ? ([
          { label: 'Open in new window', icon: 'open-window', hint: 'Enter', disabled: multi, onSelect: () => openInWindow(m) },
          'sep',
        ] as MenuEntry[])
      : []),
    { label: 'Reply', icon: 'reply', hint: 'Ctrl+R', disabled: multi, onSelect: () => composeFrom('reply', m.id) },
    { label: 'Reply all', icon: 'replyall', hint: 'Ctrl+Shift+R', disabled: multi, onSelect: () => composeFrom('replyAll', m.id) },
    { label: 'Forward', icon: 'fwd', hint: 'Ctrl+F', disabled: multi, onSelect: () => composeFrom('forward', m.id) },
    'sep',
    {
      label: m.seen ? 'Mark as unread' : 'Mark as read',
      icon: m.seen ? 'unread' : 'mail-open',
      onSelect: () => void applyToMessages(ids, { type: 'markRead', read: !m.seen }),
    },
    {
      label: m.flagged ? 'Unflag' : 'Flag',
      icon: 'flag',
      hint: 'Insert',
      onSelect: () => void applyToMessages(ids, { type: 'flag', flagged: !m.flagged }),
    },
    'sep',
    ...moveEntries,
    { label: 'Archive', icon: 'archive', hint: 'E', onSelect: () => void applyToMessages(ids, { type: 'archive' }) },
    {
      label: inJunk ? 'Not spam' : 'Report spam',
      icon: 'spam',
      onSelect: () => void applyToMessages(ids, { type: inJunk ? 'notSpam' : 'spam' }),
    },
    { label: 'Delete', icon: 'trash', hint: 'Delete', onSelect: () => deleteMessages(ids) },
    'sep',
    {
      label: 'Copy sender address',
      icon: 'copy',
      disabled: !m.from,
      onSelect: () => {
        if (m.from) void navigator.clipboard.writeText(m.from.address).catch(() => toastError('Could not copy.'));
      },
    },
    {
      label: 'Search for messages from this sender',
      icon: 'search',
      disabled: !m.from,
      onSelect: () => {
        if (m.from) useUi.getState().startSearch(`from:${m.from.address}`, null);
      },
    },
  ];
}
