// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  classify,
  contrastRatio,
  detectDarkAware,
  mapBackground,
  mapBorder,
  mapText,
  oklchToRgb,
  parseColor,
  planBody,
  rgbToOklch,
  toCss,
  transformDesigned,
  transformSimple,
  verifyContrast,
  type PlanOptions,
} from '../../src/renderer/src/lib/emailTheme';
import { buildSrcdoc, sanitizeEmailHtml } from '../../src/renderer/src/lib/sanitize';

const hex = (s: string) => parseColor(s)!;
const css = (s: string) => toCss(mapBackground(hex(s)));
const kindOf = (html: string) => classify(html).kind;

// A frozen clock keeps the 80 ms time limit out of every test but the one that checks it:
// real timers made these flaky when the suite ran in parallel on a busy CPU.
const frozen = () => 0;
const DARK: PlanOptions = { dark: true, setting: 'auto', override: null, autoFallback: false, now: frozen };

describe('parseColor', () => {
  it('reads hex, rgb, hsl, names and transparent', () => {
    expect(toCss(hex('#fff'))).toBe('#ffffff');
    expect(toCss(hex('#0A66C2'))).toBe('#0a66c2');
    expect(toCss(hex('rgb(10, 102, 194)'))).toBe('#0a66c2');
    expect(toCss(hex('rgb(10 102 194 / 50%)'))).toBe('rgba(10,102,194,0.5)');
    expect(toCss(hex('hsl(0, 100%, 50%)'))).toBe('#ff0000');
    expect(toCss(hex('white'))).toBe('#ffffff');
    expect(toCss(hex('rebeccapurple'))).toBe('#663399');
    expect(hex('transparent').a).toBe(0);
  });
  it('returns null for what it cannot read', () => {
    expect(parseColor('var(--x)')).toBeNull();
    expect(parseColor('oklch(0.5 0.1 20)')).toBeNull();
    expect(parseColor('#12')).toBeNull();
    expect(parseColor('notacolor')).toBeNull();
  });
});

describe('OKLCH mapping', () => {
  it('round-trips through OKLCH', () => {
    for (const c of ['#0a66c2', '#e8590c', '#808080', '#ffffff', '#000000']) {
      const back = oklchToRgb(rgbToOklch(hex(c)));
      expect(toCss(back)).toBe(c);
    }
  });
  it('white background becomes about the surface color', () => {
    const o = rgbToOklch(hex(css('#ffffff')));
    expect(o.L).toBeCloseTo(0.27, 2);
    expect(Math.abs(hex(css('#ffffff')).r - 0x2b)).toBeLessThan(6);
  });
  it('pale tints stay lighter than the surface and keep their hue', () => {
    const tint = rgbToOklch(hex('#e7f0fb'));
    const out = rgbToOklch(hex(css('#e7f0fb')));
    expect(out.L).toBeGreaterThan(0.27);
    expect(out.L).toBeLessThan(0.35);
    expect(Math.abs(out.h - tint.h)).toBeLessThan(6);
    expect(out.C).toBeLessThan(tint.C);
  });
  it('keeps dark and mid-tone backgrounds, and alpha', () => {
    expect(css('#0a66c2')).toBe('#0a66c2'); // brand blue (mid-tone)
    expect(css('#b45309')).toBe('#b45309'); // brand amber
    expect(css('#111111')).toBe('#111111');
    expect(hex(css('rgba(255,255,255,0.5)')).a).toBeCloseTo(0.5, 2);
  });
  it('keeps saturated brand backgrounds colorful (chroma-aware)', () => {
    const orange = rgbToOklch(hex('#e8590c'));
    const o = rgbToOklch(hex(css('#e8590c')));
    expect(o.C).toBeGreaterThan(orange.C * 0.8);
    expect(Math.abs(o.h - orange.h)).toBeLessThan(6);
    expect(o.L).toBeGreaterThan(0.45);
    expect(o.L).toBeLessThanOrEqual(orange.L);
    expect(css('#e8590c')).not.toBe('#6a2200');
    const yellow = rgbToOklch(hex('#ffd60a'));
    const y = rgbToOklch(hex(css('#ffd60a')));
    expect(y.C).toBeGreaterThan(yellow.C * 0.8);
    expect(yellow.L - y.L).toBeLessThanOrEqual(0.101);
  });
  it('still turns near-white and light gray backgrounds into dark surfaces', () => {
    expect(rgbToOklch(hex(css('#ffffff'))).L).toBeCloseTo(0.27, 2);
    expect(rgbToOklch(hex(css('#f4f4f4'))).L).toBeLessThan(0.33);
    expect(rgbToOklch(hex(css('#d9d9d9'))).L).toBeLessThan(0.4);
  });
  it('maps text: neutral dark to primary, gray to secondary, dark colors lightened', () => {
    expect(toCss(mapText(hex('#000000')))).toBe('#ffffff');
    expect(toCss(mapText(hex('#222222')))).toBe('#ffffff');
    expect(toCss(mapText(hex('#444444')))).toBe('#cfcfcf');
    const o = rgbToOklch(mapText(hex('#7a2e0e')));
    expect(o.L).toBeGreaterThanOrEqual(0.72 - 0.01);
    expect(o.L).toBeLessThanOrEqual(0.92);
    expect(Math.abs(o.h - rgbToOklch(hex('#7a2e0e')).h)).toBeLessThan(6);
    expect(toCss(mapText(hex('#ffffff')))).toBe('#ffffff'); // white text stays
    expect(toCss(mapText(hex('#f2c661')))).toBe('#f2c661'); // light colors stay
  });
  it('maps neutral light borders to the border color only', () => {
    expect(toCss(mapBorder(hex('#dddddd')))).toBe('#3a3a3a');
    expect(toCss(mapBorder(hex('#0a66c2')))).toBe('#0a66c2');
    expect(toCss(mapBorder(hex('#333333')))).toBe('#333333');
  });
});

describe('classify()', () => {
  it('plain text has no HTML', () => {
    expect(classify(null).kind).toBe('plain');
  });
  it('compose output with a font and black text is Simple', () => {
    expect(kindOf('<div dir="ltr"><div style="font-family:arial;color:#000000">Hi</div></div>')).toBe('simple');
    expect(kindOf('<div style="background-color:white;color:black">Hi</div>')).toBe('simple');
    expect(kindOf('<table bgcolor="#ffffff"><tr><td>x</td></tr></table>')).toBe('simple');
  });
  it('a few colored words and links keep it Simple', () => {
    expect(
      kindOf('<p>Hi <span style="color:#c00">red</span> <a style="color:#0563c1" href="https://a.example">link</a></p>'),
    ).toBe('simple');
  });
  it('a colored background makes it Designed', () => {
    expect(kindOf('<table><tr><td style="background-color:#0a66c2">x</td></tr></table>')).toBe('designed');
    expect(kindOf('<table><tr><td bgcolor="#eeeeee">x</td></tr></table>')).toBe('designed');
    expect(kindOf('<style>.h{background:#e8590c}</style><div class="h">x</div>')).toBe('designed');
    expect(kindOf('<div style="background:#111">x</div>')).toBe('designed');
  });
  it('background images and gradients make it Designed', () => {
    expect(kindOf('<div style="background-image:url(data:image/png;base64,AAAA)">x</div>')).toBe('designed');
    expect(kindOf('<div style="background:linear-gradient(#fff,#eee)">x</div>')).toBe('designed');
    expect(kindOf('<table background="https://a.example/bg.png"><tr><td>x</td></tr></table>')).toBe('designed');
  });
  it('more than 3 distinct colored text colors on first-level containers makes it Designed', () => {
    const c = (n: string) => `<div style="color:${n}">x</div>`;
    expect(kindOf(c('#c00') + c('#0a0') + c('#00c'))).toBe('simple');
    expect(kindOf(c('#c00') + c('#0a0') + c('#00c') + c('#c0c'))).toBe('designed');
    // colors deep inside do not count
    expect(
      kindOf(
        '<div><div><div><p style="color:#c00">a</p><p style="color:#0a0">a</p><p style="color:#00c">a</p><p style="color:#c0c">a</p></div></div></div>',
      ),
    ).toBe('simple');
  });
});

describe('detectDarkAware', () => {
  it('finds meta tags and media queries', () => {
    expect(detectDarkAware('<meta name="color-scheme" content="light dark">')).toBe(true);
    expect(detectDarkAware('<meta content="light dark" name="supported-color-schemes">')).toBe(true);
    expect(detectDarkAware('<style>@media (prefers-color-scheme: dark){body{background:#000}}</style>')).toBe(true);
    expect(detectDarkAware('<meta name="color-scheme" content="light">')).toBe(false);
    expect(detectDarkAware('<p>hi</p>')).toBe(false);
  });
});

describe('transformSimple', () => {
  it('turns white backgrounds transparent and neutral text into theme colors', () => {
    const out = transformSimple(
      '<div style="background-color:#fff;color:#000">a</div><font color="#333333">b</font><a style="color:#0563c1;text-decoration:underline" href="https://a.example">c</a>',
    );
    expect(out).toContain('background-color:transparent');
    expect(out).toContain('color:#ffffff');
    expect(out).toContain('color="#ffffff"');
    expect(out).not.toContain('0563c1');
  });
});

describe('transformDesigned', () => {
  const header =
    '<table bgcolor="#ffffff" style="background:#ffffff"><tr><td bgcolor="#0a66c2" style="background-color:#0a66c2;color:#ffffff">Head</td></tr><tr><td style="color:#333333">Body</td></tr></table>';
  it('converts light backgrounds, keeps brand colors', () => {
    const r = transformDesigned(header, { now: frozen });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.html).not.toContain('bgcolor="#ffffff"');
    expect(r.html).not.toContain('background:#ffffff');
    expect(r.html).toContain('#0a66c2');
    expect(r.html).toContain('color:#ffffff'); // 333 -> primary, white stays
  });
  it('limit: more than 400 color declarations falls back', () => {
    const many = Array.from({ length: 401 }, () => '<p style="color:#123456">x</p>').join('');
    expect(transformDesigned(many, { now: frozen }).ok).toBe(false);
    expect(transformDesigned(many, { force: true, now: frozen }).ok).toBe(true);
    const ok = Array.from({ length: 400 }, () => '<p style="color:#123456">x</p>').join('');
    expect(transformDesigned(ok, { now: frozen }).ok).toBe(true);
  });
  it('limit: more than 10% unparseable colors falls back', () => {
    const bad = (n: number, total: number) =>
      Array.from({ length: total }, (_, i) => `<p style="color:${i < n ? 'var(--c)' : '#123456'}">x</p>`).join('');
    expect(transformDesigned(bad(11, 100), { now: frozen }).ok).toBe(false);
    expect(transformDesigned(bad(10, 100), { now: frozen }).ok).toBe(true);
  });
  it('limit: blend modes and filters fall back', () => {
    expect(transformDesigned('<div style="mix-blend-mode:multiply;color:#123">x</div>').ok).toBe(false);
    expect(transformDesigned('<div style="filter:invert(1)">x</div>').ok).toBe(false);
    expect(transformDesigned('<style>.a{backdrop-filter:blur(2px)}</style><div class="a">x</div>').ok).toBe(false);
  });
  it('limit: a gradient on a wide container falls back, a button gradient does not', () => {
    const wide = '<div style="background:linear-gradient(#fff,#eee)"><table><tr><td>x</td></tr></table></div>';
    expect(transformDesigned(wide, { now: frozen }).ok).toBe(false);
    const classRule =
      '<style>.hero{background-image:url(data:image/png;base64,AAAA)}</style><table class="hero"><tr><td><h1>x</h1></td></tr></table>';
    expect(transformDesigned(classRule, { now: frozen }).ok).toBe(false);
    const button =
      '<table><tr><td style="background-image:linear-gradient(#f90,#c60);padding:8px"><a href="https://a.example">Buy</a></td></tr></table>';
    expect(transformDesigned(button, { now: frozen }).ok).toBe(true);
  });
  it('limit: more than 80 ms falls back (fake clock)', () => {
    let t = 0;
    const now = () => (t += 100);
    expect(transformDesigned(header, { now }).ok).toBe(false);
    t = 0;
    expect(transformDesigned(header, { now, force: true }).ok).toBe(true);
  });
  it('strips sender height rules on html and body', () => {
    const r = transformDesigned('<style>html,body{height:100%;min-height:100vh;margin:0}.x{height:50px}</style><p>x</p>', { now: frozen });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.html).not.toMatch(/html,body\{[^}]*height/);
    expect(r.html).toContain('.x{height:50px}');
  });
});

describe('planBody', () => {
  const simple = { html: '<div style="color:#000">Hi</div>', kind: 'simple' as const, darkAware: false };
  const designed = {
    html: '<table bgcolor="#ffffff"><tr><td bgcolor="#0a66c2" style="color:#fff">H</td></tr></table>',
    kind: 'designed' as const,
    darkAware: false,
  };
  const gradient = {
    html: '<div style="background:linear-gradient(#fff,#eee)"><table><tr><td>x</td></tr></table></div>',
    kind: 'designed' as const,
    darkAware: false,
  };

  it('light theme is unchanged: white body, padding 16', () => {
    const p = planBody(designed, { ...DARK, dark: false });
    expect(p).toMatchObject({ variant: 'light', card: false, scheme: 'light', bodyPadding: 16, verify: 'none' });
    expect(p.html).toContain('#ffffff');
  });
  it('simple: theme colors, no card', () => {
    const p = planBody(simple, DARK);
    expect(p).toMatchObject({ variant: 'simple', card: false, scheme: 'dark', bodyPadding: 0 });
    expect(p.html).toContain('#ffffff');
    expect(p.css).toContain('#479ef5');
  });
  it('designed: transform with verification', () => {
    const p = planBody(designed, DARK);
    expect(p).toMatchObject({ variant: 'transform', card: false, scheme: 'dark', verify: 'full' });
  });
  it('designed with a wide gradient: paper card with the original colors', () => {
    const p = planBody(gradient, DARK);
    expect(p).toMatchObject({ variant: 'card', card: true, scheme: 'light', verify: 'none' });
    expect(p.html).toContain('linear-gradient(#fff,#eee)');
    expect(p.fallbackReason).toBeTruthy();
  });
  it('verification failure (autoFallback) gives the card', () => {
    expect(planBody(designed, { ...DARK, autoFallback: true })).toMatchObject({ variant: 'card' });
  });
  it('toggle: original colors -> card; show in dark mode retries ignoring the limits', () => {
    expect(planBody(designed, { ...DARK, override: 'original' })).toMatchObject({ variant: 'card' });
    const forced = planBody(gradient, { ...DARK, override: 'dark' });
    expect(forced).toMatchObject({ variant: 'transform', verify: 'fix', card: false });
    expect(planBody(designed, { ...DARK, autoFallback: true, override: 'dark' }).variant).toBe('transform');
  });
  it('"Always light background" gives the card for every HTML message', () => {
    expect(planBody(simple, { ...DARK, setting: 'light' })).toMatchObject({ variant: 'card', card: true });
    expect(planBody(designed, { ...DARK, setting: 'light' })).toMatchObject({ variant: 'card', card: true });
    expect(planBody(designed, { ...DARK, setting: 'light', override: 'dark' }).variant).toBe('transform');
  });
  it('senders that support dark mode are not transformed', () => {
    const p = planBody({ ...designed, darkAware: true }, DARK);
    expect(p).toMatchObject({ variant: 'darkaware', scheme: 'dark', verify: 'full' });
    expect(p.html).toContain('bgcolor="#ffffff"');
  });
});

describe('verifyContrast', () => {
  const run = (bodyHtml: string, strict = true, now?: () => number) => {
    // A real frame document has a window (getComputedStyle), like the reading pane's iframe.
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    const doc = frame.contentDocument!;
    doc.body.innerHTML = bodyHtml;
    const r = verifyContrast(doc, { strict, now });
    frame.remove();
    return { doc, r };
  };
  it('fixes low contrast text (white on dark, dark on light)', () => {
    const { doc, r } = run(
      '<div style="background-color:#2b2b2b"><p id="a" style="color:#444444">low</p></div><div style="background-color:#eeeeee"><p id="b" style="color:#dddddd">low2</p></div><p id="c" style="color:#ffffff">fine</p>',
    );
    expect(r.fixed).toBe(2);
    expect(doc.getElementById('a')!.style.getPropertyValue('color')).toBe('rgb(255, 255, 255)');
    expect(doc.getElementById('b')!.style.getPropertyValue('color')).toBe('rgb(26, 26, 26)');
  });
  it('composites alpha backgrounds over the surface', () => {
    const { r } = run('<div style="background-color:rgba(255,255,255,0.05)"><p style="color:#ffffff">ok</p></div>');
    expect(r.fixed).toBe(0);
  });
  it('rejects when more than 20% of text sits on an image background', () => {
    const body =
      '<div style="background-image:url(x.png)"><p>a</p><p>b</p></div><p style="color:#fff">c</p><p style="color:#fff">d</p>';
    const strict = run(body, true);
    expect(strict.r.unknown).toBe(2);
    expect(strict.r.reject).toBe(true);
    expect(run(body, false).r.reject).toBe(false);
  });
  it('rejects when verification is too slow', () => {
    let t = 0;
    expect(run('<p style="color:#fff">a</p>', true, () => (t += 100)).r.reject).toBe(true);
  });
  it('contrast ratio is the WCAG formula', () => {
    expect(contrastRatio(hex('#000'), hex('#fff'))).toBeCloseTo(21, 1);
    expect(contrastRatio(hex('#fff'), hex('#fff'))).toBeCloseTo(1, 5);
  });
});

describe('sanitize integration', () => {
  it('classifies once for the blocked and the allowed variant', () => {
    const out = sanitizeEmailHtml(
      '<div style="background-image:url(https://a.example/bg.png)"><p>x</p></div><img src="https://t.example/p.gif">',
    );
    expect(out.hasRemote).toBe(true);
    expect(out.classification.kind).toBe('designed');
    expect(out.blocked).not.toContain('a.example');
    const a = planBody({ html: out.blocked, kind: out.classification.kind, darkAware: out.darkAware }, DARK);
    const b = planBody({ html: out.allowed, kind: out.classification.kind, darkAware: out.darkAware }, DARK);
    expect(a.kind).toBe(b.kind);
  });
  it('srcdoc keeps the CSP and forces auto height; no scripts are allowed', () => {
    const doc = buildSrcdoc('<p>x</p>', false, { css: 'body{color:#fff}', scheme: 'dark', bodyPadding: 0 });
    expect(doc).toContain("default-src 'none'");
    expect(doc).toContain('img-src data:');
    expect(doc).not.toMatch(/script-src|allow-scripts/);
    expect(doc).toContain('height:auto!important;min-height:0!important');
    expect(doc).toContain('<meta name="color-scheme" content="dark">');
    expect(buildSrcdoc('<p>x</p>', true)).toContain('img-src data: mailroom-img:');
  });
});
