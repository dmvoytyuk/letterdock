// Pure helpers for composing mail: reply/forward recipients and quoting, signature, mailto:, and
// building the final RFC 822 message with nodemailer's MailComposer. No I/O besides reading
// attachment files that MailComposer streams.
import { randomUUID } from 'node:crypto';
import MailComposer from 'nodemailer/lib/mail-composer';
import { convert } from 'html-to-text';
import type { Address, ComposeMode, MessageBody } from '../../shared/ipc';
import { isValidEmail } from '../accounts/autodiscover';

// ---------- small text helpers ----------

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Plain text to safe HTML: escape, keep line breaks. */
export function textToHtml(text: string): string {
  return escapeHtml(text).replace(/\r\n|\r|\n/g, '<br>');
}

/** HTML to readable plain text (for the text/plain alternative and for quoting). */
export function htmlToPlain(html: string): string {
  return convert(html, {
    wordwrap: false,
    selectors: [
      { selector: 'a', options: { hideLinkHrefIfSameAsText: true } },
      { selector: 'img', format: 'skip' },
      { selector: 'style', format: 'skip' },
      { selector: 'script', format: 'skip' },
    ],
  });
}

const MAX_QUOTE_CHARS = 200_000;

/** Text of a message for quoting: the text part, else the HTML converted to text. Capped. */
export function quotableText(body: Pick<MessageBody, 'text' | 'html'>): string {
  const t = body.text?.trim() ? body.text : body.html ? htmlToPlain(body.html) : '';
  return t.length > MAX_QUOTE_CHARS ? `${t.slice(0, MAX_QUOTE_CHARS)}\n[...]` : t;
}

// ---------- subjects ----------

const REPLY_PREFIX = /^\s*(re|r|aw|sv|antw|rif)\s*:\s*/i;
const FORWARD_PREFIX = /^\s*(fwd?|i|wg|vs|tr|enc)\s*:\s*/i;

export function replySubject(subject: string): string {
  const s = subject.trim();
  return REPLY_PREFIX.test(s) ? s : `Re: ${s}`.trim();
}

export function forwardSubject(subject: string): string {
  const s = subject.trim();
  return FORWARD_PREFIX.test(s) ? s : `Fwd: ${s}`.trim();
}

// ---------- recipients ----------

function key(a: Address): string {
  return a.address.trim().toLowerCase();
}

export function dedupeAddresses(list: Address[], exclude: Set<string> = new Set()): Address[] {
  const seen = new Set(exclude);
  const out: Address[] = [];
  for (const a of list) {
    const k = key(a);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(a);
  }
  return out;
}

export interface ReplyRecipients {
  to: Address[];
  cc: Address[];
}

/**
 * Reply: To = Reply-To, else From. If the message is from you, reply to its recipients instead.
 * Reply all: add the original To and Cc, minus your own addresses and duplicates.
 */
export function replyRecipients(
  src: Pick<MessageBody, 'replyTo' | 'header'>,
  own: string[],
  all: boolean,
): ReplyRecipients {
  const ownSet = new Set(own.map((a) => a.toLowerCase()));
  const sender = src.replyTo[0] ?? src.header.from;
  const fromMe = !!src.header.from && ownSet.has(key(src.header.from));
  let to: Address[] = fromMe ? src.header.to : sender ? [sender] : [];
  let cc: Address[] = [];
  if (all) {
    to = [...to, ...(fromMe ? [] : src.header.to)];
    cc = src.header.cc;
  }
  to = dedupeAddresses(to, ownSet);
  const toKeys = new Set(to.map(key));
  cc = dedupeAddresses(cc, new Set([...ownSet, ...toKeys]));
  // Never leave the To line empty because we removed ourselves (e.g. a note to self).
  if (to.length === 0 && sender) to = [sender];
  return { to, cc };
}

/** References for a reply: the original's References plus its Message-ID (last 20 ids). */
export function replyReferences(
  original: { references: string | null; messageId: string | null },
): string | null {
  const ids = (original.references?.match(/<[^>]+>/g) ?? []).slice();
  if (original.messageId && !ids.includes(original.messageId)) ids.push(original.messageId);
  return ids.length ? ids.slice(-20).join(' ') : null;
}

// ---------- quoting ----------

function whoLine(a: Address | null): string {
  if (!a) return 'someone';
  return a.name ? `${a.name} <${a.address}>` : a.address;
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

const QUOTE_STYLE = 'margin:0 0 0 .8ex;border-left:2px solid #c8c8c8;padding-left:1ex';

/** Signature as an HTML block; plain-text signatures are escaped. Empty string if none. */
export function signatureHtml(signature: string | null | undefined): string {
  const sig = signature?.trim();
  if (!sig) return '';
  const body = /<[a-z][\s\S]*>/i.test(sig) ? sig : textToHtml(sig);
  return `<div class="mailroom-signature">-- <br>${body}</div>`;
}

/** Safe quoted block: the original rendered as escaped text inside a blockquote. */
export function quoteHtml(src: MessageBody): string {
  const intro = `On ${formatDate(src.header.date)}, ${escapeHtml(whoLine(src.header.from))} wrote:`;
  return (
    `<div class="mailroom-quote-intro">${intro}</div>` +
    `<blockquote class="mailroom-quote" type="cite" style="${QUOTE_STYLE}">${textToHtml(quotableText(src))}</blockquote>`
  );
}

export function forwardHtml(src: MessageBody): string {
  const lines = [
    '---------- Forwarded message ----------',
    `From: ${whoLine(src.header.from)}`,
    `Date: ${formatDate(src.header.date)}`,
    `Subject: ${src.header.subject}`,
    `To: ${src.header.to.map(whoLine).join(', ')}`,
    ...(src.header.cc.length ? [`Cc: ${src.header.cc.map(whoLine).join(', ')}`] : []),
  ];
  return (
    `<div class="mailroom-forward-header">${lines.map(escapeHtml).join('<br>')}</div><br>` +
    `<div class="mailroom-forward">${textToHtml(quotableText(src))}</div>`
  );
}

export interface ComposeHtmlParts {
  mode: ComposeMode;
  signature: string | null | undefined;
  source?: MessageBody;
}

/** Initial editor content: empty line, signature, then the quote or forwarded text. */
export function initialHtml(p: ComposeHtmlParts): string {
  const sig = signatureHtml(p.signature);
  const head = '<p><br></p>';
  if (p.mode === 'new' || !p.source) return head + sig;
  const tail = p.mode === 'forward' ? forwardHtml(p.source) : quoteHtml(p.source);
  return head + sig + (sig ? '<br>' : '') + tail;
}

// ---------- mailto: ----------

export interface MailtoFields {
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string;
  body: string;
}

function parseAddressList(raw: string): Address[] {
  return raw
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter((s) => isValidEmail(s))
    .map((address) => ({ address }));
}

/** Parse a mailto: URL (RFC 6068). Anything unparseable gives empty fields. */
export function parseMailto(url: string): MailtoFields {
  const empty: MailtoFields = { to: [], cc: [], bcc: [], subject: '', body: '' };
  if (!/^mailto:/i.test(url)) return empty;
  const rest = url.slice('mailto:'.length);
  const q = rest.indexOf('?');
  const dec = (s: string) => {
    try {
      return decodeURIComponent(s.replace(/\+/g, ' '));
    } catch {
      return s;
    }
  };
  const out: MailtoFields = { ...empty, to: parseAddressList(dec(q < 0 ? rest : rest.slice(0, q))) };
  if (q >= 0) {
    for (const pair of rest.slice(q + 1).split('&')) {
      const eq = pair.indexOf('=');
      if (eq < 0) continue;
      const k = pair.slice(0, eq).toLowerCase();
      const v = dec(pair.slice(eq + 1));
      if (k === 'to') out.to.push(...parseAddressList(v));
      else if (k === 'cc') out.cc.push(...parseAddressList(v));
      else if (k === 'bcc') out.bcc.push(...parseAddressList(v));
      else if (k === 'subject') out.subject = v.slice(0, 500);
      else if (k === 'body') out.body = v.slice(0, 20_000);
    }
  }
  out.to = dedupeAddresses(out.to);
  return out;
}

// ---------- building the message ----------

export interface BuildInput {
  from: Address;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string;
  html: string;
  messageId: string;
  inReplyTo?: string | null;
  references?: string | null;
  attachments: { filename: string; path: string; contentType: string }[];
  date?: Date;
}

export function generateMessageId(email: string): string {
  const domain = email.split('@')[1]?.trim() || 'mailroom.local';
  return `<${randomUUID()}@${domain}>`;
}

/**
 * Build the RFC 822 bytes. MailComposer never writes a Bcc header (that is what we want for the
 * SMTP send); use withBccHeader for drafts and the copy saved in Sent.
 */
export function buildRaw(input: BuildInput): Promise<Buffer> {
  const options = {
    from: input.from.name
      ? { name: input.from.name, address: input.from.address }
      : input.from.address,
    to: input.to.map((a) => (a.name ? { name: a.name, address: a.address } : a.address)),
    cc: input.cc.map((a) => (a.name ? { name: a.name, address: a.address } : a.address)),
    bcc: input.bcc.map((a) => (a.name ? { name: a.name, address: a.address } : a.address)),
    subject: input.subject,
    html: input.html,
    text: htmlToPlain(input.html),
    messageId: input.messageId,
    ...(input.inReplyTo ? { inReplyTo: input.inReplyTo } : {}),
    ...(input.references ? { references: input.references } : {}),
    attachments: input.attachments.map((a) => ({
      filename: a.filename,
      path: a.path,
      contentType: a.contentType,
    })),
    headers: { 'X-Mailer': 'Mailroom' },
    date: input.date ?? new Date(),
  };
  const mail = new MailComposer(options);
  return new Promise<Buffer>((resolve, reject) => {
    mail.compile().build((err, buf) => (err ? reject(err) : resolve(buf)));
  });
}

/** Add a Bcc header to finished bytes (for the copy saved in Sent). */
export function withBccHeader(raw: Buffer, bcc: Address[]): Buffer {
  if (bcc.length === 0) return raw;
  const line = `Bcc: ${bcc.map((a) => a.address).join(', ')}\r\n`;
  return Buffer.concat([Buffer.from(line, 'utf8'), raw]);
}

export function addressList(...lists: Address[][]): string[] {
  return dedupeAddresses(lists.flat()).map((a) => a.address);
}
