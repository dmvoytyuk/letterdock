import { create } from 'zustand';
import type {
  Account,
  AccountId,
  AccountStatus,
  AppError,
  AppEvent,
  AppSettings,
  Folder,
  FolderCounts,
  OAuthSettings,
} from '../../../shared/ipc';
import { asAppError, call } from '../lib/api';
import type { ShortcutPreset } from '../lib/shortcuts';

export interface SyncProgress {
  folderId: number | null;
  phase: 'folders' | 'initial' | 'incremental' | 'older' | 'idle';
  done: number;
  total: number | null;
}

/** The shortcut style the user picked (Outlook until settings are loaded). */
export function activePreset(): ShortcutPreset {
  return useApp.getState().settings?.shortcutPreset === 'gmail' ? 'gmail' : 'outlook';
}

interface AppState {
  loaded: boolean;
  loadError: AppError | null;
  accounts: Account[];
  statuses: Record<AccountId, AccountStatus>;
  folders: Folder[];
  counts: FolderCounts | null;
  settings: AppSettings | null;
  oauth: OAuthSettings | null;
  progress: Record<AccountId, SyncProgress>;
  authRequired: Record<AccountId, 'password' | 'oauth'>;
  online: boolean;
  /** Bumped when everything must be refetched (engine restarted). */
  epoch: number;

  loadAll: () => Promise<void>;
  refetchAccounts: () => Promise<void>;
  refetchFolders: (accountId?: AccountId) => Promise<void>;
  refetchCounts: () => Promise<void>;
  refetchStatuses: () => Promise<void>;
  updateSettings: (patch: Partial<AppSettings>) => Promise<void>;
  setOAuth: (o: OAuthSettings) => void;
  handleEvent: (e: AppEvent) => void;
}

function byId(list: AccountStatus[]): Record<AccountId, AccountStatus> {
  const out: Record<AccountId, AccountStatus> = {};
  for (const s of list) out[s.accountId] = s;
  return out;
}

export const useApp = create<AppState>((set, get) => ({
  loaded: false,
  loadError: null,
  accounts: [],
  statuses: {},
  folders: [],
  counts: null,
  settings: null,
  oauth: null,
  progress: {},
  authRequired: {},
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  epoch: 0,

  async loadAll() {
    try {
      const [accounts, statuses, folders, counts, settings, oauth] = await Promise.all([
        call('accounts.list'),
        call('accounts.statuses'),
        call('folders.list', {}),
        call('folders.counts'),
        call('settings.get'),
        call('oauth.getSettings'),
      ]);
      set((s) => ({
        loaded: true,
        loadError: null,
        accounts,
        statuses: byId(statuses),
        folders,
        counts,
        settings,
        oauth,
        epoch: s.epoch + 1,
      }));
    } catch (e) {
      set({ loaded: true, loadError: asAppError(e) });
    }
  },

  async refetchAccounts() {
    try {
      const [accounts, statuses] = await Promise.all([
        call('accounts.list'),
        call('accounts.statuses'),
      ]);
      set({ accounts, statuses: byId(statuses) });
      await Promise.all([get().refetchFolders(), get().refetchCounts()]);
    } catch {
      /* the next event retries */
    }
  },

  async refetchFolders(accountId) {
    try {
      const folders = await call('folders.list', accountId ? { accountId } : {});
      if (!accountId) set({ folders });
      else set((s) => ({ folders: [...s.folders.filter((f) => f.accountId !== accountId), ...folders] }));
    } catch {
      /* ignore */
    }
  },

  async refetchCounts() {
    try {
      set({ counts: await call('folders.counts') });
    } catch {
      /* ignore */
    }
  },

  async refetchStatuses() {
    try {
      set({ statuses: byId(await call('accounts.statuses')) });
    } catch {
      /* ignore */
    }
  },

  async updateSettings(patch) {
    const prev = get().settings;
    if (prev) set({ settings: { ...prev, ...patch } });
    try {
      set({ settings: await call('settings.set', patch) });
    } catch (e) {
      if (prev) set({ settings: prev });
      throw e;
    }
  },

  setOAuth: (oauth) => set({ oauth }),

  handleEvent(e) {
    switch (e.type) {
      case 'account:status':
        set((s) => ({ statuses: { ...s.statuses, [e.status.accountId]: e.status } }));
        if (e.status.state === 'online') {
          set((s) => {
            if (!s.authRequired[e.status.accountId]) return s;
            const rest = { ...s.authRequired };
            delete rest[e.status.accountId];
            return { authRequired: rest };
          });
        }
        break;
      case 'account:authRequired':
        set((s) => ({ authRequired: { ...s.authRequired, [e.accountId]: e.reason } }));
        break;
      case 'accounts:changed':
        void get().refetchAccounts();
        break;
      case 'folders:changed':
        void get().refetchFolders(e.accountId);
        break;
      case 'counts:changed':
        set({ counts: { unifiedInboxUnread: e.unifiedInboxUnread, perFolder: e.perFolder } });
        break;
      case 'sync:progress':
        set((s) => ({
          progress: {
            ...s.progress,
            [e.accountId]: {
              folderId: e.folderId,
              phase: e.phase,
              done: e.done,
              total: e.total,
            },
          },
        }));
        break;
      case 'pending:count':
        // Changes waiting to sync (offline queue). The count also arrives with account:status.
        set((s) => {
          const cur = s.statuses[e.accountId];
          return cur ? { statuses: { ...s.statuses, [e.accountId]: { ...cur, pendingCount: e.count } } } : s;
        });
        break;
      case 'engine:restarted':
        void get().loadAll();
        break;
      case 'settings:changed':
        // Settings were changed in another window (theme and so on).
        set({ settings: e.settings, oauth: e.oauth });
        break;
      default:
        break;
    }
  },
}));

// ---------- selectors / helpers ----------
export function unreadOfFolder(counts: FolderCounts | null, f: Folder): number {
  const c = counts?.perFolder.find((p) => p.folderId === f.id);
  return c ? c.unread : f.unreadCount;
}

/** Number of messages in a folder (live number from the counts event, folder list as fallback). */
export function totalOfFolder(counts: FolderCounts | null, f: Folder): number {
  const c = counts?.perFolder.find((p) => p.folderId === f.id);
  return c ? c.total : f.totalCount;
}

export function accountInbox(folders: Folder[], accountId: AccountId): Folder | undefined {
  return folders.find((f) => f.accountId === accountId && f.role === 'inbox');
}
