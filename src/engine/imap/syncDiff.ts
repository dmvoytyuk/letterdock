// Pure sync decision logic (unit tested; no I/O).
import type { FlagSet, LocalFlagRow } from '../db/repos/messageRepo';
import { sameFlags } from './parse';

export const INITIAL_MAX_INBOX = 500;
export const INITIAL_MAX_OTHER = 200;
export const OLDER_PAGE = 200;
export const FETCH_BATCH = 100;

/** Choose the UIDs for the first sync: the highest `max`, returned newest first. */
export function pickInitialUids(uids: number[], max: number): number[] {
  return [...uids].sort((a, b) => b - a).slice(0, max);
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export type UidValidityDecision = 'first' | 'same' | 'reset';

export function checkUidValidity(stored: number | null, server: number): UidValidityDecision {
  if (stored === null) return 'first';
  return stored === server ? 'same' : 'reset';
}

export interface MailboxSnapshot {
  uidValidity: number;
  uidNext: number;
  highestModseq: string | null;
  exists: number;
}
export interface StoredState {
  uidnext: number | null;
  highestmodseq: string | null;
  serverExists: number | null;
}

/**
 * Cheap "did anything change?" test. With CONDSTORE an unchanged HIGHESTMODSEQ and UIDNEXT mean no
 * new mail, flag change or (usually) expunge. Without it we cannot know, so we must check.
 */
export function mailboxUnchanged(server: MailboxSnapshot, stored: StoredState): boolean {
  if (server.highestModseq === null || stored.highestmodseq === null) return false;
  // A bare EXPUNGE of an old message changes neither HIGHESTMODSEQ nor UIDNEXT (RFC 7162),
  // so the message count must match too.
  return (
    server.highestModseq === stored.highestmodseq &&
    server.uidNext === stored.uidnext &&
    server.exists === stored.serverExists
  );
}

export interface RemoteFlags {
  uid: number;
  flags: FlagSet;
  modseq?: string | null;
}

/** Flag changes between local rows and what the server reported. */
export function diffFlags(
  local: LocalFlagRow[],
  remote: RemoteFlags[],
): { uid: number; flags: FlagSet; modseq?: string | null }[] {
  const byUid = new Map(local.map((l) => [l.uid, l]));
  const out: { uid: number; flags: FlagSet; modseq?: string | null }[] = [];
  for (const r of remote) {
    const l = byUid.get(r.uid);
    if (!l) continue;
    if (!sameFlags(l, r.flags)) out.push({ uid: r.uid, flags: r.flags, modseq: r.modseq });
  }
  return out;
}

/** Local UIDs (>= fromUid) that the server no longer has. */
export function findExpunged(localUids: number[], serverUids: Set<number>, fromUid = 0): number[] {
  return localUids.filter((u) => u >= fromUid && !serverUids.has(u));
}

/** Server UIDs we do not have yet. */
export function findMissing(serverUids: number[], localUids: Set<number>): number[] {
  return serverUids.filter((u) => !localUids.has(u));
}

/** Expand a UID list into an IMAP sequence set string, compressing consecutive runs. */
export function toSequenceSet(uids: number[]): string {
  const sorted = [...new Set(uids)].sort((a, b) => a - b);
  const parts: string[] = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    parts.push(i === j ? String(sorted[i]) : `${sorted[i]}:${sorted[j]}`);
    i = j + 1;
  }
  return parts.join(',');
}

/** Exponential backoff with full jitter, capped at 5 minutes (ARCHITECTURE 5.4). */
export function backoffDelayMs(attempt: number, rand: () => number = Math.random): number {
  const base = Math.min(2000 * 2 ** Math.max(0, attempt - 1), 5 * 60 * 1000);
  // 75%..100% of base so retries spread out but never collapse to zero.
  return Math.round(base * (0.75 + rand() * 0.25));
}
