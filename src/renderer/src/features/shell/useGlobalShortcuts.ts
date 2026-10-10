import { useEffect } from 'react';
import { CONV_MOVE_EVENT, LIST_MOVE_EVENT, isPlainKey, isTypingTarget, matchShortcut, startsSequence, worksWhileTyping, type ShortcutId } from '../../lib/shortcuts';
import { useApp, accountInbox, activePreset } from '../../store/app';
import { useList } from '../../store/list';
import { useUi } from '../../store/ui';
import { applyToMessages, composeFrom, deleteMessages, deleteMessagesPermanently, newMessage, openCompose, openInWindow, roleOf } from '../../lib/actions';
import { allMuted, allPinned, canMute, canSnoozeRole, openSnoozeMenu, setMuted, setPinned, snoozeAnchor } from '../../lib/light';
import { canPinHere } from '../../lib/pinRules';
import { undoLast } from '../../store/undo';
import { printOpenMessage } from '../../lib/print';
import { toast } from '../../store/toasts';
import { useMenu } from '../../components/ui';
import { syncAll } from './TitleBar';
import { toggleSidebar } from '../sidebar/SidebarToggle';

/** Keys that act on messages only when focus is in the list or reading pane (or nowhere). */
const PLAIN_KEYS: ShortcutId[] = ['delete', 'deletePermanent', 'archive', 'flag', 'open', 'snooze', 'pin', 'mute'];
/** Gmail-style single keys that work wherever focus is, except in a text field. */
const ANYWHERE_KEYS: ShortcutId[] = ['compose', 'search', 'goInbox'];
/** "g" then "i": how long the second key may take. */
const SEQUENCE_MS = 1500;

function focusList(): void {
  const el =
    document.querySelector<HTMLElement>('#pane-list [role=listbox]') ?? document.querySelector<HTMLElement>('#pane-list');
  el?.focus();
}

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
    // The key pressed just before, for "g then i" (Gmail style).
    let prev: { key: string; at: number } | null = null;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(e.key)) return; // a modifier alone is not a key press
      const preset = activePreset();
      const previousKey = prev && Date.now() - prev.at < SEQUENCE_MS ? prev.key : null;
      prev = null;
      const sc = matchShortcut(e, preset, previousKey);
      const typing = isTypingTarget(e.target);
      const blocked = !!document.querySelector('.modal, .light-pop') || !!useMenu.getState().menu;
      if (!sc) {
        if (!typing && !blocked && startsSequence(e, preset)) prev = { key: 'g', at: Date.now() };
        return;
      }
      const ui = useUi.getState();
      if (typing && !worksWhileTyping(sc, e)) return;
      if (document.querySelector('.modal, .light-pop') && sc.id !== 'back') {
        // A dialog is open: only Esc (handled by the dialog itself) matters.
        return;
      }
      if (useMenu.getState().menu) return;
      const target = e.target as HTMLElement | null;
      const inMail = !target || target === document.body || !!target.closest('#pane-list, #pane-reading');
      if (PLAIN_KEYS.includes(sc.id) && !inMail) return;
      // Single character keys of the Gmail style act on messages only when focus is on the list or reading pane.
      if (isPlainKey(e) && !ANYWHERE_KEYS.includes(sc.id) && !inMail) return;
      if (sc.id === 'open' && !target?.closest('#pane-list')) return;
      if ((sc.id === 'archive' || sc.id === 'delete' || sc.id === 'flag') && target?.closest('#pane-reading button')) {
        // Enter/Space on a toolbar button is theirs; these keys are fine though.
      }

      const list = useList.getState();
      const ids = list.selectedIds.length ? list.selectedIds : list.focusId !== null ? [list.focusId] : [];
      const first = list.items.find((m) => m.id === ids[0]);
      // The outbox and Scheduled views have no message list on screen (Scheduled has its own keys): message keys must not touch rows that are hidden.
      const messageLevel = ui.page === 'mail' && ui.view.kind !== 'outbox' && ui.view.kind !== 'scheduled';

      const cardAttr = target?.closest('.ccard[data-mid]')?.getAttribute('data-mid');
      const cardId = cardAttr && !target?.closest('.ccard.isdraft') ? Number(cardAttr) : null;

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
        case 'commandBox':
          return run(() => ui.set({ commandBoxOpen: true }));
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
        // In a conversation the keys act on the card that has focus, else on the newest message that is not yours (3.10.4).
        case 'reply':
          return run(() => (cardId !== null ? openCompose({ mode: 'reply', sourceMessageId: cardId }) : composeFrom('reply', ids[0])));
        case 'replyAll':
          return run(() => (cardId !== null ? openCompose({ mode: 'replyAll', sourceMessageId: cardId }) : composeFrom('replyAll', ids[0])));
        case 'forward':
          return run(() => (cardId !== null ? openCompose({ mode: 'forward', sourceMessageId: cardId }) : composeFrom('forward', ids[0])));
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
        case 'delete':
          return run(() => deleteMessages(ids));
        // Shift+Delete: delete for good from any folder, after a confirmation. No Undo.
        case 'deletePermanent':
          return run(() => deleteMessagesPermanently(ids));
        case 'archive':
          return run(() => void applyToMessages(ids, { type: 'archive' }));
        case 'markRead':
          return run(() => void applyToMessages(ids, { type: 'markRead', read: true }));
        case 'markUnread':
          return run(() => void applyToMessages(ids, { type: 'markRead', read: false }));
        case 'flag':
          return run(() => void applyToMessages(ids, { type: 'flag', flagged: !(first?.flagged ?? false) }));
        // Snooze, Pin and Mute (DESIGN-SPEC 3.13): same rules as the menus. Nothing happens where the command is not offered.
        case 'snooze':
          return run(() => {
            const rows = list.items.filter((m) => ids.includes(m.id));
            if (rows.length === 0) return;
            if (ui.view.kind !== 'snoozed' && !rows.every((m) => canSnoozeRole(roleOf(m)))) return;
            const a = snoozeAnchor();
            openSnoozeMenu(ids, a.x, a.y, ui.view.kind === 'snoozed');
          });
        case 'pin':
          return run(() => {
            if (ids.length > 0 && canPinHere(ui.view, ui.unreadOnly)) void setPinned(ids, !allPinned(ids));
          });
        case 'mute':
          return run(() => {
            const rows = list.items.filter((m) => ids.includes(m.id));
            if (rows.length === 0 || !rows.every((m) => canMute(m))) return;
            void setMuted(ids, !allMuted(ids));
          });
        case 'selectAll':
          return run(() => list.selectAll());
        case 'undo':
          return run(undoLast);
        // Gmail style: j and k move through the list, x checks the row, n and p move between the cards of a conversation.
        case 'listNext':
        case 'listPrev':
          return run(() => window.dispatchEvent(new CustomEvent(LIST_MOVE_EVENT, { detail: sc.id === 'listNext' ? 1 : -1 })));
        case 'convNext':
        case 'convPrev':
          return run(() => window.dispatchEvent(new CustomEvent(CONV_MOVE_EVENT, { detail: sc.id === 'convNext' ? 1 : -1 })));
        case 'selectRow':
          return run(() => {
            const id = list.focusId ?? list.selectedIds[list.selectedIds.length - 1] ?? null;
            if (id === null) return;
            // The first press turns on the check boxes and keeps a row that is already selected checked.
            if (!list.selectMode) list.setSelectMode(true);
            if (list.selectMode || !list.selectedIds.includes(id)) list.toggle(id);
          });
        case 'toList':
          return run(() => {
            if (ui.mode === 'narrow' && ui.readerOpen) ui.set({ readerOpen: false });
            else focusList();
          });
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
