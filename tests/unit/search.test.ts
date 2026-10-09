import { describe, expect, it } from 'vitest';
import { buildMatch, parseDate, parseQuery } from '../../src/engine/search/queryParser';
import { SearchService } from '../../src/engine/search/searchService';

describe('parseQuery', () => {
  it('splits free text, phrases and operators', () => {
    const q = parseQuery('budget "q3 plan" from:bob subject:"team lunch" is:unread has:attachment after:2026-01-05');
    expect(q.terms).toEqual([
      { text: 'budget', column: null, phrase: false },
      { text: 'q3 plan', column: null, phrase: true },
      { text: 'bob', column: 'from_text', phrase: false },
      { text: 'team lunch', column: 'subject', phrase: true },
    ]);
    expect(q.unread).toBe(true);
    expect(q.hasAttachment).toBe(true);
    expect(q.after).toBe(new Date(2026, 0, 5).getTime());
    expect(q.chips).toEqual(['from:bob', 'subject:"team lunch"', 'is:unread', 'has:attachment', 'after:2026-01-05']);
  });

  it('understands account / folder / flagged / read / to / before', () => {
    const q = parseQuery('to:eve account:Work folder:Archive in:inbox is:flagged is:read before:2026-12-31');
    expect(q.accountTerms).toEqual(['work']);
    expect(q.folderTerms).toEqual(['archive', 'inbox']);
    expect(q.flagged).toBe(true);
    expect(q.unread).toBe(false);
    expect(q.before).toBe(new Date(2026, 11, 31).getTime());
    expect(q.terms).toEqual([{ text: 'eve', column: 'to_text', phrase: false }]);
  });

  it('treats unknown operators and bad values as text', () => {
    const q = parseQuery('foo:bar is:weird before:notadate after:2026-13-45 http://x.com');
    expect(q.terms.map((t) => t.text)).toEqual(['foo:bar', 'is:weird', 'before:notadate', 'after:2026-13-45', 'http://x.com']);
    expect(q.chips).toEqual([]);
  });

  it('validates dates', () => {
    expect(parseDate('2026-02-30')).toBeNull();
    expect(parseDate('2026-2-3')).toBeNull();
    expect(parseDate('2024-02-29')).not.toBeNull();
  });
});

describe('buildMatch', () => {
  it('quotes every term and prefixes the last', () => {
    expect(buildMatch(parseQuery('hello wor'))).toBe('"hello" "wor"*');
    expect(buildMatch(parseQuery('"exact phrase"'))).toBe('"exact phrase"');
    expect(buildMatch(parseQuery('from:bob lunch'))).toBe('from_text : "bob" "lunch"*');
  });
  it('neutralises FTS syntax typed by the user', () => {
    expect(buildMatch(parseQuery('a"b OR b* NEAR(x'))).toBe('"a""b" "OR" "b*" "NEAR(x"*');
    expect(buildMatch(parseQuery('AND'))).toBe('"AND"*');
  });
  it('returns null when there is nothing to search for in the index', () => {
    expect(buildMatch(parseQuery('is:unread'))).toBeNull();
    expect(buildMatch(parseQuery('***'))).toBeNull();
  });
  it('can fall back to one phrase', () => {
    expect(buildMatch(parseQuery('foo bar'), true)).toBe('"foo bar"');
  });
});

describe('IMAP criteria', () => {
  it('maps operators to IMAP SEARCH keys', () => {
    const c = SearchService.criteria(parseQuery('invoice from:bob to:eve subject:hi is:unread is:flagged after:2026-01-01'));
    expect(c).toMatchObject({ text: 'invoice', from: 'bob', to: 'eve', subject: 'hi', seen: false, flagged: true });
    expect(c.since).toBeInstanceOf(Date);
    expect(SearchService.criteria(parseQuery('has:attachment'))).toEqual({ all: true });
  });
});
