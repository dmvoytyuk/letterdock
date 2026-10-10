// Pure parts of the light features (DESIGN-SPEC 3.13): snooze times, command matching, shortcuts, status bar text.
import { describe, expect, it } from 'vitest';
import { snoozeOptions, snoozeUntilText, parseHm, DEFAULT_SNOOZE_TIMES } from '../../src/renderer/src/lib/snooze';
import { fuzzyMatch, rankItems } from '../../src/renderer/src/lib/fuzzy';
import { canPinHere } from '../../src/renderer/src/lib/pinRules';
import { matchShortcut, shortcutsFor, type KeyLike } from '../../src/renderer/src/lib/shortcuts';
import { middleText } from '../../src/renderer/src/lib/statusBar';

const key = (k: string, o: Partial<KeyLike> = {}): KeyLike => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...o });
// Local time (month is 0-based): Wed 14 Oct 2026.
const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m, d, h, min).getTime();
const ids = (now: number) => snoozeOptions(now, DEFAULT_SNOOZE_TIMES).map((o) => o.id);

describe('snooze times', () => {
  it('offers Later today before 16:00, Tomorrow, This weekend and Next week on a weekday morning', () => {
    const now = at(2026, 9, 14, 10);
    expect(ids(now)).toEqual(['today', 'tomorrow', 'weekend', 'nextweek']);
    const o = snoozeOptions(now, DEFAULT_SNOOZE_TIMES);
    expect(new Date(o[0]!.at).getHours()).toBe(18);
    expect(new Date(o[1]!.at).getDate()).toBe(15);
    expect(new Date(o[1]!.at).getHours()).toBe(8);
    expect(new Date(o[2]!.at).getDay()).toBe(6);
    expect(new Date(o[2]!.at).getHours()).toBe(9);
    expect(new Date(o[3]!.at).getDay()).toBe(1);
    expect(new Date(o[3]!.at).getDate()).toBe(19);
  });
  it('hides Later today from 16:00', () => {
    expect(ids(at(2026, 9, 14, 16))).toEqual(['tomorrow', 'weekend', 'nextweek']);
    expect(ids(at(2026, 9, 14, 15, 59))).toContain('today');
  });
  it('weekend: Saturday before the weekend time stays, later Saturday and Sunday hide it', () => {
    expect(ids(at(2026, 9, 17, 8, 30))).toContain('weekend'); // Saturday 08:30
    expect(ids(at(2026, 9, 17, 9, 30))).not.toContain('weekend');
    expect(ids(at(2026, 9, 18, 10))).not.toContain('weekend'); // Sunday
  });
  it('on a Monday, Next week is the Monday after it', () => {
    const o = snoozeOptions(at(2026, 9, 12, 7), DEFAULT_SNOOZE_TIMES).find((x) => x.id === 'nextweek')!;
    expect(new Date(o.at).getDate()).toBe(19);
  });
  it('uses the times from Settings, and falls back on junk', () => {
    const o = snoozeOptions(at(2026, 9, 14, 10), { morning: '07:30', evening: '17:15', weekendMorning: '10:00' });
    expect(new Date(o[0]!.at).getMinutes()).toBe(15);
    expect(new Date(o[1]!.at).getMinutes()).toBe(30);
    expect(parseHm('nonsense', '08:00')).toEqual({ h: 8, m: 0 });
  });
  it('words for the toast', () => {
    const now = at(2026, 9, 14, 10);
    expect(snoozeUntilText(at(2026, 9, 14, 18), now)).toMatch(/^Today /);
    expect(snoozeUntilText(at(2026, 9, 15, 8), now)).toMatch(/^Tomorrow /);
    expect(snoozeUntilText(at(2026, 9, 20, 8), now)).not.toMatch(/^(Today|Tomorrow)/);
  });
});

describe('command matching', () => {
  it('needs the letters in order and ignores case and accents', () => {
    expect(fuzzyMatch('arch', 'Archive')).not.toBeNull();
    expect(fuzzyMatch('ARCH', 'archive')).not.toBeNull();
    expect(fuzzyMatch('cafe', 'Go to Café')).not.toBeNull();
    expect(fuzzyMatch('zz', 'Archive')).toBeNull();
    expect(fuzzyMatch('ev', 've')).toBeNull();
  });
  it('word starts and runs rank higher', () => {
    const items = ['Mark as unread', 'Move to...', 'Open in new window'];
    const r = rankItems(items, 'mo', (s) => s, () => null);
    expect(r[0]!.item).toBe('Move to...');
  });
  it('ties go to recent commands, then the fixed order; at most the limit', () => {
    const items = ['Go to A', 'Go to B', 'Go to C'];
    const r = rankItems(items, 'go', (s) => s, (s) => (s === 'Go to C' ? 0 : null));
    expect(r.map((x) => x.item)).toEqual(['Go to C', 'Go to A', 'Go to B']);
    const many = Array.from({ length: 60 }, (_, i) => `Go to ${i}`);
    expect(rankItems(many, 'go', (s) => s, () => null, 30).length).toBe(30);
  });
  it('reports which letters matched', () => {
    expect(fuzzyMatch('mv', 'Move')!.positions).toEqual([0, 2]);
  });
});

describe('shortcuts of the light features', () => {
  it('Ctrl+K is the command box in the main window; Ctrl+E and F3 still search', () => {
    expect(matchShortcut(key('k', { ctrlKey: true }), 'outlook')?.id).toBe('commandBox');
    expect(matchShortcut(key('e', { ctrlKey: true }), 'outlook')?.id).toBe('search');
    expect(matchShortcut(key('F3'), 'outlook')?.id).toBe('search');
  });
  it('snooze, pin and mute in both styles', () => {
    expect(matchShortcut(key('h'), 'outlook')?.id).toBe('snooze');
    expect(matchShortcut(key('b'), 'outlook')).toBeNull();
    expect(matchShortcut(key('b'), 'gmail')?.id).toBe('snooze');
    expect(matchShortcut(key('h'), 'gmail')?.id).toBe('snooze');
    expect(matchShortcut(key('p', { altKey: true }), 'outlook')?.id).toBe('pin');
    expect(matchShortcut(key('m', { altKey: true }), 'outlook')?.id).toBe('mute');
    expect(matchShortcut(key('m'), 'outlook')).toBeNull();
    expect(matchShortcut(key('m'), 'gmail')?.id).toBe('mute');
  });
  it('the table lists them, with the compose keys', () => {
    const keys = shortcutsFor('gmail').map((s) => s.keys).join(' | ');
    expect(keys).toContain('Alt+P');
    expect(keys).toContain('Ctrl+Shift+Q');
    expect(shortcutsFor('outlook').find((s) => s.id === 'search')!.keys).toBe('Ctrl+E / F3');
  });
});

describe('pin and the status bar', () => {
  it('pins only in folder lists and All inboxes, and not with a filter on', () => {
    expect(canPinHere({ kind: 'all' })).toBe(true);
    expect(canPinHere({ kind: 'folder', folderId: 3 })).toBe(true);
    expect(canPinHere({ kind: 'all' }, true)).toBe(false);
    for (const kind of ['unread', 'flagged'] as const) expect(canPinHere({ kind })).toBe(false);
    expect(canPinHere({ kind: 'snoozed', accountId: null })).toBe(false);
    expect(canPinHere({ kind: 'search', query: 'x', accountId: null })).toBe(false);
  });
  it('Snoozed view text', () => {
    const base = {
      page: 'mail' as const,
      accounts: [],
      folders: [],
      counts: null,
      outboxCount: 0,
      list: { scopeKind: null, isSearch: false, loading: false, total: null, itemCount: 0, selectedCount: 0 },
    };
    expect(middleText({ ...base, view: { kind: 'snoozed', accountId: 'a1' }, snoozedCount: 3 })).toBe('Snoozed · 3 messages');
    expect(middleText({ ...base, view: { kind: 'snoozed', accountId: 'a1' }, snoozedCount: 0 })).toBe('Snoozed');
  });
});
