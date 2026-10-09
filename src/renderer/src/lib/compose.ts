// Pure helpers for the compose window (recipients, links, signature, wording checks).
import type { Address } from '../../../shared/ipc';
import { escapeHtml, isValidEmail } from './format';

/**
 * Turns pasted or typed text into addresses. Handles "a@b.com; c@d.com", "Jane Cooper <jane@x.com>"
 * and quoted names with commas. Text without an "@" is kept as an (invalid) entry so the user sees it.
 */
export function parseRecipients(text: string): Address[] {
  const out: Address[] = [];
  const re = /"[^"]*"\s*<[^>]*>|[^,;\n]+/g;
  for (const m of text.matchAll(re)) {
    const raw = m[0].trim();
    if (!raw) continue;
    const named = /^"?([^"<]*?)"?\s*<([^>]+)>$/.exec(raw);
    if (named) {
      const name = named[1]!.trim();
      const address = named[2]!.trim();
      out.push(name ? { name, address } : { address });
    } else {
      out.push({ address: raw.replace(/^<|>$/g, '').trim() });
    }
  }
  return out;
}

/**
 * Text still sitting in a recipient box. Real addresses become recipients; anything else is
 * `leftover` (never stored as a recipient). `bad` tells that something unusable was typed.
 */
export function resolvePending(list: Address[], text: string): { list: Address[]; leftover: string; bad: boolean } {
  if (!text.trim()) return { list, leftover: '', bad: false };
  const parsed = parseRecipients(text);
  const good = parsed.filter(isValidAddress);
  const bad = parsed.length > good.length;
  return { list: addAddresses(list, good), leftover: bad ? text : '', bad };
}

export const isValidAddress = (a: Address): boolean => isValidEmail(a.address);

/** Merge new addresses into a list without repeating an address (case-insensitive). */
export function addAddresses(list: Address[], extra: Address[]): Address[] {
  const seen = new Set(list.map((a) => a.address.toLowerCase()));
  const out = [...list];
  for (const a of extra) {
    const key = a.address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}

export function chipLabel(a: Address): string {
  return a.name?.trim() || a.address;
}

/** Same markup the engine writes (engine/smtp/mime.ts signatureHtml), so swapping can find it. */
export function signatureHtml(signature: string | null | undefined): string {
  const sig = signature?.trim();
  if (!sig) return '';
  const body = /<[a-z][\s\S]*>/i.test(sig) ? sig : escapeHtml(sig).replace(/\r\n|\r|\n/g, '<br>');
  return `<div class="letterdock-signature">-- <br>${body}</div>`;
}

/** Link text typed by the user to a safe URL, or null if it is not an http, https or mailto link. */
export function normalizeUrl(input: string): string | null {
  const t = input.trim();
  if (!t) return null;
  if (/^(https?:|mailto:)/i.test(t)) {
    try {
      return new URL(t).href;
    } catch {
      return null;
    }
  }
  if (/^[^\s@]+@[^\s@]+\.[^\s@.]+$/.test(t)) return `mailto:${t}`;
  if (/^[^\s:/]+\.[^\s:/]+(\/\S*)?$/.test(t)) {
    try {
      return new URL(`https://${t}`).href;
    } catch {
      return null;
    }
  }
  return null;
}

/** "attached", "attachment", "attaching" ... in text the user wrote (not the quoted reply). */
export function mentionsAttachment(text: string): boolean {
  return /\battach(ed|ment|ments|ing)?\b/i.test(text);
}

export const MAX_ATTACH_BYTES = 25 * 1024 * 1024;
export const WARN_ATTACH_BYTES = 20 * 1024 * 1024;
