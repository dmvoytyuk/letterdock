// Development only: the "demo" data set for the fake backend (http://localhost:5173/?fake=1&scenario=demo).
// It is used by scripts/make-site-screenshots.mjs for the website and README pictures.
// EVERYTHING here is invented: people, brands and addresses (example.com / example.org / example.net).
// Do not put real names, real companies or real logos in this file.
import type {
  Account,
  AccountStatus,
  Address,
  AppSettings,
  Folder,
  FolderRole,
  MessageHeader,
  Rule,
  RuleActivityItem,
  ScheduledItem,
  SendReq,
} from '../../../shared/ipc';

export interface DemoBody {
  html?: string | null;
  text?: string | null;
  /** The mail has pictures from the internet (the "Images are blocked" banner shows). */
  remoteImages?: boolean;
  attachments?: { filename: string; contentType: string; size: number }[];
}
export interface DemoContact {
  address: string;
  name: string | null;
  sentCount: number;
  lastUsed: number;
  isOwn: boolean;
  acc?: string;
}
export interface DemoScheduled extends ScheduledItem {
  req: SendReq;
}
export interface Demo {
  accounts: Account[];
  folders: Folder[];
  messages: MessageHeader[];
  bodies: Map<number, DemoBody>;
  statuses: AccountStatus[];
  contacts: DemoContact[];
  rules: Rule[];
  activity: RuleActivityItem[];
  scheduled: DemoScheduled[];
  settings: Partial<AppSettings>;
  nextMessageId: number;
  nextFolderId: number;
}

const MIN = 60_000;
const DAY = 86_400_000;
const svgUri = (svg: string): string => 'data:image/svg+xml;base64,' + btoa(svg);

// ---------- flat pictures for the newsletters (no photos, no logos) ----------
const sunriseSvg = svgUri(`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="220" viewBox="0 0 600 220">
<defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FDE7C8"/><stop offset="1" stop-color="#F6B99A"/></linearGradient></defs>
<rect width="600" height="220" fill="url(#s)"/>
<circle cx="440" cy="110" r="52" fill="#FFF4D6"/>
<path d="M0 170 Q120 100 240 160 T480 150 T600 140 V220 H0Z" fill="#8CC5A0"/>
<path d="M0 195 Q150 140 300 190 T600 180 V220 H0Z" fill="#4E9F77"/>
<path d="M70 70 c30 -40 70 -40 70 -5 s-40 45 -70 5z" fill="none" stroke="#4B3FD6" stroke-width="7" stroke-linecap="round"/>
</svg>`);
const loafSvg = svgUri(`<svg xmlns="http://www.w3.org/2000/svg" width="560" height="200" viewBox="0 0 560 200">
<rect width="560" height="200" fill="#FFE2B8"/>
<circle cx="90" cy="60" r="34" fill="#FFB347"/><circle cx="470" cy="150" r="46" fill="#FFC978"/>
<ellipse cx="280" cy="125" rx="130" ry="52" fill="#C97B2B"/>
<ellipse cx="280" cy="110" rx="124" ry="46" fill="#E39A45"/>
<path d="M200 98 l22 -26 M255 92 l22 -28 M310 92 l22 -28 M360 100 l20 -22" stroke="#F8D49A" stroke-width="9" stroke-linecap="round"/>
</svg>`);

const para = (s: string, color = '#444444') => `<p style="margin:0 0 14px;line-height:1.55;color:${color}">${s}</p>`;

const brightloopHtml = `<table width="100%" cellpadding="0" cellspacing="0" bgcolor="#F1EFFB" style="background-color:#F1EFFB"><tr><td align="center" style="padding:20px 8px">
<table width="600" cellpadding="0" cellspacing="0" bgcolor="#FFFFFF" style="background-color:#FFFFFF;font-family:Segoe UI,Arial,sans-serif;max-width:600px">
<tr><td bgcolor="#4B3FD6" style="background-color:#4B3FD6;padding:20px 28px;color:#FFFFFF;font-size:24px;font-weight:bold">Brightloop Weekly</td></tr>
<tr><td style="padding:0"><img src="${sunriseSvg}" width="600" height="220" alt="A sunrise over green hills" style="display:block;width:100%;height:auto"></td></tr>
<tr><td style="padding:26px 28px 8px;font-size:15px">
<h1 style="margin:0 0 12px;font-size:26px;line-height:1.25;color:#1F1A5E">5 small habits that actually stick</h1>
${para('Big plans fade by February. Tiny ones survive. This week we asked readers which habits lasted more than a year, and the answers were surprisingly small.')}
${para('The winner: a glass of water before the first coffee. Two minutes, no gear, and nobody skipped it on a busy day.')}
<table cellpadding="0" cellspacing="0" style="margin:18px 0 8px"><tr><td bgcolor="#4B3FD6" style="background-color:#4B3FD6;padding:12px 22px;border-radius:6px"><a href="https://example.com/brightloop/habits" style="color:#FFFFFF;text-decoration:none;font-weight:bold">Read the full story</a></td></tr></table>
</td></tr>
<tr><td style="border-top:1px solid #E4E2F4;padding:16px 28px;color:#8A88A6;font-size:12px">You are getting this because you signed up for Brightloop Weekly. This is a made-up newsletter for demo pictures.</td></tr>
</table></td></tr></table>`;

const pinewoodHtml = `<table width="100%" cellpadding="0" cellspacing="0" bgcolor="#FFFFFF" style="background-color:#FFFFFF"><tr><td align="center" style="padding:16px 8px">
<table width="560" cellpadding="0" cellspacing="0" bgcolor="#FFFFFF" style="background-color:#FFFFFF;font-family:Georgia,serif;max-width:560px">
<tr><td align="center" style="padding:10px 0 14px;color:#B45A00;font-size:30px;font-weight:bold;letter-spacing:1px">Pinewood Bakery</td></tr>
<tr><td><img src="${loafSvg}" width="560" height="200" alt="A fresh loaf of bread" style="display:block;width:100%;height:auto"></td></tr>
<tr><td align="center" style="padding:22px 20px 6px;color:#222222"><div style="font-size:28px;font-weight:bold;color:#D2691E">Spring menu is here</div>
<div style="font-size:16px;margin-top:10px;color:#333333;line-height:1.5">Warm rosemary loaf, lemon buns and our new honey oat bread. Baked every morning from 6 am.</div></td></tr>
<tr><td style="padding:14px 40px;font-size:16px;color:#222222"><table width="100%" cellpadding="6" cellspacing="0">
<tr><td>Rosemary loaf</td><td align="right"><b>4.80</b></td></tr>
<tr><td>Lemon bun (2)</td><td align="right"><b>3.20</b></td></tr>
<tr><td>Honey oat bread</td><td align="right"><b>5.10</b></td></tr></table></td></tr>
<tr><td align="center" style="padding:10px 0 24px"><table cellpadding="0" cellspacing="0"><tr><td bgcolor="#FF8C1A" style="background-color:#FF8C1A;padding:13px 30px;border-radius:30px"><a href="https://example.com/pinewood/order" style="color:#FFFFFF;text-decoration:none;font-weight:bold;font-family:Arial,sans-serif">Order for pickup</a></td></tr></table></td></tr>
<tr><td align="center" style="background-color:#FFF3E0;padding:14px;color:#8A6A3E;font-size:12px;font-family:Arial,sans-serif">Pinewood Bakery is a made-up shop for demo pictures.</td></tr>
</table></td></tr></table>`;

const libraryHtml = `<div style="font-family:Segoe UI,Arial,sans-serif;color:#222222;max-width:560px">
<img src="https://example.com/images/northfield-library-banner.jpg" width="560" height="160" alt="Northfield Library banner" style="display:block">
<h2 style="color:#1B5E3B;margin:18px 0 8px">Your hold is ready for pickup</h2>
<p style="line-height:1.5">Hello Anna, the book you reserved, <b>The Quiet Orchard</b>, is waiting at the front desk. We will keep it for 7 days.</p>
<img src="https://example.com/images/book-cover.jpg" width="120" height="170" alt="Cover of The Quiet Orchard" style="display:block;margin:8px 0">
<p style="line-height:1.5">Opening hours this week: Mon to Fri 9 am to 7 pm, Sat 10 am to 4 pm.</p>
<p style="color:#666666;font-size:12px">Northfield Library is a made-up library for demo pictures.</p></div>`;

const txt = (greeting: string, lines: string[], sign: string): string => `${greeting}\n\n${lines.join('\n\n')}\n\n${sign}`;

export function buildDemo(now: number): Demo {
  // ---------- accounts and folders ----------
  const accountRows: [string, string, string, string, Account['provider']][] = [
    ['a1', 'Personal', 'anna@example.com', '#0F6CBD', 'gmail'],
    ['a2', 'Work', 'anna.rossi@example.org', '#0E7C7B', 'generic'],
    ['a3', 'Family', 'rossi.family@example.net', '#C74B00', 'generic'],
    ['a4', 'Club', 'anna.club@example.net', '#8764B8', 'generic'],
  ];
  const accounts: Account[] = accountRows.map(([id, name, email, color, provider], i) => ({
    id,
    email,
    displayName: name,
    color,
    provider,
    authType: 'password',
    oauthProvider: null,
    imap: { host: 'imap.example.com', port: 993, security: 'ssl' },
    smtp: { host: 'smtp.example.com', port: 465, security: 'ssl' },
    username: email,
    syncDays: 90,
    signature: id === 'a1' ? 'Anna' : id === 'a2' ? 'Anna Rossi\nProject lead' : null,
    enabled: true,
    sortOrder: i,
    badge: name[0]!,
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
      [null, 'Reading'],
      [null, 'Receipts'],
    ] as const) {
      folders.push({ id: fid++, accountId: a.id, path: name, name, role: role as FolderRole | null, delimiter: '/', unreadCount: 0, totalCount: 0, selectable: true });
    }
  }
  const folderOf = (accountId: string, role: string): Folder => folders.find((f) => f.accountId === accountId && f.role === role)!;
  const named = (accountId: string, name: string): Folder => folders.find((f) => f.accountId === accountId && f.name === name)!;

  // ---------- messages ----------
  const messages: MessageHeader[] = [];
  const bodies = new Map<number, DemoBody>();
  let mid = 1;
  const addr = (name: string, address: string): Address => ({ name, address });
  const me = (accId: string): Address => ({ name: 'Anna Rossi', address: accounts.find((a) => a.id === accId)!.email });
  const P = {
    ben: addr('Ben Carter', 'ben.carter@example.net'),
    priya: addr('Priya Nair', 'priya@example.com'),
    tom: addr('Tom Becker', 'tom.becker@example.org'),
    mia: addr('Mia Okafor', 'mia.okafor@example.com'),
    lena: addr('Lena Hoffmann', 'lena@example.org'),
    marco: addr('Marco Rossi', 'marco.rossi@example.net'),
    dana: addr('Dana Whitfield', 'dana@example.org'),
    bright: addr('Brightloop Weekly', 'weekly@example.net'),
    pine: addr('Pinewood Bakery', 'orders@example.com'),
    lib: addr('Northfield Library', 'holds@example.org'),
    lark: addr('Larkspur Studio', 'billing@example.org'),
    harbor: addr('Harbor Print Co.', 'accounts@example.net'),
    school: addr('Maple Street School', 'office@example.org'),
    shop: addr('Larkspur Shop', 'orders@example.net'),
    hr: addr('Northfield HR', 'people@example.org'),
    cycle: addr('Cedar Ridge Cycling Club', 'rides@example.net'),
  };

  interface Opt {
    seen?: boolean;
    flagged?: boolean;
    att?: DemoBody['attachments'];
    body?: DemoBody;
    to?: Address[];
    answered?: boolean;
  }
  function add(acc: string, role: string, minutesAgo: number, from: Address, subject: string, snippet: string, o: Opt = {}): number {
    const f = folderOf(acc, role);
    const fromMe = role === 'sent' || role === 'drafts';
    const id = mid++;
    messages.push({
      id,
      accountId: acc,
      folderId: f.id,
      uid: id,
      messageIdHeader: `<demo${id}@example.com>`,
      subject,
      from,
      to: o.to ?? [fromMe ? P.ben : me(acc)],
      cc: [],
      date: now - minutesAgo * MIN,
      snippet,
      seen: o.seen ?? true,
      flagged: o.flagged ?? false,
      answered: o.answered ?? false,
      draft: role === 'drafts',
      hasAttachments: !!o.att?.length,
      size: 6000,
      bodyCached: true,
      ...(role === 'drafts' ? { draftSync: 'saved' as const, localOnly: false } : {}),
    });
    bodies.set(id, { text: txt(`Hi ${fromMe ? (o.to?.[0]?.name ?? 'there').split(' ')[0] : 'Anna'},`, [snippet], fromMe ? 'Anna' : `Best,\n${(from.name ?? 'Anna').split(' ')[0]}`), ...(o.body ?? {}), attachments: o.att ?? [] });
    return id;
  }
  const pdf = (filename: string, size = 184_320) => [{ filename, contentType: 'application/pdf', size }];
  const H = 60;

  // -- the first eight rows of the unified inbox (3 unread) --
  add('a1', 'inbox', 14, P.bright, '5 small habits that actually stick', 'Big plans fade by February. Tiny ones survive. This week we asked readers which habits lasted more than a year...', { body: { html: brightloopHtml, text: null } });
  const weekend = 'Weekend plans';
  const w1 = add('a1', 'inbox', 2 * DAY / MIN + 3 * H, P.ben, weekend, 'Hey Anna, are you free on Saturday? I am thinking of a hike at Cedar Ridge, then lunch.');
  add('a1', 'sent', 2 * DAY / MIN + 2 * H, me('a1'), `Re: ${weekend}`, 'Saturday works for me. What time would you leave? I can bring sandwiches.', { to: [P.ben] });
  const w3 = add('a1', 'inbox', DAY / MIN + 4 * H, P.ben, `Re: ${weekend}`, 'Let us meet at 9 at the trailhead parking. Mia is in. Tom is checking his shifts.');
  const w4 = add('a1', 'inbox', 38, P.ben, `Re: ${weekend}`, 'Tom is in too! The weather looks good, around 18 degrees. Bring a jacket just in case.', { seen: false });
  bodies.set(w1, { text: txt('Hey Anna,', ['Are you free on Saturday? I am thinking of a hike at Cedar Ridge, then lunch at the little place by the lake.', 'Tom and Mia might join.'], 'Ben') });
  // Replies carry the older mail as quoted text (plain text with "> " lines): the reading pane folds it behind a "..." button.
  bodies.set(w3, {
    text:
      txt('Hi Anna,', ['Let us meet at 9 at the trailhead parking. Mia is in. Tom is checking his shifts and will tell us tonight.'], 'Ben') +
      '\n\nOn Sun, 11 Oct 2026 at 08:20, Anna Rossi <anna@example.com> wrote:\n> Saturday works for me. What time would you leave?\n> I can bring sandwiches.\n>\n> Anna\n',
  });
  bodies.set(w4, {
    text:
      txt('Hi Anna,', ['Tom is in too! The weather looks good, around 18 degrees.', 'Bring a jacket just in case. I will bring a thermos of tea.'], 'See you Saturday,\nBen') +
      '\n\nOn Mon, 12 Oct 2026 at 18:30, Ben Carter <ben.carter@example.net> wrote:\n> Let us meet at 9 at the trailhead parking. Mia is in.\n> Tom is checking his shifts and will tell us tonight.\n',
  });

  const q3 = 'Q3 report: final numbers';
  add('a2', 'inbox', 20 * H, P.tom, q3, 'Hi Anna, the final Q3 numbers are in the shared sheet. Please check the travel line before we send it on.');
  add('a2', 'sent', 18 * H, me('a2'), `Re: ${q3}`, 'Thanks Tom. The travel line looks right to me. I will send the summary to Priya this afternoon.', { to: [P.tom] });
  const q3c = add('a2', 'inbox', 52, P.tom, `Re: ${q3}`, 'Great, thank you. Priya is happy with it. We can present on Thursday.', { answered: false });
  // A Gmail-style reply: the quote is a .gmail_quote block (folded behind a "..." button).
  bodies.set(q3c, {
    html:
      '<div dir="ltr">Hi Anna,<br><br>Great, thank you. Priya is happy with it. We can present on Thursday.<br><br>Best,<br>Tom</div><br>' +
      '<div class="gmail_quote"><div dir="ltr" class="gmail_attr">On Mon, 12 Oct 2026 at 15:10, Anna Rossi &lt;anna.rossi@example.org&gt; wrote:<br></div>' +
      '<blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex">' +
      '<div dir="ltr">Thanks Tom. The travel line looks right to me. I will send the summary to Priya this afternoon.</div></blockquote></div>',
    text: null,
  });
  add('a2', 'inbox', 70, P.priya, 'Invoice #1187 for October', 'Hi Anna, please find the invoice for October attached. Payment is due in 14 days.', { seen: false, att: pdf('invoice-1187.pdf') });
  add('a1', 'inbox', 120, P.pine, 'Spring menu is here: try the rosemary loaf', 'Warm rosemary loaf, lemon buns and our new honey oat bread. Baked every morning from 6 am.', { seen: false, body: { html: pinewoodHtml, text: null } });
  add('a1', 'inbox', 180, P.lib, 'Your hold is ready for pickup', 'Hello Anna, the book you reserved, The Quiet Orchard, is waiting at the front desk.', { body: { html: libraryHtml, text: null, remoteImages: true } });
  add('a1', 'inbox', 300, P.mia, 'Photos from the lake', 'Here are the best ones from last weekend. The sunset one is my favourite!', { att: [{ filename: 'lake-sunset.jpg', contentType: 'image/jpeg', size: 1_240_000 }, { filename: 'lake-group.jpg', contentType: 'image/jpeg', size: 980_000 }] });
  add('a2', 'inbox', 360, P.lena, 'Team lunch on Friday?', 'Shall we book the Italian place near the office? Twelve people so far.');

  // -- older mail from every account (12 more unread, so All inboxes shows 15) --
  const older: [string, number, Address, string, string, Opt?][] = [
    ['a3', 7 * H, P.marco, "Dinner at Nonna's on Sunday", 'Nonna is making lasagne again. Can you bring the dessert? We start at one.', { seen: false }],
    ['a4', 8 * H, P.dana, 'Saturday ride: route and meeting point', 'We meet at the old mill at 8:30. The route is 45 km, mostly flat. Bring water.', { seen: false }],
    ['a1', 10 * H, P.shop, 'Your parcel is on its way', 'Good news: your order left our warehouse today. Track it with the number below.', { seen: false }],
    ['a3', 22 * H, P.school, 'School trip form to sign', 'Please sign and return the form for the museum trip by Friday.', { seen: false, att: pdf('trip-form.pdf', 92_000) }],
    ['a2', 24 * H, P.hr, 'Updated holiday calendar', 'The holiday calendar for next year is ready. Please enter your days by the end of the month.', { seen: false }],
    ['a4', 26 * H, P.cycle, 'Membership renewal reminder', 'Your Cedar Ridge Cycling Club membership ends on 31 October. Renew online in two minutes.', { seen: false }],
    ['a1', 28 * H, P.lark, 'Invoice INV-2041 from Larkspur Studio', 'Thank you for your order. The invoice for the logo refresh is attached.', { att: pdf('INV-2041.pdf') }],
    ['a3', 30 * H, P.marco, 'Gift ideas for Grandma', 'I made a list of ideas in our family note. The scarf is my top pick, what do you think?', { seen: false }],
    ['a2', 32 * H, P.priya, 'Please review: Q4 plan draft', 'I put the draft in the shared folder. Comments are welcome until Wednesday evening.', { seen: false }],
    ['a4', 40 * H, P.dana, 'Volunteer rota for the autumn ride', 'We still need two people for the rest stop. Reply if you can help.', { seen: false }],
    ['a1', 48 * H, P.mia, 'Birthday plans', 'I would love to see you on the 24th. Small dinner at my place, nothing fancy.', { flagged: true }],
    ['a3', 50 * H, P.school, 'Invoice for the school trip', 'The invoice for the museum trip is attached. Payment can be made at the front desk.', { att: pdf('school-trip-invoice.pdf', 76_000) }],
    ['a2', 52 * H, P.harbor, 'Reminder: invoice 1163 is due Friday', 'This is a friendly reminder that invoice 1163 for the printed flyers is due on Friday.', {}],
    ['a4', 56 * H, P.dana, 'Club newsletter: October', 'Ride results, new members and the winter schedule. Enjoy the read!', { seen: false }],
    ['a1', 60 * H, P.pine, 'Receipt for order 5521', 'Thank you for your order. Your receipt is below. See you at the bakery!', {}],
    ['a2', 70 * H, P.lena, 'Meeting notes: planning call', 'Notes from Monday are in the shared folder. Action items are marked in yellow.', { seen: false }],
    ['a3', 74 * H, P.marco, 'Photos from the picnic', 'Here are the photos from the picnic. Aunt Rosa is in half of them.', { seen: false, att: [{ filename: 'picnic-1.jpg', contentType: 'image/jpeg', size: 1_100_000 }] }],
    ['a1', 80 * H, P.ben, 'Book you asked about', 'It is called The Quiet Orchard. I think you will like it.', {}],
  ];
  for (const [acc, ago, from, subject, snippet, o] of older) add(acc, 'inbox', ago, from, subject, snippet, o);

  // -- a few other folders --
  add('a1', 'sent', 6 * H, me('a1'), 'Photos from the lake', 'Thanks Mia! The sunset one is great. Can I share it with the group?', { to: [P.mia] });
  add('a2', 'sent', 30 * H, me('a2'), 'Notes for Thursday', 'Hi Priya, here are my notes for Thursday. Let me know if you want to change the order.', { to: [P.priya] });
  add('a1', 'drafts', 90, me('a1'), 'Birthday ideas for Mia', 'A few ideas so far: a small plant, a book, tickets for the lake boat.', { to: [P.mia] });
  add('a1', 'archive', 5 * DAY / MIN, P.lib, 'Welcome to Northfield Library', 'Your library card is ready. Thank you for joining us.');
  add('a1', 'inbox', 90 * H, P.pine, 'Rosemary loaf recipe', 'You asked for our rosemary loaf recipe. Here it is, step by step.', {});

  messages.sort((a, b) => b.date - a.date || b.id - a.id);

  // ---------- who is online ----------
  const statuses: AccountStatus[] = accounts.map((a) => ({ accountId: a.id, state: 'online', lastSyncAt: now - 2 * MIN, error: null, nextRetryAt: null, pendingCount: 0 }));

  // ---------- recipient suggestions ----------
  const people = [P.ben, P.priya, P.tom, P.mia, P.lena, P.marco, P.dana];
  const contacts: DemoContact[] = [
    ...people.map((p, i) => ({ address: p.address, name: p.name ?? null, sentCount: 12 - i, lastUsed: now - i * 2 * DAY, isOwn: false })),
    ...accounts.map((a) => ({ address: a.email, name: 'Anna Rossi', sentCount: 0, lastUsed: now, isOwn: true })),
  ];

  // ---------- rules (three) and what they did lately ----------
  const base = { enabled: true, trigger: 'inbox' as const, createdAt: now - 20 * DAY, warning: null };
  const noAct = { markRead: false, flag: false, delete: false, stop: false };
  const reading = named('a1', 'Reading');
  const rules: Rule[] = [
    { ...base, id: 11, position: 1, name: 'Newsletters to Reading folder', accountId: 'a1', matchMode: 'any', conditions: [{ field: 'from', value: 'weekly@example.net' }, { field: 'subject', value: 'newsletter' }], actions: { ...noAct, moveToFolderId: reading.id, moveToFolderPath: 'Reading' } },
    { ...base, id: 12, position: 2, name: 'Mark receipts as read', accountId: null, matchMode: 'all', conditions: [{ field: 'subject', value: 'receipt' }], actions: { ...noAct, markRead: true } },
    { ...base, id: 13, position: 3, name: 'Flag mail from Ben', accountId: null, matchMode: 'all', conditions: [{ field: 'from', value: 'ben.carter@example.net' }], actions: { ...noAct, flag: true } },
  ];
  const act = (id: number, minutesAgo: number, o: Partial<RuleActivityItem>): RuleActivityItem => ({
    id, ts: now - minutesAgo * MIN, ruleId: 11, ruleName: 'Newsletters to Reading folder', ruleDeleted: false, accountId: 'a1', count: 1,
    subject: null, sender: null, summary: 'Moved to Reading', runNow: false, undone: false, canUndo: true, warning: false, ...o,
  });
  const activity: RuleActivityItem[] = [
    act(1, 3 * H, { subject: 'Brightloop Weekly: autumn reading list', sender: 'weekly@example.net' }),
    act(2, 26 * H, { ruleId: 12, ruleName: 'Mark receipts as read', accountId: 'a1', subject: 'Receipt for order 5521', sender: 'orders@example.com', summary: 'Marked as read' }),
  ];

  // ---------- one message waits to be sent later ----------
  const tomorrow8 = new Date(now);
  tomorrow8.setHours(8, 0, 0, 0);
  const sendAt = tomorrow8.getTime() + DAY;
  const req: SendReq = { draftId: 'demo-sch-1', accountId: 'a1', to: [P.mia], cc: [], bcc: [], subject: 'Happy birthday, Mia!', html: '<p>Happy birthday! See you on the 24th.</p>', attachmentTokens: [] };
  const scheduled: DemoScheduled[] = [
    { id: 101, accountId: 'a1', draftId: req.draftId, subject: req.subject, to: req.to, cc: [], snippet: 'Happy birthday! See you on the 24th.', hasAttachments: false, sendAt, createdAt: now - H * MIN, status: 'scheduled', waiting: null, lastError: null, attempt: 0, overdueMs: 0, req },
  ];

  return {
    accounts, folders, messages, bodies, statuses, contacts, rules, activity, scheduled,
    settings: { groupConversations: true, markReadDelayMs: -1, remoteImages: 'block', theme: 'system' },
    nextMessageId: mid,
    nextFolderId: fid,
  };
}
