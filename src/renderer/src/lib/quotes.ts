// Folding of quoted text in message bodies (DESIGN-SPEC 3.6 and 3.10.4): the part of a reply that repeats
// the older mail is hidden behind a small "..." button. HTML mail is folded here, on the sanitized HTML,
// and toggled from the parent window through the frame's document (the frame has no scripts). Plain text
// is folded in React (`TextBody`).

export const QUOTE_SHOW = 'Show quoted text';
export const QUOTE_HIDE = 'Hide quoted text';

// ---------- HTML ----------
/** What a quoted region of the HTML looks like in the frame. `data-ld-toggle` is the button. */
export const QUOTE_WRAP = 'ld-qw';
export const QUOTE_TOGGLE_ATTR = 'data-ld-toggle';

/** Class prefixes (before "-signature" / "-quote-intro") that our own mail carries. */
export const OWN_CLASS_PREFIXES = ['letterdock', /* classes written by older versions */ 'mailroom'] as const;
/** CSS selector for our own classes with the given suffix, e.g. ownClassSelector('signature'). */
export function ownClassSelector(suffix: string): string {
  return OWN_CLASS_PREFIXES.map((p) => `.${p}-${suffix}`).join(', ');
}

const INTRO_CLASSES = new RegExp(`(^|\\s)(${OWN_CLASS_PREFIXES.map((p) => `${p}-quote-intro`).join('|')}|moz-cite-prefix|gmail_attr)(\\s|$)`);
/** "On Mon, 5 Oct 2026, Jane wrote:" in the languages mail clients write it in. */
const WROTE = /(wrote|écrit|schrieb|escribió|scritto|schreef|skrev|napisał|escreveu)\s*:?\s*$/i;
const NOT_TABLE_PARENT = new Set(['TABLE', 'TBODY', 'THEAD', 'TFOOT', 'TR', 'UL', 'OL', 'DL', 'SELECT', 'COLGROUP']);

interface Region {
  parent: Node;
  first: Node;
  last: Node;
}

const isBlank = (n: Node): boolean => n.nodeType === 3 && !(n.textContent ?? '').trim();
const isBr = (n: Node): boolean => n.nodeType === 1 && (n as Element).tagName === 'BR';
const isEl = (n: Node | null): n is Element => !!n && n.nodeType === 1;

function nodesOf(r: Region): Node[] {
  const out: Node[] = [];
  for (let n: Node | null = r.first; n; n = n.nextSibling) {
    out.push(n);
    if (n === r.last) break;
  }
  return out;
}

/** The sibling before `n` that is not a blank text node or a <br>. */
function prevMeaningful(n: Node): Node | null {
  let p = n.previousSibling;
  while (p && (isBlank(p) || isBr(p))) p = p.previousSibling;
  return p;
}
function nextMeaningful(n: Node): Node | null {
  let p = n.nextSibling;
  while (p && (isBlank(p) || isBr(p))) p = p.nextSibling;
  return p;
}

function isIntro(n: Node | null): n is Element {
  if (!isEl(n)) return false;
  if (INTRO_CLASSES.test(n.getAttribute('class') ?? '')) return true;
  const text = (n.textContent ?? '').trim();
  // A short "... wrote:" line, not a paragraph that happens to end that way.
  return text.length > 0 && text.length < 300 && WROTE.test(text) && !n.querySelector('blockquote');
}

function lastSibling(n: Node): Node {
  let l: Node = n;
  while (l.nextSibling) l = l.nextSibling;
  return l;
}

/** The element that starts a quote of this kind, with the intro line before it when there is one. */
function withIntro(el: Element): Region | null {
  const parent = el.parentNode;
  if (!parent) return null;
  let first: Node = el;
  const intro = prevMeaningful(el);
  if (isIntro(intro)) first = intro;
  return { parent, first, last: el };
}

function findRegions(body: HTMLElement, html: string): Region[] {
  const found: Region[] = [];
  const add = (r: Region | null) => {
    if (r && !NOT_TABLE_PARENT.has((r.parent as Element).tagName ?? '')) found.push(r);
  };

  // Gmail and Yahoo wrap the whole quote (the "On ... wrote:" line and the blockquote).
  body.querySelectorAll('div.gmail_quote, div.yahoo_quoted, blockquote.gmail_quote').forEach((el) => add(withIntro(el)));

  // Apple Mail and Thunderbird: blockquote[type=cite].
  body.querySelectorAll('blockquote[type="cite"]').forEach((el) => add(withIntro(el)));

  // Our own reply (also from older versions): an intro line followed by a blockquote.
  body.querySelectorAll(`${ownClassSelector('quote-intro')}, .moz-cite-prefix`).forEach((el) => {
    const next = nextMeaningful(el);
    if (isEl(next) && next.tagName === 'BLOCKQUOTE' && el.parentNode) add({ parent: el.parentNode, first: el, last: next });
  });

  // Outlook: a separator ("From: ... Sent: ...") and then the old mail, up to the end of its container.
  const outlook = (start: Element) => {
    let first: Node = start;
    const before = prevMeaningful(start);
    if (isEl(before) && before.tagName === 'HR') first = before;
    // When the separator is the first thing in a wrapper, the old mail continues after the wrapper.
    for (;;) {
      const parent = first.parentNode;
      if (!parent || parent === body || !isEl(parent)) break;
      if (prevMeaningful(first)) break;
      first = parent;
    }
    const parent = first.parentNode;
    if (parent) add({ parent, first, last: lastSibling(first) });
  };
  body.querySelectorAll('[id$="divRplyFwdMsg"]').forEach(outlook);
  body.querySelectorAll('div[style*="border-top"]').forEach((el) => {
    const style = (el.getAttribute('style') ?? '').toLowerCase();
    const text = (el.textContent ?? '').trim();
    if (/border-top\s*:\s*solid/.test(style) && /^(from|de|von|da|van)\s*:/i.test(text) && /(sent|date|envoy|gesendet|enviado|inviato)\s*:/i.test(text)) {
      outlook(el);
    }
  });
  // Text clients: "-----Original Message-----".
  const mentionsOriginal = /original message|ursprüngliche nachricht|message d'origine|mensaje original/i.test(html);
  body.querySelectorAll(mentionsOriginal ? 'p, div, span, font' : 'x-none').forEach((el) => {
    if (el.children.length > 2) return;
    if (/^[-_ ]{2,}\s*(original message|ursprüngliche nachricht|message d'origine|mensaje original)\s*[-_ ]{2,}$/i.test((el.textContent ?? '').trim())) outlook(el);
  });

  return found;
}

function contains(r: Region, x: Node): boolean {
  return nodesOf(r).some((n) => n === x || n.contains(x));
}

/** Keep the outermost regions: one that lies inside another one (or repeats it) is dropped. */
function outermost(all: Region[]): Region[] {
  const keep: Region[] = [];
  for (const a of all) {
    if (keep.some((k) => contains(k, a.first))) continue;
    for (let i = keep.length - 1; i >= 0; i--) if (contains(a, keep[i]!.first)) keep.splice(i, 1);
    keep.push(a);
  }
  return keep;
}

export interface FoldResult {
  html: string;
  /** How many quoted parts got a button. */
  count: number;
}

/**
 * Wrap every quoted part of sanitized email HTML: a button (`[data-ld-toggle]`, "..." in the frame) and
 * the quote itself hidden until the button is used. Nothing is folded when it would leave an empty message.
 */
export function foldQuotedHtml(html: string): FoldResult {
  if (!html || !/(gmail_quote|yahoo_quoted|cite|quote-intro|moz-cite|divRplyFwdMsg|border-top|original message|wrote|écrit|schrieb|escribió|scritto)/i.test(html)) {
    return { html, count: 0 };
  }
  const doc = new DOMParser().parseFromString(`<!doctype html><html><head></head><body>${html}</body></html>`, 'text/html');
  const body = doc.body;
  const regions = outermost(findRegions(body, html));
  if (regions.length === 0) return { html, count: 0 };

  // Fold only when something is left to read outside the quotes.
  const covered = new Set<Node>();
  for (const r of regions) for (const n of nodesOf(r)) covered.add(n);
  const visibleOutside = (n: Node): boolean => {
    if (covered.has(n)) return false;
    if (n.nodeType === 3) return !!(n.textContent ?? '').trim();
    if (!isEl(n)) return false;
    if (n.tagName === 'STYLE' || n.tagName === 'HEAD') return false;
    if (n.tagName === 'IMG') return true;
    return [...n.childNodes].some(visibleOutside);
  };
  if (![...body.childNodes].some(visibleOutside)) return { html, count: 0 };

  regions.forEach((r, i) => {
    const wrap = doc.createElement('div');
    wrap.className = QUOTE_WRAP;
    const bar = doc.createElement('div');
    const btn = doc.createElement('span');
    btn.className = 'ld-qt';
    btn.setAttribute('role', 'button');
    btn.setAttribute('tabindex', '0');
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-label', QUOTE_SHOW);
    btn.setAttribute('title', QUOTE_SHOW);
    btn.setAttribute(QUOTE_TOGGLE_ATTR, String(i));
    btn.textContent = '…';
    bar.appendChild(btn);
    const inner = doc.createElement('div');
    inner.className = 'ld-qb';
    const nodes = nodesOf(r);
    r.parent.insertBefore(wrap, r.first);
    for (const n of nodes) inner.appendChild(n);
    wrap.appendChild(bar);
    wrap.appendChild(inner);
  });
  return { html: body.innerHTML, count: regions.length };
}

/** Open or close one quote inside the frame's document. Returns whether it is open now. */
export function setQuoteOpen(toggle: Element, open?: boolean): boolean {
  const wrap = toggle.closest(`.${QUOTE_WRAP}`);
  if (!wrap) return false;
  const next = open ?? !wrap.hasAttribute('data-open');
  if (next) wrap.setAttribute('data-open', '');
  else wrap.removeAttribute('data-open');
  const label = next ? QUOTE_HIDE : QUOTE_SHOW;
  toggle.setAttribute('aria-expanded', String(next));
  toggle.setAttribute('aria-label', label);
  toggle.setAttribute('title', label);
  return next;
}

/** The pill in the frame: small, neutral, readable on any background (CanvasText follows the frame's color scheme). */
export const QUOTE_FRAME_CSS =
  '.ld-qw{margin:6px 0;display:block}' +
  '.ld-qt{display:inline-block;box-sizing:border-box;min-width:36px;min-height:24px;padding:0 10px;text-align:center;' +
  'font:600 14px/22px "Segoe UI",system-ui,sans-serif;letter-spacing:1px;border:1px solid rgba(128,128,128,.6);border-radius:12px;' +
  'background:rgba(128,128,128,.16)!important;color:CanvasText!important;cursor:pointer;user-select:none;-webkit-user-select:none}' +
  '.ld-qt:hover{background:rgba(128,128,128,.3)!important}' +
  '.ld-qt:focus-visible{outline:2px solid #0f6cbd;outline-offset:2px}' +
  '.ld-qb{display:none}.ld-qw[data-open]>.ld-qb{display:block}';

// ---------- plain text ----------
export type TextPart = { quoted: false; text: string } | { quoted: true; text: string };

const QUOTE_LINE = /^\s*>/;
const INTRO_START = /^\s*(on|le|am|el|il|op|den|em)\s+\S/i;
const ORIGINAL = /^\s*[-_ ]{2,}\s*(original message|ursprüngliche nachricht|message d'origine|mensaje original)\s*[-_ ]{2,}\s*$/i;

/**
 * Split a plain-text message into text and quoted parts: runs of "> ..." lines with their
 * "On ... wrote:" line, and everything after an "-----Original Message-----" line.
 * Returns one part when nothing is folded (also when the whole message is quoted).
 */
export function splitQuotedText(text: string): TextPart[] {
  const lines = text.split('\n');
  const quoted = new Array<boolean>(lines.length).fill(false);

  for (let i = 0; i < lines.length; i++) {
    if (ORIGINAL.test(lines[i]!)) {
      for (let j = i; j < lines.length; j++) quoted[j] = true;
      break;
    }
  }

  let i = 0;
  while (i < lines.length) {
    if (quoted[i] || !QUOTE_LINE.test(lines[i]!)) {
      i++;
      continue;
    }
    // A run of quote lines; blank lines inside the run belong to it when more quote lines follow.
    let end = i;
    for (let j = i; j < lines.length; j++) {
      if (QUOTE_LINE.test(lines[j]!)) end = j;
      else if (lines[j]!.trim() === '') continue;
      else break;
    }
    let start = i;
    // The "On ... wrote:" line before the run, which may wrap onto a second line.
    let k = start - 1;
    while (k >= 0 && lines[k]!.trim() === '') k--;
    if (k >= 0 && !quoted[k] && !QUOTE_LINE.test(lines[k]!) && WROTE.test(lines[k]!.trim())) {
      start = k;
      if (!INTRO_START.test(lines[k]!) && k > 0 && INTRO_START.test(lines[k - 1]!) && !QUOTE_LINE.test(lines[k - 1]!)) start = k - 1;
    }
    for (let j = start; j <= end; j++) quoted[j] = true;
    i = end + 1;
  }

  const parts: TextPart[] = [];
  let cur: string[] = [];
  let curQuoted = false;
  const flush = () => {
    if (cur.length > 0) parts.push({ quoted: curQuoted, text: cur.join('\n') });
    cur = [];
  };
  lines.forEach((line, idx) => {
    if (quoted[idx] !== curQuoted) {
      flush();
      curQuoted = quoted[idx]!;
    }
    cur.push(line);
  });
  flush();

  // Fold only when something is left to read.
  if (!parts.some((p) => p.quoted) || !parts.some((p) => !p.quoted && p.text.trim() !== '')) return [{ quoted: false, text }];
  return parts;
}
