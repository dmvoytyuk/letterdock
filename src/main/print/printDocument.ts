// Builds the document that is printed (pure, no Electron). The print window runs NO script and has a
// strict CSP, so even a body that slipped past the renderer's sanitizer cannot run anything or load
// anything except data: and the local image cache (mailroom-img:). Colors are always light.
import { IMAGE_SCHEME } from '../../shared/imageProxy';

export const PRINT_CSP = [
  "default-src 'none'",
  "script-src 'none'",
  `img-src data: ${IMAGE_SCHEME}:`,
  "style-src 'unsafe-inline'",
  'font-src data:',
  "media-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ');

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const BAD = 'script|iframe|frame|frameset|object|embed|applet|form|base|meta|link|template|noscript';

/**
 * Belt and braces: remove tags that must never be in a printed body, even though the renderer's
 * sanitizer already forbids them. (The CSP and "no JavaScript" are the real protection.)
 */
export function stripDangerousTags(html: string): string {
  return html
    .replace(new RegExp(`<\\s*(${BAD})\\b[\\s\\S]*?<\\s*/\\s*\\1\\s*>`, 'gi'), '')
    .replace(new RegExp(`<\\s*/?\\s*(${BAD})\\b[^>]*>`, 'gi'), '');
}

export interface PrintAddress {
  name?: string;
  address: string;
}

export interface PrintAttachment {
  filename: string | null;
  size: number;
}

export interface PrintInput {
  subject: string;
  from: PrintAddress | null;
  to: PrintAddress[];
  cc: PrintAddress[];
  /** Printed only when not empty (known only for mail we sent or got with a Bcc header). */
  bcc?: PrintAddress[];
  /** Listed by name and size at the end; the files are not printed. */
  attachments?: PrintAttachment[];
  /** Epoch ms. */
  date: number;
  /** Sanitized HTML from the renderer, or null to print `text`. */
  bodyHtml: string | null;
  text: string;
}

function fmtAddr(a: PrintAddress): string {
  const name = a.name?.trim();
  return name && name !== a.address ? `${name} <${a.address}>` : a.address;
}

/** "Monday, 5 October 2026, 10:42" in the local time zone. */
export function fmtDate(ms: number): string {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(ms));
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
    return `${get('weekday')}, ${get('day')} ${get('month')} ${get('year')}, ${get('hour')}:${get('minute')}`;
  } catch {
    return new Date(ms).toISOString();
  }
}

export function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const CSS = `
:root{color-scheme:light}
@page{margin:15mm}
html,body{background:#fff!important;color:#000!important;margin:0}
body{font:11pt/1.4 "Segoe UI",Arial,sans-serif;padding:0}
.hdr{border-bottom:1px solid #999;margin:0 0 14px;padding:0 0 10px;break-inside:avoid}
.hdr h1{font-size:16pt;margin:0 0 8px;font-weight:700;overflow-wrap:anywhere}
.hdr table{border-collapse:collapse;font-size:10pt}
.hdr th{font-weight:700;text-align:left;vertical-align:top;padding:1px 10px 1px 0;white-space:nowrap}
.hdr td{padding:1px 0;overflow-wrap:anywhere}
.mail-body{overflow-wrap:anywhere}
.mail-body img{max-width:100%!important;height:auto}
.mail-body table{max-width:100%}
.mail-body tr{break-inside:avoid}
.mail-body pre.plain{white-space:pre-wrap;font:10.5pt/1.4 Consolas,"Courier New",monospace;margin:0}
.att{border-top:1px solid #999;margin:14px 0 0;padding:8px 0 0;font-size:10pt;overflow-wrap:anywhere;break-inside:avoid}
a{color:#0F6CBD;text-decoration:underline}
`;

function attachmentsHtml(list: PrintAttachment[]): string {
  if (list.length === 0) return '';
  const items = list
    .map((a) => `${escapeHtml(a.filename?.trim() || '(no name)')} (${fmtSize(a.size)})`)
    .join(', ');
  return `<div class="att"><b>Attachments (${list.length}):</b> ${items}</div>`;
}

export function buildPrintDocument(i: PrintInput): string {
  const subject = i.subject.trim() || '(no subject)';
  const rows: string[] = [];
  const row = (label: string, value: string) =>
    rows.push(`<tr><th>${label}</th><td>${escapeHtml(value)}</td></tr>`);
  if (i.from) row('From', fmtAddr(i.from));
  if (i.to.length) row('To', i.to.map(fmtAddr).join(', '));
  if (i.cc.length) row('Cc', i.cc.map(fmtAddr).join(', '));
  if (i.bcc?.length) row('Bcc', i.bcc.map(fmtAddr).join(', '));
  row('Date', fmtDate(i.date));
  const body =
    i.bodyHtml !== null
      ? stripDangerousTags(i.bodyHtml)
      : `<pre class="plain">${escapeHtml(i.text)}</pre>`;
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${PRINT_CSP}">` +
    `<title>${escapeHtml(subject)}</title><style>${CSS}</style></head><body>` +
    `<div class="hdr"><h1>${escapeHtml(subject)}</h1><table>${rows.join('')}</table></div>` +
    `<div class="mail-body">${body}</div>${attachmentsHtml(i.attachments ?? [])}</body></html>`
  );
}
