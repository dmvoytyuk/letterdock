// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { toProxyUrl, fromProxyUrl } from '../../src/shared/imageProxy';
import { buildSrcdoc, cidRefs, sanitizeEmailHtml } from '../../src/renderer/src/lib/sanitize';

const run = (html: string, cid: Record<string, string> = {}) => sanitizeEmailHtml(html, cid);

describe('sanitizeEmailHtml', () => {
  it('removes scripts, event handlers and dangerous tags', () => {
    const out = run(
      '<p onclick="x()">hi</p><script>alert(1)</script><iframe src="https://e.com"></iframe><form action="/x"><input></form><object data="a"></object><embed src="a"><meta http-equiv="refresh" content="0"><link rel="stylesheet" href="https://e.com/a.css"><base href="https://e.com">',
    );
    for (const html of [out.blocked, out.allowed]) {
      expect(html).toContain('hi');
      expect(html).not.toMatch(/<script|<iframe|<form|<input|<object|<embed|<meta|<link|<base|onclick/i);
    }
  });

  it('removes javascript: and data: links and hardens the rest', () => {
    const out = run(
      '<a href="javascript:alert(1)">a</a><a href="data:text/html,x">b</a><a href="https://ok.example/x">c</a>',
    );
    expect(out.blocked).not.toMatch(/javascript:|data:text/i);
    expect(out.blocked).toContain('rel="noopener noreferrer"');
    expect(out.blocked).toContain('target="_blank"');
    expect(out.blocked).toContain('https://ok.example/x');
  });

  it('blocks remote images by default and flags them', () => {
    const out = run('<img src="https://track.example/p.gif"><img srcset="https://a/b.png 2x" src="//x/y.png">');
    expect(out.hasRemote).toBe(true);
    expect(out.blocked).not.toMatch(/(?<!data-blocked-)src=|srcset/i);
    expect(out.blocked).toContain('data-blocked-src');
    expect(out.allowed).toContain(`src="${toProxyUrl('https://track.example/p.gif')}"`);
    expect(out.allowed).not.toMatch(/https?:\/\//);
  });

  it('strips remote CSS urls when blocked and dangerous CSS always', () => {
    const out = run(
      '<style>@import url(https://e.com/a.css); .a{background:url(https://e.com/x.png);color:red} .b{behavior:url(x.htc);-moz-binding:url(x);width:expression(alert(1))}</style><div style="background-image:url(https://e.com/y.png);color:blue">x</div>',
    );
    expect(out.hasRemote).toBe(true);
    expect(out.blocked).not.toMatch(/https?:\/\/|@import|behavior|-moz-binding|expression/i);
    expect(out.blocked).toContain('color:red');
    expect(out.blocked).toContain('color:blue');
    expect(out.allowed).toContain(toProxyUrl('https://e.com/y.png')!);
    expect(out.allowed).not.toContain('https://e.com');
    expect(out.allowed).not.toMatch(/@import|behavior|-moz-binding|expression/i);
  });

  it('removes background attributes when blocked', () => {
    const out = run('<table background="https://e.com/bg.png"><tr><td>x</td></tr></table>');
    expect(out.hasRemote).toBe(true);
    expect(out.blocked).not.toContain('background=');
  });

  it('maps cid: images to provided data urls and drops unknown ones', () => {
    const out = run('<img src="cid:logo"><img src="cid:other">', { logo: 'data:image/png;base64,AAAA' });
    expect(out.blocked).toContain('data:image/png;base64,AAAA');
    expect(out.blocked).not.toContain('cid:');
    expect(out.hasRemote).toBe(false);
  });

  it('drops file: and other unknown image sources', () => {
    const out = run('<img src="file:///C:/secret.png"><img src="ftp://x/y.png">');
    expect(out.allowed).not.toMatch(/file:|ftp:/);
  });

  it('removes svg and srcdoc attributes', () => {
    const out = run('<svg onload="x()"><script>1</script></svg><p srcdoc="x">ok</p>');
    expect(out.blocked).not.toMatch(/<svg|srcdoc|onload/i);
  });
});

describe('buildSrcdoc', () => {
  it('uses a locked down CSP and only allows remote images when asked', () => {
    const blocked = buildSrcdoc('<p>x</p>', false);
    const allowed = buildSrcdoc('<p>x</p>', true);
    expect(blocked).toContain("default-src 'none'");
    expect(blocked).toContain('img-src data:;');
    expect(blocked).not.toContain('https:');
    expect(allowed).toContain('img-src data: letterdock-img:;');
    expect(allowed).not.toMatch(/https?:/);
    expect(blocked).toContain("frame-src 'none'");
  });
});

describe('remote image rewrite to the local cache', () => {
  it('rewrites img src, srcset, background attributes and CSS urls; leaves nothing remote', () => {
    const out = run(
      '<img src="//cdn.example/a.png" srcset="https://cdn.example/a.png 1x, https://cdn.example/a@2x.png 2x">' +
        '<table background="http://e.com/bg.png"><tr><td style="background-image:url(\'https://e.com/c.png\')">x</td></tr></table>' +
        '<style>.h{background:url(https://e.com/d.png) no-repeat}</style>',
    );
    const html = out.allowed;
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).toContain(toProxyUrl('https://cdn.example/a.png')!);
    expect(html).toContain(toProxyUrl('https://cdn.example/a@2x.png')! + ' 2x');
    expect(html).toContain(`background="${toProxyUrl('http://e.com/bg.png')}"`);
    expect(html).toContain(toProxyUrl('https://e.com/c.png')!);
    expect(html).toContain(toProxyUrl('https://e.com/d.png')!);
    // blocked mode is unchanged: no proxy URLs, no remote URLs at all
    expect(out.blocked).not.toMatch(/letterdock-img|https?:\/\/e\.com|srcset/);
  });
  it('round-trips URLs with unusual characters', () => {
    const u = 'https://ex.com/a b/é?x=1&y=(2)\'"';
    expect(fromProxyUrl(toProxyUrl(u)!)).toBe(u);
    expect(toProxyUrl('data:image/png;base64,AA')).toBeNull();
    expect(fromProxyUrl('letterdock-img://i/' + btoa('ftp://x/y'))).toBeNull();
    expect(fromProxyUrl('https://example.com/')).toBeNull();
  });
});

describe('cidRefs', () => {
  it('finds distinct lower-cased cid references', () => {
    expect(cidRefs('<img src="cid:A1"><img src=\'cid:a1\'><img src=cid:B2>')).toEqual(['a1', 'b2']);
  });
});
