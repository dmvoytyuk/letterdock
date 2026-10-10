import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { AccountId, ConversationSort, FolderId, ListScope, MessageId, Rule, RuleCondition } from '../../../shared/ipc';

export type View =
  | { kind: 'all' }
  | { kind: 'unread' }
  | { kind: 'flagged' }
  | { kind: 'account'; accountId: AccountId }
  | { kind: 'folder'; folderId: FolderId }
  | { kind: 'outbox' }
  /** Mail waiting to be sent later (DESIGN-SPEC 3.11). `accountId` null = every account. */
  | { kind: 'scheduled'; accountId: AccountId | null }
  | { kind: 'search'; query: string; accountId: AccountId | null };

/** How the list of conversations is ordered (DESIGN-SPEC 3.5, 3.10.2). One choice for every folder. */
export interface ListSort {
  sort: ConversationSort;
  direction: 'asc' | 'desc';
}
/** Date: newest first. Sender and Subject: A to Z. */
export function defaultDirection(sort: ConversationSort): 'asc' | 'desc' {
  return sort === 'date' ? 'desc' : 'asc';
}
export const DEFAULT_SORT: ListSort = { sort: 'date', direction: 'desc' };

export type Page = 'mail' | 'settings';
export type SettingsSection =
  'accounts' | 'general' | 'appearance' | 'mail' | 'rules' | 'notifications' | 'keys' | 'shortcuts' | 'about';
export type Density = 'compact' | 'comfortable' | 'roomy';
export type LayoutMode = 'wide' | 'medium' | 'narrow';

export const LIMITS = {
  sidebar: { def: 264, min: 200, max: 360 },
  list: { def: 380, min: 280, max: 560 },
  readingMin: 360,
};
export const ROW_HEIGHT: Record<Density, number> = { compact: 56, comfortable: 68, roomy: 80 };

export interface AddAccountRequest {
  initialEmail?: string;
  /** Account to sign in again (password or OAuth). */
  reauthAccountId?: AccountId;
  /** Which button the user picked on the Welcome screen (changes the hint only). */
  hintProvider?: 'gmail' | 'microsoft';
}

/** What the rule editor opens with (DESIGN-SPEC 3.12.2, 3.12.3). */
export interface RuleEditorRequest {
  /** Edit this rule. */
  rule?: Rule;
  /** A new rule, started from a message ("Create rule from this sender..."). */
  prefill?: { name: string; accountId: AccountId | null; conditions: RuleCondition[] };
}
/** The "Run rule now" dialog (DESIGN-SPEC 3.12.4). */
export interface RunRulesRequest {
  ruleId: number | 'all';
  folderId?: FolderId | 'allInboxes';
}

export type FolderDialog =
  | { kind: 'create'; accountId: AccountId; parentPath: string | null; parentName: string | null }
  | { kind: 'rename'; folderId: FolderId }
  | { kind: 'delete'; folderId: FolderId };

interface UiState {
  // persisted
  sidebarCollapsed: boolean;
  sidebarW: number;
  listW: number;
  density: Density;
  /** DESIGN-SPEC 3.6.1 F: 'auto' adapts designed mail in the dark theme, 'light' always uses a light background. */
  emailDarkMode: 'auto' | 'light';
  /** Show the account badge in single-account folders too (always shown in unified views with 2+ accounts). */
  showAccountBadge: boolean;
  /** DESIGN-SPEC 4.8: the status bar at the bottom of the main window. */
  showStatusBar: boolean;
  expanded: Record<AccountId, boolean>;
  moreOpen: Record<AccountId, boolean>;
  /** Last folders the user moved mail to, per account (newest first). */
  recentFolders: Record<AccountId, FolderId[]>;
  recentSearches: string[];
  /** Order of the message list and of the conversation list (one global choice). */
  listSort: ListSort;

  // session
  page: Page;
  settingsSection: SettingsSection;
  settingsAccountId: AccountId | null;
  view: View;
  /** The view to return to when a search ends. */
  prevView: View;
  unreadOnly: boolean;
  mode: LayoutMode;
  drawerOpen: boolean;
  /** Narrow mode: true while the reading pane replaces the list. */
  readerOpen: boolean;
  addAccount: AddAccountRequest | null;
  folderDialog: FolderDialog | null;
  removeAccountId: AccountId | null;
  cheatsheetOpen: boolean;
  searchHint: boolean;
  /** Which sync popover is open: the title bar button's or the status bar's. They never open together. */
  syncPopover: 'title' | 'bar' | null;
  searchFocusTick: number;
  /** Message to select once the list has it (from ui:openMessage). */
  pendingOpenMessageId: number | null;
  moveDialog: MessageId[] | null;
  /** Messages waiting for the "delete permanently?" confirmation, and how many messages that is. */
  confirmPermanent: { ids: MessageId[]; count: number } | null;
  /** Trash or Junk folder waiting for the "empty it?" confirmation. */
  emptyFolderId: FolderId | null;
  /** The rule editor, when open. `{}` is a new empty rule. */
  ruleEditor: RuleEditorRequest | null;
  /** The "Run rule now" dialog, when open. */
  runRules: RunRulesRequest | null;
  /** Which tab of Settings > Rules is shown. */
  rulesTab: 'rules' | 'activity';

  set: (p: Partial<UiState>) => void;
  setView: (v: View) => void;
  toggleExpanded: (id: AccountId, value?: boolean) => void;
  openSettings: (section?: SettingsSection, accountId?: AccountId | null) => void;
  closeSettings: () => void;
  startSearch: (query: string, accountId: AccountId | null) => void;
  exitSearch: () => void;
  /** Leave search or the outbox view (used before showing a specific message). */
  exitSearchOrOutbox: () => void;
  rememberFolder: (accountId: AccountId, folderId: FolderId) => void;
  setListSort: (sort: ConversationSort, direction?: 'asc' | 'desc') => void;
}

export const useUi = create<UiState>()(
  persist(
    (set) => ({
      sidebarCollapsed: false,
      sidebarW: LIMITS.sidebar.def,
      listW: LIMITS.list.def,
      density: 'comfortable',
      emailDarkMode: 'auto',
      showAccountBadge: false,
      showStatusBar: true,
      expanded: {},
      moreOpen: {},
      recentFolders: {},
      recentSearches: [],
      listSort: DEFAULT_SORT,

      page: 'mail',
      settingsSection: 'accounts',
      settingsAccountId: null,
      view: { kind: 'all' },
      prevView: { kind: 'all' },
      unreadOnly: false,
      mode: 'wide',
      drawerOpen: false,
      readerOpen: false,
      addAccount: null,
      folderDialog: null,
      removeAccountId: null,
      cheatsheetOpen: false,
      searchHint: false,
      syncPopover: null,
      searchFocusTick: 0,
      pendingOpenMessageId: null,
      moveDialog: null,
      confirmPermanent: null,
      emptyFolderId: null,
      ruleEditor: null,
      runRules: null,
      rulesTab: 'rules',

      set: (p) => set(p),
      setView: (view) => set({ view, page: 'mail', drawerOpen: false, readerOpen: false }),
      toggleExpanded: (id, value) =>
        set((s) => ({ expanded: { ...s.expanded, [id]: value ?? !s.expanded[id] } })),
      openSettings: (section, accountId) =>
        set((s) => ({
          page: 'settings',
          drawerOpen: false,
          settingsSection: section ?? s.settingsSection,
          settingsAccountId: accountId === undefined ? null : accountId,
        })),
      closeSettings: () => set({ page: 'mail' }),
      startSearch: (query, accountId) =>
        set((s) => {
          const q = query.trim();
          const recent = [q, ...s.recentSearches.filter((x) => x !== q)].slice(0, 5);
          return {
            view: { kind: 'search', query: q, accountId },
            prevView: s.view.kind === 'search' ? s.prevView : s.view,
            recentSearches: recent,
            page: 'mail',
            readerOpen: false,
            drawerOpen: false,
          };
        }),
      exitSearch: () =>
        set((s) => (s.view.kind === 'search' ? { view: s.prevView, readerOpen: false } : s)),
      exitSearchOrOutbox: () =>
        set((s) =>
          s.view.kind === 'search'
            ? { view: s.prevView.kind === 'outbox' || s.prevView.kind === 'scheduled' ? { kind: 'all' } : s.prevView }
            : s.view.kind === 'outbox' || s.view.kind === 'scheduled'
              ? { view: { kind: 'all' } }
              : s,
        ),
      setListSort: (sort, direction) => set({ listSort: { sort, direction: direction ?? defaultDirection(sort) } }),
      rememberFolder: (accountId, folderId) =>
        set((s) => ({
          recentFolders: {
            ...s.recentFolders,
            [accountId]: [
              folderId,
              ...(s.recentFolders[accountId] ?? []).filter((x) => x !== folderId),
            ].slice(0, 4),
          },
        })),
    }),
    {
      name: 'letterdock.ui',
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({
        sidebarCollapsed: s.sidebarCollapsed,
        sidebarW: s.sidebarW,
        listW: s.listW,
        density: s.density,
        emailDarkMode: s.emailDarkMode,
        showAccountBadge: s.showAccountBadge,
        showStatusBar: s.showStatusBar,
        expanded: s.expanded,
        moreOpen: s.moreOpen,
        recentFolders: s.recentFolders,
        recentSearches: s.recentSearches,
        listSort: s.listSort,
      }),
    },
  ),
);

export function scopeOf(view: View): ListScope {
  switch (view.kind) {
    case 'all':
      return { kind: 'unifiedInbox' };
    case 'unread':
      return { kind: 'unifiedUnread' };
    case 'flagged':
      return { kind: 'unifiedFlagged' };
    case 'account':
      return { kind: 'accountInbox', accountId: view.accountId };
    case 'folder':
      return { kind: 'folder', folderId: view.folderId };
    default:
      // Outbox and search have their own data; the list store handles them separately.
      return { kind: 'unifiedInbox' };
  }
}

export function isUnified(view: View): boolean {
  return (
    view.kind === 'all' ||
    view.kind === 'unread' ||
    view.kind === 'flagged' ||
    view.kind === 'search'
  );
}
