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
import { useUpdates } from '../store/updates';
import { useConvSignal } from '../store/conversations';
import { undoWithToken, useUndo } from '../store/undo';
import { handleScheduledEvent, useScheduled } from '../store/scheduled';
import { useSnooze } from '../store/snooze';
import { handleRulesEvent, useRules } from '../store/rules';
import { backOnlineText, reportDroppedChanges, reportFolderConflict, reportQueueFailure } from './queueFailures';

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
    void useScheduled.getState().refetch();
    void useSnooze.getState().refetch();
    void useRules.getState().refetchRules();
    call('updates.status')
      .then((s) => useUpdates.getState().setStatus(s))
      .catch(() => undefined);
    const off = window.api.on((e) => {
      useApp.getState().handleEvent(e);
      handleOutboxEvent(e);
      handleScheduledEvent(e);
      handleRulesEvent(e);
      if (e.type === 'update:status') {
        useUpdates.getState().setStatus(e.status);
      } else if (e.type === 'action:failed') {
        // The server refused a change for good and the engine undid it. Tell the user (grouped).
        reportQueueFailure(e);
        scheduleRefresh();
      } else if (e.type === 'pending:dropped') {
        reportDroppedChanges(e);
      } else if (e.type === 'folder:conflict') {
        // A folder change from the offline queue met a difference on the server.
        reportFolderConflict(e);
      } else if (e.type === 'ui:undoAvailable') {
        // A message window archived, deleted or moved a message and closed: its Undo lives here now.
        useUndo.getState().push(e.undoToken, e.count);
        toast(e.label, { actionLabel: 'Undo', onAction: () => void undoWithToken(e.undoToken), duration: 6000 });
      } else if (e.type === 'ui:openSettings') {
        useUi.getState().openSettings(e.section, null);
      } else if (e.type === 'ui:compose') {
        call('compose.openWindow', { mode: 'new', mailto: e.mailto }).catch((err) =>
          toastError((err as { message?: string }).message ?? 'Could not open the message.'),
        );
      } else if (e.type === 'conversations:changed') {
        // The open conversation and the list reload. About 2000 ids mean "everything".
        useConvSignal.getState().bump(e.threadIds);
        if (useList.getState().grouped) scheduleRefresh(400);
      } else if (e.type === 'messages:changed') {
        useConvSignal.getState().bump();
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
      } else if (e.type === 'snooze:changed' || e.type === 'snooze:returned') {
        // Snoozed mail was set, cleared or woke up: counts, the Snoozed view and the list change.
        void useSnooze.getState().refetch();
        useConvSignal.getState().bump();
        scheduleRefresh();
      } else if (e.type === 'notify:actionDone') {
        // A button on a notification did its work in the background (DESIGN-SPEC 3.13.3).
        if (e.action === 'archive') {
          const token = e.undoToken;
          if (token) useUndo.getState().push(token, 1);
          toast('Moved to Archive', {
            duration: 6000,
            ...(token ? { actionLabel: 'Undo', onAction: () => void undoWithToken(token) } : {}),
          });
        } else toast('Marked as read');
        scheduleRefresh();
      } else if (e.type === 'engine:restarted') {
        void useSnooze.getState().refetch();
        void useScheduled.getState().refetch();
        void useRules.getState().refetchRules();
        scheduleRefresh();
      } else if (e.type === 'ui:openMessage') {
        const ui = useUi.getState();
        if (ui.view.kind === 'search' || ui.view.kind === 'outbox' || ui.view.kind === 'scheduled' || ui.view.kind === 'snoozed') ui.exitSearchOrOutbox();
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
function scheduleRefresh(ms = 150): void {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void useList.getState().refresh();
  }, ms);
}
