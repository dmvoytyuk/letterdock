// Pure parts of: message window, printing, mailto: handling, and the new IPC channels.
import { describe, expect, it } from 'vitest';
import { computeMailtoStatus, DEFAULT_APPS_URI, findMailtoArg } from '../../src/main/mailto';
import {
  buildPrintDocument,
  fmtDate,
  fmtSize,
  PRINT_CSP,
  stripDangerousTags,
} from '../../src/main/print/printDocument';
import { schemas } from '../../src/main/ipcSchemas';
import { DEFAULT_VIEWER_SIZE, parseViewerSize, viewerHash } from '../../src/main/viewerState';
import { isMainChannel } from '../../src/shared/channels';

describe('findMailtoArg', () => {
  it('finds the link among normal arguments', () => {
    expect(findMailtoArg(['Letterdock.exe', '--flag', 'mailto:bob@x.com?subject=Hi'])).toBe(
      'mailto:bob@x.com?subject=Hi',
    );
    expect(findMailtoArg(['MAILTO:Bob@x.com'])).toBe('MAILTO:Bob@x.com');
  });
  it('ignores everything else', () => {
    expect(findMailtoArg(['a', 'https://x.com', 'file:///c:/x', 'mailto'])).toBeNull();
    expect(findMailtoArg([])).toBeNull();
  });
  it('rejects control characters and huge values', () => {
    expect(findMailtoArg(['mailto:a@b.com\r\nBcc: evil@x.com'])).toBeNull();
    expect(findMailtoArg([`mailto:${'a'.repeat(9000)}@b.com`])).toBeNull();
  });
});

describe('computeMailtoStatus', () => {
  const base = { registeredCommand: true, currentHandlerName: 'Letterdock', appName: 'Letterdock' };
  it('is never registered in dev runs', () => {
    expect(computeMailtoStatus({ ...base, isPackaged: false })).toEqual({ registered: false });
  });
  it('reports registration and default', () => {
    expect(computeMailtoStatus({ ...base, isPackaged: true })).toEqual({
      registered: true,
      isDefault: true,
    });
    expect(
      computeMailtoStatus({ ...base, isPackaged: true, currentHandlerName: 'Outlook' }),
    ).toEqual({ registered: true, isDefault: false });
    expect(computeMailtoStatus({ ...base, isPackaged: true, currentHandlerName: '' })).toEqual({
      registered: true,
      isDefault: false,
    });
  });
  it('uses a fixed settings address', () => {
    expect(DEFAULT_APPS_URI).toBe('ms-settings:defaultapps');
  });
});

describe('message window helpers', () => {
  it('builds the hash and reads a saved size safely', () => {
    expect(viewerHash(42)).toBe('msg=42');
    expect(parseViewerSize(null)).toEqual(DEFAULT_VIEWER_SIZE);
    expect(parseViewerSize('not json')).toEqual(DEFAULT_VIEWER_SIZE);
    expect(parseViewerSize('{"width":"x","height":5}')).toEqual(DEFAULT_VIEWER_SIZE);
    expect(parseViewerSize('{"width":1000,"height":700,"maximized":true}')).toEqual({
      width: 1000,
      height: 700,
      maximized: true,
    });
    expect(parseViewerSize('{"width":10,"height":99999}')).toMatchObject({ width: 480, height: 8000 });
  });
});

describe('print document', () => {
  const input = {
    subject: 'Hello <b>there</b>',
    from: { name: 'Eve "<script>"', address: 'eve@x.com' },
    to: [{ address: 'me@x.com' }],
    cc: [],
    date: Date.UTC(2026, 9, 8, 12, 0),
    bodyHtml: null,
    text: 'Line 1 <img src=x onerror=alert(1)>\nLine 2',
  };
  it('escapes header values and text bodies', () => {
    const doc = buildPrintDocument(input);
    expect(doc).not.toMatch(/<b>there/);
    expect(doc).toContain('Hello &lt;b&gt;there&lt;/b&gt;');
    expect(doc).toContain('Eve &quot;&lt;script&gt;&quot; &lt;eve@x.com&gt;');
    expect(doc).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(doc).not.toMatch(/<img/);
  });
  it('carries a strict CSP first, no script, light colors', () => {
    const doc = buildPrintDocument({ ...input, bodyHtml: '<p>Hi</p>' });
    expect(doc.indexOf('Content-Security-Policy')).toBeLessThan(doc.indexOf('<body>'));
    expect(PRINT_CSP).toContain("default-src 'none'");
    expect(PRINT_CSP).toContain("script-src 'none'");
    expect(PRINT_CSP).toContain('img-src data: letterdock-img:');
    expect(PRINT_CSP).not.toMatch(/https?:/);
    expect(doc).toContain('color-scheme:light');
    expect(doc).toContain('background:#fff!important');
    expect(doc).not.toMatch(/<script/i);
  });
  it('strips tags that must never print, even from "sanitized" input', () => {
    const dirty =
      '<p>ok</p><script>alert(1)</script><iframe src="https://evil"></iframe><meta http-equiv="refresh" content="0;url=https://evil"><base href="https://evil/"><link rel="stylesheet" href="https://evil/x.css"><SCRIPT >x</SCRIPT ><form action="x"><input></form>';
    const clean = stripDangerousTags(dirty);
    expect(clean).toContain('<p>ok</p>');
    expect(clean).not.toMatch(/script|iframe|meta|base|link|form/i);
    const doc = buildPrintDocument({ ...input, bodyHtml: dirty });
    expect(doc).not.toMatch(/evil/);
  });
  it('prints Bcc only when known, and lists attachments as text', () => {
    const none = buildPrintDocument({ ...input, bodyHtml: '<p>x</p>' });
    expect(none).not.toContain('Bcc');
    expect(none).not.toContain('Attachments');
    const doc = buildPrintDocument({
      ...input,
      bodyHtml: '<p>x</p>',
      bcc: [{ name: 'Sec', address: 'sec@x.com' }],
      attachments: [
        { filename: 'budget <q4>.pdf', size: 245_760 },
        { filename: null, size: 900 },
      ],
    });
    expect(doc).toContain('<th>Bcc</th><td>Sec &lt;sec@x.com&gt;</td>');
    expect(doc).toContain('<b>Attachments (2):</b> budget &lt;q4&gt;.pdf (240 KB), (no name) (900 B)');
  });
  it('formats the date and sizes the way the design says', () => {
    const d = new Date(2026, 9, 5, 10, 42).getTime(); // local time
    expect(fmtDate(d)).toBe('Monday, 5 October 2026, 10:42');
    expect(fmtSize(18 * 1024)).toBe('18 KB');
    expect(fmtSize(2.5 * 1024 * 1024)).toBe('2.5 MB');
  });
  it('keeps letterdock-img images', () => {
    const doc = buildPrintDocument({
      ...input,
      bodyHtml: '<img src="letterdock-img://i/aHR0cHM6Ly94">',
    });
    expect(doc).toContain('letterdock-img://i/aHR0cHM6Ly94');
  });
});

describe('new IPC channels', () => {
  it('validates their payloads', () => {
    expect(schemas['message.openWindow'].safeParse({ messageId: 5 }).success).toBe(true);
    expect(schemas['message.openWindow'].safeParse({ messageId: -1 }).success).toBe(false);
    expect(schemas['message.print'].safeParse({ messageId: 5, bodyHtml: '<p>x</p>' }).success).toBe(true);
    expect(schemas['message.print'].safeParse({ messageId: 5, bodyHtml: 5 }).success).toBe(false);
    expect(schemas['contacts.suggest'].safeParse({ query: 'an', limit: 8 }).success).toBe(true);
    expect(schemas['contacts.suggest'].safeParse({ query: 'an', limit: 500 }).success).toBe(false);
    expect(schemas['contacts.suggest'].safeParse({ limit: 5 }).success).toBe(false);
    expect(schemas['contacts.forget'].safeParse({ address: 'a@b.com' }).success).toBe(true);
    expect(schemas['contacts.forget'].safeParse({ address: '' }).success).toBe(false);
    expect(schemas['app.mailtoStatus'].safeParse(undefined).success).toBe(true);
    expect(schemas['app.openDefaultAppsSettings'].safeParse(undefined).success).toBe(true);
  });
  it('routes them to the right process', () => {
    for (const c of ['message.openWindow', 'message.print', 'app.mailtoStatus', 'app.openDefaultAppsSettings']) {
      expect(isMainChannel(c), c).toBe(true);
    }
    for (const c of ['contacts.suggest', 'contacts.forget']) expect(isMainChannel(c), c).toBe(false);
  });
});
