// Pure helpers that turn imapflow FETCH results into DB input rows.
import type { Address } from '../../shared/ipc';
import type { FlagSet, HeaderInput } from '../db/repos/messageRepo';

interface EnvAddr {
  name?: string | undefined;
  address?: string | undefined;
}
interface EnvLike {
  date?: Date | string | undefined;
  subject?: string | undefined;
  messageId?: string | undefined;
  inReplyTo?: string | undefined;
  from?: EnvAddr[] | undefined;
  replyTo?: EnvAddr[] | undefined;
  to?: EnvAddr[] | undefined;
  cc?: EnvAddr[] | undefined;
  bcc?: EnvAddr[] | undefined;
}
interface StructLike {
  type: string;
  part?: string | undefined;
  encoding?: string | undefined;
  disposition?: string | undefined;
  dispositionParameters?: Record<string, string> | undefined;
  parameters?: Record<string, string> | undefined;
  childNodes?: StructLike[] | undefined;
}

export interface FetchedLike {
  uid: number;
  flags?: Set<string> | undefined;
  size?: number | undefined;
  internalDate?: Date | string | undefined;
  envelope?: EnvLike | undefined;
  bodyStructure?: StructLike | undefined;
  headers?: Buffer | undefined;
  modseq?: bigint | undefined;
  /** Server conversation id (Gmail X-GM-THRID / OBJECTID THREADID). */
  threadId?: string | undefined;
}

export function toAddresses(list: EnvAddr[] | undefined): Address[] {
  if (!list) return [];
  const out: Address[] = [];
  for (const a of list) {
    if (!a.address) continue;
    const addr: Address = { address: a.address };
    if (a.name) addr.name = a.name;
    out.push(addr);
  }
  return out;
}

const SYSTEM_FLAGS = new Set([
  '\\seen',
  '\\flagged',
  '\\answered',
  '\\draft',
  '\\deleted',
  '\\recent',
]);

export function flagsToSet(flags: Set<string> | undefined): FlagSet {
  const lower = new Set<string>();
  const keywords: string[] = [];
  for (const f of flags ?? []) {
    lower.add(f.toLowerCase());
    if (!SYSTEM_FLAGS.has(f.toLowerCase())) keywords.push(f);
  }
  return {
    seen: lower.has('\\seen'),
    flagged: lower.has('\\flagged'),
    answered: lower.has('\\answered'),
    draft: lower.has('\\draft'),
    deleted: lower.has('\\deleted'),
    keywords: keywords.sort(),
  };
}

export function sameFlags(a: FlagSet, b: FlagSet): boolean {
  return (
    a.seen === b.seen &&
    a.flagged === b.flagged &&
    a.answered === b.answered &&
    a.draft === b.draft &&
    a.deleted === b.deleted &&
    a.keywords.length === b.keywords.length &&
    a.keywords.every((k, i) => k === b.keywords[i])
  );
}

/** True when the structure contains a real (non-inline-only, non-text-body) attachment. */
export function structureHasAttachments(node: StructLike | undefined): boolean {
  if (!node) return false;
  const disp = node.disposition?.toLowerCase();
  const type = node.type.toLowerCase();
  if (node.childNodes?.length) return node.childNodes.some(structureHasAttachments);
  if (disp === 'attachment') return true;
  if (type.startsWith('multipart/')) return false;
  if (type === 'text/plain' || type === 'text/html') return false;
  // Non-text leaf with a filename and not inline-with-content-id counts as an attachment.
  const hasName = !!(node.dispositionParameters?.filename || node.parameters?.name);
  return hasName && disp !== 'inline';
}

export interface SnippetPart {
  part: string;
  type: string;
  encoding: string;
  charset: string | null;
}

/** The part to peek at for a list snippet: first plain-text leaf, else first HTML leaf. */
export function pickSnippetPart(root: StructLike | undefined): SnippetPart | null {
  if (!root) return null;
  let html: SnippetPart | null = null;
  let found: SnippetPart | null = null;
  const walk = (n: StructLike): void => {
    if (found) return;
    if (n.childNodes?.length) {
      n.childNodes.forEach(walk);
      return;
    }
    const type = n.type.toLowerCase();
    if (n.disposition?.toLowerCase() === 'attachment') return;
    if (type !== 'text/plain' && type !== 'text/html') return;
    const sp: SnippetPart = {
      part: n.part ?? '1',
      type,
      encoding: n.encoding ?? '7bit',
      charset: n.parameters?.charset ?? null,
    };
    if (type === 'text/plain') found = sp;
    else html ??= sp;
  };
  walk(root);
  return found ?? html;
}

/** Extract the References header value (space-joined ids) from a raw header block. */
export function parseReferencesHeader(headers: Buffer | undefined): string | null {
  if (!headers) return null;
  const text = headers.toString('utf8').replace(/\r?\n[ \t]+/g, ' ');
  const m = /^references:\s*(.*)$/im.exec(text);
  const v = m?.[1]?.trim();
  return v ? v : null;
}

export function toDateMs(d: Date | string | undefined): number | null {
  if (!d) return null;
  const t = d instanceof Date ? d.getTime() : Date.parse(d);
  return Number.isFinite(t) ? t : null;
}

export function fetchedToHeader(accountId: string, folderId: number, m: FetchedLike): HeaderInput {
  const env = m.envelope ?? {};
  const internal = toDateMs(m.internalDate) ?? Date.now();
  const header = toDateMs(env.date);
  // Never trust absurd Date headers (far future) for ordering.
  const dateMs = header !== null && header <= Date.now() + 24 * 3600 * 1000 ? header : internal;
  return {
    accountId,
    folderId,
    uid: m.uid,
    messageId: env.messageId ?? null,
    inReplyTo: env.inReplyTo ?? null,
    references: parseReferencesHeader(m.headers),
    subject: env.subject ?? '',
    from: toAddresses(env.from)[0] ?? null,
    to: toAddresses(env.to),
    cc: toAddresses(env.cc),
    bcc: toAddresses(env.bcc),
    replyTo: toAddresses(env.replyTo),
    dateMs,
    internalMs: internal,
    size: m.size ?? null,
    flags: flagsToSet(m.flags),
    modseq: m.modseq !== undefined ? m.modseq.toString() : null,
    hasAttachments: structureHasAttachments(m.bodyStructure),
    gmThrid: m.threadId ? String(m.threadId) : null,
  };
}
