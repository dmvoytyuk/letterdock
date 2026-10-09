// Development only: a fake window.api so the UI can be viewed in a plain browser
// (http://localhost:5173/?fake=1). Never included in production builds.
// It mimics the M2/M3 backend behaviour: moved messages keep their id and arrive in
// `messages:changed.updated`, sends always queue, undo tokens, search, OAuth waiting, outbox.
import type {
  Account,
  AccountStatus,
  Address,
  AppEvent,
  AppSettings,
  ComposeDraft,
  DraftAttachment,
  DraftSyncState,
  Folder,
  IpcChannel,
  MessageBody,
  MessageHeader,
  OutboxItem,
  PreloadApi,
  SendReq,
} from '../../../shared/ipc';

const now = Date.now();
const isComposeWindow = location.pathname.endsWith('compose.html');
const isViewerWindow = location.pathname.endsWith('viewer.html');

const accounts: Account[] = [
  ['a1', 'Personal Gmail', 'alex.rivera@gmail.example', '#0F6CBD', 'gmail'],
  ['a2', 'Work Outlook', 'a.rivera@northfield.example', '#0E7C7B', 'outlook'],
  ['a3', 'iCloud', 'alex.rivera@icloud.example', '#C74B00', 'icloud'],
].map(([id, name, email, color, provider], i) => ({
  id: id!,
  email: email!,
  displayName: name!,
  color: color!,
  provider: provider as Account['provider'],
  authType: id === 'a2' ? 'oauth2' : 'password',
  oauthProvider: id === 'a2' ? 'microsoft' : null,
  imap: { host: 'imap.example', port: 993, security: 'ssl' },
  smtp: { host: 'smtp.example', port: 465, security: 'ssl' },
  username: email!,
  syncDays: 90,
  signature: id === 'a1' ? 'Alex Rivera\nPersonal' : id === 'a2' ? 'Alex Rivera\nNorthfield Ltd' : null,
  enabled: true,
  sortOrder: i,
  badge: name![0]!.toUpperCase(),
}));

let fid = 1;
const folders: Folder[] = [];
for (const a of accounts) {
  for (const [role, name] of [
    ['inbox', 'INBOX'],
    ['drafts', 'Drafts'],
    ['sent', 'Sent'],
    ['archive', 'Archive'],
    ['junk', 'Spam'],
    ['trash', 'Trash'],
    [null, 'Projects'],
    [null, 'Receipts'],
  ] as const) {
    folders.push({
      id: fid++,
      accountId: a.id,
      path: name,
      name,
      role,
      delimiter: '/',
      unreadCount: 0,
      totalCount: 0,
      selectable: true,
    });
  }
}
const folderOf = (id: number) => folders.find((f) => f.id === id)!;
const roleFolder = (accountId: string, role: string) =>
  folders.find((f) => f.accountId === accountId && f.role === role)!;

const people = ['Jane Cooper', 'Marcus Webb', 'Priya Nair', 'Atlas Cloud Billing', 'Sofia Marchetti', 'Tom Ellery'];
const subjects = [
  'Quarterly budget review',
  'Dinner on Saturday?',
  'Website copy: v3 for review',
  'Your invoice for September is ready',
  'Photos from the weekend',
  'Re: Offsite agenda',
];
const messages: MessageHeader[] = [];
let mid = 1;
function seed(f: Folder, count: number, tag = ''): void {
  for (let i = 0; i < count; i++) {
    const p = (i + f.id) % people.length;
    messages.push({
      id: mid,
      accountId: f.accountId,
      folderId: f.id,
      uid: mid,
      messageIdHeader: `<m${mid}@x>`,
      subject: `${subjects[p]}${i > 5 ? ` (${i})` : ''}${tag}`,
      from: { name: people[p]!, address: `${people[p]!.split(' ')[0]!.toLowerCase()}@example.com` },
      to: [{ address: 'me@example.com' }],
      cc: [],
      date: now - i * 3_600_000 * (1 + (i % 7)) - f.id * 60_000,
      snippet: 'Hi team, attached is the draft for the Q4 budget. Please look at the marketing and tooling lines before Friday...',
      seen: i % 3 === 0 ? false : true,
      flagged: i % 11 === 0,
      answered: false,
      draft: f.role === 'drafts',
      hasAttachments: i % 4 === 0,
      size: 4000,
      bodyCached: true,
    });
    mid++;
  }
}
for (const f of folders.filter((x) => x.role === 'inbox')) seed(f, 90);
for (const a of accounts) {
  seed(roleFolder(a.id, 'trash'), 6, ' [in Trash]');
  seed(roleFolder(a.id, 'junk'), 5, ' [spam]');
  seed(roleFolder(a.id, 'drafts'), 4, ' [draft]');
  // Demo of the draft sync states (DESIGN-SPEC 3.7): saving, queued, failed, saved.
  const dm = messages.filter((m) => m.folderId === roleFolder(a.id, 'drafts').id);
  const states: DraftSyncState[] = ['saving', 'queued', 'failed', 'saved'];
  dm.forEach((m, i) => {
    m.draftSync = states[i % 4]!;
    m.localOnly = m.draftSync !== 'saved';
  });
  seed(roleFolder(a.id, 'archive'), 8, ' [archived]');
}

// ---------- email body fixtures for the dark-mode rendering work (DESIGN-SPEC 3.6.1) ----------
const fixtureBodies = new Map<number, { html: string | null; text: string | null }>();
function addFixture(subject: string, html: string | null, text: string | null, minutesAgo: number): void {
  const inbox = folders.find((x) => x.role === 'inbox')!;
  messages.push({
    id: mid,
    accountId: inbox.accountId,
    folderId: inbox.id,
    uid: mid,
    messageIdHeader: `<fx${mid}@x>`,
    subject,
    from: { name: 'Fixture Sender', address: 'fixture@example.com' },
    to: [{ address: 'me@example.com' }],
    cc: [],
    date: now - minutesAgo * 1000,
    snippet: subject,
    seen: false,
    flagged: false,
    answered: false,
    draft: false,
    hasAttachments: false,
    size: 2000,
    bodyCached: true,
  });
  fixtureBodies.set(mid, { html, text });
  mid++;
}
addFixture('Fixture: plain text "Test"', null, 'Test', 1);
addFixture(
  'Fixture: Gmail simple compose',
  `<div dir="ltr"><div style="font-family:arial,helvetica,sans-serif;color:#000000">Hi Alex,<br><br>Here is the <a href="https://ok.example/plan">plan</a> we talked about. I wrote <code>npm run build</code> in the notes.</div><div><br></div><div class="gmail_quote"><div dir="ltr" class="gmail_attr">On Mon, 5 Oct 2026 at 10:41, Jane Cooper &lt;jane@example.com&gt; wrote:<br></div><blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex"><div dir="ltr" style="color:#222222">Can you send the plan before Friday?<br>Thanks!</div></blockquote></div></div>`,
  null,
  2,
);
addFixture(
  'Fixture: designed newsletter (white body, brand header)',
  `<table width="100%" cellpadding="0" cellspacing="0" bgcolor="#f4f4f4" style="background-color:#f4f4f4"><tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" bgcolor="#ffffff" style="background-color:#ffffff;font-family:Arial,sans-serif">
<tr><td bgcolor="#0a66c2" style="background-color:#0a66c2;padding:24px;color:#ffffff;font-size:26px;font-weight:bold">Hollow Books Weekly</td></tr>
<tr><td style="padding:24px;color:#333333;font-size:15px"><h2 style="color:#7a2e0e;margin:0 0 8px">Autumn picks for you</h2>
<p style="color:#555555">Cozy reads for the first cold evenings. <a href="https://ok.example/books" style="color:#0a66c2">Browse the list</a>.</p>
<p style="color:#999999;font-size:13px">Light gray helper text that is hard to read on white.</p>
<img src="data:image/svg+xml;base64,PHN2ZyB4bWxucz0naHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmcnIHdpZHRoPSczMDAnIGhlaWdodD0nNjAnPjxyZWN0IHdpZHRoPSczMDAnIGhlaWdodD0nNjAnIGZpbGw9JyNmZmYnLz48dGV4dCB4PScxMCcgeT0nMzgnIGZpbGw9JyMwMDAnPkxvZ288L3RleHQ+PC9zdmc+" width="300" height="60" alt="Logo" style="display:block">
<table cellpadding="0" cellspacing="0"><tr><td bgcolor="#e8590c" style="background-color:#e8590c;padding:10px 18px;border-radius:4px"><a href="https://ok.example/buy" style="color:#ffffff;text-decoration:none;font-weight:bold">Shop now</a></td></tr></table>
</td></tr>
<tr><td style="border-top:1px solid #dddddd;padding:16px 24px;color:#888888;font-size:12px">You received this because you subscribed.</td></tr>
</table></td></tr></table>`,
  null,
  3,
);
addFixture(
  'Fixture: gradient / background-image newsletter',
  `<div style="background:linear-gradient(135deg,#ff9a9e,#fad0c4);font-family:Arial,sans-serif;padding:0;min-height:100%;height:100%">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:32px;color:#4a1d1d">
<h1 style="margin:0 0 8px;color:#4a1d1d">Summer sale ends tonight</h1>
<p style="color:#6b2a2a">Everything is 40% off. <a href="https://ok.example/sale" style="color:#8b1a1a">See deals</a></p>
</td></tr></table></div>`,
  null,
  4,
);
messages.sort((a, b) => b.date - a.date || b.id - a.id);

function recount(): void {
  for (const f of folders) {
    const inFolder = messages.filter((m) => m.folderId === f.id);
    f.totalCount = inFolder.length;
    f.unreadCount = inFolder.filter((m) => !m.seen).length;
  }
}
recount();

const settings: AppSettings = {
  notifications: { enabled: true, mutedAccountIds: [], showPreview: true, sound: true },
  markReadDelayMs: 1500,
  remoteImages: 'block',
  theme: 'system',
  startMinimizedToTray: false,
  closeToTray: false,
  launchAtLogin: false,
  maxBodyCacheMB: 2048,
  imageCacheMaxMb: 500,
  imageCacheMaxAgeDays: 30,
  maxWorkConnectionsPerAccount: 2,
  verboseLogging: false,
  autoUpdateCheck: true,
  undoSendDelayMs: 5000,
  alwaysShowCcBcc: false,
  rememberComposeBounds: true,
  suggestFromAllAccounts: true,
};

const statuses: AccountStatus[] = [
  { accountId: 'a1', state: 'online', lastSyncAt: now - 120_000, error: null, nextRetryAt: null, pendingCount: 0 },
  { accountId: 'a2', state: 'needs_reauth', lastSyncAt: null, error: { code: 'OAUTH_REAUTH_REQUIRED', message: 'Sign in again.', retryable: false }, nextRetryAt: null, pendingCount: 0 },
  {
    accountId: 'a3',
    state: 'auth_failed',
    lastSyncAt: null,
    error: { code: 'AUTH_FAILED', message: 'The server rejected the password.', retryable: false },
    nextRetryAt: null,
    pendingCount: 0,
  },
];

const html = (n: number) => `<div style="font-family:Arial,sans-serif"><h2 style="color:#7a2e0e">Out for delivery #${n}</h2>
<p>Hi Alex, your parcel from <b>Hollow Books</b> will arrive today.</p>
<img src="https://tracker.example/pixel.gif" width="200" height="60" alt="banner">
<p><a href="https://evil.example/login">https://bank.example/login</a></p>
<p><a href="https://ok.example/x">Track my parcel</a></p>
<script>alert('x')</script></div>`;

// ---------- contacts (recipient autocomplete) ----------
interface FakeContact {
  address: string;
  name: string | null;
  sentCount: number;
  lastUsed: number;
  isOwn: boolean;
  /** Account that knows this contact best (the others do not know it). */
  acc?: string;
}
const DAYS = 86_400_000;
const contactBook: FakeContact[] = [
  ...people.map((n, i) => ({
    address: `${n.split(' ')[0]!.toLowerCase()}@example.com`,
    name: n,
    sentCount: [14, 6, 0, 1, 3, 0][i]!,
    lastUsed: now - i * 6 * DAYS,
    isOwn: false,
    acc: i % 3 === 2 ? 'a2' : 'a1',
  })),
  { address: 'mark.jacobs@northfield.example', name: 'Mark Jacobs', sentCount: 2, lastUsed: now - 3 * DAYS, isOwn: false, acc: 'a2' },
  { address: 'marta.rossi@northfield.example', name: 'Marta Rossi', sentCount: 9, lastUsed: now - 1 * DAYS, isOwn: false, acc: 'a2' },
  { address: 'maria.chen@icloud.example', name: 'Maria Chen', sentCount: 3, lastUsed: now - 8 * DAYS, isOwn: false, acc: 'a3' },
  { address: 'jane.cooper@acme.example', name: 'Jane Cooper', sentCount: 0, lastUsed: now - 90 * DAYS, isOwn: false, acc: 'a2' },
  { address: 'anna.jamison@example.org', name: null, sentCount: 0, lastUsed: now - 200 * DAYS, isOwn: false },
  { address: 'jose.garcia@example.es', name: 'Jos\u00e9 Garc\u00eda', sentCount: 5, lastUsed: now - 2 * DAYS, isOwn: false },
  ...accounts.map((a) => ({ address: a.email, name: 'Alex Rivera', sentCount: 0, lastUsed: now, isOwn: true })),
];
const fold = (t: string) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
type FakeSuggestion = FakeContact & { otherAccountId?: string };
function suggest(query: string, limit: number, accountId?: string): FakeSuggestion[] {
  const q = fold(query.trim());
  if (!q) return [];
  const starts = (text: string, sep: RegExp) => {
    const t = fold(text);
    for (let i = t.indexOf(q); i !== -1; i = t.indexOf(q, i + 1)) if (i === 0 || sep.test(t[i - 1]!)) return true;
    return false;
  };
  const all = settings.suggestFromAllAccounts;
  return contactBook
    .filter((c) => (c.name ? starts(c.name, /[\s\-'.]/) : false) || starts(c.address, /[.\-_@]/))
    .filter((c) => !accountId || c.isOwn || c.acc === undefined || c.acc === accountId || all)
    .map((c): FakeSuggestion => (accountId && !c.isOwn && c.acc !== undefined && c.acc !== accountId ? { ...c, otherAccountId: c.acc } : c))
    .sort(
      (a, b) =>
        Number(a.isOwn) - Number(b.isOwn) ||
        Number(!!a.otherAccountId) - Number(!!b.otherAccountId) ||
        b.sentCount - a.sentCount ||
        b.lastUsed - a.lastUsed,
    )
    .slice(0, limit);
}

// ---------- cross-window plumbing (the fake compose window is a second page) ----------
const listeners = new Set<(e: AppEvent) => void>();
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('mailroom-fake') : null;
function emitLocal(e: AppEvent): void {
  for (const l of listeners) l(e);
}
function emit(e: AppEvent): void {
  emitLocal(e);
  channel?.postMessage(e);
}
channel?.addEventListener('message', (m: MessageEvent<AppEvent>) => {
  emitLocal(m.data);
  if (!isComposeWindow && !isViewerWindow && m.data.type === 'outbox:changed') armOutbox();
});

const LS = {
  get<T>(k: string, d: T): T {
    try {
      const v = localStorage.getItem('fake.' + k);
      return v ? (JSON.parse(v) as T) : d;
    } catch {
      return d;
    }
  },
  set(k: string, v: unknown): void {
    try {
      localStorage.setItem('fake.' + k, JSON.stringify(v));
    } catch {
      /* ignore */
    }
  },
};

interface StoredOutbox extends OutboxItem {
  req: SendReq;
}
const readOutbox = (): StoredOutbox[] => LS.get<StoredOutbox[]>('outbox', []);
const writeOutbox = (l: StoredOutbox[]) => LS.set('outbox', l);
const drafts = (): Record<string, SendReq> => LS.get('drafts', {});
const saveDrafts = (d: Record<string, SendReq>) => LS.set('drafts', d);

const timers = new Map<number, ReturnType<typeof setTimeout>>();
function armOutbox(): void {
  for (const it of readOutbox()) {
    if (it.state !== 'queued' || timers.has(it.id)) continue;
    timers.set(
      it.id,
      setTimeout(() => runSend(it.id), Math.max(0, it.sendAt - Date.now())),
    );
  }
}
function runSend(id: number): void {
  timers.delete(id);
  let list = readOutbox();
  const it = list.find((x) => x.id === id);
  if (!it || it.state !== 'queued') return;
  it.state = 'sending';
  writeOutbox(list);
  emit({ type: 'outbox:changed' });
  setTimeout(() => {
    list = readOutbox();
    const cur = list.find((x) => x.id === id);
    if (!cur) return;
    if (/fail/i.test(cur.subject)) {
      cur.state = 'failed';
      cur.attempts += 1;
      cur.lastError = 'The server refused the connection (fake).';
      writeOutbox(list);
      emit({ type: 'outbox:changed' });
      emit({ type: 'send:result', outboxId: id, ok: false, error: { code: 'HOST_UNREACHABLE', message: "Couldn't reach the mail server (fake).", retryable: true } });
      return;
    }
    writeOutbox(list.filter((x) => x.id !== id));
    emit({ type: 'outbox:changed' });
    emit(
      /reject/i.test(cur.subject)
        ? { type: 'send:result', outboxId: id, ok: true, error: { code: 'SERVER_REJECTED', message: 'The server refused these addresses: nobody@example.com', retryable: false } }
        : { type: 'send:result', outboxId: id, ok: true },
    );
  }, 1200);
}

// ---------- helpers ----------
const delay = <T>(v: T, ms = 120) => new Promise<T>((r) => setTimeout(() => r(v), ms));
const err = (code: string, message: string, retryable = false) => Promise.reject({ code, message, retryable });

const undoStore = new Map<string, { id: number; folderId: number }[]>();
let undoSeq = 1;
const allowed = new Set<string>(['jane@example.com']);
let attSeq = 1;

function scopeFilter(scope: { kind: string; folderId?: number; accountId?: string }) {
  return (m: MessageHeader) => {
    const role = folderOf(m.folderId).role;
    if (scope.kind === 'folder') return m.folderId === scope.folderId;
    if (scope.kind === 'accountInbox') return m.accountId === scope.accountId && role === 'inbox';
    if (scope.kind === 'unifiedFlagged') return m.flagged && role !== 'trash' && role !== 'junk';
    if (scope.kind === 'unifiedUnread') return !m.seen && role === 'inbox';
    return role === 'inbox';
  };
}

interface Parsed {
  words: string[];
  from: string[];
  to: string[];
  subject: string[];
  account: string[];
  folder: string[];
  is: string[];
  attach: boolean;
  before: number | null;
  after: number | null;
  chips: string[];
}
function parseQuery(q: string): Parsed {
  const p: Parsed = { words: [], from: [], to: [], subject: [], account: [], folder: [], is: [], attach: false, before: null, after: null, chips: [] };
  const re = /(\w+):("[^"]*"|\S+)|"([^"]+)"|(\S+)/g;
  for (const m of q.matchAll(re)) {
    const [, op, val, phrase, word] = m;
    if (op) {
      const v = val!.replace(/^"|"$/g, '').toLowerCase();
      const o = op.toLowerCase();
      if (o === 'from') p.from.push(v);
      else if (o === 'to') p.to.push(v);
      else if (o === 'subject') p.subject.push(v);
      else if (o === 'account') p.account.push(v);
      else if (o === 'folder' || o === 'in') p.folder.push(v);
      else if (o === 'is') p.is.push(v);
      else if (o === 'has' && v === 'attachment') p.attach = true;
      else if (o === 'before') p.before = Date.parse(v);
      else if (o === 'after') p.after = Date.parse(v);
      else {
        p.words.push(m[0].toLowerCase());
        continue;
      }
      p.chips.push(`${o}:${v}`);
    } else if (phrase) p.words.push(phrase.toLowerCase());
    else if (word) p.words.push(word.toLowerCase());
  }
  return p;
}
function searchLocal(query: string, accountId?: string) {
  const p = parseQuery(query);
  if (!query.trim()) return { items: [], parsedFilters: [], totalApprox: 0, coverage: { messagesIndexed: messages.length, bodiesIndexed: messages.length - 40 } };
  const items = messages.filter((m) => {
    const f = folderOf(m.folderId);
    if (accountId && m.accountId !== accountId) return false;
    if (p.account.length && !p.account.some((a) => accounts.find((x) => x.id === m.accountId)!.displayName.toLowerCase().includes(a))) return false;
    if (p.folder.length) {
      if (!p.folder.some((x) => f.name.toLowerCase().includes(x) || f.role === x)) return false;
    } else if (f.role === 'trash' || f.role === 'junk') return false;
    const sender = `${m.from?.name ?? ''} ${m.from?.address ?? ''}`.toLowerCase();
    if (p.from.length && !p.from.every((x) => sender.includes(x))) return false;
    if (p.to.length && !p.to.every((x) => m.to.some((t) => t.address.toLowerCase().includes(x)))) return false;
    if (p.subject.length && !p.subject.every((x) => m.subject.toLowerCase().includes(x))) return false;
    if (p.is.includes('unread') && m.seen) return false;
    if (p.is.includes('read') && !m.seen) return false;
    if (p.is.includes('flagged') && !m.flagged) return false;
    if (p.attach && !m.hasAttachments) return false;
    if (p.before !== null && m.date >= p.before) return false;
    if (p.after !== null && m.date < p.after) return false;
    const hay = `${m.subject} ${m.snippet} ${sender}`.toLowerCase();
    return p.words.every((w) => hay.includes(w));
  });
  return {
    items: items.slice(0, 300).map((m, i) => ({ ...m, rank: i })),
    parsedFilters: p.chips,
    totalApprox: items.length,
    coverage: { messagesIndexed: messages.length, bodiesIndexed: messages.length - 40 },
  };
}

function changed(partial: { updated?: number[]; removed?: number[]; added?: number[]; folderIds: number[] }): void {
  recount();
  emit({ type: 'messages:changed', added: partial.added ?? [], updated: partial.updated ?? [], removed: partial.removed ?? [], folderIds: partial.folderIds });
  emit({
    type: 'counts:changed',
    unifiedInboxUnread: folders.filter((f) => f.role === 'inbox').reduce((n, f) => n + f.unreadCount, 0),
    perFolder: folders.map((f) => ({ folderId: f.id, unread: f.unreadCount, total: f.totalCount })),
  });
}

function destFor(action: { type: string; destFolderId?: number }, m: MessageHeader): number | null {
  switch (action.type) {
    case 'move':
      return action.destFolderId!;
    case 'archive':
      return roleFolder(m.accountId, 'archive').id;
    case 'delete':
      return roleFolder(m.accountId, 'trash').id;
    case 'spam':
      return roleFolder(m.accountId, 'junk').id;
    case 'notSpam':
      return roleFolder(m.accountId, 'inbox').id;
    default:
      return null;
  }
}

function quoteOf(m: MessageHeader): string {
  const who = m.from?.name ?? m.from?.address ?? 'someone';
  return `<div class="mailroom-quote-intro">On ${new Date(m.date).toLocaleString()}, ${who} wrote:</div><blockquote class="mailroom-quote" type="cite" style="margin:0 0 0 .8ex;border-left:2px solid #c8c8c8;padding-left:1ex">${m.snippet}</blockquote>`;
}
const sigHtml = (a: Account) =>
  a.signature ? `<div class="mailroom-signature">-- <br>${a.signature.replace(/\n/g, '<br>')}</div>` : '';

function oauthNow() {
  return { microsoft: { clientIdOverride: '', builtInClientId: '00000000-0000-4000-8000-000000000000', effectiveClientId: '00000000-0000-4000-8000-000000000000', tenant: 'common' } };
}
const oauthWaits = new Map<string, { cancel: () => void }>();
let sessionSeq = 1;

function handle(channel: IpcChannel, req: unknown): Promise<unknown> {
  const r = req as Record<string, unknown> | undefined;
  switch (channel) {
    case 'accounts.list':
      return delay(accounts);
    case 'accounts.statuses':
      return delay(statuses);
    case 'accounts.update': {
      const a = accounts.find((x) => x.id === r!.accountId);
      if (!a) return err('NOT_FOUND', 'Account not found.');
      Object.assign(a, r!.patch);
      emit({ type: 'accounts:changed' });
      return delay(a);
    }
    case 'accounts.updateCredentials': {
      const st = statuses.find((s) => s.accountId === r!.accountId);
      if (st) Object.assign(st, { state: 'online', error: null });
      emit({ type: 'account:status', status: st! });
      return delay(undefined, 600);
    }
    case 'accounts.add': {
      const input = r as unknown as Account;
      const acct: Account = { ...accounts[0]!, id: `a${accounts.length + 1}`, email: input.email, displayName: input.displayName, authType: input.authType, oauthProvider: input.authType === 'oauth2' ? 'microsoft' : null, signature: null, sortOrder: accounts.length, badge: input.displayName[0]?.toUpperCase() ?? '?' };
      accounts.push(acct);
      statuses.push({ accountId: acct.id, state: 'online', lastSyncAt: Date.now(), error: null, nextRetryAt: null, pendingCount: 0 });
      emit({ type: 'accounts:changed' });
      return delay(acct, 400);
    }
    case 'accounts.discover': {
      const email = String((r as { email: string }).email).toLowerCase();
      if (/@(outlook|hotmail|live)\./.test(email)) {
        return delay(
          {
            config: {
              provider: 'outlook',
              imap: { host: 'outlook.office365.com', port: 993, security: 'ssl' },
              smtp: { host: 'smtp.office365.com', port: 587, security: 'starttls' },
              usernameTemplate: email,
              suggestedAuth: 'oauth2',
              oauthProvider: 'microsoft',
              oauthRequired: true,
              appPasswordHelpUrl: null,
              help: { providerName: 'Outlook.com', authMethod: 'microsoft-oauth', appPasswordHelpUrl: null, instructions: 'Sign in with your Microsoft account in the browser.', notes: [] },
              source: 'known',
            },
          },
          400,
        );
      }
      return delay({ config: null }, 400);
    }
    case 'folders.list':
      return delay(folders);
    case 'folders.counts':
      return delay({
        unifiedInboxUnread: folders.filter((f) => f.role === 'inbox').reduce((n, f) => n + f.unreadCount, 0),
        perFolder: folders.map((f) => ({ folderId: f.id, unread: f.unreadCount, total: f.totalCount })),
      });
    case 'folders.empty': {
      const f = folderOf(r!.folderId as number);
      if (f.role !== 'trash' && f.role !== 'junk') return err('INVALID_INPUT', 'Only Trash and Spam can be emptied.');
      const gone = messages.filter((m) => m.folderId === f.id).map((m) => m.id);
      for (const id of gone) messages.splice(messages.findIndex((m) => m.id === id), 1);
      setTimeout(() => changed({ removed: gone, folderIds: [f.id] }), 50);
      return delay({ deleted: gone.length }, 300);
    }
    case 'settings.get':
      return delay(settings);
    case 'settings.set':
      Object.assign(settings, r);
      setTimeout(() => emit({ type: 'settings:changed', settings: { ...settings }, oauth: oauthNow() }), 20);
      return delay(settings);
    case 'oauth.getSettings':
      return delay(oauthNow());
    case 'oauth.setSettings': {
      const m = (r as { microsoft?: { clientIdOverride: string; tenant: string } }).microsoft;
      return delay({ microsoft: { clientIdOverride: m?.clientIdOverride ?? '', builtInClientId: '00000000-0000-4000-8000-000000000000', effectiveClientId: m?.clientIdOverride || '00000000-0000-4000-8000-000000000000', tenant: m?.tenant ?? 'common' } });
    }
    case 'oauth.start': {
      const sessionId = `s${sessionSeq++}`;
      return delay({ sessionId, authUrl: `https://login.microsoftonline.example/authorize?session=${sessionId}` }, 200);
    }
    case 'oauth.complete': {
      const sessionId = (r as { sessionId: string }).sessionId;
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => {
          oauthWaits.delete(sessionId);
          resolve({ email: 'new.user@outlook.example', sessionId });
        }, 4000);
        oauthWaits.set(sessionId, {
          cancel: () => {
            clearTimeout(t);
            reject({ code: 'CANCELLED', message: 'Sign-in was cancelled.', retryable: false });
          },
        });
      });
    }
    case 'oauth.cancel':
      oauthWaits.get((r as { sessionId: string }).sessionId)?.cancel();
      oauthWaits.delete((r as { sessionId: string }).sessionId);
      return delay(undefined, 10);
    case 'oauth.reauthorize': {
      return new Promise((resolve) =>
        setTimeout(() => {
          const id = (r as { accountId: string }).accountId;
          const st = statuses.find((s) => s.accountId === id);
          if (st) Object.assign(st, { state: 'online', error: null });
          emit({ type: 'account:status', status: st! });
          resolve(undefined);
        }, 4000),
      );
    }
    case 'messages.list': {
      const scope = r!.scope as { kind: string; folderId?: number; accountId?: string };
      const cursor = r!.cursor as { date: number; id: number } | null;
      const limit = (r!.limit as number) ?? 50;
      let list = messages.filter(scopeFilter(scope));
      if (r!.unreadOnly) list = list.filter((m) => !m.seen);
      if (cursor) list = list.filter((m) => m.date < cursor.date || (m.date === cursor.date && m.id < cursor.id));
      const page = list.slice(0, limit);
      const more = list.length > limit;
      return delay({
        items: page,
        nextCursor: more ? { date: page[page.length - 1]!.date, id: page[page.length - 1]!.id } : null,
        canLoadOlderFromServer: false,
        total: cursor ? null : list.length,
      });
    }
    case 'messages.getHeaders':
      return delay(messages.filter((m) => (r!.messageIds as number[]).includes(m.id)));
    case 'messages.get': {
      const m = messages.find((x) => x.id === r!.messageId);
      if (!m) return err('NOT_FOUND', 'That message is gone.');
      const body: MessageBody = {
        id: m.id,
        header: m,
        bcc: [],
        replyTo: [],
        inReplyTo: null,
        references: null,
        senderImagesAllowed: allowed.has(m.from?.address.toLowerCase() ?? ''),
        html: fixtureBodies.has(m.id) ? fixtureBodies.get(m.id)!.html : m.id % 2 === 0 ? html(m.id) : null,
        text: fixtureBodies.has(m.id) ? fixtureBodies.get(m.id)!.text : m.id % 2 === 0 ? null : 'Hello,\n\nPlain text message with a link https://example.com/page and more.\n\nBye',
        attachments: m.hasAttachments
          ? [
              { id: m.id * 10, filename: 'budget-q4.pdf', contentType: 'application/pdf', size: 245760, contentId: null, inline: false },
              { id: m.id * 10 + 1, filename: 'setup.exe', contentType: 'application/octet-stream', size: 1800000, contentId: null, inline: false },
            ]
          : [],
        hasRemoteImages: fixtureBodies.has(m.id) ? false : m.id % 2 === 0,
        truncated: false,
      };
      return delay(body, 250);
    }
    case 'messages.apply': {
      const a = r!.action as { type: string; read?: boolean; flagged?: boolean; destFolderId?: number };
      const ids = r!.messageIds as number[];
      if (a.type === 'markRead' || a.type === 'flag') {
        for (const id of ids) {
          const m = messages.find((x) => x.id === id);
          if (m) {
            if (a.type === 'markRead') m.seen = !!a.read;
            else m.flagged = !!a.flagged;
          }
        }
        setTimeout(() => changed({ updated: ids, folderIds: [] }), 30);
        return delay({ succeeded: ids, failed: [] });
      }
      const moved: { id: number; folderId: number }[] = [];
      const removed: number[] = [];
      const touched = new Set<number>();
      for (const id of ids) {
        const m = messages.find((x) => x.id === id);
        if (!m) continue;
        const from = m.folderId;
        const f = folderOf(from);
        if (a.type === 'delete' && f.role === 'trash') {
          messages.splice(messages.indexOf(m), 1);
          removed.push(id);
          touched.add(from);
          continue;
        }
        const dest = destFor(a, m);
        if (dest === null || dest === from) continue;
        moved.push({ id, folderId: from });
        m.folderId = dest;
        touched.add(from);
        touched.add(dest);
      }
      let undoToken: string | undefined;
      if (moved.length > 0) {
        undoToken = `u${undoSeq++}`;
        undoStore.set(undoToken, moved);
        setTimeout(() => undoStore.delete(undoToken!), 60_000);
      }
      setTimeout(() => changed({ updated: moved.map((x) => x.id), removed, folderIds: [...touched] }), 60);
      return delay({ succeeded: [...moved.map((x) => x.id), ...removed], failed: [], ...(undoToken ? { undoToken } : {}) }, 150);
    }
    case 'messages.undo': {
      const token = (r as { undoToken: string }).undoToken;
      const moved = undoStore.get(token);
      if (!moved) return err('NOT_FOUND', 'Too late to undo.');
      undoStore.delete(token);
      const touched = new Set<number>();
      for (const x of moved) {
        const m = messages.find((y) => y.id === x.id);
        if (m) {
          touched.add(m.folderId);
          m.folderId = x.folderId;
          touched.add(x.folderId);
        }
      }
      setTimeout(() => changed({ updated: moved.map((x) => x.id), folderIds: [...touched] }), 60);
      return delay({ restored: moved.map((x) => x.id) }, 150);
    }
    case 'messages.markAllRead': {
      const scope = (r as { scope: { kind: string; folderId?: number; accountId?: string } }).scope;
      const list =
        scope.kind === 'account'
          ? messages.filter((m) => m.accountId === scope.accountId)
          : messages.filter(scopeFilter(scope));
      let n = 0;
      for (const m of list) {
        if (!m.seen) {
          m.seen = true;
          n++;
        }
      }
      setTimeout(() => changed({ updated: list.map((m) => m.id), folderIds: [] }), 60);
      return delay({ count: n }, 200);
    }
    case 'senders.allowImages': {
      const { address, allow } = r as { address: string; allow: boolean };
      if (allow) allowed.add(address.toLowerCase());
      else allowed.delete(address.toLowerCase());
      return delay(undefined, 50);
    }
    case 'senders.listAllowed':
      return delay([...allowed]);
    case 'search.local':
      return delay(searchLocal(String(r!.query), r!.accountId as string | undefined), 200);
    case 'search.server': {
      const q = String(r!.query);
      const inbox = folders.find((f) => f.role === 'inbox')!;
      const word = parseQuery(q).words[0] ?? 'found';
      const added: MessageHeader[] = [];
      for (let i = 0; i < 2; i++) {
        const m: MessageHeader = { ...messages[0]!, id: mid++, uid: mid, folderId: inbox.id, accountId: inbox.accountId, subject: `Older mail about ${word} (${i + 1})`, date: now - 400 * 86_400_000 - i * 3_600_000, seen: true };
        messages.push(m);
        added.push(m);
      }
      changed({ added: added.map((m) => m.id), folderIds: [inbox.id] });
      return delay({ added: added.length, items: added }, 900);
    }
    case 'compose.openWindow': {
      const url = `compose.html?fake=1#req=${encodeURIComponent(JSON.stringify(req))}`;
      window.open(url, '_blank', 'popup,width=760,height=720');
      return delay(undefined, 20);
    }
    case 'compose.prepare': {
      const p = r as { mode: string; sourceMessageId?: number; accountId?: string; draftId?: string; mailto?: string };
      if (p.draftId) {
        const d = drafts()[p.draftId];
        if (!d) return err('NOT_FOUND', 'This draft is no longer available.');
        return delay({ ...d, inReplyToMessageId: null, mode: 'new', attachments: LS.get<DraftAttachment[]>('att.' + p.draftId, []) } satisfies ComposeDraft);
      }
      const draftId = `d${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
      const src = p.sourceMessageId !== undefined ? messages.find((m) => m.id === p.sourceMessageId) : undefined;
      const account = accounts.find((a) => a.id === (src?.accountId ?? p.accountId)) ?? accounts[0]!;
      const base: ComposeDraft = { draftId, accountId: account.id, to: [], cc: [], bcc: [], subject: '', html: `<p><br></p>${sigHtml(account)}`, inReplyToMessageId: null, mode: 'new', attachments: [] };
      if (p.mailto) {
        const u = new URL(p.mailto);
        base.to = u.pathname ? [{ address: decodeURIComponent(u.pathname) }] : [];
        base.subject = u.searchParams.get('subject') ?? '';
        const list = (k: string): Address[] => (u.searchParams.get(k) ?? '').split(',').filter(Boolean).map((address) => ({ address }));
        base.cc = list('cc');
        base.bcc = list('bcc');
      }
      if (src && p.mode !== 'new') {
        base.mode = p.mode as ComposeDraft['mode'];
        base.inReplyToMessageId = src.id;
        const quote = p.mode === 'forward' ? `<div>---------- Forwarded message ----------</div>${quoteOf(src)}` : quoteOf(src);
        base.html = `<p><br></p>${sigHtml(account)}<br>${quote}`;
        if (p.mode === 'forward') {
          base.subject = `Fwd: ${src.subject}`;
          if (src.hasAttachments) base.attachments = [{ tokenId: `file:fwd${attSeq++}`, filename: 'budget-q4.pdf', size: 245760, contentType: 'application/pdf' }];
        } else {
          base.subject = /^re:/i.test(src.subject) ? src.subject : `Re: ${src.subject}`;
          base.to = src.from ? [src.from] : [];
          if (p.mode === 'replyAll') base.cc = [{ name: 'Marcus Webb', address: 'marcus@example.com' }, { address: 'priya@example.com' }, ...Array.from({ length: 6 }, (_, i): Address => ({ address: `team${i + 1}@example.com` }))];
        }
      }
      return delay(base, 200);
    }
    case 'compose.pickFiles': {
      const att: DraftAttachment = { tokenId: `file:p${attSeq++}`, filename: 'notes.txt', size: 2048, contentType: 'text/plain' };
      return delay({ attachments: [att] }, 200);
    }
    case 'compose.attachData': {
      const d = r as unknown as { filename: string; contentType: string; data: Uint8Array };
      return delay({ tokenId: `file:d${attSeq++}`, filename: d.filename, size: d.data.byteLength, contentType: d.contentType } satisfies DraftAttachment, 250);
    }
    case 'drafts.retrySave': {
      const id = (r as { messageId: number }).messageId;
      const m = messages.find((x) => x.id === id);
      // Rows are replaced, not mutated, like the real backend (list rows are memoized).
      const put = (patch: Partial<MessageHeader>): void => {
        const i = messages.findIndex((x) => x.id === id);
        messages[i] = { ...messages[i]!, ...patch };
        changed({ updated: [id], folderIds: [messages[i]!.folderId] });
      };
      if (m && m.draft && (m.draftSync === 'failed' || m.draftSync === 'queued')) {
        put({ draftSync: 'saving' });
        setTimeout(() => put({ draftSync: 'saved', localOnly: false }), 2500);
      }
      return delay(undefined, 30);
    }
    case 'compose.discard': {
      const d = drafts();
      delete d[(r as { draftId: string }).draftId];
      saveDrafts(d);
      return delay(undefined, 30);
    }
    case 'compose.saveDraft': {
      const q = r as unknown as SendReq;
      const d = drafts();
      d[q.draftId] = q;
      saveDrafts(d);
      return delay({ savedAt: Date.now() }, 100);
    }
    case 'compose.send': {
      const q = r as unknown as SendReq;
      if (q.to.length + q.cc.length + q.bcc.length === 0) return err('INVALID_INPUT', 'Add at least one recipient.');
      const d = drafts();
      d[q.draftId] = q;
      saveDrafts(d);
      const list = readOutbox();
      const id = (list.reduce((n, x) => Math.max(n, x.id), 0) || 0) + 1;
      const sendAt = Date.now() + settings.undoSendDelayMs;
      list.push({ id, accountId: q.accountId, subject: q.subject, state: 'queued', lastError: null, sendAt, attempts: 0, req: q });
      writeOutbox(list);
      emit({ type: 'outbox:changed' });
      if (!isComposeWindow && !isViewerWindow) armOutbox();
      return delay({ outboxId: id, state: 'queued', sendAt }, 100);
    }
    case 'outbox.list':
      return delay(readOutbox().map(({ req: _req, ...it }) => it), 30);
    case 'outbox.retry': {
      const list = readOutbox();
      const it = list.find((x) => x.id === (r as { outboxId: number }).outboxId);
      if (it) Object.assign(it, { state: 'queued', lastError: null, sendAt: Date.now() });
      writeOutbox(list);
      emit({ type: 'outbox:changed' });
      return delay(undefined, 30);
    }
    case 'outbox.cancel': {
      const list = readOutbox();
      const it = list.find((x) => x.id === (r as { outboxId: number }).outboxId);
      if (!it) return err('NOT_FOUND', 'That message is no longer in the outbox.');
      if (it.state === 'sending') return err('CANCELLED', 'The message is already being sent.');
      const t = timers.get(it.id);
      if (t) clearTimeout(t);
      timers.delete(it.id);
      writeOutbox(list.filter((x) => x.id !== it.id));
      emit({ type: 'outbox:changed' });
      return delay({ draftId: it.req.draftId }, 30);
    }
    case 'attachments.cidData':
      return delay(null, 10);
    case 'system.networkChanged': {
      // Dev behavior of the offline queue: going offline queues 3 changes for Personal Gmail,
      // coming back online sends them and one is refused for good (the change is undone).
      const online = (r as { online: boolean }).online;
      const st = statuses[0]!;
      if (!online) {
        st.state = 'offline';
        st.pendingCount = 3;
      } else {
        const had = st.pendingCount > 0;
        st.state = 'online';
        st.pendingCount = 0;
        if (had) {
          const mine = messages.filter((m) => m.accountId === 'a1' && folderOf(m.folderId).role === 'inbox').slice(0, 1);
          setTimeout(() => {
            emit({ type: 'action:failed', messageIds: mine.map((m) => m.id), error: { code: 'SERVER_REJECTED', message: 'The folder was removed on the server.', retryable: false }, accountId: 'a1', kind: 'delete' });
          }, 600);
        }
      }
      emit({ type: 'account:status', status: { ...st } });
      emit({ type: 'pending:count', accountId: 'a1', count: st.pendingCount });
      return delay(undefined, 10);
    }
    case 'sync.all':
    case 'sync.account':
    case 'sync.folder':
    case 'log.write':
    case 'app.openExternal':
      return delay(undefined, 10);
    case 'message.openWindow': {
      window.open(`viewer.html?fake=1#msg=${(r as { messageId: number }).messageId}`, '_blank', 'popup,width=860,height=720');
      return delay(undefined, 20);
    }
    case 'message.print': {
      (window as unknown as { __lastPrint?: unknown }).__lastPrint = r;
      return delay({ printed: true }, 400);
    }
    case 'contacts.suggest': {
      const q = r as { query: string; limit?: number; accountId?: string };
      return delay(suggest(q.query, q.limit ?? 8, q.accountId), 40);
    }
    case 'contacts.forget': {
      const addr = (r as { address: string }).address.toLowerCase();
      const at = contactBook.findIndex((c) => c.address.toLowerCase() === addr);
      if (at >= 0) contactBook.splice(at, 1);
      return delay(undefined, 20);
    }
    case 'app.mailtoStatus':
      return delay({ registered: true, isDefault: LS.get<boolean | null>('mailtoDefault', false) ?? undefined }, 60);
    case 'app.openDefaultAppsSettings':
      // Dev: pretend the user picked Mailroom in Windows Settings.
      LS.set('mailtoDefault', true);
      return delay(undefined, 20);
    case 'updates.status':
    case 'updates.check':
      return delay({ state: 'unavailable', currentVersion: '0.1.0-fake', reason: 'dev-build' }, 60);
    case 'sync.loadOlder':
      return delay({ fetched: 0, reachedStart: true }, 10);
    case 'images.cacheInfo':
      return delay({ bytes: 12 * 1024 * 1024, files: 48 });
    case 'images.clearCache':
      return delay({ freed: 12 * 1024 * 1024 });
    case 'app.info':
      return delay({ version: '0.1.0-fake', dbPath: 'C:\\fake\\mailroom.db', electron: '0' });
    default:
      return Promise.reject({ code: 'UNSUPPORTED', message: `${channel} is not available in the fake API.`, retryable: false });
  }
}

export function installFakeApi(): void {
  const api: PreloadApi = {
    invoke: ((channel: IpcChannel, req?: unknown) => handle(channel, req)) as PreloadApi['invoke'],
    on(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
  (window as unknown as { api: PreloadApi }).api = api;
  if (!isComposeWindow && !isViewerWindow) armOutbox();
  // Dev hook: push any event into every fake window, e.g. __fakeEmit({ type: 'pending:count', accountId: 'a1', count: 2 }).
  (window as unknown as { __fakeEmit: (e: AppEvent) => void }).__fakeEmit = emit;
}
