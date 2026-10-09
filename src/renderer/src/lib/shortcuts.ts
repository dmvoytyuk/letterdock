// One table drives both the global key handler and Settings > Shortcuts (DESIGN-SPEC 5.1, 7.6).

/** The key set the user picked in Settings > Shortcuts. Gmail style adds single-key shortcuts. */
export type ShortcutPreset = 'outlook' | 'gmail';
export const DEFAULT_PRESET: ShortcutPreset = 'outlook';

/** Window events for j / k (list) and n / p (conversation): the list and the conversation do their own scrolling and focus. */
export const LIST_MOVE_EVENT = 'ld:list-move';
export const CONV_MOVE_EVENT = 'ld:conv-move';

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
  | 'listNext'
  | 'listPrev'
  | 'selectRow'
  | 'toList'
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
  /** Extra keys that only count in the Gmail style (added to `keys` and `match`). */
  gmail?: { keys: string; match: KeyMatcher[] };
  /** A shortcut that exists only in this style (then `keys` and `match` are its keys). */
  only?: ShortcutPreset;
}

export interface KeyMatcher {
  key: string; // KeyboardEvent.key, compared case-insensitively
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  /**
   * Punctuation that sits in a different place on each keyboard layout ('#', '/'): Shift is ignored,
   * and so is AltGr (Windows reports it as Ctrl+Alt). Ctrl or Alt alone still do not match.
   */
  loose?: boolean;
  /** Only when this key was pressed just before ("g" then "i"). */
  after?: string;
}

const k = (key: string, o: Omit<KeyMatcher, 'key'> = {}): KeyMatcher => ({ key, ...o });

export const SHORTCUTS: Shortcut[] = [
  {
    id: 'compose',
    group: 'Global',
    label: 'New message',
    keys: 'Ctrl+N',
    match: [k('n', { ctrl: true })],
    gmail: { keys: 'C', match: [k('c')] },
  },
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
    gmail: { keys: '/', match: [k('/', { loose: true })] },
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
    gmail: { keys: 'G then I', match: [k('i', { after: 'g' })] },
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
    gmail: { keys: 'O', match: [k('o')] },
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
    gmail: { keys: 'R', match: [k('r')] },
  },
  {
    id: 'replyAll',
    group: 'Message list and reading',
    label: 'Reply all',
    keys: 'Ctrl+Shift+R',
    match: [k('r', { ctrl: true, shift: true })],
    gmail: { keys: 'A', match: [k('a')] },
  },
  {
    id: 'forward',
    group: 'Message list and reading',
    label: 'Forward',
    keys: 'Ctrl+F',
    match: [k('f', { ctrl: true })],
    gmail: { keys: 'F', match: [k('f')] },
  },
  {
    id: 'delete',
    group: 'Message list and reading',
    label: 'Delete',
    keys: 'Delete / Ctrl+D',
    match: [k('Delete'), k('d', { ctrl: true })],
    gmail: { keys: '#', match: [k('#', { loose: true })] },
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
    gmail: { keys: 'Shift+I', match: [k('i', { shift: true })] },
  },
  {
    id: 'markUnread',
    group: 'Message list and reading',
    label: 'Mark as unread',
    keys: 'Ctrl+U',
    match: [k('u', { ctrl: true })],
    gmail: { keys: 'Shift+U', match: [k('u', { shift: true })] },
  },
  {
    id: 'flag',
    group: 'Message list and reading',
    label: 'Flag or unflag',
    keys: 'Insert / Ctrl+Shift+G',
    match: [k('Insert'), k('g', { ctrl: true, shift: true })],
    gmail: { keys: 'S', match: [k('s')] },
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
    gmail: { keys: 'N', match: [k('n')] },
  },
  {
    id: 'convPrev',
    group: 'Message list and reading',
    label: 'Previous message in a conversation (reading pane)',
    keys: 'Alt+Up',
    match: [k('ArrowUp', { alt: true })],
    gmail: { keys: 'P', match: [k('p')] },
  },
  {
    id: 'undo',
    group: 'Message list and reading',
    label: 'Undo last delete, archive or move',
    keys: 'Ctrl+Z',
    match: [k('z', { ctrl: true })],
    gmail: { keys: 'Z', match: [k('z')] },
  },
  {
    id: 'listNext',
    group: 'Message list and reading',
    label: 'Next message in the list',
    keys: 'J',
    match: [k('j')],
    only: 'gmail',
  },
  {
    id: 'listPrev',
    group: 'Message list and reading',
    label: 'Previous message in the list',
    keys: 'K',
    match: [k('k')],
    only: 'gmail',
  },
  {
    id: 'selectRow',
    group: 'Message list and reading',
    label: 'Check or uncheck the message',
    keys: 'X',
    match: [k('x')],
    only: 'gmail',
  },
  {
    id: 'toList',
    group: 'Message list and reading',
    label: 'Back to the message list',
    keys: 'U',
    match: [k('u')],
    only: 'gmail',
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

/** The shortcuts of one style, with the extra Gmail keys merged into `keys` and `match`. */
export function shortcutsFor(preset: ShortcutPreset): Shortcut[] {
  const out: Shortcut[] = [];
  for (const s of SHORTCUTS) {
    if (s.only && s.only !== preset) continue;
    if (preset === 'gmail' && s.gmail) {
      out.push({ ...s, keys: `${s.keys} / ${s.gmail.keys}`, match: [...s.match, ...s.gmail.match] });
    } else out.push(s);
  }
  return out;
}

const tables: Record<ShortcutPreset, Shortcut[]> = { outlook: shortcutsFor('outlook'), gmail: shortcutsFor('gmail') };

export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

function modifiersOk(m: KeyMatcher, e: KeyLike): boolean {
  if (m.loose) {
    // No Ctrl and no Alt, or both (AltGr). Shift does not matter.
    return (e.ctrlKey || e.metaKey) === e.altKey;
  }
  if (!!m.ctrl !== (e.ctrlKey || e.metaKey)) return false;
  if (!!m.shift !== e.shiftKey) return false;
  return !!m.alt === e.altKey;
}

/**
 * Which shortcut (if any) does this key event trigger? `previousKey` is the key pressed just
 * before (for "g then i"); the caller forgets it after a second or two.
 */
export function matchShortcut(
  e: KeyLike,
  preset: ShortcutPreset = DEFAULT_PRESET,
  previousKey: string | null = null,
): Shortcut | null {
  const key = e.key.toLowerCase();
  for (const s of tables[preset]) {
    for (const m of s.match) {
      if (key !== m.key.toLowerCase()) continue;
      if (m.after && m.after.toLowerCase() !== previousKey?.toLowerCase()) continue;
      if (!modifiersOk(m, e)) continue;
      return s;
    }
  }
  return null;
}

/** Does this key start a two-key shortcut ("g" in the Gmail style)? */
export function startsSequence(e: KeyLike, preset: ShortcutPreset): boolean {
  return preset === 'gmail' && e.key.toLowerCase() === 'g' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
}

/**
 * A key that types a character (a letter, a digit, '#', '/') with no Ctrl or Alt held (AltGr counts
 * as none). These are the keys that must never fire while the user types.
 */
export function isPlainKey(e: KeyLike): boolean {
  if (e.key.length !== 1) return false;
  return (e.ctrlKey || e.metaKey) === e.altKey;
}

/** Shortcuts with a modifier (or F-key, or Esc) that still work while the cursor is in a text field. */
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
  'back',
];

/**
 * May this shortcut run while the user types in a field? Keys that type a character never do (so
 * "c" or "#" can be typed); only modifier combinations, F-keys and Esc that are meant for it.
 */
export function worksWhileTyping(sc: Shortcut, e: KeyLike): boolean {
  if (isPlainKey(e)) return false;
  return WORKS_WHILE_TYPING.includes(sc.id);
}

/** True when the event target is somewhere the user types text. */
export function isTypingTarget(t: EventTarget | null): boolean {
  // Reads properties instead of using instanceof, so it also works without a DOM (in tests).
  const el = t as { tagName?: unknown; isContentEditable?: unknown; type?: unknown } | null;
  if (!el || typeof el.tagName !== 'string') return false;
  if (el.isContentEditable === true) return true;
  const tag = el.tagName.toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = typeof el.type === 'string' ? el.type : 'text';
    return !['checkbox', 'radio', 'button'].includes(type);
  }
  return false;
}
