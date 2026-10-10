// HTML email sanitizing (ARCHITECTURE section 9). Security-critical: keep changes small and tested.
import DOMPurify from 'dompurify';
import type * as TrackersModule from '../../../shared/trackers';
import * as csstree from 'css-tree';
import { IMAGE_SCHEME, isRemoteUrl, toProxyUrl } from '../../../shared/imageProxy';
import { classify,detectDarkAware, type ClassifyResult } from './emailTheme';
import { QUOTE_FRAME_CSS } from './quotes';

export interface SanitizedHtml {
  /** Safe HTML with every remote resource removed. */
  blocked: string;
  /** Safe HTML that keeps remote images (only used after the user clicks "Load images"). */
  allowed: string;
  /** True if the message wanted to load something from the internet. */
  hasRemote: boolean;
  /** Simple or Designed (dark-theme rendering, DESIGN-SPEC 3.6.1). Same for both variants above. */
  classification: ClassifyResult;
  /** The sender says it supports dark mode (meta color-scheme or prefers-color-scheme rules). */
  darkAware: boolean;
  /** Tracking images found (DESIGN-SPEC 3.13.7). They are removed from BOTH variants above, also after "Load images". */
  trackers: { count: number; domains: string[] };
}

/** The tracker list code (`shared/trackers.ts`). It loads with `import()` the first time an HTML message is opened. */
export type TrackerApi = typeof TrackersModule;
let trackerLib: TrackerApi | null = null;
let trackerLoad: Promise<TrackerApi> | null = null;
export function loadTrackerLib(): Promise<TrackerApi> {
  trackerLoad ??= import('../../../shared/trackers').then((m) => (trackerLib = m));
  return trackerLoad;
}
export function trackerLibIfLoaded(): TrackerApi | null {
  return trackerLib;
}

/**
 * Takes the tracking images (known tracker hosts, hidden 1x1 images) out of the tree before it is
 * copied into the blocked and allowed variants. They never load, and they do not count as "remote
 * images" for the banner. Never throws: a failure here must not hold back the message.
 */
function stripTrackers(root: HTMLElement, lib: TrackerApi): { count: number; domains: string[] } {
  try {
    const found: Parameters<TrackerApi['summarizeTrackers']>[0][number][] = [];
    root.querySelectorAll('img').forEach((img) => {
      const raw = (img.getAttribute('src') ?? '').trim();
      if (!isRemoteUrl(raw)) return;
      const cand = {
        src: raw.startsWith('//') ? `https:${raw}` : raw,
        width: img.getAttribute('width'),
        height: img.getAttribute('height'),
        style: img.getAttribute('style'),
        hidden: img.hasAttribute('hidden'),
      };
      if (!lib.isTracker(cand)) return;
      found.push(cand);
      img.removeAttribute('src');
      img.removeAttribute('srcset');
    });
    return lib.summarizeTrackers(found);
  } catch {
    return { count: 0, domains: [] };
  }
}

const FORBID_TAGS = [
  'script',
  'iframe',
  'object',
  'embed',
  'form',
  'input',
  'button',
  'textarea',
  'select',
  'meta',
  'link',
  'base',
  'frame',
  'frameset',
  'applet',
  'svg',
  'math',
  'audio',
  'video',
  'source',
  'track',
];

const purify = DOMPurify(window);
purify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    const href = (node.getAttribute('href') ?? '').trim();
    if (/^(javascript|data|vbscript|file):/i.test(href)) node.removeAttribute('href');
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

/** Remove dangerous CSS. When `blockRemote`, also drop any rule that points to the internet. */
function cleanCss(css: string, blockRemote: boolean, asDeclarations: boolean): string | null {
  try {
    const ast = csstree.parse(css, { context: asDeclarations ? 'declarationList' : 'stylesheet' });
    let remote = false;
    csstree.walk(ast, {
      enter(node: csstree.CssNode, item: csstree.ListItem<csstree.CssNode>, list: csstree.List<csstree.CssNode>) {
        if (node.type === 'Atrule' && node.name.toLowerCase() === 'import') {
          remote = true;
          list.remove(item);
          return;
        }
        if (node.type === 'Declaration') {
          const prop = node.property.toLowerCase();
          const text = csstree.generate(node.value).toLowerCase();
          if (
            prop === 'behavior' ||
            prop === '-moz-binding' ||
            text.includes('expression(') ||
            text.includes('javascript:')
          ) {
            list.remove(item);
            return;
          }
          let drop = false;
          csstree.walk(node.value, (n) => {
            if (n.type === 'Url') {
              const v = n.value.trim();
              if (isRemoteUrl(v)) {
                remote = true;
                if (blockRemote) drop = true;
                else {
                  // Remote images load through the local cache (letterdock-img:), never directly.
                  const p = toProxyUrl(v);
                  if (p) n.value = p;
                  else drop = true;
                }
              } else if (!/^data:image\//i.test(v)) {
                drop = true;
              }
            }
          });
          if (drop) list.remove(item);
        }
      },
    });
    void remote;
    return csstree.generate(ast);
  } catch {
    return null;
  }
}

function cssHasRemote(css: string): boolean {
  return /url\(\s*['"]?\s*(https?:)?\/\//i.test(css) || /@import/i.test(css);
}

/** Rewrite the remote candidates of a srcset to the local cache; drops everything else. */
export function proxySrcset(srcset: string): string {
  return srcset
    .split(/,\s+|,(?=\S+\s+\d)/)
    .map((c) => c.trim().split(/\s+/))
    .flatMap(([url, ...desc]) => {
      const p = url ? toProxyUrl(url) : null;
      return p ? [[p, ...desc].join(' ')] : [];
    })
    .join(', ');
}

function processTree(root: HTMLElement, blockRemote: boolean, cid: Record<string, string>): void {
  root.querySelectorAll('style').forEach((st) => {
    const cleaned = cleanCss(st.textContent ?? '', blockRemote, false);
    if (cleaned === null) st.remove();
    else st.textContent = cleaned;
  });
  root.querySelectorAll('[style]').forEach((el) => {
    const cleaned = cleanCss(el.getAttribute('style') ?? '', blockRemote, true);
    if (cleaned === null) el.removeAttribute('style');
    else el.setAttribute('style', cleaned);
  });
  root.querySelectorAll('img').forEach((img) => {
    const src = (img.getAttribute('src') ?? '').trim();
    if (/^cid:/i.test(src)) {
      const data = cid[src.slice(4).replace(/^<|>$/g, '').toLowerCase()];
      if (data) img.setAttribute('src', data);
      else img.removeAttribute('src');
    } else if (/^data:image\//i.test(src)) {
      /* inline image: fine */
    } else if (isRemoteUrl(src)) {
      if (blockRemote) {
        img.setAttribute('data-blocked-src', src);
        img.removeAttribute('src');
      } else {
        const p = toProxyUrl(src);
        if (p) img.setAttribute('src', p);
        else img.removeAttribute('src');
      }
    } else {
      img.removeAttribute('src');
    }
    const srcset = img.getAttribute('srcset');
    if (srcset !== null) {
      const kept = blockRemote ? '' : proxySrcset(srcset);
      if (kept) img.setAttribute('srcset', kept);
      else img.removeAttribute('srcset');
    }
  });
  root.querySelectorAll('[background]').forEach((el) => {
    const v = el.getAttribute('background') ?? '';
    const p = blockRemote ? null : toProxyUrl(v);
    if (p) el.setAttribute('background', p);
    else el.removeAttribute('background');
  });
  root.querySelectorAll('[poster]').forEach((el) => el.removeAttribute('poster'));
}

function detectRemote(root: HTMLElement): boolean {
  if (root.querySelector('img[src^="http"], img[src^="//"], img[srcset], [background]')) {
    const imgs = [...root.querySelectorAll('img')];
    if (
      imgs.some((i) => isRemoteUrl(i.getAttribute('src') ?? '') || i.hasAttribute('srcset')) ||
      [...root.querySelectorAll('[background]')].some((e) => isRemoteUrl(e.getAttribute('background') ?? ''))
    )
      return true;
  }
  for (const st of root.querySelectorAll('style')) if (cssHasRemote(st.textContent ?? '')) return true;
  for (const el of root.querySelectorAll('[style]'))
    if (cssHasRemote(el.getAttribute('style') ?? '')) return true;
  return false;
}

export function sanitizeEmailHtml(raw: string, cid: Record<string, string> = {}, trackers: TrackerApi | null = null): SanitizedHtml {
  const body = purify.sanitize(raw, {
    FORBID_TAGS,
    FORBID_ATTR: ['formaction', 'ping', 'srcdoc'],
    ALLOW_DATA_ATTR: false,
    USE_PROFILES: { html: true },
    ADD_ATTR: ['target'],
    FORCE_BODY: true,
    RETURN_DOM: true,
  }) as HTMLElement;
  const found = trackers ? stripTrackers(body, trackers) : { count: 0, domains: [] };
  const hasRemote = detectRemote(body);
  // Classify before remote content is removed, so blocked and allowed images give the same answer.
  const classification = classify(body.innerHTML);
  const darkAware = detectDarkAware(raw);
  const a = body.cloneNode(true) as HTMLElement;
  const b = body.cloneNode(true) as HTMLElement;
  processTree(a, false, cid);
  processTree(b, true, cid);
  return { blocked: b.innerHTML, allowed: a.innerHTML, hasRemote, classification, darkAware, trackers: found };
}

// The frame height must follow the content, never the pane: height:auto!important beats sender rules.
const BASE_CSS =
  'html,body{margin:0;padding:0;height:auto!important;min-height:0!important}body{font-family:"Segoe UI",system-ui,sans-serif;font-size:14px;line-height:1.5;color:#1a1a1a;background:#fff;word-wrap:break-word;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%}pre{white-space:pre-wrap}a{color:#0f6cbd}';

export interface FrameTheme {
  /** Extra CSS, added after the base CSS. */
  css: string;
  scheme: 'light' | 'dark';
  bodyPadding: number;
}

export function buildSrcdoc(bodyHtml: string, allowRemote: boolean, theme?: FrameTheme): string {
  const csp = [
    "default-src 'none'",
    allowRemote ? `img-src data: ${IMAGE_SCHEME}:` : 'img-src data:',
    "style-src 'unsafe-inline'",
    'font-src data:',
    "media-src 'none'",
    "frame-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ');
  const pad = `body{padding:${theme ? theme.bodyPadding : 16}px}`;
  const scheme = theme?.scheme === 'dark' ? '<meta name="color-scheme" content="dark">' : '';
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}">${scheme}<style>${BASE_CSS}${QUOTE_FRAME_CSS}${pad}${theme?.css ?? ''}</style></head><body>${bodyHtml}</body></html>`;
}

export function cidRefs(html: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/cid:([^"'\s)>]+)/gi)) out.add(m[1]!.toLowerCase());
  return [...out];
}
