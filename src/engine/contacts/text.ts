// Text helpers of the contacts index (pure). Folding makes search ignore case and accents and works
// for every script (Cyrillic, Greek, accented Latin); tokens are what a typed prefix is matched to.

import { replaceControlChars } from '../../shared/safety';

// Letters that do not split into base letter + accent mark.
const SPECIAL: Record<string, string> = {
  ß: 'ss',
  ø: 'o',
  đ: 'd',
  ð: 'd',
  ł: 'l',
  æ: 'ae',
  œ: 'oe',
  ı: 'i',
  þ: 'th',
};

/** Lower case, accents removed (Latin, Cyrillic, ...). "Éric" -> "eric", "Ёлка" -> "елка". */
export function fold(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[ßøđðłæœıþ]/g, (c) => SPECIAL[c] ?? c);
}

/** Words of a text, folded. "a.smith@example.com" -> a, smith, example, com. */
export function tokenize(s: string): string[] {
  return fold(s)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0);
}

// Addresses nobody writes to on purpose.
const NO_REPLY =
  /^(?:no[-_.]?reply|do[-_.]?not[-_.]?reply|don[-_.]?t[-_.]?reply|mailer[-_.]?daemon|postmaster|bounces?)(?:[-_.+=].*)?$/i;

const SIMPLE_ADDRESS = /^[^\s@<>(),;:"[\]\\]+@[^\s@<>(),;:"[\]\\]+\.[^\s@<>(),;:"[\]\\.]{2,}$/;

/** Normalizes an address (trim, lower case). Returns null for anything that is not a plain address. */
export function cleanAddress(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const a = raw.trim().toLowerCase();
  if (a.length < 5 || a.length > 254) return null;
  if (!SIMPLE_ADDRESS.test(a)) return null;
  return a;
}

/** Automatic senders and system addresses: never offered as recipients. */
export function isNoReply(address: string): boolean {
  const at = address.lastIndexOf('@');
  const local = at > 0 ? address.slice(0, at) : address;
  return NO_REPLY.test(local);
}

/** A display name worth keeping (not empty, not just the address again). */
export function cleanName(raw: string | null | undefined, address: string): string | null {
  if (!raw) return null;
  const n = replaceControlChars(raw, ' ')
    .replace(/^["'\s]+|["'\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (n.length === 0 || n.length > 200) return null;
  if (n.toLowerCase() === address) return null;
  return n;
}
