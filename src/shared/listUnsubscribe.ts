// Pure helpers for the Unsubscribe feature (DESIGN-SPEC 3.13.1). No node / electron imports.
// Reads List-Unsubscribe (RFC 2369), List-Unsubscribe-Post (RFC 8058), List-Id (RFC 2919) and the
// topmost Authentication-Results header (RFC 8601), and decides what the user may do.
import type { UnsubscribeAuth } from './ipc';

/** The headers we keep from a message (raw, unfolded). Stored as JSON next to the body. */
export interface ListHeaders {
  /** List-Unsubscribe */
  lu?: string;
  /** List-Unsubscribe-Post */
  lup?: string;
  /** List-Id */
  lid?: string;
  /** The FIRST (topmost) Authentication-Results header. Lower ones can be forged by the sender. */
  ar?: string;
}

const WANTED = new Map<string, keyof ListHeaders>([
  ['list-unsubscribe', 'lu'],
  ['list-unsubscribe-post', 'lup'],
  ['list-id', 'lid'],
  ['authentication-results', 'ar'],
]);

/**
 * Reads the four headers we need from a raw message (or just its header part). Folded lines are
 * unfolded. For each name only the first occurrence is kept, which for Authentication-Results is the
 * topmost one, the one added by the user's own mail provider.
 */
export function readListHeaders(source: Uint8Array | string): ListHeaders {
  const text = typeof source === 'string' ? source : new TextDecoder('latin1').decode(source);
  let end = text.search(/\r?\n\r?\n/);
  if (end < 0) end = text.length;
  const lines = text.slice(0, end).split(/\r?\n/);
  const out: ListHeaders = {};
  let key: keyof ListHeaders | null = null;
  let cur = '';
  const flush = () => {
    if (key && out[key] === undefined) out[key] = cur.trim();
    key = null;
  };
  for (const line of lines) {
    if (/^[ \t]/.test(line)) {
      if (key) cur += ' ' + line.trim();
      continue;
    }
    flush();
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const name = line.slice(0, i).trim().toLowerCase();
    const k = WANTED.get(name);
    if (k) {
      key = k;
      cur = line.slice(i + 1);
    }
  }
  flush();
  return out;
}

export interface ParsedListUnsubscribe {
  /** https URLs, in the order given. */
  https: string[];
  mailto: { address: string; subject: string; body: string }[];
}

/** Every `<...>` item of a List-Unsubscribe value. Only https and mailto are usable. */
export function parseListUnsubscribe(value: string | undefined): ParsedListUnsubscribe {
  const out: ParsedListUnsubscribe = { https: [], mailto: [] };
  if (!value) return out;
  for (const m of value.matchAll(/<([^<>]{1,2000})>/g)) {
    const raw = m[1]!.trim();
    if (/^https:\/\//i.test(raw)) {
      try {
        const u = new URL(raw);
        if (u.protocol === 'https:' && u.hostname && !u.username && !u.password) out.https.push(u.toString());
      } catch {
        /* not a URL: ignore */
      }
    } else if (/^mailto:/i.test(raw)) {
      const mt = parseMailto(raw);
      if (mt) out.mailto.push(mt);
    }
  }
  return out;
}

const SIMPLE_ADDRESS = /^[^\s@<>,;"()]+@[^\s@<>,;"()]+\.[^\s@<>,;"()]+$/;

export function parseMailto(raw: string): { address: string; subject: string; body: string } | null {
  const rest = raw.replace(/^mailto:/i, '');
  const q = rest.indexOf('?');
  const addrPart = q >= 0 ? rest.slice(0, q) : rest;
  let address: string;
  try {
    address = decodeURIComponent(addrPart).trim();
  } catch {
    return null;
  }
  if (!SIMPLE_ADDRESS.test(address)) return null;
  let subject = '';
  let body = '';
  if (q >= 0) {
    for (const part of rest.slice(q + 1).split('&')) {
      const eq = part.indexOf('=');
      if (eq <= 0) continue;
      const k = part.slice(0, eq).toLowerCase();
      let v: string;
      try {
        v = decodeURIComponent(part.slice(eq + 1).replace(/\+/g, ' '));
      } catch {
        continue;
      }
      // Header injection and other recipients are not accepted: only subject and body are used.
      if (k === 'subject') subject = v.replace(/[\r\n]+/g, ' ').trim().slice(0, 200);
      else if (k === 'body') body = v.slice(0, 2000);
    }
  }
  return { address, subject: subject || 'unsubscribe', body };
}

/** RFC 8058: the sender allows a POST with `List-Unsubscribe=One-Click`. */
export function isOneClick(post: string | undefined): boolean {
  return !!post && /(^|[\s;,])List-Unsubscribe\s*=\s*One-Click\b/i.test(post);
}

export interface ListId {
  /** Lower-case list identifier, for example `news.example.com`. */
  id: string;
  /** The readable phrase before it, if any. */
  name: string | null;
}

export function parseListId(value: string | undefined): ListId | null {
  if (!value) return null;
  const m = /<([^<>]{1,255})>/.exec(value);
  const id = (m ? m[1]! : value).trim().toLowerCase();
  if (!id) return null;
  let name: string | null = null;
  if (m) {
    const phrase = value.slice(0, m.index).trim().replace(/^"(.*)"$/, '$1').trim();
    if (phrase) name = phrase.slice(0, 200);
  }
  return { id, name };
}

type Verdict = 'pass' | 'fail' | 'other';

function verdict(v: string): Verdict {
  const w = v.toLowerCase();
  if (w === 'pass') return 'pass';
  if (w === 'fail') return 'fail';
  return 'other';
}

export interface AuthResults {
  dkim: { verdict: Verdict; domain: string | null }[];
  spf: Verdict[];
  dmarc: Verdict[];
}

/** Reads the dkim / spf / dmarc results of ONE Authentication-Results value. */
export function parseAuthResults(value: string | undefined): AuthResults {
  const out: AuthResults = { dkim: [], spf: [], dmarc: [] };
  if (!value) return out;
  // The first part (before the first ;) is the server name. Each later part is one method result.
  const parts = value.split(';').slice(1);
  for (const part of parts) {
    const m = /^\s*(dkim|spf|dmarc)\s*=\s*([a-z]+)/i.exec(part);
    if (!m) continue;
    const method = m[1]!.toLowerCase();
    const v = verdict(m[2]!);
    if (method === 'spf') out.spf.push(v);
    else if (method === 'dmarc') out.dmarc.push(v);
    else {
      let domain: string | null = null;
      const d = /header\.d\s*=\s*([^\s;]+)/i.exec(part);
      const i = /header\.i\s*=\s*([^\s;]+)/i.exec(part);
      const raw = d?.[1] ?? i?.[1];
      if (raw) domain = raw.replace(/^.*@/, '').replace(/^"|"$/g, '').toLowerCase();
      out.dkim.push({ verdict: v, domain });
    }
  }
  return out;
}

/** The signing domain is the From domain or one of its parents (`example.com` for `news.example.com`). */
export function domainAligned(signing: string, fromDomain: string): boolean {
  const s = signing.toLowerCase();
  const f = fromDomain.toLowerCase();
  return s === f || f.endsWith('.' + s);
}

/**
 * Sender check for the Unsubscribe button (DESIGN-SPEC 3.13.1):
 *  - failed:   a dkim, spf or dmarc result is `fail`; or dkim passed only for a domain that does
 *              not match the From domain and spf + dmarc do not vouch for the sender.
 *  - verified: dkim pass with a matching signing domain, or spf pass together with dmarc pass.
 *  - unknown:  no header, or no dkim / spf result.
 */
export function evaluateAuth(
  authResults: string | undefined,
  fromAddress: string | null | undefined,
): UnsubscribeAuth {
  const r = parseAuthResults(authResults);
  const hasAny = r.dkim.length > 0 || r.spf.length > 0;
  if (!authResults || !hasAny) return 'unknown';
  if (r.dkim.some((x) => x.verdict === 'fail') || r.spf.includes('fail') || r.dmarc.includes('fail')) {
    return 'failed';
  }
  const fromDomain = fromAddress && fromAddress.includes('@') ? fromAddress.split('@').pop()!.trim() : '';
  const dkimPass = r.dkim.filter((x) => x.verdict === 'pass');
  const aligned = !!fromDomain && dkimPass.some((x) => x.domain !== null && domainAligned(x.domain, fromDomain));
  if (aligned) return 'verified';
  if (r.spf.includes('pass') && r.dmarc.includes('pass')) return 'verified';
  if (dkimPass.length > 0) return 'failed'; // signed, but not by the sender's own domain
  return 'unknown';
}
