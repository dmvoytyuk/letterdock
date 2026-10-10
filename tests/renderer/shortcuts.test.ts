// The key map: Outlook style (default) and the opt-in Gmail style, the "g then i" pair, keyboard
// layouts where '#' and '/' need Shift or AltGr, and the guard that keeps single keys out of text fields.
import { describe, expect, it } from 'vitest';
import {
  SHORTCUTS,
  isPlainKey,
  isTypingTarget,
  matchShortcut,
  shortcutsFor,
  startsSequence,
  worksWhileTyping,
  type KeyLike,
  type ShortcutPreset,
} from '../../src/renderer/src/lib/shortcuts';

const key = (k: string, o: Partial<KeyLike> = {}): KeyLike => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...o,
});
const idOf = (e: KeyLike, preset: ShortcutPreset = 'gmail', prev: string | null = null) =>
  matchShortcut(e, preset, prev)?.id ?? null;

describe('key map, Outlook style', () => {
  it('keeps the Outlook keys', () => {
    expect(idOf(key('r', { ctrlKey: true }), 'outlook')).toBe('reply');
    expect(idOf(key('r', { ctrlKey: true, shiftKey: true }), 'outlook')).toBe('replyAll');
    expect(idOf(key('Delete'), 'outlook')).toBe('delete');
    expect(idOf(key('n', { ctrlKey: true }), 'outlook')).toBe('compose');
    expect(idOf(key('ArrowDown', { altKey: true }), 'outlook')).toBe('convNext');
    expect(idOf(key('z', { metaKey: true }), 'outlook')).toBe('undo'); // Cmd counts as Ctrl
  });

  it('has no Gmail single keys, and the default is Outlook', () => {
    for (const k of ['j', 'k', 'c', 'r', 'a', 'f', 's', 'x', 'u', 'n', 'p', 'z', 'o', '#', '/']) {
      expect(idOf(key(k), 'outlook'), k).toBeNull();
    }
    expect(idOf(key('I', { shiftKey: true }), 'outlook')).toBeNull();
    expect(matchShortcut(key('j'))).toBeNull(); // no preset given = Outlook
    expect(shortcutsFor('outlook').some((s) => s.only === 'gmail')).toBe(false);
    expect(shortcutsFor('outlook').map((s) => s.id)).not.toContain('listNext');
  });

  it('e still archives in both styles', () => {
    expect(idOf(key('e'), 'outlook')).toBe('archive');
    expect(idOf(key('e'), 'gmail')).toBe('archive');
  });
});

describe('key map, Gmail style', () => {
  const table: [string, KeyLike, string][] = [
    ['j next in list', key('j'), 'listNext'],
    ['k previous in list', key('k'), 'listPrev'],
    ['o open', key('o'), 'open'],
    ['e archive', key('e'), 'archive'],
    ['r reply', key('r'), 'reply'],
    ['a reply all', key('a'), 'replyAll'],
    ['f forward', key('f'), 'forward'],
    ['s flag', key('s'), 'flag'],
    ['c compose', key('c'), 'compose'],
    ['/ search', key('/'), 'search'],
    ['z undo', key('z'), 'undo'],
    ['x check row', key('x'), 'selectRow'],
    ['u back to list', key('u'), 'toList'],
    ['n next message in conversation', key('n'), 'convNext'],
    ['p previous message in conversation', key('p'), 'convPrev'],
    ['Shift+I mark read', key('I', { shiftKey: true }), 'markRead'],
    ['Shift+U mark unread', key('U', { shiftKey: true }), 'markUnread'],
    ['# delete (US layout, Shift+3)', key('#', { shiftKey: true }), 'delete'],
    ['# delete (no modifier)', key('#'), 'delete'],
    ['# delete (AltGr, reported as Ctrl+Alt)', key('#', { ctrlKey: true, altKey: true }), 'delete'],
    ['/ search (Shift+7 on an Italian keyboard)', key('/', { shiftKey: true }), 'search'],
    ['caps lock does not change a letter', key('J'), 'listNext'],
  ];
  it.each(table)('%s', (_name, e, id) => {
    expect(idOf(e, 'gmail')).toBe(id);
  });

  it('the Outlook keys keep working', () => {
    expect(idOf(key('r', { ctrlKey: true }), 'gmail')).toBe('reply');
    expect(idOf(key('Delete'), 'gmail')).toBe('delete');
    expect(idOf(key('F9'), 'gmail')).toBe('syncAll');
    expect(idOf(key('/', { ctrlKey: true }), 'gmail')).toBe('cheatsheet'); // not "search"
    expect(idOf(key('i', { ctrlKey: true, shiftKey: true }), 'gmail')).toBe('goInbox');
  });

  it('a single key does not fire with Ctrl or Alt held alone', () => {
    expect(idOf(key('j', { ctrlKey: true }), 'gmail')).toBeNull();
    expect(idOf(key('c', { ctrlKey: true }), 'gmail')).toBeNull(); // Ctrl+C is copy
    expect(idOf(key('x', { ctrlKey: true }), 'gmail')).toBeNull(); // Ctrl+X is cut
    expect(idOf(key('s', { altKey: true }), 'gmail')).toBeNull();
    expect(idOf(key('#', { ctrlKey: true }), 'gmail')).toBeNull();
    expect(idOf(key('/', { altKey: true }), 'gmail')).toBeNull();
    expect(idOf(key('r', { shiftKey: true }), 'gmail')).toBeNull(); // Shift+R is not reply
  });

  it('g then i goes to the Inbox, but i alone does nothing', () => {
    expect(idOf(key('i'), 'gmail', null)).toBeNull();
    expect(idOf(key('i'), 'gmail', 'x')).toBeNull();
    expect(idOf(key('i'), 'gmail', 'g')).toBe('goInbox');
    expect(idOf(key('i'), 'outlook', 'g')).toBeNull();
    expect(startsSequence(key('g'), 'gmail')).toBe(true);
    expect(startsSequence(key('G', { shiftKey: true }), 'gmail')).toBe(false);
    expect(startsSequence(key('g', { ctrlKey: true }), 'gmail')).toBe(false);
    expect(startsSequence(key('g'), 'outlook')).toBe(false);
  });

  it('no two shortcuts of a style answer to the same key', () => {
    for (const preset of ['outlook', 'gmail'] as const) {
      const seen = new Map<string, string>();
      for (const s of shortcutsFor(preset)) {
        for (const m of s.match) {
          const sig = JSON.stringify([m.key.toLowerCase(), !!m.ctrl, !!m.shift, !!m.alt, m.after ?? '']);
          expect(seen.get(sig) ?? s.id, `${preset}: ${m.key}`).toBe(s.id);
          seen.set(sig, s.id);
        }
      }
    }
  });
});

describe('the table shows the active set', () => {
  it('Gmail style lists the Gmail keys next to the Outlook keys; Outlook style lists none', () => {
    const outlook = new Map(shortcutsFor('outlook').map((s) => [s.id, s.keys]));
    const gmail = new Map(shortcutsFor('gmail').map((s) => [s.id, s.keys]));
    expect(outlook.get('reply')).toBe('Ctrl+R');
    expect(gmail.get('reply')).toBe('Ctrl+R / R');
    expect(gmail.get('delete')).toBe('Delete / Ctrl+D / #');
    expect(gmail.get('goInbox')).toBe('Ctrl+Shift+I / G then I');
    expect(gmail.get('convNext')).toBe('Alt+Down / N');
    expect(gmail.get('listNext')).toBe('J');
    expect(outlook.has('listNext')).toBe(false);
    expect(gmail.size).toBeGreaterThan(outlook.size);
  });

  it('covers every item of the design spec list', () => {
    const ids = new Set(shortcutsFor('gmail').map((s) => s.id));
    for (const id of [
      'listNext',
      'listPrev',
      'open',
      'archive',
      'delete',
      'reply',
      'replyAll',
      'forward',
      'flag',
      'markRead',
      'markUnread',
      'compose',
      'search',
      'goInbox',
      'undo',
      'selectRow',
      'convNext',
      'convPrev',
      'toList',
    ]) {
      expect(ids.has(id as never), id).toBe(true);
    }
    expect(SHORTCUTS.every((s) => s.keys.length > 0 && (s.match.length > 0 || s.external === true))).toBe(true);
  });
});

describe('the typing guard', () => {
  const el = (tagName: string, o: { type?: string; isContentEditable?: boolean } = {}) =>
    ({ tagName, ...o }) as unknown as EventTarget;

  it('knows where the user types', () => {
    expect(isTypingTarget(el('INPUT', { type: 'text' }))).toBe(true);
    expect(isTypingTarget(el('INPUT', { type: 'search' }))).toBe(true);
    expect(isTypingTarget(el('INPUT'))).toBe(true);
    expect(isTypingTarget(el('TEXTAREA'))).toBe(true);
    expect(isTypingTarget(el('SELECT'))).toBe(true);
    expect(isTypingTarget(el('DIV', { isContentEditable: true }))).toBe(true);
    expect(isTypingTarget(el('INPUT', { type: 'checkbox' }))).toBe(false);
    expect(isTypingTarget(el('INPUT', { type: 'radio' }))).toBe(false);
    expect(isTypingTarget(el('BUTTON'))).toBe(false);
    expect(isTypingTarget(el('DIV'))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget({} as EventTarget)).toBe(false); // window or document
  });

  it('a key that types a character never runs a shortcut while typing', () => {
    // "c" is New message in Gmail style, but typing "c" in a field must type it.
    for (const k of ['c', '/', '#', 'j', 'r', 's', 'x', 'z', 'e', 'I']) {
      const e = key(k, k === 'I' ? { shiftKey: true } : {});
      const sc = matchShortcut(e, 'gmail');
      expect(sc, k).not.toBeNull();
      expect(worksWhileTyping(sc!, e), k).toBe(false);
    }
  });

  it('modifier combinations and F-keys meant for it still run while typing', () => {
    const run = (e: KeyLike) => {
      const sc = matchShortcut(e, 'gmail')!;
      return worksWhileTyping(sc, e);
    };
    expect(run(key('n', { ctrlKey: true }))).toBe(true); // New message
    expect(run(key('e', { ctrlKey: true }))).toBe(true); // Focus search
    expect(run(key('F9'))).toBe(true);
    expect(run(key('Escape'))).toBe(true);
    expect(run(key('/', { ctrlKey: true }))).toBe(true); // cheat sheet
    // Message keys with a modifier are not meant for a text field.
    expect(run(key('r', { ctrlKey: true }))).toBe(false);
    expect(run(key('Delete'))).toBe(false);
    expect(run(key('z', { ctrlKey: true }))).toBe(false); // the field has its own undo
  });

  it('tells character keys from other keys', () => {
    expect(isPlainKey(key('a'))).toBe(true);
    expect(isPlainKey(key('A', { shiftKey: true }))).toBe(true);
    expect(isPlainKey(key('#', { ctrlKey: true, altKey: true }))).toBe(true); // AltGr
    expect(isPlainKey(key('a', { ctrlKey: true }))).toBe(false);
    expect(isPlainKey(key('a', { altKey: true }))).toBe(false);
    expect(isPlainKey(key('Enter'))).toBe(false);
    expect(isPlainKey(key('F9'))).toBe(false);
    expect(isPlainKey(key('Escape'))).toBe(false);
  });
});
