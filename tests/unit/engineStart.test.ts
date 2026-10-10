// Engine start must not do full-table work when nothing is dirty (cold start speed).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEngine, type Engine } from '../../src/engine/engine';
import { openDatabase, type Db } from '../../src/engine/db/connection';
import { AccountRepo } from '../../src/engine/db/repos/accountRepo';
import { FolderRepo } from '../../src/engine/db/repos/folderRepo';
import { nullLogger } from '../../src/engine/logger';
import { DEFAULT_SETTINGS } from '../../src/main/settings';
import { header, makeAccount, makeCtx } from '../helpers';

const dirs: string[] = [];
const engines: Engine[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const e of engines.splice(0)) await e.shutdown().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function boot(dir: string, db: Db = openDatabase(join(dir, 'mail.db')), log = nullLogger()): Engine {
  const e = createEngine({
    dataDir: dir,
    db,
    send: () => undefined,
    log,
    settings: () => DEFAULT_SETTINGS,
    secrets: {
      getCredential: async () => ({ kind: 'password', password: 'x' }),
      set: async () => undefined,
      delete: async () => undefined,
    } as never,
    discoverDeps: { fetchText: async () => null, resolveMx: async () => [] },
  });
  engines.push(e);
  return e;
}

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'ld-start-'));
  dirs.push(d);
  return d;
}

describe('engine start', () => {
  it('recomputes the folder counts only when the marker is missing or different', async () => {
    const dir = tempDir();
    const spy = vi.spyOn(FolderRepo.prototype, 'recomputeAll');
    const first = boot(dir);
    first.start();
    expect(spy).toHaveBeenCalledTimes(1); // new database: no marker yet
    await first.shutdown();

    const second = boot(dir);
    second.start();
    expect(spy).toHaveBeenCalledTimes(1); // nothing dirty: no scan of the message table
    second.ctx.db.prepare("DELETE FROM kv WHERE k = 'folder_counts_marker'").run();
    await second.shutdown();

    const third = boot(dir);
    third.start();
    expect(spy).toHaveBeenCalledTimes(2); // marker gone (an older version, or a new migration)
  });

  it('does not read the message or contact tables while starting, and loads the contacts on first use', async () => {
    const dir = tempDir();
    const db = openDatabase(join(dir, 'mail.db'));
    new AccountRepo(db).insert(makeAccount(), 1);
    db.prepare(
      `INSERT INTO contact (account_id, address, name, name_ms, sent_count, recv_count, last_sent_ms, last_seen_ms)
       VALUES ('acc-1', 'anna@example.com', 'Anna Bell', 1, 0, 3, 0, 5)`,
    ).run();
    db.prepare("INSERT INTO kv (k, v) VALUES ('contacts.backfill', '1')").run(); // no re-learning
    // Run the one-time start work (the counts marker) once, as a first start would.
    const warm = boot(dir, db);
    warm.start();
    await warm.shutdown();

    const db2 = openDatabase(join(dir, 'mail.db'));
    const prepared: string[] = [];
    const real = db2.prepare.bind(db2);
    vi.spyOn(db2, 'prepare').mockImplementation(((sql: string) => {
      prepared.push(sql);
      return real(sql);
    }) as never);
    const e = boot(dir, db2);
    e.start();
    // (The snoozed-mail count reads only the small partial index idx_msg_snoozed.)
    const heavy = prepared
      .filter((s) => /FROM\s+(message|contact|contact_forgotten)\b/i.test(s))
      .filter((s) => !/snoozed_until IS NOT NULL/.test(s));
    expect(heavy).toEqual([]);
    // First use: the index is read then.
    const found = (await e.handle('contacts.suggest', { query: 'ann' })) as { address: string }[];
    expect(found.map((c) => c.address)).toEqual(['anna@example.com']);
    expect(prepared.some((s) => /FROM\s+contact\b/i.test(s))).toBe(true);
  });

  it('writes the start phases to the debug log', () => {
    const dir = tempDir();
    const calls: unknown[][] = [];
    const log = nullLogger();
    vi.spyOn(log, 'debug').mockImplementation(((...a: unknown[]) => void calls.push(a)) as never);
    boot(dir, undefined, log).start();
    const hit = calls.find((c) => c[1] === 'engine start phases');
    const phases = (hit?.[0] as { phasesMs: Record<string, number> }).phasesMs;
    expect(Object.keys(phases)).toEqual(expect.arrayContaining(['folderCounts', 'sessions', 'total']));
  });
});

describe('FolderRepo.recomputeAll', () => {
  it('gives the same numbers as recomputing each folder (deleted and snoozed mail not counted, empty folders 0)', () => {
    const { ctx, db } = makeCtx();
    ctx.accounts.insert(makeAccount(), 1);
    ctx.folders.syncListed('acc-1', [
      { path: 'INBOX', name: 'INBOX', delimiter: '/', role: 'inbox', subscribed: true, selectable: true },
      { path: 'Empty', name: 'Empty', delimiter: '/', role: null, subscribed: true, selectable: true },
    ]);
    const inbox = ctx.folders.rowByPath('acc-1', 'INBOX')!.id;
    const empty = ctx.folders.rowByPath('acc-1', 'Empty')!.id;
    ctx.messages.upsertHeaders([1, 2, 3, 4].map((uid) => header({ folderId: inbox, uid })));
    db.prepare('UPDATE message SET flag_seen = 1 WHERE uid = 1').run();
    db.prepare('UPDATE message SET flag_deleted = 1 WHERE uid = 2').run();
    db.prepare('UPDATE message SET snoozed_until = 99 WHERE uid = 3').run();
    db.prepare('UPDATE folder SET total_count = 77, unread_count = 66').run(); // wrong on purpose
    ctx.folders.recomputeAll();
    const all = db.prepare('SELECT id, total_count AS t, unread_count AS u FROM folder ORDER BY id').all();
    expect(all).toEqual([
      { id: inbox, t: 2, u: 1 },
      { id: empty, t: 0, u: 0 },
    ]);
    for (const f of all as { id: number; t: number; u: number }[]) {
      expect(ctx.folders.recomputeCounts(f.id)).toEqual({ total: f.t, unread: f.u });
    }
  });
});
