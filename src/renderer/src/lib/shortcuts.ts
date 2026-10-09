// One table drives both the global key handler and Settings > Shortcuts (DESIGN-SPEC 5.1, 7.6).
export type ShortcutId =
  | 'compose'
  | 'addAccount'
  | 'search'
  | 'settings'
  | 'toggleSidebar'
  | 'nextPane'
  | 'prevPane'
  | 'syncAll'
  | 'goAll'
  | 'goAccount'
  | 'goInbox'
  | 'cheatsheet'
  | 'reply'
  | 'replyAll'
  | 'forward'
  | 'delete'
  | 'deletePermanent'
  | 'archive'
  | 'move'
  | 'markRead'
  | 'markUnread'
  | 'flag'
  | 'selectAll'
  | 'open'
  | 'undo'
  | 'print'
  | 'closeWindow'
  | 'convNext'
  | 'convPrev'
  | 'send'
  | 'sendLater'
  | 'back';

export interface Shortcut {
  id: ShortcutId;
  group: 'Global' | 'Message list and reading' | 'Writing a message';
  label: string;
  /** Display text. Alternatives are separated by " / ". */
  keys: string;
  /** Matchers; the first that fits wins. */
  match: KeyMatcher[];
}

export interface KeyMatcher {
  key: string; // KeyboardEvent.key, compared case-insensitively
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
}

const k = (key: string, o: Omit<KeyMatcher, 'key'> = {}): KeyMatcher => ({ key, ...o });

export const SHORTCUTS: Shortcut[] = [
  { id: 'compose', group: 'Global', label: 'New message', keys: 'Ctrl+N', match: [k('n', { ctrl: true })] },
  {
    id: 'addAccount',
    group: 'Global',
    label: 'Add account',
    keys: 'Ctrl+Shift+A',
    match: [k('a', { ctrl: true, shift: true })],
  },
  {
    id: 'search',
    group: 'Global',
    label: 'Focus search',
    keys: 'Ctrl+E / Ctrl+K / F3',
    match: [k('e', { ctrl: true }), k('k', { ctrl: true }), k('F3')],
  },
  { id: 'settings', group: 'Global', label: 'Settings', keys: 'Ctrl+,', match: [k(',', { ctrl: true })] },
  {
    id: 'toggleSidebar',
    group: 'Global',
    label: 'Show or hide the sidebar',
    keys: 'Ctrl+B',
    match: [k('b', { ctrl: true })],
  },
  { id: 'nextPane', group: 'Global', label: 'Next pane', keys: 'F6', match: [k('F6')] },
  {
    id: 'prevPane',
    group: 'Global',
    label: 'Previous pane',
    keys: 'Shift+F6',
    match: [k('F6', { shift: true })],
  },
  { id: 'syncAll', group: 'Global', label: 'Check all accounts for mail', keys: 'F9', match: [k('F9')] },
  { id: 'goAll', group: 'Global', label: 'Go to All inboxes', keys: 'Ctrl+1', match: [k('1', { ctrl: true })] },
  {
    id: 'goAccount',
    group: 'Global',
    label: 'Go to the Inbox of account 1 to 8',
    keys: 'Ctrl+2 to Ctrl+9',
    match: [2, 3, 4, 5, 6, 7, 8, 9].map((n) => k(String(n), { ctrl: true })),
  },
  {
    id: 'goInbox',
    group: 'Global',
    label: 'Go to Inbox of the current account',
    keys: 'Ctrl+Shift+I',
    match: [k('i', { ctrl: true, shift: true })],
  },
  {
    id: 'cheatsheet',
    group: 'Global',
    label: 'Show shortcuts',
    keys: 'Ctrl+/',
    match: [k('/', { ctrl: true })],
  },
  { id: 'back', group: 'Global', label: 'Close dialog, search or message', keys: 'Esc', match: [k('Escape')] },
  {
    id: 'open',
    group: 'Message list and reading',
    label: 'Open message in its own window',
    keys: 'Enter',
    match: [k('Enter')],
  },
  {
    id: 'print',
    group: 'Message list and reading',
    label: 'Print the message',
    keys: 'Ctrl+P',
    match: [k('p', { ctrl: true })],
  },
  {
    id: 'closeWindow',
    group: 'Message list and reading',
    label: 'Close a message window (in message windows only)',
    keys: 'Ctrl+W',
    match: [k('w', { ctrl: true })],
  },
  {
    id: 'reply',
    group: 'Message list and reading',
    label: 'Reply',
    keys: 'Ctrl+R',
    match: [k('r', { ctrl: true })],
  },
  {
    id: 'replyAll',
    group: 'Message list and reading',
    label: 'Reply all',
    keys: 'Ctrl+Shift+R',
    match: [k('r', { ctrl: true, shift: true })],
  },
  {
    id: 'forward',
    group: 'Message list and reading',
    label: 'Forward',
    keys: 'Ctrl+F',
    match: [k('f', { ctrl: true })],
  },
  {
    id: 'delete',
    group: 'Message list and reading',
    label: 'Delete',
    keys: 'Delete / Ctrl+D',
    match: [k('Delete'), k('d', { ctrl: true })],
  },
  {
    id: 'deletePermanent',
    group: 'Message list and reading',
    label: 'Delete permanently',
    keys: 'Shift+Delete',
    match: [k('Delete', { shift: true })],
  },
  {
    id: 'archive',
    group: 'Message list and reading',
    label: 'Archive',
    keys: 'E / Backspace',
    match: [k('e'), k('Backspace')],
  },
  {
    id: 'move',
    group: 'Message list and reading',
    label: 'Move to folder',
    keys: 'Ctrl+Shift+M',
    match: [k('m', { ctrl: true, shift: true })],
  },
  {
    id: 'markRead',
    group: 'Message list and reading',
    label: 'Mark as read',
    keys: 'Ctrl+Q',
    match: [k('q', { ctrl: true })],
  },
  {
    id: 'markUnread',
    group: 'Message list and reading',
    label: 'Mark as unread',
    keys: 'Ctrl+U',
    match: [k('u', { ctrl: true })],
  },
  {
    id: 'flag',
    group: 'Message list and reading',
    label: 'Flag or unflag',
    keys: 'Insert / Ctrl+Shift+G',
    match: [k('Insert'), k('g', { ctrl: true, shift: true })],
  },
  {
    id: 'selectAll',
    group: 'Message list and reading',
    label: 'Select all',
    keys: 'Ctrl+A',
    match: [k('a', { ctrl: true })],
  },
  {
    id: 'convNext',
    group: 'Message list and reading',
    label: 'Next message in a conversation (reading pane)',
    keys: 'Alt+Down',
    match: [k('ArrowDown', { alt: true })],
  },
  {
    id: 'convPrev',
    group: 'Message list and reading',
    label: 'Previous message in a conversation (reading pane)',
    keys: 'Alt+Up',
    match: [k('ArrowUp', { alt: true })],
  },
  {
    id: 'undo',
    group: 'Message list and reading',
    label: 'Undo last delete, archive or move',
    keys: 'Ctrl+Z',
    match: [k('z', { ctrl: true })],
  },
  {
    id: 'send',
    group: 'Writing a message',
    label: 'Send',
    keys: 'Ctrl+Enter',
    match: [k('Enter', { ctrl: true })],
  },
  {
    id: 'sendLater',
    group: 'Writing a message',
    label: 'Open the Send later menu',
    keys: 'Ctrl+Shift+Enter',
    match: [k('Enter', { ctrl: true, shift: true })],
  },
];

/** Which shortcut (if any) does this key event trigger? */
export function matchShortcut(e: KeyboardEvent): Shortcut | null {
  for (const s of SHORTCUTS) {
    for (const m of s.match) {
      if (e.key.toLowerCase() !== m.key.toLowerCase()) continue;
      if (!!m.ctrl !== (e.ctrlKey || e.metaKey)) continue;
      if (!!m.shift !== e.shiftKey) continue;
      if (!!m.alt !== e.altKey) continue;
      return s;
    }
  }
  return null;
}

/** True when the event target is somewhere the user types text. */
export function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  const tag = t.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (t as HTMLInputElement).type;
    return !['checkbox', 'radio', 'button'].includes(type);
  }
  return false;
}
