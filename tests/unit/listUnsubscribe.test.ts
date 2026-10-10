import { describe, expect, it } from 'vitest';
import {
  domainAligned,
  evaluateAuth,
  isOneClick,
  parseAuthResults,
  parseListId,
  parseListUnsubscribe,
  parseMailto,
  readListHeaders,
} from '../../src/shared/listUnsubscribe';

describe('readListHeaders', () => {
  const raw = [
    'Authentication-Results: mx.provider.com; dkim=pass header.d=example.com; spf=pass; dmarc=pass',
    'Received: from somewhere',
    'Authentication-Results: forged.example; dkim=fail',
    'From: News <news@example.com>',
    'List-Unsubscribe: <https://example.com/u/1>,',
    '  <mailto:unsub@example.com?subject=remove>',
    'List-Unsubscribe-Post: List-Unsubscribe=One-Click',
    'List-Id: "Example News" <news.example.com>',
    'Subject: Hello',
    '',
    'List-Id: <in-the-body.example>',
    '',
  ].join('\r\n');

  it('takes the topmost Authentication-Results and unfolds long values', () => {
    const h = readListHeaders(raw);
    expect(h.ar).toContain('dkim=pass');
    expect(h.ar).not.toContain('forged');
    expect(h.lu).toBe('<https://example.com/u/1>, <mailto:unsub@example.com?subject=remove>');
    expect(h.lup).toBe('List-Unsubscribe=One-Click');
    expect(h.lid).toBe('"Example News" <news.example.com>');
  });

  it('works on bytes and on a message with no list headers', () => {
    expect(readListHeaders(new TextEncoder().encode('Subject: x\r\n\r\nbody'))).toEqual({});
  });
});

describe('parseListUnsubscribe', () => {
  it('reads https and mailto items and ignores everything else', () => {
    const p = parseListUnsubscribe(
      '<http://insecure.example/u>, <https://example.com/u?id=1>, <mailto:a@example.com?subject=Unsubscribe%20me&body=Please>, <javascript:alert(1)>, <ftp://x>',
    );
    expect(p.https).toEqual(['https://example.com/u?id=1']);
    expect(p.mailto).toEqual([{ address: 'a@example.com', subject: 'Unsubscribe me', body: 'Please' }]);
  });

  it('refuses https links with a user name and mailto links with a bad address', () => {
    const p = parseListUnsubscribe('<https://user:pw@example.com/u>, <mailto:not an address>');
    expect(p.https).toEqual([]);
    expect(p.mailto).toEqual([]);
    expect(parseListUnsubscribe(undefined)).toEqual({ https: [], mailto: [] });
  });

  it('uses "unsubscribe" when the mailto link has no subject and drops header injection', () => {
    expect(parseMailto('mailto:a@example.com')?.subject).toBe('unsubscribe');
    const m = parseMailto('mailto:a@example.com?subject=x%0D%0ABcc:%20evil@example.com&cc=evil@example.com');
    expect(m?.subject).toBe('x Bcc: evil@example.com');
    expect(m?.address).toBe('a@example.com');
  });
});

describe('isOneClick / parseListId', () => {
  it('recognizes the RFC 8058 value', () => {
    expect(isOneClick('List-Unsubscribe=One-Click')).toBe(true);
    expect(isOneClick('list-unsubscribe=one-click')).toBe(true);
    expect(isOneClick('something=else')).toBe(false);
    expect(isOneClick(undefined)).toBe(false);
  });

  it('reads the list id and the readable name', () => {
    expect(parseListId('"Example News" <News.Example.com>')).toEqual({ id: 'news.example.com', name: 'Example News' });
    expect(parseListId('<x.example>')).toEqual({ id: 'x.example', name: null });
    expect(parseListId('')).toBeNull();
  });
});

describe('sender check (Authentication-Results)', () => {
  const ar = (s: string) => `mx.google.com; ${s}`;

  it('is verified with a matching dkim domain, or spf together with dmarc', () => {
    expect(evaluateAuth(ar('dkim=pass header.d=example.com'), 'news@example.com')).toBe('verified');
    // a parent domain of the From domain counts
    expect(evaluateAuth(ar('dkim=pass header.i=@example.com'), 'news@mail.example.com')).toBe('verified');
    expect(evaluateAuth(ar('spf=pass smtp.mailfrom=bounce.esp.net; dmarc=pass header.from=brand.com'), 'a@brand.com')).toBe('verified');
    // one of two signatures matches
    expect(
      evaluateAuth(ar('dkim=pass header.d=esp.net; dkim=pass header.d=brand.com'), 'a@brand.com'),
    ).toBe('verified');
  });

  it('is unknown without a header or without dkim / spf results', () => {
    expect(evaluateAuth(undefined, 'a@b.com')).toBe('unknown');
    expect(evaluateAuth('', 'a@b.com')).toBe('unknown');
    expect(evaluateAuth('mx.example; none', 'a@b.com')).toBe('unknown');
    expect(evaluateAuth(ar('dmarc=pass'), 'a@b.com')).toBe('unknown');
    expect(evaluateAuth(ar('dkim=none; spf=neutral'), 'a@b.com')).toBe('unknown');
  });

  it('is failed on a fail result or a signing domain that is not the sender', () => {
    expect(evaluateAuth(ar('dkim=fail header.d=example.com'), 'a@example.com')).toBe('failed');
    expect(evaluateAuth(ar('dkim=pass header.d=example.com; spf=fail'), 'a@example.com')).toBe('failed');
    expect(evaluateAuth(ar('spf=pass; dmarc=fail'), 'a@example.com')).toBe('failed');
    // signed by somebody else, nothing else vouches for the sender
    expect(evaluateAuth(ar('dkim=pass header.d=evil.test'), 'a@example.com')).toBe('failed');
    // a child domain cannot sign for its parent
    expect(evaluateAuth(ar('dkim=pass header.d=mail.example.com'), 'a@example.com')).toBe('failed');
  });

  it('parses several results and domains', () => {
    const r = parseAuthResults(ar('dkim=pass header.d=A.com; dkim=fail header.i=@b.com; spf=softfail; dmarc=pass'));
    expect(r.dkim).toEqual([
      { verdict: 'pass', domain: 'a.com' },
      { verdict: 'fail', domain: 'b.com' },
    ]);
    expect(r.spf).toEqual(['other']);
    expect(r.dmarc).toEqual(['pass']);
    expect(domainAligned('example.com', 'news.example.com')).toBe(true);
    expect(domainAligned('xample.com', 'news.example.com')).toBe(false);
  });
});
