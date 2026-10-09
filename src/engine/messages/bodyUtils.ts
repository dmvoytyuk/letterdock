// Pure helpers for cached bodies.

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  ndash: '-',
  mdash: '-',
  hellip: '...',
  lsquo: "'",
  rsquo: "'",
  ldquo: '"',
  rdquo: '"',
  bull: '-',
  middot: '-',
  copy: '(c)',
  reg: '(R)',
  trade: '(TM)',
  zwnj: '',
  zwj: '',
  shy: '',
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, body: string) => {
    if (body[0] === '#') {
      const code = body[1].toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return ' ';
      // Dashes and quotes become plain ASCII; other characters stay as they are.
      if (code === 0x2013 || code === 0x2014) return '-';
      if (code === 0x2018 || code === 0x2019) return "'";
      if (code === 0x201c || code === 0x201d) return '"';
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? ' ';
  });
}

// Characters marketing mails use as invisible padding after the preview text.
// eslint-disable-next-line no-misleading-character-class
const INVISIBLE = /[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0]/g;

/**
 * Cheap HTML to text for snippets and the search index. Not for display.
 * Works on cut-off HTML too (a 3 KB peek often ends inside <style> or <head>): blocks that never
 * close are dropped to the end, and when a <body> tag exists everything before it is ignored.
 */
export function stripHtml(html: string): string {
  let s = html
    // Comments, including Outlook conditional comments (<!--[if gte mso 9]><xml>...<![endif]-->).
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<!--[\s\S]*$/, ' ')
    // Downlevel-revealed conditionals and doctype: <![if !mso]>, <![endif]>, <!DOCTYPE ...>
    .replace(/<![^>]*>/g, ' ');
  // Skip the document head when we can see where the body starts.
  const body = /<body\b[^>]*>/i.exec(s);
  if (body) s = s.slice(body.index + body[0].length);
  s = s
    .replace(/<(script|style|head|title|xml|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    // An unclosed block (cut-off input) swallows the rest of the text.
    .replace(/<(script|style|head|title|xml)\b[\s\S]*$/i, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h[1-6])>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    // A tag cut off at the end of the chunk.
    .replace(/<[^>]*$/, ' ');
  s = decodeEntities(s).replace(INVISIBLE, '');
  return stripCss(s).replace(/\s+/g, ' ').trim();
}

/** Remove CSS that leaked into text: at-rules ("@font-face {...}") and "selector { prop: value }" blocks. */
function stripCss(src: string): string {
  return src
    .replace(/@(?:font-face|media|import|charset|page|keyframes|supports|-[a-z]+-keyframes)\b[^{};]*(?:\{(?:[^{}]|\{[^{}]*\})*\}|;)/gi, ' ')
    .replace(/@(?:font-face|media|keyframes|supports)\b[^{}]*\{[\s\S]*$/gi, ' ')
    .replace(/[^{};]{0,80}\{\s*[a-z-]+\s*:[^{}]*\}/gi, ' ')
    .replace(/[^{};]{0,80}\{\s*[a-z-]+\s*:[^{}]*$/gi, ' ');
}

/** Remove image placeholders, links and "view in browser" lines from snippet text. */
export function cleanSnippetText(src: string): string {
  let s = stripCss(src)
    .replace(/\[\s*(?:image|img|inline image|cid)\b[^\]]*\]/gi, ' ')
    .replace(/\[\s*(?:image|img|inline image|cid)\b\S*/gi, ' ')
    // Links in angle brackets or square brackets, and bare URLs.
    .replace(/[<[(]\s*(?:https?:\/\/|www\.)[^\s>\])]*\s*[>\])]?/gi, ' ')
    .replace(/(?:https?:\/\/|www\.)\S*/gi, ' ')
    .replace(INVISIBLE, '')
    .replace(/\uFFFD+\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  // "View in browser" style opening lines, possibly more than one.
  const lead =
    /^(?:(?:view|read|open)\s+(?:this\s+)?(?:email|message|newsletter|mail|it|online)?\s*(?:in|on)\s+(?:your\s+|a\s+)?(?:web\s+)?browser|having trouble (?:viewing|reading) this (?:email|message)\??(?: view it in your browser)?|(?:email )?not displaying (?:correctly|properly)\??(?: view it in your browser)?)[\s.:|-]*/i;
  for (let i = 0; i < 3; i++) {
    const next = s.replace(lead, '').trim();
    if (next === s) break;
    s = next;
  }
  return s;
}

/**
 * `text` is the plain-text part (null when the message only has HTML: do not pass text that was
 * generated from the HTML). `max` caps the length.
 */
export function makeSnippet(text: string | null, html: string | null, max = 200): string {
  const fromText = text && text.trim() ? cleanSnippetText(text) : '';
  if (fromText) return fromText.slice(0, max);
  return html ? cleanSnippetText(stripHtml(html)).slice(0, max) : '';
}

/** Text stored in the search index, capped at 100 KB (ARCHITECTURE 5.5). */
export function ftsText(text: string | null, html: string | null): string {
  const src = text && text.trim() ? text : html ? stripHtml(html) : '';
  return src.slice(0, 100 * 1024);
}

/** Hint for the UI: does the HTML pull in remote content (http/https images, srcset, CSS url())? */
export function hasRemoteImages(html: string | null): boolean {
  if (!html) return false;
  return (
    /<(img|video|source|image|input)\b[^>]*\b(src|poster|srcset)\s*=\s*["']?\s*(https?:)?\/\//i.test(
      html,
    ) ||
    /\bbackground\s*=\s*["']?\s*https?:\/\//i.test(html) ||
    /url\(\s*["']?\s*(https?:)?\/\//i.test(html)
  );
}

const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/** Make an attachment name safe to use as a Windows file name. */
export function safeFileName(name: string | null | undefined, fallback = 'attachment'): string {
  // eslint-disable-next-line no-control-regex
  let n = (name ?? '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
  n = n.replace(/^\.+/, '').replace(/[. ]+$/, '');
  if (!n) n = fallback;
  if (RESERVED.test(n)) n = '_' + n;
  if (n.length > 120) {
    const dot = n.lastIndexOf('.');
    const ext = dot > 0 && n.length - dot <= 12 ? n.slice(dot) : '';
    n = n.slice(0, 120 - ext.length) + ext;
  }
  return n;
}

export { isExecutableName } from '../../shared/safety';
