import { Fragment, type ReactNode } from 'react';

/** Operators the engine understands (ARCHITECTURE 6.2, Search). */
export const SEARCH_OPERATORS: { op: string; example: string; help: string }[] = [
  { op: 'from:', example: 'from:jane', help: 'Sender name or address' },
  { op: 'to:', example: 'to:bob@acme.com', help: 'Recipient' },
  { op: 'subject:', example: 'subject:invoice', help: 'Words in the subject' },
  { op: 'account:', example: 'account:work', help: 'Only one account' },
  { op: 'folder:', example: 'folder:trash', help: 'Only one folder (Trash and Spam are skipped otherwise)' },
  { op: 'is:', example: 'is:unread', help: 'unread, read or flagged' },
  { op: 'has:attachment', example: 'has:attachment', help: 'Messages with files' },
  { op: 'before:', example: 'before:2026-01-31', help: 'Older than a date (YYYY-MM-DD)' },
  { op: 'after:', example: 'after:2026-01-01', help: 'Newer than a date (YYYY-MM-DD)' },
];

const OP_RE = /\b(from|to|subject|account|folder|in|is|has|before|after):("[^"]*"|\S+)/gi;
/** Operators whose value is text that appears in the message (so it is worth highlighting). */
const TEXT_OPS = new Set(['from', 'to', 'subject']);

/** Words to highlight in results: the free text plus the values of from:, to: and subject:. */
export function searchTerms(query: string): string[] {
  const out: string[] = [];
  let rest = query;
  for (const m of query.matchAll(OP_RE)) {
    if (TEXT_OPS.has(m[1]!.toLowerCase())) out.push(m[2]!.replace(/^"|"$/g, ''));
  }
  rest = rest.replace(OP_RE, ' ');
  for (const m of rest.matchAll(/"([^"]+)"|(\S+)/g)) out.push((m[1] ?? m[2] ?? '').trim());
  const cleaned = out
    .map((t) => t.replace(/[*"]/g, '').trim())
    .filter((t) => t.length > 0);
  return [...new Set(cleaned.map((t) => t.toLowerCase()))].sort((a, b) => b.length - a.length);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Wraps the matching parts of `text` in <mark>. */
export function Highlight({ text, terms }: { text: string; terms: string[] }): ReactNode {
  if (terms.length === 0 || !text) return text;
  const re = new RegExp(`(${terms.map(escapeRe).join('|')})`, 'gi');
  const parts = text.split(re);
  if (parts.length === 1) return text;
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <mark key={i}>{p}</mark>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        ),
      )}
    </>
  );
}
