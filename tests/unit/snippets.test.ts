// Snippet cleaning: cut-off marketing HTML, quoted-printable cut mid-escape, windows-1252, plain text links.
import { describe, expect, it } from 'vitest';
import { snippetOf } from '../../src/engine/imap/snippets';
import { cleanSnippetText, makeSnippet, stripHtml } from '../../src/engine/messages/bodyUtils';
import type { SnippetPart } from '../../src/engine/imap/parse';

const html = (charset: string | null, encoding = '7bit'): SnippetPart => ({
  part: '2',
  type: 'text/html',
  encoding,
  charset,
});

const HEAD =
  '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN"><html xmlns="http://www.w3.org/1999/xhtml">' +
  '<head><!--[if gte mso 9]><xml><o:OfficeDocumentSettings><o:AllowPNG/><o:PixelsPerInch>96</o:PixelsPerInch>' +
  '</o:OfficeDocumentSettings></xml><![endif]--><meta charset="utf-8"><title>Welcome back</title>' +
  "<style type=\"text/css\">@font-face { font-family: 'Anthropic Sans'; src: url('https://assets.claude.ai/Fonts/Anthropic-Sans.woff2'); }\n" +
  'body { margin: 0; padding: 0; } @media only screen and (max-width: 600px) { .container { width: 100% !important; } }\n';

describe('stripHtml on cut-off documents', () => {
  it('drops an unclosed <style> in the head (no body tag seen yet)', () => {
    expect(stripHtml(HEAD)).toBe('');
    expect(stripHtml(HEAD.slice(0, 700))).toBe('');
  });

  it('skips the conditional comment, head and style, and keeps the body text', () => {
    const doc = `${HEAD}</style></head><body><div style="display:none">As of April 4 we are enforcing new limits&#847;&zwnj;&nbsp;</div><p>Hi,</p>`;
    expect(stripHtml(doc)).toBe('As of April 4 we are enforcing new limits Hi,');
  });

  it('drops CSS that leaked into plain text and decodes numeric entities', () => {
    expect(stripHtml('<p>a&#8211;b &#x41; &copy;</p>')).toBe('a-b A (c)');
    expect(cleanSnippetText("96 @font-face { font-family: 'X'; src: url('https://a/b.woff'); } Hello there")).toBe(
      '96 Hello there',
    );
  });

  it('removes a tag cut in half at the end', () => {
    expect(stripHtml('<p>Hello</p><a href="https://example.com/very/long')).toBe('Hello');
  });
});

describe('snippetOf', () => {
  it('marketing HTML cut at 3 KB: no CSS, no leading 96, no links', async () => {
    const filler = '<td>' + 'x'.repeat(10) + '</td>';
    const doc = `${HEAD}${'.pad { color: red; }\n'.repeat(200)}`;
    const cut = Buffer.from(doc + filler).subarray(0, 3072);
    expect(await snippetOf(html('utf-8'), cut, true)).toBe('');
  });

  it('full marketing HTML gives the visible text only', async () => {
    const doc = `${HEAD}</style></head><body><a href="https://claude.ai">Hi,</a> <p>As of April 4 at 12pm PT we are enforcing new limits.</p></body></html>`;
    expect(await snippetOf(html('utf-8'), Buffer.from(doc))).toBe('Hi, As of April 4 at 12pm PT we are enforcing new limits.');
  });

  it('quoted-printable cut in the middle of an =XX escape', async () => {
    const qp = '<html><body><p>Caf=C3=A9 au lait is =E2=80=94 nice and warm today for everyone here</p></body></html>';
    for (let cut = qp.length - 40; cut < qp.length - 2; cut++) {
      const snip = await snippetOf(html('utf-8', 'quoted-printable'), Buffer.from(qp.slice(0, cut)), true);
      expect(snip.startsWith('Café au lait')).toBe(true);
      expect(snip).not.toMatch(/=[0-9A-F]?$/);
      expect(snip).not.toContain('\uFFFD');
    }
    // Cut right after the "=" and after "=C".
    const a = '<p>Hello =C3=A9 wor=';
    const b = '<p>Hello =C3=A9 wor=C';
    expect(await snippetOf(html('utf-8', 'quoted-printable'), Buffer.from(a), true)).toBe('Hello é wor');
    expect(await snippetOf(html('utf-8', 'quoted-printable'), Buffer.from(b), true)).toBe('Hello é wor');
  });

  it('windows-1252 part: 0x96 is an en dash, not a stray character', async () => {
    const buf = Buffer.concat([Buffer.from('<p>Pro '), Buffer.from([0x96]), Buffer.from(' Max plan</p>')]);
    const snip = await snippetOf(html('windows-1252'), buf);
    expect(snip).toContain('Pro');
    expect(snip).toContain('Max plan');
    expect(snip).not.toContain('\uFFFD');
    expect(snip).toMatch(/Pro .{1,2} Max plan/);
  });

  it('plain text starting with an angle-bracket link', async () => {
    const part: SnippetPart = { part: '1', type: 'text/plain', encoding: '7bit', charset: 'utf-8' };
    const raw = "<https://claude.ai> Hi,\r\n\r\nAs of April 4 at 12pm PT / 8pm BST, we're enforcing new limits.\r\nSee https://claude.ai/limits for more.";
    expect(await snippetOf(part, Buffer.from(raw))).toBe("Hi, As of April 4 at 12pm PT / 8pm BST, we're enforcing new limits. See for more.");
  });
});

describe('cleanSnippetText', () => {
  it('removes links, image markers and view-in-browser openers; keeps normal text', () => {
    expect(cleanSnippetText('View this email in your browser <https://x.com/v?id=1> Big sale today [image: logo] now')).toBe(
      'Big sale today now',
    );
    expect(cleanSnippetText('[https://tracker.example/p.gif] Hello (see www.example.com) friend')).toBe('Hello (see friend');
    expect(cleanSnippetText('Meeting at 3pm, room 4 (bring slides)')).toBe('Meeting at 3pm, room 4 (bring slides)');
  });

  it('makeSnippet uses the same cleaning for text and HTML', () => {
    expect(makeSnippet('<https://claude.ai> Hello', null)).toBe('Hello');
    expect(makeSnippet(null, `${HEAD}</style></head><body><p>Hello</p></body>`)).toBe('Hello');
  });
});
