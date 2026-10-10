// Engine performance baseline (opt-in). Driven by `npm run perf` (scripts/perf-baseline.mjs), which
// starts vitest with PERF=1 and reads the JSON this file writes to PERF_OUT. `npm test` skips it.
//
// What it does
//   1. Builds (once, then cached in the temp folder) a large deterministic mailbox: 3 accounts,
//      50 000 messages, ~5 000 distinct people, 200 long conversations, ~600 downloaded bodies.
//      The accounts are added through the real engine against the FakeImapServer (so folders and
//      roles are the real ones); the bulk rows are then written straight into SQLite with the same
//      repository code the sync uses (upsertHeaders / saveBody). Pushing 50k messages through IMAP
//      would take many minutes per run. After seeding, the accounts are disabled so no sync can
//      touch the rows, and the one-time conversation and contact back-fills are run to completion
//      (otherwise run 1 would pay for them and runs 2+ would not).
//   2. Repeats PERF_RUNS times, each in a fresh engine on the same database file:
//        cold start     createEngine -> start() -> first screen data (accounts, folders, first
//                       unified-inbox page). "ready" = that last step returned.
//        first call     the first call of each IPC channel in that engine (cold prepared statements)
//        warm calls     PERF_WARM more calls per channel (messages.list, conversations.list,
//                       search.local, messages.get on a downloaded body)
//        memory         RSS and heap after a forced GC, right after the warm calls
//   3. Writes raw samples (not statistics) to PERF_OUT. The orchestrator computes median / p90.
//
// Notes for reading the numbers
//   - All runs happen in ONE vitest worker process, so the OS file cache is warm after run 1. Memory
//     read inside such a process is NOT trustworthy (RSS keeps native SQLite memory of engines that were shut down, and it is
//     +380 MB if the seed was built in the same process). The driver therefore takes the memory
//     numbers from separate fresh processes (PERF_RUNS=1), and builds the seed in its own process
//     (PERF_SEED_ONLY=1) before any measuring. PERF_SEED_DIR points at an existing seed folder.
//   - Cold start does not include process start-up or any IMAP traffic (accounts are disabled to
//     keep the dataset stable).
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { setFlagsFromString } from 'node:v8';
import { describe, it } from 'vitest';
import { openDatabase, type Db } from '../../src/engine/db/connection';
import { AccountRepo } from '../../src/engine/db/repos/accountRepo';
import { MessageRepo, type HeaderInput } from '../../src/engine/db/repos/messageRepo';
import { MIGRATIONS } from '../../src/engine/db/migrations';
import type { Address } from '../../src/shared/ipc';
import { createHarness, waitFor, waitForInboxCursors, type Harness } from '../fakes/engineHarness';
import { rawMessage, startFakeImap, type FakeImapServer } from '../fakes/fakeImapServer';

// Bump when the generator below changes (the cached database is rebuilt).
const SEED_VERSION = 1;

const RUNS = Number(process.env['PERF_RUNS'] ?? 7);
const WARM = Number(process.env['PERF_WARM'] ?? 5);
const OUT = process.env['PERF_OUT'] ?? '';
const SCALE = Number(process.env['PERF_SCALE'] ?? 1); // 0.1 = quick smoke test of the script itself

const TOTAL_MESSAGES = Math.round(50_000 * SCALE);
const CONTACTS = Math.round(5_000 * SCALE);
const THREADS = Math.round(200 * SCALE);
const THREAD_LEN = 25;
const CACHED_EVERY = 83; // about 600 downloaded bodies

// ---------- deterministic data ----------
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TOPICS = [
  'invoice',
  'invoice',
  'invoice',
  'meeting',
  'meeting',
  'quarterly report',
  'travel plans',
  'project update',
  'project update',
  'newsletter',
  'receipt',
  'schedule change',
  'proposal',
  'contract',
  'birthday',
  'security alert',
  'order confirmation',
  'weekly digest',
  'question',
];
const WORDS = [
  'alpha',
  'bravo',
  'charlie',
  'delta',
  'echo',
  'foxtrot',
  'garden',
  'harbor',
  'island',
  'jungle',
  'kitchen',
  'lantern',
  'meadow',
  'north',
  'orchard',
  'pillow',
  'quarry',
  'river',
  'summit',
  'tunnel',
  'update',
  'review',
  'budget',
  'deadline',
  'forecast',
  'draft',
  'agenda',
  'minutes',
  'payment',
  'status',
];
const FIRST = [
  'Ana',
  'Ben',
  'Cleo',
  'Dan',
  'Eva',
  'Finn',
  'Gia',
  'Hugo',
  'Iris',
  'Jon',
  'Kira',
  'Leo',
];

interface Plan {
  accountId: string;
  email: string;
  folders: { id: number; role: string | null; share: number }[];
}

function personAt(i: number): Address {
  return {
    name: `${FIRST[i % FIRST.length]} Person${i}`,
    address: `p${i}@d${i % 97}.example.test`,
  };
}

function buildHeaders(plans: Plan[]): HeaderInput[] {
  const rnd = mulberry32(0xc0ffee);
  const BASE = Date.UTC(2026, 5, 1);
  const YEAR = 365 * 24 * 3600 * 1000;
  const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)]!;
  const person = (): number => Math.floor(rnd() ** 2 * CONTACTS); // a few people write most mail
  const rows: HeaderInput[] = [];
  const uidNext = new Map<number, number>();
  const nextUid = (folderId: number) => {
    const u = (uidNext.get(folderId) ?? 100_000) + 1;
    uidNext.set(folderId, u);
    return u;
  };
  const pickFolder = (p: Plan) => {
    let r = rnd();
    for (const f of p.folders) {
      if ((r -= f.share) < 0) return f;
    }
    return p.folders[0]!;
  };
  const flags = (seen: boolean) => ({
    seen,
    flagged: false,
    answered: false,
    draft: false,
    deleted: false,
    keywords: [] as string[],
  });
  const mk = (p: Plan, folderId: number, o: Partial<HeaderInput>): HeaderInput => ({
    accountId: p.accountId,
    folderId,
    uid: nextUid(folderId),
    messageId: null,
    inReplyTo: null,
    references: null,
    subject: '',
    from: null,
    to: [{ address: p.email }],
    cc: [],
    bcc: [],
    replyTo: [],
    dateMs: BASE,
    internalMs: BASE,
    size: 2000 + Math.floor(rnd() * 20000),
    flags: flags(true),
    modseq: null,
    hasAttachments: false,
    ...o,
  });

  // Long conversations (Message-ID / In-Reply-To chains), spread over the accounts, in the inboxes.
  let made = 0;
  for (let t = 0; t < THREADS; t++) {
    const p = plans[t % plans.length]!;
    const inbox = p.folders.find((f) => f.role === 'inbox')!;
    const topic = pick(TOPICS);
    const start = BASE - Math.floor(rnd() * 2 * YEAR);
    const root = `<thr${t}-0@perf.test>`;
    for (let k = 0; k < THREAD_LEN; k++) {
      const fromMe = k % 3 === 2;
      const them = personAt((t * 7 + (k % 4)) % CONTACTS);
      const d = start + k * 3_600_000 * (1 + Math.floor(rnd() * 5));
      rows.push(
        mk(p, inbox.id, {
          messageId: `<thr${t}-${k}@perf.test>`,
          inReplyTo: k === 0 ? null : `<thr${t}-${k - 1}@perf.test>`,
          references: k === 0 ? null : root,
          subject: k === 0 ? `${topic} thread ${t}` : `Re: ${topic} thread ${t}`,
          from: fromMe ? { name: 'Me', address: p.email } : them,
          to: fromMe ? [them] : [{ address: p.email }],
          dateMs: d,
          internalMs: d,
          flags: flags(rnd() > 0.1),
        }),
      );
      made++;
    }
  }

  // The rest: one message per conversation. A unique number in each subject stops the subject-based
  // threading rule from joining them (so the number of conversations stays stable).
  for (let n = 0; made < TOTAL_MESSAGES; n++, made++) {
    const p = plans[n % plans.length]!;
    const f = pickFolder(p);
    const sent = f.role === 'sent';
    const who = personAt(person());
    const d = BASE - Math.floor(rnd() * 3 * YEAR);
    rows.push(
      mk(p, f.id, {
        messageId: `<m${n}@perf.test>`,
        subject: `${pick(TOPICS)} ${pick(WORDS)} #${n}`,
        from: sent ? { name: 'Me', address: p.email } : who,
        to: sent ? [who] : [{ address: p.email }],
        cc: rnd() < 0.1 ? [personAt(person())] : [],
        dateMs: d,
        internalMs: d,
        flags: flags(rnd() > 0.15),
        hasAttachments: rnd() < 0.08,
      }),
    );
  }
  return rows;
}

function bodyText(rnd: () => number, i: number): string {
  const n = 30 + Math.floor(rnd() * 40);
  const w: string[] = [];
  for (let k = 0; k < n; k++) w.push(WORDS[Math.floor(rnd() * WORDS.length)]!);
  if (i % 3 === 0) w.splice(Math.floor(rnd() * n), 0, 'boardroom'); // only found by a body search
  return w.join(' ');
}

// ---------- seeding ----------
async function seed(server: FakeImapServer, dir: string): Promise<void> {
  const dbFile = join(dir, 'mail.db');
  // 1. Real accounts and folders through the engine.
  const h = await createHarness(server, { dbFile, dataDir: dir });
  const accs = [];
  for (let i = 1; i <= 3; i++) {
    accs.push(await h.addAccount({ email: `perf${i}@example.com`, displayName: `Perf ${i}` }));
  }
  await waitForInboxCursors(
    h,
    accs.map((a) => a.id),
  );
  const plans: Plan[] = accs.map((a) => {
    const fs = h.engine.ctx.folders.list(a.id);
    const wanted: [string, number][] = [
      ['inbox', 0.6],
      ['archive', 0.22],
      ['sent', 0.1],
      ['trash', 0.05],
      ['junk', 0.03],
    ];
    const chosen = wanted.flatMap(([role, w]) => {
      const f = fs.find((x) => x.role === role);
      return f ? [{ id: f.id, role, w }] : [];
    });
    const sum = chosen.reduce((s, c) => s + c.w, 0);
    return {
      accountId: a.id,
      email: a.email,
      folders: chosen.map((c) => ({ id: c.id, role: c.role, share: c.w / sum })),
    };
  });
  await h.engine.shutdown();

  // 2. Bulk rows through the repositories, accounts switched off.
  const db = openDatabase(dbFile);
  const accountsRepo = new AccountRepo(db);
  for (const a of accs) accountsRepo.update(a.id, { enabled: false });
  const repo = new MessageRepo(db);
  const rows = buildHeaders(plans);
  const rnd = mulberry32(0xbeef);
  const CHUNK = 1000;
  let seen = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { added } = repo.upsertHeaders(rows.slice(i, i + CHUNK));
    for (const id of added) {
      seen++;
      if (seen % CACHED_EVERY !== 0) continue;
      const text = bodyText(rnd, seen);
      repo.saveBody(
        id,
        {
          text,
          html: `<html><body><p>${text}</p><p>Regards, Person</p></body></html>`,
          snippet: text.slice(0, 120),
          attachments: [],
          ftsBodyText: text,
        },
        Date.UTC(2026, 5, 1),
      );
    }
  }
  db.close();

  // 3. Let the one-time back-fills finish, then fold the WAL into the main file.
  const p = await createHarness(server, { dbFile, dataDir: dir });
  p.engine.start();
  await p.engine.threadsReady();
  await waitFor('contacts back-fill', () => !p.engine.ctx.contacts.needsBackfill(), 300_000);
  await p.engine.shutdown();
  const fin = openDatabase(dbFile);
  fin.pragma('wal_checkpoint(TRUNCATE)');
  fin.close();
}

// ---------- measuring ----------
type Samples = Record<string, { unit: string; samples: number[]; note?: string }>;
function add(m: Samples, name: string, unit: string, v: number, note?: string): void {
  (m[name] ??= { unit, samples: [], ...(note ? { note } : {}) }).samples.push(v);
}

setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void;
const mb = (n: number) => n / 1024 / 1024;
function mem() {
  gc();
  gc();
  const u = process.memoryUsage();
  return {
    rss: mb(u.rss),
    heap: mb(u.heapUsed),
    external: mb(u.external),
    arrayBuffers: mb(u.arrayBuffers),
  };
}

/** SQLite facts that explain native memory: page cache setting, mmap, file sizes. */
function sqliteFacts(db: Db, dbFile: string) {
  const pageSize = db.pragma('page_size', { simple: true }) as number;
  const cacheSize = db.pragma('cache_size', { simple: true }) as number; // >0 pages, <0 KiB
  return {
    cacheMb: mb(cacheSize < 0 ? -cacheSize * 1024 : cacheSize * pageSize),
    mmapMb: mb(db.pragma('mmap_size', { simple: true }) as number),
    dbMb: mb(statSync(dbFile).size),
    walMb: mb(existsSync(`${dbFile}-wal`) ? statSync(`${dbFile}-wal`).size : 0),
  };
}

describe.skipIf(!process.env['PERF'])('engine performance baseline', () => {
  it('measures the engine on the large seeded mailbox', async () => {
    const server = await startFakeImap({
      inbox: [1, 2, 3].map((n) => ({ raw: rawMessage({ subject: `seed ${n}` }) })),
    });
    // PERF_SEED_DIR lets two code versions run on the very same seeded database file.
    const cache =
      process.env['PERF_SEED_DIR'] ||
      join(tmpdir(), `letterdock-perf-seed-v${SEED_VERSION}-m${MIGRATIONS.length}-s${SCALE}`);
    const work = mkdtempSync(join(tmpdir(), 'letterdock-perf-run-'));
    try {
      if (!existsSync(join(cache, 'mail.db'))) {
        const tmp = `${cache}.building`;
        rmSync(tmp, { recursive: true, force: true });
        mkdirSync(tmp, { recursive: true });
        const t0 = performance.now();
        await seed(server, tmp);
        console.log(`[perf] seeded in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
        rmSync(cache, { recursive: true, force: true });
        renameSync(tmp, cache);
      } else {
        console.log(`[perf] reusing cached seed ${cache}`);
      }
      // Seeding is slow and leaves the process 300+ MB bigger (the first rows of the seed are
      // built in this process), so the driver builds the seed in its own process first.
      if (process.env['PERF_SEED_ONLY']) return;
      const dbFile = join(work, 'mail.db');
      copyFileSync(join(cache, 'mail.db'), dbFile);

      const m: Samples = {};
      const counts: Record<string, number> = {};
      const inboxReq = { scope: { kind: 'unifiedInbox' }, cursor: null, limit: 100 };

      for (let run = 0; run < RUNS; run++) {
        const before = mem();
        // ----- cold start -----
        const t0 = performance.now();
        const h: Harness = await createHarness(server, {
          dbFile,
          dataDir: work,
          settings: { groupConversations: true },
        });
        const tCreated = performance.now();
        h.engine.start();
        const tStarted = performance.now();
        const handle = (c: string, p?: unknown) => h.engine.handle(c, p);
        await handle('accounts.list');
        await handle('folders.list');
        const tFirst = performance.now();
        await handle('messages.list', inboxReq);
        const tReady = performance.now();
        add(m, 'engine.coldStart.create', 'ms', tCreated - t0, 'open database + wire services');
        add(m, 'engine.coldStart.start', 'ms', tStarted - tCreated, 'engine.start() returns');
        add(
          m,
          'engine.coldStart.ready',
          'ms',
          tReady - t0,
          'create + start + accounts, folders and first inbox page',
        );

        // ----- operations. Each returns [milliseconds, number of items] for the part that counts. -----
        const cachedIds = (
          h.engine.ctx.db
            .prepare("SELECT id FROM message WHERE body_state = 'cached' ORDER BY id LIMIT 50")
            .all() as { id: number }[]
        ).map((r) => r.id);
        let getN = 0;
        const page = async (channel: string, second: boolean): Promise<[number, number]> => {
          let cursor: unknown = null;
          if (second) {
            const p1 = (await handle(channel, inboxReq)) as { nextCursor: unknown };
            cursor = p1.nextCursor;
          }
          const t = performance.now();
          const r = (await handle(channel, { ...inboxReq, cursor })) as { items: unknown[] };
          return [performance.now() - t, r.items.length];
        };
        const search = async (query: string): Promise<[number, number]> => {
          const t = performance.now();
          const r = (await handle('search.local', { query, limit: 100 })) as { items: unknown[] };
          return [performance.now() - t, r.items.length];
        };
        const ops: Record<string, () => Promise<[number, number]>> = {
          'messages.list.page1': () => page('messages.list', false),
          'messages.list.page2': () => page('messages.list', true),
          'conversations.list.page1': () => page('conversations.list', false),
          'conversations.list.page2': () => page('conversations.list', true),
          'search.local.word': () => search('budget'),
          // A very common word (about 17% of the subjects). Slow on purpose: one sample per run.
          'search.local.commonWord': () => search('invoice'),
          'search.local.from': () => search('from:p42'),
          'search.local.phrase': () => search('"quarterly report"'),
          'search.local.body': () => search('boardroom'),
          'search.local.unreadWord': () => search('is:unread alpha'),
          'messages.get.cached': async () => {
            const id = cachedIds[getN++ % cachedIds.length]!;
            const t = performance.now();
            const r = (await handle('messages.get', { messageId: id })) as { text: string | null };
            return [performance.now() - t, r.text?.length ?? 0];
          },
        };
        add(
          m,
          'engine.messages.list.page1.firstCall',
          'ms',
          tReady - tFirst,
          'first call in a fresh engine',
        );
        for (const [name, fn] of Object.entries(ops)) {
          const single = name === 'search.local.commonWord';
          for (let i = 0; i <= (single ? 0 : WARM); i++) {
            const [ms, n] = await fn();
            counts[name] = n;
            if (single) {
              add(
                m,
                `engine.${name}`,
                'ms',
                ms,
                'one call per run (no warm-up): the slowest query',
              );
            } else if (i === 0) {
              if (name !== 'messages.list.page1') {
                add(m, `engine.${name}.firstCall`, 'ms', ms, 'first call in a fresh engine');
              }
            } else {
              add(m, `engine.${name}`, 'ms', ms);
            }
          }
        }

        // ----- memory -----
        const after = mem();
        add(
          m,
          'engine.memory.rss',
          'MB',
          after.rss,
          'whole vitest worker process, after GC and warm calls',
        );
        add(
          m,
          'engine.memory.heapUsed',
          'MB',
          after.heap,
          'JS heap in use, after GC and warm calls',
        );
        add(
          m,
          'engine.memory.rssGrowth',
          'MB',
          after.rss - before.rss,
          'RSS after warm calls minus RSS before this engine existed',
        );
        for (const [k, v] of [
          ['external', after.external],
          ['arrayBuffers', after.arrayBuffers],
        ] as const)
          add(m, `engine.memory.${k}`, 'MB', v, 'process.memoryUsage() after GC and warm calls');
        const facts = sqliteFacts(h.engine.ctx.db, dbFile);
        for (const [k, v] of Object.entries(facts))
          add(m, `engine.sqlite.${k}`, 'MB', v, 'SQLite setting or file size (not a timing)');
        await h.engine.shutdown();
      }

      // ----- dataset facts (so a changed seed is visible) -----
      const probe = openDatabase(dbFile);
      const one = (sql: string) => (probe.prepare(sql).get() as { n: number }).n;
      const dataset = {
        accounts: one('SELECT COUNT(*) n FROM account'),
        messages: one('SELECT COUNT(*) n FROM message'),
        unifiedInboxMessages: one(
          "SELECT COUNT(*) n FROM message m JOIN folder f ON f.id = m.folder_id WHERE f.role = 'inbox'",
        ),
        contacts: one('SELECT COUNT(*) n FROM contact'),
        conversations: one("SELECT COUNT(DISTINCT account_id || ':' || thread_id) n FROM message"),
        longConversations: one(
          'SELECT COUNT(*) n FROM (SELECT 1 FROM message GROUP BY account_id, thread_id HAVING COUNT(*) >= 10)',
        ),
        cachedBodies: one("SELECT COUNT(*) n FROM message WHERE body_state = 'cached'"),
        dbBytes: statSync(dbFile).size,
        seedVersion: SEED_VERSION,
        scale: SCALE,
      };
      probe.close();

      if (OUT)
        writeFileSync(OUT, JSON.stringify({ metrics: m, itemCounts: counts, dataset }, null, 2));
    } finally {
      await server.close();
      rmSync(work, { recursive: true, force: true });
    }
  }, 3_600_000);
});
