import { create } from 'zustand';
import type {
  AppError,
  ConversationRow,
  SearchRes,
  FolderId,
  ListScope,
  MessageHeader,
  MessageId,
  PageCursor,
} from '../../../shared/ipc';
import { asAppError, call } from '../lib/api';
import { useApp } from './app';
import { scopeOf, useUi, type View } from './ui';

export const PAGE = 50;

/**
 * A row of the list. With "Group messages into conversations" on, each row is a conversation: it
 * looks like the newest message of the conversation (same id, subject, date) and carries the whole
 * `ConversationRow` in `conv`. Selection, keys, grouping by date and drag work on it like on a message.
 */
export type ListItem = MessageHeader & { conv?: ConversationRow };

/** Turn a conversation into a list row. `folderId` is the folder being viewed (0 in combined views). */
export function conversationItem(row: ConversationRow, folderId: number): ListItem {
  return {
    id: row.latest.id,
    accountId: row.accountId,
    folderId,
    uid: 0,
    messageIdHeader: null,
    subject: row.latest.title,
    from: row.latest.from,
    to: [],
    cc: [],
    date: row.latest.date,
    snippet: row.latest.snippet,
    seen: row.unreadCount === 0,
    flagged: row.hasFlag,
    answered: false,
    draft: false,
    hasAttachments: row.hasAttachment,
    size: null,
    bodyCached: true,
    threadId: row.threadId,
    conv: row,
  };
}

/** Views that can show conversations (not search, Outbox or Scheduled). */
export function canGroup(view: View): boolean {
  return ['all', 'unread', 'flagged', 'account', 'folder'].includes(view.kind);
}

/** True when the list shows conversations for this view (setting on and a view that supports it). */
export function wantsGrouped(view: View): boolean {
  return !!useApp.getState().settings?.groupConversations && canGroup(view);
}

export interface SearchInfo {
  query: string;
  accountId: string | null;
  parsedFilters: string[];
  totalApprox: number;
  coverage: { messagesIndexed: number; bodiesIndexed: number };
  /** Set after "Search on server": how many new messages the server added. */
  serverAdded: number | null;
}

interface ListState {
  key: string;
  scope: ListScope | null;
  /** Set instead of `scope` while a search is on screen. */
  search: SearchInfo | null;
  serverSearching: boolean;
  searchSort: 'rank' | 'date';
  setSearchSort: (sort: 'rank' | 'date') => void;
  unreadOnly: boolean;
  /** Rows are conversations (see ListItem). */
  grouped: boolean;
  items: ListItem[];
  nextCursor: PageCursor | null;
  canLoadOlder: boolean;
  endReached: boolean;
  total: number | null;
  loading: boolean;
  loadingMore: boolean;
  refreshing: boolean;
  error: AppError | null;

  selectedIds: MessageId[];
  anchorId: MessageId | null;
  focusId: MessageId | null;
  selectMode: boolean;

  load: (view: View, unreadOnly: boolean, grouped?: boolean) => Promise<void>;
  loadMore: () => Promise<void>;
  /** Re-read what is loaded; `extra` asks for that many more rows (used when paging by a sort key). */
  refresh: (extra?: number) => Promise<void>;
  patch: (ids: MessageId[], p: Partial<ListItem>) => void;
  /** Drop rows from the screen right away (optimistic move / delete). */
  removeLocal: (ids: MessageId[]) => void;
  searchOnServer: () => Promise<void>;

  selectOnly: (id: MessageId) => void;
  toggle: (id: MessageId) => void;
  rangeTo: (id: MessageId) => void;
  selectAll: () => void;
  clearSelection: () => void;
  setSelectMode: (on: boolean) => void;
  setFocus: (id: MessageId | null) => void;
}

let seq = 0;

// `grouped` stays the last element: load() compares keys without it to keep the selection when the setting flips.
const scopeKey = (scope: ListScope, unreadOnly: boolean, sortKey: string, grouped = false) =>
  JSON.stringify([scope, unreadOnly, sortKey, grouped]);

/** Sort and direction of the conversation list, as one string (part of the list key). */
function currentSortKey(): string {
  const { sort, direction } = useUi.getState().listSort;
  return `${sort}:${direction}`;
}

/** The folder a conversation list is about (0 when it mixes folders). */
function scopeFolderId(scope: ListScope): number {
  return scope.kind === 'folder' ? scope.folderId : 0;
}

interface Page {
  items: ListItem[];
  nextCursor: PageCursor | null;
  canLoadOlderFromServer: boolean;
  total: number | null;
}

/** One page of messages or of conversations. */
async function fetchPage(
  scope: ListScope,
  cursor: PageCursor | null,
  limit: number,
  unreadOnly: boolean,
  grouped: boolean,
): Promise<Page> {
  // `nextCursor` goes back unchanged, together with the same sort and direction (it carries the sort key).
  const { sort, direction } = useUi.getState().listSort;
  if (grouped) {
    const res = await call('conversations.list', { scope, cursor, limit, unreadOnly, sort, direction });
    const folderId = scopeFolderId(scope);
    return { ...res, items: res.items.map((r) => conversationItem(r, folderId)) };
  }
  return call('messages.list', { scope, cursor, limit, unreadOnly, sort, direction });
}

/** Cursor for "the page after this row". A conversation pages by its newest message id. */
function cursorAfter(m: ListItem | undefined): PageCursor | null {
  if (!m) return null;
  return { date: m.date, id: m.conv ? Math.max(...m.conv.messageIds, m.id) : m.id };
}
const SEARCH_LIMIT = 300;

/** Results arrive best match first; "Newest first" re-sorts them here. */
function orderSearch(items: MessageHeader[], sort: 'rank' | 'date'): MessageHeader[] {
  const rankOf = (m: MessageHeader) => (m as MessageHeader & { rank?: number }).rank ?? 0;
  return sort === 'date'
    ? [...items].sort((a, b) => b.date - a.date || b.id - a.id)
    : [...items].sort((a, b) => rankOf(a) - rankOf(b));
}

async function runSearch(query: string, accountId: string | null): Promise<SearchRes> {
  const res = await call('search.local', { query, ...(accountId ? { accountId } : {}), limit: SEARCH_LIMIT });
  return { ...res, items: [...res.items].sort((a, b) => a.rank - b.rank) };
}

/** Folders on the server that `sync.loadOlder` should be called for, for this scope. */
function olderFolderIds(scope: ListScope): FolderId[] {
  const { folders, accounts } = useApp.getState();
  const enabled = new Set(accounts.filter((a) => a.enabled).map((a) => a.id));
  switch (scope.kind) {
    case 'folder':
      return [scope.folderId];
    case 'accountInbox':
      return folders.filter((f) => f.accountId === scope.accountId && f.role === 'inbox').map((f) => f.id);
    case 'unifiedInbox':
    case 'unifiedUnread':
      return folders.filter((f) => f.role === 'inbox' && enabled.has(f.accountId)).map((f) => f.id);
    default:
      return [];
  }
}

export const useList = create<ListState>((set, get) => ({
  key: '',
  scope: null,
  search: null,
  serverSearching: false,
  searchSort: 'rank',
  setSearchSort(sort) {
    set((cur) => ({ searchSort: sort, items: orderSearch(cur.items, sort) }));
  },
  unreadOnly: false,
  grouped: false,
  items: [],
  nextCursor: null,
  canLoadOlder: false,
  endReached: false,
  total: null,
  loading: false,
  loadingMore: false,
  refreshing: false,
  error: null,
  selectedIds: [],
  anchorId: null,
  focusId: null,
  selectMode: false,

  async load(view, unreadOnly, groupedArg) {
    if (view.kind === 'search') return loadSearch(view.query, view.accountId, set, get);
    const scope = scopeOf(view);
    const grouped = groupedArg ?? wantsGrouped(view);
    const key = scopeKey(scope, unreadOnly, currentSortKey(), grouped);
    const mine = ++seq;
    const prev = get();
    const sameScope = prev.key === key;
    // Turning the setting on or off keeps the same mail selected: the conversation that holds the
    // selected message, or the newest message of the selected conversation.
    const baseKey = (k: string) => k.slice(0, k.lastIndexOf(','));
    const toggled = !sameScope && prev.key !== '' && baseKey(prev.key) === baseKey(key) && !prev.search;
    const carryIds = toggled
      ? prev.items
          .filter((m) => prev.selectedIds.includes(m.id))
          .flatMap((m) => (m.conv ? m.conv.messageIds : [m.id]))
      : [];
    set({
      key,
      scope,
      search: null,
      unreadOnly,
      grouped,
      loading: true,
      error: null,
      ...(sameScope
        ? {}
        : {
            items: [],
            nextCursor: null,
            canLoadOlder: false,
            endReached: false,
            total: null,
            selectedIds: [],
            anchorId: null,
            focusId: null,
            selectMode: false,
          }),
    });
    try {
      const res = await fetchPage(scope, null, PAGE, unreadOnly, grouped);
      if (mine !== seq) return;
      const carried = carryIds.length
        ? res.items.find((m) => (m.conv ? m.conv.messageIds.some((i) => carryIds.includes(i)) : carryIds.includes(m.id)))
        : undefined;
      set({
        items: res.items,
        nextCursor: res.nextCursor,
        canLoadOlder: res.canLoadOlderFromServer,
        total: res.total,
        loading: false,
        ...(carried ? { selectedIds: [carried.id], anchorId: carried.id, focusId: carried.id } : {}),
      });
    } catch (e) {
      if (mine !== seq) return;
      set({ loading: false, error: asAppError(e) });
    }
  },

  async loadMore() {
    const s = get();
    if (!s.scope || s.loading || s.loadingMore || s.error) return;
    const scope = s.scope;
    const mine = seq;
    if (s.nextCursor) {
      set({ loadingMore: true });
      try {
        const res = await fetchPage(scope, s.nextCursor, PAGE, s.unreadOnly, s.grouped);
        if (mine !== seq) return;
        const have = new Set(get().items.map((m) => m.id));
        set({
          items: [...get().items, ...res.items.filter((m) => !have.has(m.id))],
          nextCursor: res.nextCursor,
          canLoadOlder: res.canLoadOlderFromServer,
          loadingMore: false,
        });
      } catch (e) {
        if (mine === seq) set({ loadingMore: false, error: asAppError(e) });
      }
      return;
    }
    if (s.canLoadOlder && !s.endReached) {
      set({ loadingMore: true });
      try {
        let fetched = 0;
        for (const folderId of olderFolderIds(scope)) {
          const r = await call('sync.loadOlder', { folderId });
          fetched += r.fetched;
        }
        if (mine !== seq) return;
        if (fetched === 0) {
          set({ loadingMore: false, endReached: true });
          return;
        }
        // Sender and Subject sorts page by a sort key the UI never builds, and oldest-first puts the
        // older mail at the top: read the list again from the top, one page longer. Newest-first date
        // order can continue after the last row.
        const ls = useUi.getState().listSort;
        if (ls.sort !== 'date' || ls.direction === 'asc') {
          const before = get().items.length;
          await get().refresh(PAGE);
          if (mine !== seq) return;
          set((cur) => ({ loadingMore: false, ...(cur.items.length <= before ? { endReached: true } : {}) }));
          return;
        }
        const last = get().items[get().items.length - 1];
        const res = await fetchPage(scope, cursorAfter(last), PAGE, s.unreadOnly, s.grouped);
        if (mine !== seq) return;
        const have = new Set(get().items.map((m) => m.id));
        const fresh = res.items.filter((m) => !have.has(m.id));
        set({
          items: [...get().items, ...fresh],
          nextCursor: res.nextCursor,
          canLoadOlder: res.canLoadOlderFromServer,
          endReached: fresh.length === 0 && !res.nextCursor,
          loadingMore: false,
        });
      } catch (e) {
        if (mine === seq) set({ loadingMore: false, error: asAppError(e) });
      }
    }
  },

  /** Re-read everything already loaded (called when messages:changed arrives). */
  async refresh(extra = 0) {
    const s = get();
    if (s.search) {
      if (s.loading) return;
      const mine = seq;
      try {
        const res = await runSearch(s.search.query, s.search.accountId);
        if (mine !== seq) return;
        const ids = new Set(res.items.map((m) => m.id));
        set((cur) => ({
          items: orderSearch(res.items, cur.searchSort),
          search: cur.search && { ...cur.search, parsedFilters: res.parsedFilters, totalApprox: res.totalApprox },
          selectedIds: cur.selectedIds.filter((id) => ids.has(id)),
          focusId: cur.focusId !== null && ids.has(cur.focusId) ? cur.focusId : null,
        }));
      } catch {
        /* the next event retries */
      }
      return;
    }
    if (!s.scope || s.loading) return;
    const scope = s.scope;
    const mine = seq;
    const want = Math.max(PAGE, s.items.length) + extra;
    const grouped = s.grouped;
    set({ refreshing: true });
    try {
      let items: ListItem[] = [];
      let cursor: PageCursor | null = null;
      let last: Page | null = null;
      for (let i = 0; i < 10; i++) {
        const res: Page = await fetchPage(scope, cursor, Math.min(200, want - items.length || PAGE), s.unreadOnly, grouped);
        items = items.concat(res.items);
        last = res;
        if (!res.nextCursor || items.length >= want) break;
        cursor = res.nextCursor;
      }
      if (mine !== seq || !last) return;
      const fin: Page = last;
      set((cur) => {
        // A conversation gets a new newest message (a new id): keep it selected by its thread.
        const keep = (id: number | null): number | null => {
          if (id === null) return null;
          if (items.some((m) => m.id === id)) return id;
          const old = cur.items.find((m) => m.id === id);
          const thread = old?.conv?.threadId;
          return thread ? (items.find((m) => m.conv?.threadId === thread)?.id ?? null) : null;
        };
        const selectedIds = [...new Set(cur.selectedIds.map(keep).filter((x): x is number => x !== null))];
        return {
          items,
          nextCursor: fin.nextCursor,
          canLoadOlder: fin.canLoadOlderFromServer,
          total: fin.total ?? cur.total,
          refreshing: false,
          error: null,
          selectedIds,
          focusId: keep(cur.focusId),
          anchorId: keep(cur.anchorId),
        };
      });
    } catch {
      if (mine === seq) set({ refreshing: false });
    }
  },

  patch(ids, p) {
    const set_ = new Set(ids);
    set({ items: get().items.map((m) => (set_.has(m.id) ? { ...m, ...p } : m)) });
  },

  removeLocal(ids) {
    const gone = new Set(ids);
    set((cur) => ({
      items: cur.items.filter((m) => !gone.has(m.id)),
      selectedIds: cur.selectedIds.filter((id) => !gone.has(id)),
      focusId: cur.focusId !== null && gone.has(cur.focusId) ? null : cur.focusId,
      anchorId: cur.anchorId !== null && gone.has(cur.anchorId) ? null : cur.anchorId,
    }));
  },

  async searchOnServer() {
    const s = get().search;
    if (!s || get().serverSearching) return;
    set({ serverSearching: true });
    try {
      const accountIds = s.accountId ? [s.accountId] : undefined;
      const r = await call('search.server', { query: s.query, ...(accountIds ? { accountIds } : {}) });
      const res = await runSearch(s.query, s.accountId);
      set((cur) => ({
        serverSearching: false,
        items: orderSearch(res.items, cur.searchSort),
        search: cur.search && {
          ...cur.search,
          parsedFilters: res.parsedFilters,
          totalApprox: res.totalApprox,
          serverAdded: r.added,
        },
      }));
    } catch (e) {
      set({ serverSearching: false });
      throw e;
    }
  },

  selectOnly: (id) => set({ selectedIds: [id], anchorId: id, focusId: id }),
  toggle: (id) => {
    const cur = get().selectedIds;
    set({
      selectedIds: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id],
      anchorId: id,
      focusId: id,
    });
  },
  rangeTo: (id) => {
    const { items, anchorId } = get();
    const a = items.findIndex((m) => m.id === (anchorId ?? id));
    const b = items.findIndex((m) => m.id === id);
    if (a < 0 || b < 0) return get().selectOnly(id);
    const [lo, hi] = a < b ? [a, b] : [b, a];
    set({ selectedIds: items.slice(lo, hi + 1).map((m) => m.id), focusId: id });
  },
  selectAll: () => set({ selectedIds: get().items.map((m) => m.id) }),
  clearSelection: () => set({ selectedIds: [], anchorId: null }),
  setSelectMode: (on) => set({ selectMode: on, ...(on ? {} : { selectedIds: [] }) }),
  setFocus: (id) => set({ focusId: id }),
}));

async function loadSearch(
  query: string,
  accountId: string | null,
  set: (p: Partial<ListState> | ((s: ListState) => Partial<ListState>)) => void,
  get: () => ListState,
): Promise<void> {
  const key = JSON.stringify(['search', query, accountId]);
  const mine = ++seq;
  const same = get().key === key;
  set({
    key,
    scope: null,
    loading: true,
    error: null,
    unreadOnly: false,
    grouped: false,
    ...(same
      ? {}
      : {
          items: [],
          nextCursor: null,
          canLoadOlder: false,
          endReached: true,
          total: null,
          selectedIds: [],
          anchorId: null,
          focusId: null,
          selectMode: false,
          search: { query, accountId, parsedFilters: [], totalApprox: 0, coverage: { messagesIndexed: 0, bodiesIndexed: 0 }, serverAdded: null },
        }),
  });
  try {
    const res = await runSearch(query, accountId);
    if (mine !== seq) return;
    set((cur) => ({
      items: orderSearch(res.items, cur.searchSort),
      loading: false,
      nextCursor: null,
      canLoadOlder: false,
      endReached: true,
      total: res.items.length,
      search: {
        query,
        accountId,
        parsedFilters: res.parsedFilters,
        totalApprox: res.totalApprox,
        coverage: res.coverage,
        serverAdded: same ? (cur.search?.serverAdded ?? null) : null,
      },
    }));
  } catch (e) {
    if (mine !== seq) return;
    set({ loading: false, error: asAppError(e) });
  }
}

/** The message shown in the reading pane: only when exactly one is selected. */
export function openIdOf(s: Pick<ListState, 'selectedIds'>): MessageId | null {
  return s.selectedIds.length === 1 ? s.selectedIds[0]! : null;
}
