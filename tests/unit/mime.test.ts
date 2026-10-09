import { describe, expect, it } from 'vitest';
import type { MessageBody } from '../../src/shared/ipc';
import {
  addressList,
  buildRaw,
  dedupeAddresses,
  forwardSubject,
  htmlToPlain,
  initialHtml,
  parseMailto,
  quoteHtml,
  replyRecipients,
  replyReferences,
  replySubject,
  signatureHtml,
  textToHtml,
  withBccHeader,
} from '../../src/engine/smtp/mime';
import { simpleParser } from 'mailparser';

function body(over: Partial<MessageBody> & { from?: string; to?: string[]; cc?: string[] } = {}): MessageBody {
  const addr = (a: string) => ({ address: a });
  return {
    id: 1,
    header: {
      id: 1,
      accountId: 'a',
      folderId: 1,
      uid: 1,
      messageIdHeader: '<m1@x>',
      subject: 'Plans',
      from: addr(over.from ?? 'alice@example.com'),
      to: (over.to ?? ['me@example.com']).map(addr),
      cc: (over.cc ?? []).map(addr),
      date: Date.UTC(2026, 9, 5, 12, 30),
      snippet: '',
      seen: true,
      flagged: false,
      answered: false,
      draft: false,
      hasAttachments: false,
      size: 10,
      bodyCached: true,
    },
    bcc: [],
    replyTo: [],
    inReplyTo: null,
    references: null,
    html: null,
    text: 'Hello there',
    attachments: [],
    hasRemoteImages: false,
    senderImagesAllowed: false,
    truncated: false,
    ...over,
  };
}

describe('subjects', () => {
  it('adds Re: / Fwd: once', () => {
    expect(replySubject('Hello')).toBe('Re: Hello');
    expect(replySubject('Re: Hello')).toBe('Re: Hello');
    expect(replySubject('RE: Hello')).toBe('RE: Hello');
    expect(replySubject('AW: Hallo')).toBe('AW: Hallo');
    expect(forwardSubject('Hello')).toBe('Fwd: Hello');
    expect(forwardSubject('Fwd: Hello')).toBe('Fwd: Hello');
    expect(forwardSubject('FW: Hello')).toBe('FW: Hello');
    expect(replySubject('')).toBe('Re:');
  });
});

describe('reply recipients', () => {
  const own = ['me@example.com', 'ME2@example.com'];

  it('reply goes to Reply-To, else From', () => {
    const b = body();
    expect(replyRecipients(b, own, false)).toEqual({ to: [{ address: 'alice@example.com' }], cc: [] });
    const withReplyTo = body({ replyTo: [{ address: 'list@example.com' }] });
    expect(replyRecipients(withReplyTo, own, false).to).toEqual([{ address: 'list@example.com' }]);
  });

  it('reply all adds To and Cc minus own addresses and duplicates', () => {
    const b = body({
      to: ['me@example.com', 'bob@example.com', 'Alice@Example.com'],
      cc: ['me2@example.com', 'carol@example.com', 'bob@example.com'],
    });
    const r = replyRecipients(b, own, true);
    expect(r.to.map((a) => a.address)).toEqual(['alice@example.com', 'bob@example.com']);
    expect(r.cc.map((a) => a.address)).toEqual(['carol@example.com']);
  });

  it('replying to your own message goes to its recipients', () => {
    const b = body({ from: 'me@example.com', to: ['bob@example.com'] });
    expect(replyRecipients(b, own, false).to.map((a) => a.address)).toEqual(['bob@example.com']);
  });

  it('a note to yourself still has a To address', () => {
    const b = body({ from: 'me@example.com', to: ['me@example.com'] });
    expect(replyRecipients(b, own, false).to).toEqual([{ address: 'me@example.com' }]);
  });

  it('dedupes case-insensitively', () => {
    expect(dedupeAddresses([{ address: 'A@x.com' }, { address: 'a@X.com' }, { address: 'b@x.com' }])).toHaveLength(2);
    expect(addressList([{ address: 'a@x.com' }], [{ address: 'A@x.com' }, { address: 'c@x.com' }])).toEqual(['a@x.com', 'c@x.com']);
  });
});

describe('references', () => {
  it('appends the original id and keeps the last 20', () => {
    expect(replyReferences({ references: '<a@x> <b@x>', messageId: '<c@x>' })).toBe('<a@x> <b@x> <c@x>');
    expect(replyReferences({ references: null, messageId: '<c@x>' })).toBe('<c@x>');
    expect(replyReferences({ references: null, messageId: null })).toBeNull();
    const many = Array.from({ length: 30 }, (_, i) => `<${i}@x>`).join(' ');
    expect(replyReferences({ references: many, messageId: '<z@x>' })!.split(' ')).toHaveLength(20);
  });
});

describe('quoting and signature', () => {
  it('escapes the quoted text', () => {
    const b = body({ text: '<script>alert(1)</script> & "q"' });
    const html = quoteHtml(b);
    expect(html).not.toContain('<script');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('wrote:');
    expect(html).toContain('alice@example.com');
  });

  it('uses HTML converted to text when there is no text part', () => {
    const b = body({ text: null, html: '<p>Hi <b>there</b></p><style>p{}</style>' });
    expect(quoteHtml(b)).toContain('Hi there');
  });

  it('signatures: plain text is escaped, HTML is kept', () => {
    expect(signatureHtml('A & B\nLine 2')).toContain('A &amp; B<br>Line 2');
    expect(signatureHtml('<b>Bold</b>')).toContain('<b>Bold</b>');
    expect(signatureHtml('  ')).toBe('');
    expect(signatureHtml(null)).toBe('');
  });

  it('initial html: new has only the signature; reply has signature then quote', () => {
    expect(initialHtml({ mode: 'new', signature: null })).toBe('<p><br></p>');
    const reply = initialHtml({ mode: 'reply', signature: 'Me', source: body() });
    expect(reply.indexOf('mailroom-signature')).toBeLessThan(reply.indexOf('mailroom-quote'));
    const fwd = initialHtml({ mode: 'forward', signature: null, source: body() });
    expect(fwd).toContain('Forwarded message');
    expect(fwd).toContain('Subject: Plans');
  });

  it('text helpers', () => {
    expect(textToHtml('a<b\r\nc')).toBe('a&lt;b<br>c');
    expect(htmlToPlain('<p>Hello <a href="https://x.com">link</a></p>')).toContain('Hello link');
  });
});

describe('mailto', () => {
  it('parses addresses, subject, body and cc', () => {
    const m = parseMailto('mailto:a@x.com,b@x.com?subject=Hi%20you&cc=c@x.com&body=Line1%0ALine2&bcc=d@x.com');
    expect(m.to.map((a) => a.address)).toEqual(['a@x.com', 'b@x.com']);
    expect(m.cc.map((a) => a.address)).toEqual(['c@x.com']);
    expect(m.bcc.map((a) => a.address)).toEqual(['d@x.com']);
    expect(m.subject).toBe('Hi you');
    expect(m.body).toBe('Line1\nLine2');
  });
  it('ignores bad input', () => {
    expect(parseMailto('https://x.com')).toEqual({ to: [], cc: [], bcc: [], subject: '', body: '' });
    expect(parseMailto('mailto:not-an-address').to).toEqual([]);
  });
});

describe('buildRaw', () => {
  it('builds a message with headers, alternatives and no Bcc header', async () => {
    const raw = await buildRaw({
      from: { name: 'Me', address: 'me@example.com' },
      to: [{ name: 'Ünïcode Name', address: 'to@example.com' }],
      cc: [],
      bcc: [{ address: 'hidden@example.com' }],
      subject: 'Grüße ✓',
      html: '<p>Hi <b>there</b></p>',
      messageId: '<id1@example.com>',
      inReplyTo: '<o@x>',
      references: '<r@x> <o@x>',
      attachments: [],
    });
    const text = raw.toString('utf8');
    expect(text).not.toMatch(/^bcc:/im);
    const p = await simpleParser(raw);
    expect(p.subject).toBe('Grüße ✓');
    expect(p.messageId).toBe('<id1@example.com>');
    expect(p.inReplyTo).toBe('<o@x>');
    expect(p.html).toContain('Hi <b>there</b>');
    expect(p.text).toContain('Hi there');
    expect(p.headers.get('x-mailer')).toBe('Mailroom');

    const withBcc = await simpleParser(withBccHeader(raw, [{ address: 'hidden@example.com' }]));
    expect(JSON.stringify(withBcc.headers.get('bcc'))).toContain('hidden@example.com');
  });
});
