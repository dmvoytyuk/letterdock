// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  addAddresses,
  mentionsAttachment,
  normalizeUrl,
  parseRecipients,
  resolvePending,
  signatureHtml,
} from '../../src/renderer/src/lib/compose';
import { searchTerms } from '../../src/renderer/src/lib/search';

describe('parseRecipients', () => {
  it('splits on commas, semicolons and new lines', () => {
    expect(parseRecipients('a@b.com; c@d.com,\ne@f.com').map((a) => a.address)).toEqual([
      'a@b.com',
      'c@d.com',
      'e@f.com',
    ]);
  });

  it('reads "Name <address>" and quoted names that contain a comma', () => {
    expect(parseRecipients('"Doe, John" <john@x.com>, Jane Cooper <jane@x.com>')).toEqual([
      { name: 'Doe, John', address: 'john@x.com' },
      { name: 'Jane Cooper', address: 'jane@x.com' },
    ]);
  });

  it('keeps text without an @ so the user can see it as an invalid entry', () => {
    expect(parseRecipients('bob')).toEqual([{ address: 'bob' }]);
    expect(parseRecipients('  ;; ')).toEqual([]);
  });
});

describe('addAddresses', () => {
  it('does not repeat an address (case-insensitive)', () => {
    const out = addAddresses([{ address: 'A@x.com' }], [{ address: 'a@X.com' }, { address: 'b@x.com' }]);
    expect(out.map((a) => a.address)).toEqual(['A@x.com', 'b@x.com']);
  });
});

describe('normalizeUrl', () => {
  it('accepts web, mail and bare domains; rejects scripts', () => {
    expect(normalizeUrl('https://example.com/a')).toBe('https://example.com/a');
    expect(normalizeUrl('example.com/path')).toBe('https://example.com/path');
    expect(normalizeUrl('me@example.com')).toBe('mailto:me@example.com');
    expect(normalizeUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeUrl('data:text/html,x')).toBeNull();
    expect(normalizeUrl('   ')).toBeNull();
  });
});

describe('mentionsAttachment', () => {
  it('spots the usual wording', () => {
    expect(mentionsAttachment('Please see the attached report')).toBe(true);
    expect(mentionsAttachment('Find the attachment below')).toBe(true);
    expect(mentionsAttachment('Thanks for the update')).toBe(false);
    expect(mentionsAttachment('A detached house')).toBe(false);
  });
});

describe('signatureHtml', () => {
  it('matches the markup the engine writes', () => {
    expect(signatureHtml('Alex\nRivera')).toBe('<div class="letterdock-signature">-- <br>Alex<br>Rivera</div>');
    expect(signatureHtml('  ')).toBe('');
    expect(signatureHtml(null)).toBe('');
  });

  it('escapes plain text', () => {
    expect(signatureHtml('Tom & Jerry 1 < 2')).toContain('Tom &amp; Jerry 1 &lt; 2');
  });
});

describe('searchTerms', () => {
  it('keeps free words and the values of from:, to: and subject:', () => {
    expect(searchTerms('budget from:jane is:unread has:attachment')).toEqual(['budget', 'jane']);
  });

  it('keeps quoted phrases whole and drops date filters', () => {
    expect(searchTerms('"quarterly review" after:2026-01-01 subject:invoice')).toEqual([
      'quarterly review',
      'invoice',
    ]);
  });

  it('is empty for operator-only queries', () => {
    expect(searchTerms('is:flagged before:2026-02-01')).toEqual([]);
  });
});

describe('resolvePending (text left in a recipient box)', () => {
  it('turns a complete address into a recipient', () => {
    const r = resolvePending([], 'jane@x.com');
    expect(r.list.map((a) => a.address)).toEqual(['jane@x.com']);
    expect(r.bad).toBe(false);
  });
  it('does not turn half-typed text into a recipient', () => {
    const r = resolvePending([{ address: 'a@b.com' }], 'dm');
    expect(r.list.map((a) => a.address)).toEqual(['a@b.com']);
    expect(r.bad).toBe(true);
    expect(r.leftover).toBe('dm');
  });
  it('keeps the good part of a mixed paste and flags the rest', () => {
    const r = resolvePending([], 'a@b.com, dm');
    expect(r.list.map((a) => a.address)).toEqual(['a@b.com']);
    expect(r.bad).toBe(true);
  });
  it('empty text changes nothing', () => {
    const list = [{ address: 'a@b.com' }];
    expect(resolvePending(list, '  ')).toEqual({ list, leftover: '', bad: false });
  });
});
