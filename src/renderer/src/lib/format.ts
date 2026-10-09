import type { Address } from '../../../shared/ipc';

export function senderName(a: Address | null | undefined): string {
  if (!a) return '(unknown sender)';
  return a.name?.trim() || a.address;
}

export function addressList(list: Address[]): string {
  return list.map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(', ');
}

export function initials(name: string): string {
  const parts = name
    .replace(/<.*>/, '')
    .trim()
    .split(/[\s._-]+/)
    .filter(Boolean);
  if (parts.length === 0) return '?';
  const s =
    parts.length === 1 ? parts[0]!.slice(0, 2) : parts[0]![0]! + parts[parts.length - 1]![0]!;
  return s.toUpperCase();
}

export function accountLetter(displayName: string, email: string): string {
  const s = (displayName || email).trim();
  return (s[0] ?? '?').toUpperCase();
}

/** The 1-2 characters shown on an account tile: the badge the user chose, else the first letter. */
export function badgeOf(a: { badge?: string; displayName: string; email: string }): string {
  return a.badge?.trim() || accountLetter(a.displayName, a.email);
}

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
const DAY = 86_400_000;

export function listDate(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const today = startOfDay(new Date(now));
  if (ms >= today) return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (ms >= today - DAY) return 'Yesterday';
  if (ms >= today - 6 * DAY) return d.toLocaleDateString(undefined, { weekday: 'short' });
  if (d.getFullYear() === new Date(now).getFullYear())
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  return d.toLocaleDateString();
}

export function fullDate(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function relativeTime(ms: number | null, now = Date.now()): string {
  if (!ms) return 'never';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

/** Group label for a date (DESIGN-SPEC 3.5). Weeks start on Monday. */
export function groupLabel(ms: number, now = Date.now()): string {
  const today = startOfDay(new Date(now));
  if (ms >= today) return 'Today';
  if (ms >= today - DAY) return 'Yesterday';
  const nd = new Date(now);
  const dow = (nd.getDay() + 6) % 7;
  const weekStart = today - dow * DAY;
  if (ms >= weekStart) return 'This week';
  if (ms >= weekStart - 7 * DAY) return 'Last week';
  const d = new Date(ms);
  if (d.getFullYear() === nd.getFullYear() && d.getMonth() === nd.getMonth()) return 'This month';
  return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

/** 1 decimal at most, and no trailing ".0" (so 2 GB, not 2.0 GB). */
function trim(n: number): string {
  const r = n >= 100 ? Math.round(n) : Math.round(n * 10) / 10;
  return String(r);
}

/** Binary units (1 KB = 1024 B), e.g. "500 MB", "2 GB", "1.5 MB". */
export function fileSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 * 1024 * 1024) return `${trim(n / (1024 * 1024))} MB`;
  return `${trim(n / (1024 * 1024 * 1024))} GB`;
}

/** Size given in megabytes, for settings choices: 500 -> "500 MB", 2048 -> "2 GB". */
export function megabytes(mb: number): string {
  return fileSize(mb * 1024 * 1024);
}

export function fileKind(name: string | null, type: string): { label: string; cls: string } {
  const ext = (name?.split('.').pop() ?? '').toLowerCase();
  if (type.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(ext))
    return { label: (ext || 'img').slice(0, 4).toUpperCase(), cls: 'img' };
  if (ext === 'pdf' || type === 'application/pdf') return { label: 'PDF', cls: '' };
  if (['doc', 'docx', 'odt', 'rtf', 'txt', 'xls', 'xlsx', 'ppt', 'pptx'].includes(ext))
    return { label: ext.slice(0, 4).toUpperCase(), cls: 'doc' };
  if (['zip', '7z', 'rar', 'gz', 'tar'].includes(ext))
    return { label: ext.toUpperCase(), cls: 'zip' };
  return { label: (ext || 'file').slice(0, 4).toUpperCase(), cls: 'gen' };
}

export function isValidEmail(e: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s.]+$/.test(e.trim());
}

export function domainOf(email: string): string {
  return (email.split('@')[1] ?? '').toLowerCase();
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}
