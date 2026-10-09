import { useEffect } from 'react';
import { isTypingTarget, matchShortcut, type ShortcutId } from '../../lib/shortcuts';
import { useApp, accountInbox } from '../../store/app';
import { useList } from '../../store/list';
import { useUi } from '../../store/ui';
import { applyToMessages, composeFrom, deleteMessages, newMessage, openInWindow } from '../../lib/actions';
import { undoLast } from '../../store/undo';
import { printOpenMessage } from '../../lib/print';
import { toast } from '../../store/toasts';
import { useMenu } from '../../components/ui';
import { syncAll } from './TitleBar';
import { toggleSidebar } from '../sidebar/SidebarToggle';

/** Shortcuts that still work while the user types in a field. */
const WORKS_WHILE_TYPING: ShortcutId[] = [
  'compose',
  'addAccount',
  'search',
  'settings',
  'toggleSidebar',
  'nextPane',
  'prevPane',
  'syncAll',
  'cheatsheet',
];
/** Plain keys (no Ctrl) that only act when focus is in the list or reading pane. */
const PLAIN_KEYS: ShortcutId[] = ['delete', 'deletePermanent', 'archive', 'flag', 'open'];

function focusPane(dir: 1 | -1): void {
  // The status bar (DESIGN-SPEC 4.8) is the last stop. It is skipped when it is not on screen.
  const stops: { sel: string; get: () => HTMLElement | null }[] = [
    { sel: 'nav.sidebar', get: () => document.querySelector<HTMLElement>('nav.sidebar [data-nav]') },
    {
      sel: '#pane-list',
      get: () => document.querySelector<HTMLElement>('#pane-list [role=listbox]') ?? document.querySelector<HTMLElement>('#pane-list'),
    },
    {
      sel: '#pane-reading',
      get: () => document.querySelector<HTMLElement>('#pane-reading .rtool button') ?? document.querySelector<HTMLElement>('#pane-reading'),
    },
    { sel: '.statusbar', get: () => document.querySelector<HTMLElement>('.statusbar button:not([disabled])') },
  ];
  const current = stops.findIndex((p) => document.activeElement?.closest(p.sel));
  for (let step = 1; step <= stops.length; step++) {
    const i = current < 0 ? 0 : (current + dir * step + stops.length * step) % stops.length;
    const el = stops[i]!.get();
    if (el) {
      el.focus();
      // A pane that cannot take focus (an empty reading pane) is skipped.
      if (el.contains(document.activeElement)) return;
    }
    if (current < 0) break;
  }
}

export function useGlobalShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const sc = matchShortcut(e);
      if (!sc) return;
      const ui = useUi.getState();
      const typing = isTypingTarget(e.target);
      if (typing && !WORKS_WHILE_TYPING.includes(sc.id) && sc.id !== 'back') return;
      if (document.querySelector('.modal') && sc.id !== 'back') {
        // A dialog is open: only Esc (handled by the dialog itself) matters.
        return;
      }
      if (useMenu.getState().menu) return;
      const target = e.target as HTMLElement | null;
      const inMail = !target || target === document.body || !!target.closest('#pane-list, #pane-reading');
      if (PLAIN_KEYS.includes(sc.id) && !inMail) return;
      if (sc.id === 'open' && !target?.closest('#pane-list')) return;
      if ((sc.id === 'archive' || sc.id === 'delete' || sc.id === 'flag') && target?.closest('#pane-reading button')) {
        // Enter/Space on a toolbar button is theirs; these keys are fine though.
      }

      const list = useList.getState();
      const ids = list.selectedIds.length ? list.selectedIds : list.focusId !== null ? [list.focusId] : [];
      const first = list.items.find((m) => m.id === ids[0]);
      // The outbox view has no message list on screen: message keys must not touch rows that are hidden.
      const messageLevel = ui.page === 'mail' && ui.view.kind !== 'outbox';

      const run = (fn: () => void) => {
        e.preventDefault();
        fn();
      };
      switch (sc.id) {
        case 'compose':
          return run(newMessage);
        case 'addAccount':
          return run(() => ui.set({ addAccount: {} }));
        case 'search':
          return run(() => ui.set({ searchFocusTick: ui.searchFocusTick + 1 }));
        case 'settings':
          return run(() => ui.openSettings());
        case 'toggleSidebar':
          return run(toggleSidebar);
        case 'nextPane':
          return run(() => focusPane(1));
        case 'prevPane':
          return run(() => focusPane(-1));
        case 'syncAll':
          return run(syncAll);
        case 'goAll':
          return run(() => ui.setView({ kind: 'all' }));
        case 'goAccount': {
          const n = Number(e.key) - 2;
          const a = useApp.getState().accounts[n];
          if (!a) return;
          const inbox = accountInbox(useApp.getState().folders, a.id);
          return run(() => ui.setView(inbox ? { kind: 'folder', folderId: inbox.id } : { kind: 'account', accountId: a.id }));
        }
        case 'goInbox': {
          const folders = useApp.getState().folders;
          let accountId: string | undefined;
          if (ui.view.kind === 'account') accountId = ui.view.accountId;
          else if (ui.view.kind === 'folder') {
            const fid = ui.view.folderId;
            accountId = folders.find((f) => f.id === fid)?.accountId;
          }
          const inbox = accountId ? accountInbox(folders, accountId) : undefined;
          return run(() => ui.setView(inbox ? { kind: 'folder', folderId: inbox.id } : { kind: 'all' }));
        }
        case 'cheatsheet':
          return run(() => ui.set({ cheatsheetOpen: true }));
        case 'back': {
          if (ui.cheatsheetOpen) return run(() => ui.set({ cheatsheetOpen: false }));
          if (ui.drawerOpen) return run(() => ui.set({ drawerOpen: false }));
          if (typing) return; // the field handles its own Esc
          if (ui.view.kind === 'search') return run(() => ui.exitSearch());
          if (ui.page === 'settings') return run(() => ui.closeSettings());
          if (ui.mode === 'narrow' && ui.readerOpen) return run(() => ui.set({ readerOpen: false }));
          if (list.selectMode) return run(() => list.setSelectMode(false));
          return;
        }
        default:
          break;
      }
      if (!messageLevel) return;
      switch (sc.id) {
        case 'reply':
          return run(() => composeFrom('reply', ids[0]));
        case 'replyAll':
          return run(() => composeFrom('replyAll', ids[0]));
        case 'forward':
          return run(() => composeFrom('forward', ids[0]));
        case 'move':
          return run(() => {
            if (ids.length > 0) ui.set({ moveDialog: ids });
          });
        case 'open':
          return run(() => {
            if (ids.length === 1 && first) openInWindow(first);
          });
        case 'print':
          return run(() => {
            if (ids.length !== 1 || !first) toast('Select one message to print it.');
            else printOpenMessage(first.id);
          });
        // Shift+Delete: the contract has no "permanent delete" for mail outside Trash, so both keys
        // move the message to Trash (mail already in Trash is deleted for good after a confirmation).
        case 'delete':
        case 'deletePermanent':
          return run(() => deleteMessages(ids));
        case 'archive':
          return run(() => void applyToMessages(ids, { type: 'archive' }));
        case 'markRead':
          return run(() => void applyToMessages(ids, { type: 'markRead', read: true }));
        case 'markUnread':
          return run(() => void applyToMessages(ids, { type: 'markRead', read: false }));
        case 'flag':
          return run(() => void applyToMessages(ids, { type: 'flag', flagged: !(first?.flagged ?? false) }));
        case 'selectAll':
          return run(() => list.selectAll());
        case 'undo':
          return run(undoLast);
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
