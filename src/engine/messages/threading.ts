// Pure helpers for conversations (DESIGN-SPEC 3.10.1). No database in here.
import type { Address } from '../../shared/ipc';
import { fold } from '../contacts/text';

/** Reply / forward prefixes in many languages: "Re:", "Fwd:", "AW:", "SV:", "Re[2]:", ... */
const PREFIX = /^\s*(?:(?:re|fwd?|aw|sv|wg|antw|odp|rv|vs|enc|tr|ref|r)\s*(?:\[\d{1,3}\]|\(\d{1,3}\))?\s*:\s*)+/i;

/** Subject without reply prefixes, folded and with single spaces. Empty when nothing is left. */
export function normalizeSubject(subject: string): string {
  let s = subject.normalize('NFKC');
  // A prefix can hide behind another one ("Re: Fwd: AW: x"); the regexp takes them all.
  s = s.replace(PREFIX, '');
  return fold(s).replace(/\s+/g, ' ').trim();
}

/** The subject as a person reads it: prefixes removed, case and accents kept. */
export function displaySubject(subject: string): string {
  const s = subject.replace(PREFIX, '').replace(/\s+/g, ' ').trim();
  return s.length > 0 ? s : subject.trim();
}

const MAX_REFS = 30;

/** Message-IDs (lower case, with the angle brackets) in an In-Reply-To / References value. */
export function extractMessageIds(...values: (string | null | undefined)[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of values) {
    if (!v) continue;
    for (const m of v.matchAll(/<[^<>\s]+>/g)) {
      const id = m[0].toLowerCase();
      if (!seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
  }
  // Very long chains: keep the root and the newest ones.
  if (out.length > MAX_REFS) return [out[0]!, ...out.slice(out.length - (MAX_REFS - 1))];
  return out;
}

export function normalizeMessageId(id: string | null | undefined): string | null {
  if (!id) return null;
  const m = /<[^<>\s]+>/.exec(id);
  return m ? m[0].toLowerCase() : null;
}

function addr(a: { address?: string | null } | null | undefined, into: Set<string>): void {
  const x = a?.address?.trim().toLowerCase();
  if (x) into.add(x);
}

/** Everybody on a message (From, To, Cc), without the user's own addresses. */
export function participantSet(
  from: string | null,
  to: Address[],
  cc: Address[],
  own: Set<string>,
): Set<string> {
  const out = new Set<string>();
  addr({ address: from }, out);
  for (const a of to) addr(a, out);
  for (const a of cc) addr(a, out);
  for (const o of own) out.delete(o);
  return out;
}

export function sharesParticipant(a: Set<string>, b: Set<string>): boolean {
  for (const x of a) if (b.has(x)) return true;
  return false;
}

/** The window of the "same subject" fallback. */
export const SUBJECT_WINDOW_MS = 30 * 86_400_000;

export const GMAIL_THREAD_PREFIX = 'g:';

/** Conversation id for a Gmail X-GM-THRID (unique across accounts). */
export function gmailThreadId(accountId: string, gmThrid: string): string {
  return `${GMAIL_THREAD_PREFIX}${accountId}:${gmThrid}`;
}
