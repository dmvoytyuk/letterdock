// Development only: a fake window.api so the UI can be viewed in a plain browser
// (http://localhost:5173/?fake=1). Never included in production builds.
// It mimics the M2/M3 backend behaviour: moved messages keep their id and arrive in
// `messages:changed.updated`, sends always queue, undo tokens, search, OAuth waiting, outbox.
import type {
  Account,
  AccountStatus,
  ConversationRow,
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
  Rule,
  RuleActivityItem,
  ScheduledItem,
  SendReq,
  UpdateStatus,
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
// ---------- conversations: a few real threads (DESIGN-SPEC 3.10) ----------
// A thread across Inbox, Sent, Archive and a draft; one whose newest message is mine; one with 3 mails.
function addMsg(accountId: string, role: string, o: Partial<MessageHeader> & { subject: string; minutesAgo: number }): void {
  const f = roleFolder(accountId, role);
  const { minutesAgo, ...rest } = o;
  messages.push({
    id: mid,
    accountId,
    folderId: f.id,
    uid: mid,
    messageIdHeader: `<th${mid}@x>`,
    from: { name: 'Jane Cooper', address: 'jane@example.com' },
    to: [{ address: accounts.find((a) => a.id === accountId)!.email }],
    cc: [],
    date: now - minutesAgo * 60_000,
    snippet: 'Thanks, I will send it on Friday. Let me know if anything changes before then...',
    seen: true,
    flagged: false,
    answered: false,
    draft: role === 'drafts',
    hasAttachments: false,
    size: 3000,
    bodyCached: true,
    ...rest,
  });
  mid++;
}
{
  const me = (id: string) => ({ name: 'Alex Rivera', address: accounts.find((a) => a.id === id)!.email });
  const t1 = 'Planning the autumn offsite';
  addMsg('a1', 'inbox', { subject: t1, minutesAgo: 60 * 24 * 5, snippet: 'Hi Alex, can we pick a date for the offsite? I think the second week of November works.' });
  addMsg('a1', 'sent', { subject: `Re: ${t1}`, minutesAgo: 60 * 24 * 4, from: me('a1'), to: [{ name: 'Jane Cooper', address: 'jane@example.com' }], snippet: 'Second week of November is fine for me. I will check the venue.' });
  addMsg('a1', 'inbox', { subject: `Re: ${t1}`, minutesAgo: 60 * 24 * 2, from: { name: 'Marcus Webb', address: 'marcus@example.com' }, seen: false, hasAttachments: true, snippet: 'I looked at the venue. Attached is the quote. It is a bit above budget.' });
  addMsg('a1', 'archive', { subject: `Re: ${t1}`, minutesAgo: 60 * 24, flagged: true, snippet: 'Let us keep the quote on file. Priya will compare two other venues.' });
  addMsg('a1', 'inbox', { subject: `Re: ${t1}`, minutesAgo: 190, seen: false, snippet: 'Great, so Thursday the 12th it is. I will send the invitation to everyone today.' });
  addMsg('a1', 'drafts', { subject: `Re: ${t1}`, minutesAgo: 30, from: me('a1'), to: [{ name: 'Jane Cooper', address: 'jane@example.com' }], snippet: 'Sounds good. One more thing about the', seen: true });
  const t2 = 'Invoice question';
  addMsg('a1', 'inbox', { subject: t2, minutesAgo: 400, from: { name: 'Priya Nair', address: 'priya@example.com' }, snippet: 'Could you confirm the invoice number for the October order?' });
  addMsg('a1', 'sent', { subject: `Re: ${t2}`, minutesAgo: 120, from: me('a1'), to: [{ name: 'Priya Nair', address: 'priya@example.com' }], snippet: 'It is INV-2041. I attached a copy to this message.', hasAttachments: true });
  const t3 = 'Q4 roadmap sign-off';
  addMsg('a2', 'inbox', { subject: t3, minutesAgo: 60 * 30, from: { name: 'Tom Ellery', address: 'tom@example.com' }, seen: false, snippet: 'Please sign off the Q4 roadmap by Wednesday.' });
  addMsg('a2', 'inbox', { subject: `Re: ${t3}`, minutesAgo: 60 * 20, from: { name: 'Sofia Marchetti', address: 'sofia@example.com' }, seen: false, snippet: 'I added the tooling items. Please check the second page.' });
  addMsg('a2', 'inbox', { subject: `Fwd: ${t3}`, minutesAgo: 60 * 6, from: { name: 'Tom Ellery', address: 'tom@example.com' }, seen: false, snippet: 'Forwarding the final version to the whole team.' });
}

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
  groupConversations: false,
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

let updateStatus: UpdateStatus = { state: 'unavailable', currentVersion: '0.1.0-fake', reason: 'dev-build' };

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
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('letterdock-fake') : null;
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

// Settings survive a reload of the fake page, so a state can be set up once.
Object.assign(settings, LS.get<Partial<AppSettings>>('settings', {}));

interface StoredOutbox extends OutboxItem {
  req: SendReq;
}
const readOutbox = (): StoredOutbox[] => LS.get<StoredOutbox[]>('outbox', []);
const writeOutbox = (l: StoredOutbox[]) => LS.set('outbox', l);
const drafts = (): Record<string, SendReq> => LS.get('drafts', {});
const saveDrafts = (d: Record<string, SendReq>) => LS.set('drafts', d);

// ---------- rules (simple fake; they never run on the fake mail) ----------
const readRules = (): Rule[] => LS.get<Rule[]>('rules', []);
const writeRules = (l: Rule[]) => LS.set('rules', l.map((r, i) => ({ ...r, position: i + 1 })));
const readActivity = (): RuleActivityItem[] => LS.get<RuleActivityItem[]>('rulesActivity', []);

// ---------- send later (kept in localStorage so the compose window and the main window share it) ----------
interface FakeScheduled extends ScheduledItem {
  req: SendReq;
}
/** One of each state of the Scheduled view (DESIGN-SPEC 3.11), made once. Clear `fake.scheduled` in localStorage to make them again. */
function seedScheduled(): FakeScheduled[] {
  const t = Date.now();
  const H = 3_600_000;
  const day = (n: number, hour: number) => {
    const d = new Date(t);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, hour, 0).getTime();
  };
  const make = (
    id: number,
    accountId: string,
    subject: string,
    to: Address[],
    sendAt: number,
    extra: Partial<ScheduledItem> = {},
    text = 'Hi, here is the text I wrote earlier. It is sent by Letterdock at the time you chose.',
  ): FakeScheduled => {
    const req: SendReq = { draftId: `sch-draft-${id}`, accountId, to, cc: [], bcc: [], subject, html: `<p>${text}</p>`, attachmentTokens: extra.hasAttachments ? ['tok'] : [] };
    return { id, accountId, draftId: req.draftId, subject, to, cc: [], snippet: text, hasAttachments: false, sendAt, createdAt: t - H, status: 'scheduled', waiting: null, lastError: null, attempt: 0, overdueMs: 0, ...extra, req };
  };
  const jane = [{ name: 'Jane Cooper', address: 'jane@example.com' }];
  const evening = day(0, 18) > t + 2 * H ? day(0, 18) : t + 3 * H;
  return [
    make(101, 'a1', 'Offsite venue shortlist', jane, evening, { hasAttachments: true }),
    make(102, 'a1', 'Happy birthday, Marcus!', [{ name: 'Marcus Webb', address: 'marcus@example.com' }], day(1, 8)),
    make(103, 'a1', 'Contract draft v2', [{ name: 'Priya Nair', address: 'priya@example.com' }], t - 20_000, { status: 'sending' }),
    make(104, 'a1', 'Parking permit', [{ address: 'office@example.com' }], t - 90_000, { waiting: 'offline' }),
    make(105, 'a2', 'Q4 numbers for Tom', [{ name: 'Tom Ellery', address: 'tom@example.com' }, { address: 'finance@example.com' }], t - 120_000, { waiting: 'signIn' }),
    make(106, 'a2', 'See you at 9 tomorrow', [{ name: 'Sofia Marchetti', address: 'sofia@example.com' }], t - 3 * 86_400_000, { status: 'held', overdueMs: 3 * 86_400_000 }),
    make(107, 'a3', 'Weekly report', [{ name: 'Atlas Cloud Billing', address: 'billing@example.com' }], day(6, 9)),
    make(108, 'a3', 'Photos from the weekend', jane, t - 40 * 60_000, { status: 'failed', lastError: 'One of the attachments is no longer on this PC.', hasAttachments: true }),
  ];
}
const readScheduled = (): FakeScheduled[] => {
  const stored = LS.get<FakeScheduled[] | null>('scheduled', null);
  if (stored) return stored;
  const seeded = seedScheduled();
  LS.set('scheduled', seeded);
  return seeded;
};
const writeScheduled = (l: FakeScheduled[]) => LS.set('scheduled', l);
const strip = ({ req: _req, ...item }: FakeScheduled): ScheduledItem => ({ ...item, overdueMs: Math.max(0, Date.now() - item.sendAt) });

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

// ---------- conversations (simple fake: same account + same subject without Re:/Fwd:) ----------
const plainSubject = (s: string) => s.replace(/^\s*((re|fwd?|aw|sv)\s*:\s*)+/i, '').trim();
const threadOfFake = (m: MessageHeader) => `fake:${m.accountId}:${plainSubject(m.subject).toLowerCase()}`;
for (const m of messages) m.threadId = threadOfFake(m);
function fakeConversationRows(scope: { kind: string; folderId?: number; accountId?: string }, unreadOnly: boolean): ConversationRow[] {
  const inScope = scopeFilter(scope);
  const own = new Set(accounts.map((a) => a.email.toLowerCase()));
  const member = new Set(messages.filter((m) => inScope(m) && (!unreadOnly || !m.seen)).map(threadOfFake));
  const byThread = new Map<string, MessageHeader[]>();
  for (const m of messages) {
    const key = threadOfFake(m);
    if (!member.has(key)) continue;
    const role = folderOf(m.folderId).role;
    const included = scope.kind === 'folder' && folderOf(scope.folderId!).role !== 'inbox' ? m.folderId === scope.folderId : role === 'inbox' || role === 'sent' || role === 'archive';
    if (!included) continue;
    byThread.set(key, [...(byThread.get(key) ?? []), m]);
  }
  const rows: ConversationRow[] = [];
  for (const [threadId, list] of byThread) {
    list.sort((a, b) => a.date - b.date || a.id - b.id);
    const latest = list[list.length - 1]!;
    rows.push({
      threadId,
      accountId: latest.accountId,
      count: list.length,
      unreadCount: list.filter((m) => !m.seen).length,
      hasFlag: list.some((m) => m.flagged),
      hasAttachment: list.some((m) => m.hasAttachments),
      participants: [...new Map([...list].reverse().map((m) => [m.from?.address ?? '?', { name: m.from?.name ?? null, address: m.from?.address ?? '?', isMe: own.has((m.from?.address ?? '').toLowerCase()), hasUnread: list.some((x) => x.from?.address === m.from?.address && !x.seen) }])).values()],
      latest: { id: latest.id, subject: latest.subject, title: plainSubject(latest.subject), snippet: latest.snippet, date: latest.date, fromMe: own.has((latest.from?.address ?? '').toLowerCase()), from: latest.from },
      folderMessageIds: list.filter(inScope).map((m) => m.id),
      messageIds: list.map((m) => m.id),
    });
  }
  return rows.sort((a, b) => b.latest.date - a.latest.date || b.latest.id - a.latest.id);
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
  return `<div class="letterdock-quote-intro">On ${new Date(m.date).toLocaleString()}, ${who} wrote:</div><blockquote class="letterdock-quote" type="cite" style="margin:0 0 0 .8ex;border-left:2px solid #c8c8c8;padding-left:1ex">${m.snippet}</blockquote>`;
}
const sigHtml = (a: Account) =>
  a.signature ? `<div class="letterdock-signature">-- <br>${a.signature.replace(/\n/g, '<br>')}</div>` : '';

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
      LS.set('settings', settings);
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
    case 'conversations.list': {
      const rows = fakeConversationRows(r!.scope as never, !!r!.unreadOnly);
      const cursor = r!.cursor as { date: number; id: number } | null;
      const limit = (r!.limit as number) ?? 50;
      const after = cursor ? rows.filter((x) => x.latest.date < cursor.date || (x.latest.date === cursor.date && x.latest.id < cursor.id)) : rows;
      const page = after.slice(0, limit);
      const more = after.length > limit;
      return delay({
        items: page,
        nextCursor: more ? { date: page[page.length - 1]!.latest.date, id: page[page.length - 1]!.latest.id } : null,
        canLoadOlderFromServer: false,
        total: cursor ? null : rows.length,
      });
    }
    case 'conversations.get': {
      const sc = r!.scope as { kind: string; folderId?: number } | undefined;
      const folderOnly = !!sc && sc.kind === 'folder' && folderOf(sc.folderId!).role !== 'inbox';
      const includes = (m: MessageHeader) => {
        const role = folderOf(m.folderId).role;
        if (folderOnly) return m.folderId === sc!.folderId;
        return role === 'inbox' || role === 'sent' || role === 'archive' || role === 'drafts';
      };
      const list = messages.filter((m) => threadOfFake(m) === r!.threadId && includes(m)).sort((a, b) => a.date - b.date || a.id - b.id);
      if (list.length === 0) return err('NOT_FOUND', 'This conversation was moved or deleted.');
      const inScope = r!.scope ? scopeFilter(r!.scope as never) : () => false;
      const own = new Set(accounts.map((a) => a.email.toLowerCase()));
      return delay({
        threadId: r!.threadId,
        accountId: r!.accountId,
        title: plainSubject(list[list.length - 1]!.subject),
        count: list.filter((m) => !m.draft).length,
        messages: list.map((m) => ({ header: m, folderId: m.folderId, folderRole: folderOf(m.folderId).role, folderName: folderOf(m.folderId).name, inCurrentFolder: inScope(m), isDraft: m.draft, fromMe: own.has((m.from?.address ?? '').toLowerCase()) })),
      });
    }
    case 'conversations.act': {
      const inScope = scopeFilter(r!.scope as never);
      const ids: number[] = [];
      for (const t of r!.threadIds as string[]) {
        const list = messages.filter((m) => threadOfFake(m) === t && inScope(m)).sort((a, b) => a.date - b.date || a.id - b.id);
        const a = r!.action as { type: string; read?: boolean; flagged?: boolean };
        if (a.type === 'markRead') ids.push(...(a.read ? list.filter((m) => !m.seen) : list.slice(-1)).map((m) => m.id));
        else if (a.type === 'flag') ids.push(...(a.flagged ? list.slice(-1) : list.filter((m) => m.flagged)).map((m) => m.id));
        else ids.push(...list.map((m) => m.id));
      }
      return handle('messages.apply', { messageIds: ids, action: r!.action }).then((res) => ({ ...(res as object), threadCount: (r!.threadIds as string[]).length, messageCount: ids.length }));
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
    case 'rules.list':
      return delay(readRules(), 80);
    case 'rules.create': {
      const list = readRules();
      if (list.length >= 50) return err('INVALID_INPUT', 'You have 50 rules. Delete one to add another.');
      const q = r as unknown as Rule;
      const rule: Rule = { ...q, id: q.id ?? Date.now() % 1_000_000_000, position: list.length + 1, createdAt: Date.now(), warning: null };
      const at = Math.min(Math.max((r!.position as number | undefined) ?? list.length + 1, 1), list.length + 1) - 1;
      list.splice(at, 0, rule);
      writeRules(list);
      emit({ type: 'rules:changed' });
      return delay(readRules()[at], 80);
    }
    case 'rules.update': {
      const list = readRules();
      const i = list.findIndex((x) => x.id === r!.id);
      if (i < 0) return err('NOT_FOUND', 'That rule is no longer there.');
      const patch = r!.patch as Partial<Rule>;
      list[i] = { ...list[i]!, ...patch, actions: { ...list[i]!.actions, ...(patch.actions ?? {}) }, warning: null };
      writeRules(list);
      emit({ type: 'rules:changed' });
      return delay(readRules()[i], 80);
    }
    case 'rules.delete': {
      const list = readRules();
      const rule = list.find((x) => x.id === r!.id);
      if (!rule) return err('NOT_FOUND', 'That rule is no longer there.');
      writeRules(list.filter((x) => x.id !== rule.id));
      emit({ type: 'rules:changed' });
      return delay(rule, 80);
    }
    case 'rules.reorder': {
      const list = readRules();
      const ids = r!.ids as number[];
      writeRules(ids.map((id) => list.find((x) => x.id === id)).filter((x): x is Rule => !!x));
      emit({ type: 'rules:changed' });
      return delay(readRules(), 80);
    }
    case 'rules.countMatches':
      return delay({ matches: 12, total: 248 }, 200);
    case 'rules.runNow': {
      const runId = r!.runId as string;
      const progress = (done: number, state: 'running' | 'finished'): AppEvent => ({ type: 'rules:progress', runId, state, done, total: 248, matched: Math.round(done / 20), moved: Math.round(done / 20), trashed: 0, markedRead: 0, flagged: 0, activityIds: [] });
      [0, 100, 200, 248].forEach((done, i) => setTimeout(() => emit(progress(done, done === 248 ? 'finished' : 'running')), 300 * (i + 1)));
      return delay({ runId }, 50);
    }
    case 'rules.cancelRun':
      return delay(undefined, 30);
    case 'rulesActivity.list':
      return delay(readActivity(), 80);
    case 'rulesActivity.undo':
      return err('INVALID_INPUT', "Can't undo. The message was changed since.");
    case 'rulesActivity.clear':
      LS.set('rulesActivity', []);
      emit({ type: 'rulesActivity:changed' });
      return delay(undefined, 40);
    case 'scheduled.create': {
      const q = r as unknown as { draftId: string; sendAt: number; draft?: SendReq };
      const req = q.draft ?? drafts()[q.draftId];
      if (!req) return err('NOT_FOUND', 'This draft is no longer available.');
      const list = readScheduled();
      if (list.length >= 100) return err('INVALID_INPUT', 'You have 100 scheduled messages. Send or cancel some first.');
      if (q.sendAt <= Date.now()) return err('INVALID_INPUT', 'Pick a time in the future.');
      const item: FakeScheduled = { id: Date.now() % 1_000_000_000, accountId: req.accountId, draftId: req.draftId, subject: req.subject, to: req.to, cc: req.cc, snippet: req.html.replace(/<[^>]+>/g, ' ').trim().slice(0, 120), hasAttachments: req.attachmentTokens.length > 0, sendAt: q.sendAt, createdAt: Date.now(), status: 'scheduled', waiting: null, lastError: null, attempt: 0, overdueMs: 0, req };
      writeScheduled([...list, item]);
      const d = drafts();
      delete d[req.draftId];
      saveDrafts(d);
      emit({ type: 'scheduled:changed' });
      return delay(strip(item), 100);
    }
    case 'scheduled.reschedule': {
      const list = readScheduled();
      const it = list.find((x) => x.id === r!.id);
      if (!it) return err('NOT_FOUND', 'That scheduled message is no longer there.');
      it.sendAt = r!.sendAt as number;
      it.status = 'scheduled';
      writeScheduled(list);
      emit({ type: 'scheduled:changed' });
      return delay(strip(it), 80);
    }
    case 'scheduled.sendNow': {
      const list = readScheduled();
      const it = list.find((x) => x.id === r!.id);
      if (!it) return err('NOT_FOUND', 'That scheduled message is no longer there.');
      it.status = 'sending';
      it.waiting = null;
      writeScheduled(list);
      emit({ type: 'scheduled:changed' });
      // On its way, then gone (it is in Sent then).
      setTimeout(() => {
        writeScheduled(readScheduled().filter((x) => x.id !== it.id));
        emit({ type: 'scheduled:changed' });
      }, 1800);
      return delay(strip(it), 80);
    }
    case 'scheduled.cancel': {
      const list = readScheduled();
      const it = list.find((x) => x.id === r!.id);
      if (!it) return err('NOT_FOUND', 'That scheduled message is no longer there.');
      writeScheduled(list.filter((x) => x.id !== it.id));
      const d = drafts();
      d[it.req.draftId] = it.req;
      saveDrafts(d);
      emit({ type: 'scheduled:changed' });
      return delay({ draftId: it.req.draftId, sendAt: it.sendAt }, 80);
    }
    case 'scheduled.delete': {
      writeScheduled(readScheduled().filter((x) => x.id !== r!.id));
      emit({ type: 'scheduled:changed' });
      return delay(undefined, 60);
    }
    case 'scheduled.list':
      return delay(readScheduled().filter((x) => !r?.accountId || x.accountId === r.accountId).sort((a, b) => a.sendAt - b.sendAt).map(strip), 80);
    case 'scheduled.get': {
      const it = readScheduled().find((x) => x.id === r!.id);
      if (!it) return err('NOT_FOUND', 'That scheduled message is no longer there.');
      return delay({ item: strip(it), html: it.req.html, bcc: it.req.bcc, attachments: [] }, 80);
    }
    case 'scheduled.count': {
      const list = readScheduled();
      const held = list.filter((x) => x.status === 'held' || x.status === 'failed').length;
      const next = list.filter((x) => x.status === 'scheduled').map((x) => x.sendAt).sort((a, b) => a - b)[0] ?? null;
      const per = new Map<string, { total: number; scheduled: number; held: number }>();
      for (const x of list) {
        const p = per.get(x.accountId) ?? { total: 0, scheduled: 0, held: 0 };
        p.total++;
        if (x.status === 'held' || x.status === 'failed') p.held++;
        else p.scheduled++;
        per.set(x.accountId, p);
      }
      return delay({ total: list.length, scheduled: list.length - held, held, nextSendAt: next, perAccount: [...per].map(([accountId, v]) => ({ accountId, ...v })) }, 60);
    }
    case 'scheduled.nextDue': {
      const due = readScheduled().filter((x) => x.status === 'scheduled' && x.sendAt <= Date.now() + 86_400_000);
      return delay({ count: due.length, nextSendAt: due.map((x) => x.sendAt).sort((a, b) => a - b)[0] ?? null }, 60);
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
      // Dev: pretend the user picked Letterdock in Windows Settings.
      LS.set('mailtoDefault', true);
      return delay(undefined, 20);
    case 'updates.status':
    case 'updates.check':
      return delay(updateStatus, 60);
    case 'updates.install':
      return delay(undefined, 200);
    case 'sync.loadOlder':
      return delay({ fetched: 0, reachedStart: true }, 10);
    case 'images.cacheInfo':
      return delay({ bytes: 12 * 1024 * 1024, files: 48 });
    case 'images.clearCache':
      return delay({ freed: 12 * 1024 * 1024 });
    case 'app.info':
      return delay({ version: '0.1.0-fake', dbPath: 'C:\\fake\\letterdock.db', electron: '0' });
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
  // Dev hook for the status bar (DESIGN-SPEC 4.8): __fakeScenario('syncing'), or ?fake=1&scenario=syncing.
  (window as unknown as { __fakeScenario: (name: string) => void }).__fakeScenario = runScenario;
  const wanted = new URLSearchParams(location.search).get('scenario');
  if (wanted && !isComposeWindow && !isViewerWindow) {
    // Mutate before the first read, and again once the window listens for events.
    runScenario(wanted);
    setTimeout(() => runScenario(wanted), 900);
  }
}

// ---------- status bar scenarios (dev only) ----------
const SCENARIOS = [
  'upToDate', 'upToDateOne', 'syncing', 'syncingUnknown', 'syncingMany', 'error', 'errorMany', 'signIn', 'signInOne',
  'offline', 'online', 'pending', 'outboxSending', 'outboxQueued', 'outboxFailed', 'updateDownloading', 'updateReady',
  'updateIdle', 'reset',
];

function setStatus(id: string, patch: Partial<AccountStatus>): void {
  const st = statuses.find((x) => x.accountId === id);
  if (!st) return;
  Object.assign(st, patch);
  emit({ type: 'account:status', status: { ...st } });
}

function putOutbox(state: OutboxItem['state']): void {
  const accountId = 'a1';
  const req = { draftId: 'dev-scenario', accountId, to: [], cc: [], bcc: [], subject: 'x', html: '', attachments: [] } as unknown as SendReq;
  const item: StoredOutbox = {
    id: 1,
    accountId,
    subject: state === 'failed' ? 'Quarterly budget review (fail)' : 'Quarterly budget review',
    state,
    lastError: state === 'failed' ? 'The server refused the connection (fake).' : null,
    sendAt: Date.now() + (state === 'queued' ? 10 * 60_000 : 0),
    attempts: state === 'queued' ? 1 : state === 'failed' ? 1 : 0,
    req,
  };
  writeOutbox([item]);
  emit({ type: 'outbox:changed' });
}

function runScenario(name: string): void {
  if (!SCENARIOS.includes(name)) {
    console.warn(`Unknown scenario "${name}". Use one of: ${SCENARIOS.join(', ')}`);
    return;
  }
  const calm = (): void => {
    for (const a of ['a1', 'a2', 'a3']) setStatus(a, { state: 'online', error: null, nextRetryAt: null, lastSyncAt: Date.now() - 5 * 60_000, pendingCount: 0 });
    for (const a of ['a1', 'a2', 'a3']) emit({ type: 'sync:progress', accountId: a, folderId: null, phase: 'idle', done: 0, total: null });
    window.dispatchEvent(new Event('online'));
  };
  const setUpdate = (st: UpdateStatus): void => {
    updateStatus = st;
    emit({ type: 'update:status', status: st });
  };
  const only = (ids: string[]): void => {
    // The sidebar and the bar look at the accounts that are enabled.
    accounts.forEach((a) => (a.enabled = ids.includes(a.id)));
    emit({ type: 'accounts:changed' });
  };
  // Outbox and update scenarios are overlays: they keep whatever the sync state is.
  const overlay = name.startsWith('outbox') || name.startsWith('update');
  if (!overlay && name !== 'signIn' && name !== 'signInOne') calm();
  if (!overlay && name !== 'upToDateOne') only(['a1', 'a2', 'a3']);
  switch (name) {
    case 'reset':
      writeOutbox([]);
      emit({ type: 'outbox:changed' });
      setUpdate({ state: 'unavailable', currentVersion: '0.1.0-fake', reason: 'dev-build' });
      break;
    case 'upToDateOne':
      only(['a1']);
      break;
    case 'syncing':
      setStatus('a1', { state: 'syncing' });
      emit({ type: 'sync:progress', accountId: 'a1', folderId: 1, phase: 'initial', done: 120, total: 500 });
      break;
    case 'syncingUnknown':
      setStatus('a1', { state: 'syncing' });
      break;
    case 'syncingMany':
      setStatus('a1', { state: 'syncing' });
      setStatus('a2', { state: 'connecting' });
      setStatus('a3', { state: 'syncing' });
      break;
    case 'error':
      setStatus('a3', { state: 'retrying', nextRetryAt: Date.now() + 60_000, error: { code: 'HOST_UNREACHABLE', message: "Can't reach the server.", retryable: true } });
      break;
    case 'errorMany':
      for (const a of ['a1', 'a2', 'a3']) setStatus(a, { state: 'retrying', nextRetryAt: Date.now() + 60_000, error: { code: 'HOST_UNREACHABLE', message: "Can't reach the server.", retryable: true } });
      break;
    case 'signIn':
      setStatus('a2', { state: 'needs_reauth', error: { code: 'OAUTH_REAUTH_REQUIRED', message: 'Sign in again.', retryable: false } });
      setStatus('a3', { state: 'auth_failed', error: { code: 'AUTH_FAILED', message: 'The server rejected the password.', retryable: false } });
      break;
    case 'signInOne':
      setStatus('a1', { state: 'online', error: null });
      setStatus('a3', { state: 'online', error: null });
      setStatus('a2', { state: 'needs_reauth', error: { code: 'OAUTH_REAUTH_REQUIRED', message: 'Sign in again.', retryable: false } });
      break;
    case 'offline':
      window.dispatchEvent(new Event('offline'));
      break;
    case 'pending':
      setStatus('a1', { pendingCount: 3 });
      emit({ type: 'pending:count', accountId: 'a1', count: 3 });
      break;
    case 'outboxSending':
      putOutbox('sending');
      break;
    case 'outboxQueued':
      putOutbox('queued');
      break;
    case 'outboxFailed':
      putOutbox('failed');
      break;
    case 'updateDownloading':
      setUpdate({ state: 'downloading', currentVersion: '0.2.6', newVersion: '0.2.7', percent: 42 });
      break;
    case 'updateReady':
      setUpdate({ state: 'ready', currentVersion: '0.2.6', newVersion: '0.2.7' });
      break;
    case 'updateIdle':
      setUpdate({ state: 'upToDate', currentVersion: '0.2.6', checkedAt: Date.now() });
      break;
    default:
      break;
  }
}
