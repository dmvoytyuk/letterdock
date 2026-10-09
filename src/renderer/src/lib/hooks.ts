import { useCallback, useEffect, useMemo } from 'react';
import { create } from 'zustand';
import type { Account, AccountId } from '../../../shared/ipc';
import { useApp } from '../store/app';
import { useUi, type LayoutMode } from '../store/ui';
import { useList } from '../store/list';
import { resolveAccountColor } from './colors';
import { call } from './api';
import { handleOutboxEvent, useOutbox } from '../store/outbox';
import { toast, toastError } from '../store/toasts';
import { backOnlineText, reportDroppedChanges, reportQueueFailure } from './queueFailures';

// ---------- theme ----------
export const useThemeState = create<{ dark: boolean }>(() => ({ dark: false }));

/** Applies data-theme from the Theme setting, following the system when set to "system". */
export function useThemeEffect(): void {
  const theme = useApp((s) => s.settings?.theme ?? 'system');
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const dark = theme === 'dark' || (theme === 'system' && mq.matches);
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
      useThemeState.setState({ dark });
    };
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [theme]);
}

/** Color to draw for an account (palette-aware, light/dark). */
export function useAccountColor(): (id: AccountId) => string {
  const accounts = useApp((s) => s.accounts);
  const dark = useThemeState((s) => s.dark);
  return useCallback(
    (id: AccountId) => {
      const i = accounts.findIndex((a) => a.id === id);
      return resolveAccountColor(i >= 0 ? (accounts[i]!.color ?? null) : null, dark, Math.max(i, 0));
    },
    [accounts, dark],
  );
}

export function useAccountMap(): Map<AccountId, Account> {
  const accounts = useApp((s) => s.accounts);
  return useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);
}

// ---------- layout mode ----------
export function modeForWidth(w: number): LayoutMode {
  if (w >= 1100) return 'wide';
  if (w >= 800) return 'medium';
  return 'narrow';
}

export function useLayoutModeEffect(): void {
  useEffect(() => {
    const apply = () => {
      const mode = modeForWidth(window.innerWidth);
      const s = useUi.getState();
      if (s.mode !== mode) useUi.setState({ mode, drawerOpen: false });
    };
    apply();
    window.addEventListener('resize', apply);
    return () => window.removeEventListener('resize', apply);
  }, []);
}

// ---------- events from the engine ----------
export function useAppEvents(): void {
  useEffect(() => {
    void useApp.getState().loadAll();
    void useOutbox.getState().refetch();
    const off = window.api.on((e) => {
      useApp.getState().handleEvent(e);
      handleOutboxEvent(e);
      if (e.type === 'action:failed') {
        // The server refused a change for good and the engine undid it. Tell the user (grouped).
        reportQueueFailure(e);
        scheduleRefresh();
      } else if (e.type === 'pending:dropped') {
        reportDroppedChanges(e);
      } else if (e.type === 'ui:compose') {
        call('compose.openWindow', { mode: 'new', mailto: e.mailto }).catch((err) =>
          toastError((err as { message?: string }).message ?? 'Could not open the message.'),
        );
      } else if (e.type === 'messages:changed') {
        const list = useList.getState();
        const scope = list.scope;
        if (list.search) {
          scheduleRefresh();
          return;
        }
        if (!scope) return;
        let relevant = true;
        if (e.folderIds.length > 0) {
          const folders = useApp.getState().folders;
          const touched = folders.filter((f) => e.folderIds.includes(f.id));
          if (scope.kind === 'folder') relevant = e.folderIds.includes(scope.folderId);
          else if (scope.kind === 'accountInbox')
            relevant = touched.some((f) => f.accountId === scope.accountId && f.role === 'inbox');
          else if (scope.kind === 'unifiedFlagged') relevant = true;
          else relevant = touched.some((f) => f.role === 'inbox');
        }
        if (relevant) scheduleRefresh();
      } else if (e.type === 'engine:restarted') {
        scheduleRefresh();
      } else if (e.type === 'ui:openMessage') {
        const ui = useUi.getState();
        if (ui.view.kind === 'search' || ui.view.kind === 'outbox') ui.exitSearchOrOutbox();
        useUi.setState({ pendingOpenMessageId: e.messageId, page: 'mail' });
      }
    });
    const online = () => {
      const wasOffline = !useApp.getState().online;
      useApp.setState({ online: true });
      if (wasOffline) toast(backOnlineText(), { duration: 4000 });
      void window.api.invoke('system.networkChanged', { online: true }).catch(() => undefined);
    };
    const offline = () => {
      useApp.setState({ online: false });
      void window.api.invoke('system.networkChanged', { online: false }).catch(() => undefined);
    };
    window.addEventListener('online', online);
    window.addEventListener('offline', offline);
    return () => {
      off();
      window.removeEventListener('online', online);
      window.removeEventListener('offline', offline);
    };
  }, []);
}

let refreshTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleRefresh(): void {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void useList.getState().refresh();
  }, 150);
}
