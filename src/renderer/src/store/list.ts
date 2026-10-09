import { create } from 'zustand';
import type {
  AppError,
  SearchRes,
  FolderId,
  ListMessagesRes,
  ListScope,
  MessageHeader,
  MessageId,
  PageCursor,
} from '../../../shared/ipc';
import { asAppError, call } from '../lib/api';
import { useApp } from './app';
import { scopeOf, type View } from './ui';

export const PAGE = 50;

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
  items: MessageHeader[];
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

  load: (view: View, unreadOnly: boolean) => Promise<void>;
  loadMore: () => Promise<void>;
  refresh: () => Promise<void>;
  patch: (ids: MessageId[], p: Partial<MessageHeader>) => void;
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

const scopeKey = (scope: ListScope, unreadOnly: boolean) => JSON.stringify([scope, unreadOnly]);
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

  async load(view, unreadOnly) {
    if (view.kind === 'search') return loadSearch(view.query, view.accountId, set, get);
    const scope = scopeOf(view);
    const key = scopeKey(scope, unreadOnly);
    const mine = ++seq;
    const sameScope = get().key === key;
    set({
      key,
      scope,
      search: null,
      unreadOnly,
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
      const res = await call('messages.list', { scope, cursor: null, limit: PAGE, unreadOnly });
      if (mine !== seq) return;
      set({
        items: res.items,
        nextCursor: res.nextCursor,
        canLoadOlder: res.canLoadOlderFromServer,
        total: res.total,
        loading: false,
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
        const res = await call('messages.list', {
          scope,
          cursor: s.nextCursor,
          limit: PAGE,
          unreadOnly: s.unreadOnly,
        });
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
        const last = get().items[get().items.length - 1];
        const res = await call('messages.list', {
          scope,
          cursor: last ? { date: last.date, id: last.id } : null,
          limit: PAGE,
          unreadOnly: s.unreadOnly,
        });
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
  async refresh() {
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
    const want = Math.max(PAGE, s.items.length);
    set({ refreshing: true });
    try {
      let items: MessageHeader[] = [];
      let cursor: PageCursor | null = null;
      let last: ListMessagesRes | null = null;
      for (let i = 0; i < 10; i++) {
        const res: ListMessagesRes = await call('messages.list', {
          scope,
          cursor,
          limit: Math.min(200, want - items.length || PAGE),
          unreadOnly: s.unreadOnly,
        });
        items = items.concat(res.items);
        last = res;
        if (!res.nextCursor || items.length >= want) break;
        cursor = res.nextCursor;
      }
      if (mine !== seq || !last) return;
      const fin: ListMessagesRes = last;
      const ids = new Set(items.map((m) => m.id));
      set((cur) => ({
        items,
        nextCursor: fin.nextCursor,
        canLoadOlder: fin.canLoadOlderFromServer,
        total: fin.total ?? cur.total,
        refreshing: false,
        error: null,
        selectedIds: cur.selectedIds.filter((id) => ids.has(id)),
        focusId: cur.focusId !== null && ids.has(cur.focusId) ? cur.focusId : null,
        anchorId: cur.anchorId !== null && ids.has(cur.anchorId) ? cur.anchorId : null,
      }));
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
