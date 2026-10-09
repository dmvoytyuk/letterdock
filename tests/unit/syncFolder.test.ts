// Sync logic against an in-memory fake of the imapflow client surface. No network.
import { beforeEach, describe, expect, it } from 'vitest';
import type { ImapFlow } from 'imapflow';
import { loadOlder, syncFolder } from '../../src/engine/imap/syncFolder';
import { makeAccount, makeCtx } from '../helpers';

interface FakeMsg {
  uid: number;
  flags: Set<string>;
  internalDate: Date;
  modseq: bigint;
  subject: string;
}

class FakeImap {
  msgs: FakeMsg[] = [];
  uidValidity = 100n;
  condstore = false;
  modseq = 1n;
  calls: string[] = [];
  failFetchAfter: number | null = null;
  private fetches = 0;

  add(uid: number, daysAgo = 1, flags: string[] = []): void {
    this.modseq++;
    this.msgs.push({
      uid,
      flags: new Set(flags),
      internalDate: new Date(1_700_000_000_000 - daysAgo * 86_400_000),
      modseq: this.modseq,
      subject: `msg ${uid}`,
    });
  }
  setFlags(uid: number, flags: string[]): void {
    this.modseq++;
    const m = this.msgs.find((x) => x.uid === uid)!;
    m.flags = new Set(flags);
    m.modseq = this.modseq;
  }
  expunge(uid: number, bumpModseq = true): void {
    if (bumpModseq) this.modseq++;
    this.msgs = this.msgs.filter((m) => m.uid !== uid);
  }
  get maxUid(): number {
    return this.msgs.reduce((a, m) => Math.max(a, m.uid), 0);
  }

  async mailboxOpen() {
    this.calls.push('open');
    return {
      path: 'INBOX',
      uidValidity: this.uidValidity,
      uidNext: this.maxUid + 1,
      exists: this.msgs.length,
      highestModseq: this.condstore ? this.modseq : undefined,
    };
  }

  private expand(range: string): Set<number> {
    const out = new Set<number>();
    for (const part of range.split(',')) {
      const [a, b] = part.split(':');
      const lo = a === '*' ? this.maxUid : Number(a);
      const hi = b === undefined ? lo : b === '*' ? this.maxUid : Number(b);
      for (let u = Math.min(lo, hi); u <= Math.max(lo, hi); u++) out.add(u);
    }
    return out;
  }

  async search(q: { since?: Date; uid?: string }) {
    this.calls.push('search');
    let list = this.msgs;
    if (q.since) list = list.filter((m) => m.internalDate >= q.since!);
    if (q.uid) {
      const set = this.expand(q.uid);
      list = list.filter((m) => set.has(m.uid));
    }
    return list.map((m) => m.uid);
  }

  async fetchAll(range: string, query: Record<string, unknown>, opts: { changedSince?: bigint }) {
    this.calls.push(opts.changedSince !== undefined ? 'fetch-changedsince' : 'fetch');
    this.fetches++;
    if (this.failFetchAfter !== null && this.fetches > this.failFetchAfter) {
      throw new Error('connection lost');
    }
    const set = this.expand(range);
    return this.msgs
      .filter((m) => set.has(m.uid))
      .filter((m) => opts.changedSince === undefined || m.modseq > opts.changedSince)
      .map((m) => ({
        seq: m.uid,
        uid: m.uid,
        flags: m.flags,
        size: 500,
        internalDate: m.internalDate,
        modseq: this.condstore ? m.modseq : undefined,
        ...(query.envelope
          ? {
              envelope: {
                subject: m.subject,
                messageId: `<${m.uid}@x>`,
                date: m.internalDate,
                from: [{ name: 'A', address: 'a@x.com' }],
                to: [{ address: 'me@example.com' }],
              },
              bodyStructure: { type: 'text/plain' },
            }
          : {}),
      }));
  }
}

function setup(role: 'inbox' | null = 'inbox') {
  const t = makeCtx();
  t.ctx.accounts.insert(makeAccount(), 1);
  t.ctx.folders.syncListed('acc-1', [
    {
      path: role ? 'INBOX' : 'Other',
      name: role ? 'INBOX' : 'Other',
      delimiter: '/',
      role,
      subscribed: true,
      selectable: true,
    },
  ]);
  const folder = () => t.ctx.folders.rowsForAccount('acc-1')[0];
  const fake = new FakeImap();
  const run = () => syncFolder(t.ctx, fake as unknown as ImapFlow, folder(), 90);
  const uids = () => t.ctx.messages.flagRows(folder().id).map((r) => r.uid);
  return { ...t, fake, run, folder, uids };
}

describe('initial sync', () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup();
  });

  it('downloads recent headers, stores cursors, updates counts and emits progress', async () => {
    s.fake.add(1, 2);
    s.fake.add(2, 1, ['\\Seen']);
    s.fake.add(3, 200); // outside the 90 day window
    const res = await s.run();
    expect(res.kind).toBe('initial');
    expect(s.uids()).toEqual([1, 2]);
    const f = s.folder();
    expect(f.uidvalidity).toBe(100);
    expect(f.uidnext).toBe(4);
    expect(f.oldest_synced_uid).toBe(1);
    expect(f.history_complete).toBe(0); // uid 3 is older than the window and was not fetched
    expect(f.total_count).toBe(2);
    expect(f.unread_count).toBe(1);
    expect(s.events.some((e) => e.type === 'sync:progress' && e.phase === 'initial')).toBe(true);
    s.ctx.hub.flush();
    expect(s.events.some((e) => e.type === 'messages:changed' && e.added.length === 2)).toBe(true);
  });

  it('records an empty folder as synced and ends with an idle progress event', async () => {
    const res = await s.run();
    expect(res.kind).toBe('initial');
    const f = s.folder();
    expect(f.uidnext).toBe(1);
    expect(f.uidvalidity).toBe(100);
    expect(f.history_complete).toBe(1);
    const prog = s.events.filter((e) => e.type === 'sync:progress');
    expect(prog[prog.length - 1]).toMatchObject({ phase: 'idle' });
  });

  it('stays synced and ends idle after every message is removed on the server', async () => {
    s.fake.add(1);
    s.fake.add(2);
    await s.run();
    s.fake.expunge(1);
    s.fake.expunge(2);
    s.events.length = 0;
    await s.run();
    expect(s.folder().uidnext).not.toBeNull();
    expect(s.uids()).toEqual([]);
    const prog = s.events.filter((e) => e.type === 'sync:progress');
    expect(prog[prog.length - 1]).toMatchObject({ phase: 'idle' });
  });

  it('marks history complete when the whole mailbox fit', async () => {
    s.fake.add(1);
    await s.run();
    expect(s.folder().history_complete).toBe(1);
  });

  it('limits the first sync (200 for non-inbox) and load-older pages the rest in', async () => {
    const o = setup(null);
    for (let u = 1; u <= 250; u++) o.fake.add(u, 1);
    await o.run();
    expect(o.uids()).toHaveLength(200);
    expect(o.folder().oldest_synced_uid).toBe(51);
    expect(o.folder().history_complete).toBe(0);
    const res = await loadOlder(o.ctx, o.fake as unknown as ImapFlow, o.folder().id);
    expect(res).toEqual({ fetched: 50, reachedStart: true });
    expect(o.uids()).toHaveLength(250);
    expect(o.folder().history_complete).toBe(1);
    expect(await loadOlder(o.ctx, o.fake as unknown as ImapFlow, o.folder().id)).toEqual({
      fetched: 0,
      reachedStart: true,
    });
  });

  it('is resumable: an interrupted sync saves no cursors and the retry completes', async () => {
    const o = setup(null);
    for (let u = 1; u <= 150; u++) o.fake.add(u, 1);
    o.fake.failFetchAfter = 1; // first batch of 100 succeeds, second fails
    await expect(o.run()).rejects.toThrow('connection lost');
    expect(o.folder().uidvalidity).toBeNull();
    expect(o.uids().length).toBe(100);
    o.fake.failFetchAfter = null;
    await o.run();
    expect(o.uids()).toHaveLength(150);
    expect(o.folder().uidvalidity).toBe(100);
  });
});

describe('incremental sync and queued flag changes', () => {
  it('does not overwrite the flags of a message whose change is still waiting to be sent', async () => {
    const s = setup();
    s.fake.add(1);
    s.fake.add(2);
    await s.run();
    const ids = s.ctx.messages.flagRows(s.folder().id).map((r) => r.id);
    // Locally both were marked read, but the server has not been told yet (queued).
    s.ctx.messages.setFlagColumn(ids, 'flag_seen', true);
    s.ctx.pendingOps = {
      count: () => 1,
      flush: async () => undefined,
      barrier: async () => undefined,
      messageIdsWithFlagOps: () => new Set([ids[0]!]),
      forgetAccount: () => undefined,
    };
    // Someone else flags both on the server.
    s.fake.setFlags(1, ['\\Flagged']);
    s.fake.setFlags(2, ['\\Flagged']);
    await s.run();
    const rows = s.ctx.messages.flagRows(s.folder().id);
    // Message 1 keeps our unsent change (seen), message 2 follows the server (unseen again).
    expect(rows.find((r) => r.uid === 1)).toMatchObject({ seen: true });
    expect(rows.find((r) => r.uid === 2)).toMatchObject({ seen: false, flagged: true });
  });
});

describe('incremental sync without CONDSTORE', () => {
  it('picks up new mail, flag changes and expunges', async () => {
    const s = setup();
    s.fake.add(1);
    s.fake.add(2);
    s.fake.add(3);
    await s.run();

    s.fake.add(4);
    s.fake.setFlags(1, ['\\Seen', '\\Flagged']);
    s.fake.expunge(2);
    const res = await s.run();
    expect(res.kind).toBe('incremental');
    expect(s.uids()).toEqual([1, 3, 4]);
    const rows = s.ctx.messages.flagRows(s.folder().id);
    expect(rows.find((r) => r.uid === 1)).toMatchObject({ seen: true, flagged: true });
    expect(res.added).toHaveLength(1);
    expect(res.removed).toHaveLength(1);
    expect(res.newUnread).toHaveLength(1);
    expect(s.folder().uidnext).toBe(5);
    expect(s.folder().unread_count).toBe(2); // uid 3 and 4 unread
  });

  it('does not duplicate when run twice with nothing new', async () => {
    const s = setup();
    s.fake.add(1);
    await s.run();
    await s.run();
    expect(s.uids()).toEqual([1]);
  });

  it('handles an emptied mailbox', async () => {
    const s = setup();
    s.fake.add(1);
    s.fake.add(2);
    await s.run();
    s.fake.expunge(1);
    s.fake.expunge(2);
    await s.run();
    expect(s.uids()).toEqual([]);
    expect(s.folder().total_count).toBe(0);
  });
});

describe('incremental sync with CONDSTORE', () => {
  it('does nothing (no fetches) when HIGHESTMODSEQ and UIDNEXT are unchanged', async () => {
    const s = setup();
    s.fake.condstore = true;
    s.fake.add(1);
    await s.run();
    s.fake.calls.length = 0;
    const res = await s.run();
    expect(res.kind).toBe('unchanged');
    expect(s.fake.calls.filter((c) => c.startsWith('fetch') || c === 'search')).toEqual([]);
  });

  it('still notices an expunge that leaves HIGHESTMODSEQ and UIDNEXT unchanged', async () => {
    const s = setup();
    s.fake.condstore = true;
    s.fake.add(1);
    s.fake.add(2);
    await s.run();
    s.fake.expunge(1, false);
    const res = await s.run();
    expect(res.kind).toBe('incremental');
    expect(s.uids()).toEqual([2]);
    expect(s.folder().server_exists).toBe(1);
  });

  it('fetches only changed flags via CHANGEDSINCE and detects expunges by UID search', async () => {
    const s = setup();
    s.fake.condstore = true;
    s.fake.add(1);
    s.fake.add(2);
    await s.run();
    s.fake.calls.length = 0;
    s.fake.setFlags(2, ['\\Seen']);
    s.fake.add(3);
    s.fake.expunge(1);
    const res = await s.run();
    expect(s.fake.calls).toContain('fetch-changedsince');
    expect(s.uids()).toEqual([2, 3]);
    expect(s.ctx.messages.flagRows(s.folder().id).find((r) => r.uid === 2)?.seen).toBe(true);
    expect(res.removed).toHaveLength(1);
    expect(s.folder().highestmodseq).toBe(s.fake.modseq.toString());
  });
});

describe('UIDVALIDITY change', () => {
  it('purges the folder and runs the initial sync again', async () => {
    const s = setup();
    s.fake.add(1);
    s.fake.add(2);
    await s.run();
    const oldIds = s.ctx.messages.idsForFolder(s.folder().id);
    s.fake.uidValidity = 200n;
    s.fake.msgs = [];
    s.fake.add(1);
    const res = await s.run();
    expect(res.kind).toBe('initial');
    expect(s.uids()).toEqual([1]);
    expect(s.folder().uidvalidity).toBe(200);
    expect(s.ctx.messages.idsForFolder(s.folder().id)).not.toEqual(oldIds);
    s.ctx.hub.flush();
    const removed = s.events
      .filter((e) => e.type === 'messages:changed')
      .flatMap((e) => (e.type === 'messages:changed' ? e.removed : []));
    expect(removed.sort()).toEqual([...oldIds].sort());
  });
});
