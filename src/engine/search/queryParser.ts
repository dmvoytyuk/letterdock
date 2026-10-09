// Search query language (ARCHITECTURE 5.8):
//   free text            every word must match; the last word also matches as a prefix
//   "exact phrase"       words next to each other
//   from: to: subject:   limit a word or phrase to that field        from:bob  subject:"q3 plan"
//   account: folder:     limit to an account (email / name) or folder (name / role)
//   is:unread  is:read  is:flagged  has:attachment
//   before:YYYY-MM-DD  after:YYYY-MM-DD
// Unknown "word:" prefixes are searched as plain text.

export interface ParsedQuery {
  /** Terms for the full-text index, in order. `column` limits the term to one FTS column. */
  terms: { text: string; column: 'subject' | 'from_text' | 'to_text' | null; phrase: boolean }[];
  accountTerms: string[];
  folderTerms: string[];
  unread: boolean | null;
  flagged: boolean | null;
  hasAttachment: boolean | null;
  before: number | null;
  after: number | null;
  /** Human-readable chips for the UI, e.g. ['from:bob', 'is:unread']. */
  chips: string[];
}

const TOKEN = /(?:[A-Za-z]+:)?"[^"]*"|\S+/g;

export function parseDate(v: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const date = new Date(y, mo - 1, d); // local midnight
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
  return date.getTime();
}

function unquote(v: string): { text: string; quoted: boolean } {
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    return { text: v.slice(1, -1), quoted: true };
  }
  return { text: v.replace(/^"/, '').replace(/"$/, ''), quoted: false };
}

export function parseQuery(raw: string): ParsedQuery {
  const q: ParsedQuery = {
    terms: [],
    accountTerms: [],
    folderTerms: [],
    unread: null,
    flagged: null,
    hasAttachment: null,
    before: null,
    after: null,
    chips: [],
  };
  const tokens = raw.match(TOKEN) ?? [];
  for (const tok of tokens) {
    const m = /^([A-Za-z]+):(.+)$/.exec(tok);
    const op = m?.[1]?.toLowerCase();
    if (m && op && m[2] !== undefined) {
      const { text, quoted } = unquote(m[2]);
      const value = text.trim();
      if (!value) continue;
      const chip = `${op}:${quoted || /\s/.test(value) ? `"${value}"` : value}`;
      switch (op) {
        case 'from':
          q.terms.push({ text: value, column: 'from_text', phrase: quoted });
          q.chips.push(chip);
          continue;
        case 'to':
          q.terms.push({ text: value, column: 'to_text', phrase: quoted });
          q.chips.push(chip);
          continue;
        case 'subject':
          q.terms.push({ text: value, column: 'subject', phrase: quoted });
          q.chips.push(chip);
          continue;
        case 'account':
          q.accountTerms.push(value.toLowerCase());
          q.chips.push(chip);
          continue;
        case 'folder':
        case 'in':
          q.folderTerms.push(value.toLowerCase());
          q.chips.push(`folder:${quoted || /\s/.test(value) ? `"${value}"` : value}`);
          continue;
        case 'is': {
          const v = value.toLowerCase();
          if (v === 'unread' || v === 'read') {
            q.unread = v === 'unread';
            q.chips.push(`is:${v}`);
            continue;
          }
          if (v === 'flagged' || v === 'starred') {
            q.flagged = true;
            q.chips.push('is:flagged');
            continue;
          }
          break;
        }
        case 'has':
          if (value.toLowerCase().startsWith('attach')) {
            q.hasAttachment = true;
            q.chips.push('has:attachment');
            continue;
          }
          break;
        case 'before':
        case 'after': {
          const ms = parseDate(value);
          if (ms !== null) {
            if (op === 'before') q.before = ms;
            else q.after = ms;
            q.chips.push(`${op}:${value}`);
            continue;
          }
          break;
        }
      }
      // Unknown operator or bad value: search the whole token as text.
    }
    const { text, quoted } = unquote(tok);
    const t = text.trim();
    if (t) q.terms.push({ text: t, column: null, phrase: quoted });
  }
  return q;
}

/** One FTS5 string literal. Double quotes inside are doubled; that is the whole escape rule. */
function fts5Quote(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

/**
 * Build the MATCH expression. Every term is quoted (so operators like AND / NEAR / * in user text are
 * plain words). The last term of each kind gets a prefix match so results appear while typing.
 * Returns null when there is nothing for the full-text index.
 */
export function buildMatch(q: ParsedQuery, wholeAsPhrase = false): string | null {
  const terms = q.terms.filter((t) => /[\p{L}\p{N}]/u.test(t.text));
  if (terms.length === 0) return null;
  if (wholeAsPhrase) return fts5Quote(terms.map((t) => t.text).join(' '));
  const lastIndex = terms.length - 1;
  return terms
    .map((t, i) => {
      const lit = fts5Quote(t.text);
      const prefix = !t.phrase && i === lastIndex ? '*' : '';
      const body = `${lit}${prefix}`;
      return t.column ? `${t.column} : ${body}` : body;
    })
    .join(' ');
}
