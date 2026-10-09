// The pending queue: persistence and merge rules (no network).
import { describe, expect, it } from 'vitest';
import { PendingQueue, type FlagPayload } from '../../src/engine/messages/pendingQueue';
import { makeAccount, makeCtx } from '../helpers';

function setup() {
  const t = makeCtx();
  t.ctx.accounts.insert(makeAccount(), 1);
  const changes: string[] = [];
  const q = new PendingQueue(t.ctx.db, () => 1000, (a) => changes.push(a));
  return { ...t, q, changes };
}

const flag = (over: Partial<FlagPayload> = {}): FlagPayload => ({
  msgId: 1,
  mid: '<a@x>',
  folderId: 1,
  col: 'flag_seen',
  value: true,
  prev: false,
  ...over,
});

describe('PendingQueue', () => {
  it('adds, counts and reports changes', () => {
    const { q, changes } = setup();
    q.addFlag('acc-1', flag());
    q.addFlag('acc-1', flag({ msgId: 2 }));
    expect(q.count('acc-1')).toBe(2);
    expect(changes.length).toBeGreaterThan(0);
    expect(q.messageIdsWithFlagOps('acc-1')).toEqual(new Set([1, 2]));
  });

  it('read then unread cancels out; a second change of another flag does not', () => {
    const { q } = setup();
    expect(q.addFlag('acc-1', flag())).toBe('added');
    expect(q.addFlag('acc-1', flag({ col: 'flag_flagged', value: true }))).toBe('added');
    expect(q.addFlag('acc-1', flag({ value: false, prev: true }))).toBe('cancelled');
    expect(q.count('acc-1')).toBe(1);
  });

  it('keeps one op when the value changes but is not back to the server value', () => {
    const { q } = setup();
    q.addFlag('acc-1', flag({ value: true, prev: false }));
    // (cannot happen with booleans except when merged twice: true -> false cancels, so check re-add)
    q.addFlag('acc-1', flag({ value: false, prev: true }));
    expect(q.count('acc-1')).toBe(0);
    q.addFlag('acc-1', flag({ value: true, prev: false }));
    expect(q.count('acc-1')).toBe(1);
  });

  it('does not merge into an op that is already being sent', () => {
    const { q } = setup();
    q.addFlag('acc-1', flag());
    q.setInFlight(q.forAccount('acc-1'), true);
    expect(q.addFlag('acc-1', flag({ value: false, prev: true }))).toBe('added');
    expect(q.count('acc-1')).toBe(2);
    expect(q.hasInFlight('acc-1', [1])).toBe(true);
  });

  it('survives a restart (loads from the table) and keeps the order', () => {
    const { q, ctx } = setup();
    q.addFlag('acc-1', flag({ msgId: 5 }));
    q.addMove('acc-1', {
      msgId: 6,
      mid: null,
      srcFolderId: 1,
      destFolderId: 2,
      origUid: 9,
      srcUv: 77,
    });
    q.addDelete('acc-1', { msgId: 7, mid: null, folderId: 2, uv: null });
    const again = new PendingQueue(ctx.db, () => 2000);
    expect(again.forAccount('acc-1').map((o) => [o.kind, (o.p as { msgId: number }).msgId])).toEqual([
      ['flag', 5],
      ['move', 6],
      ['delete', 7],
    ]);
    expect(again.findMove('acc-1', 6)?.p.srcUv).toBe(77);
  });

  it('a delete drops waiting flag changes of the same message', () => {
    const { q } = setup();
    q.addFlag('acc-1', flag({ msgId: 3 }));
    q.addFlag('acc-1', flag({ msgId: 4 }));
    q.addDelete('acc-1', { msgId: 3, mid: null, folderId: 1, uv: null });
    expect(q.forAccount('acc-1').map((o) => [o.kind, (o.p as { msgId: number }).msgId])).toEqual([
      ['flag', 4],
      ['delete', 3],
    ]);
  });

  it('batches only neighbours that can share one command', () => {
    const { q } = setup();
    q.addFlag('acc-1', flag({ msgId: 1 }));
    q.addFlag('acc-1', flag({ msgId: 2 }));
    q.addFlag('acc-1', flag({ msgId: 3, value: false, prev: true })); // other value
    q.addFlag('acc-1', flag({ msgId: 4 }));
    expect(q.nextBatch('acc-1').map((o) => (o.p as { msgId: number }).msgId)).toEqual([1, 2]);
    q.removeMany(q.nextBatch('acc-1'));
    expect(q.nextBatch('acc-1').map((o) => (o.p as { msgId: number }).msgId)).toEqual([3]);
  });

  it('counts failures and ignores unreadable rows', () => {
    const { q, ctx } = setup();
    q.addFlag('acc-1', flag());
    q.noteFailure(q.forAccount('acc-1'), 'timeout');
    expect(q.forAccount('acc-1')[0]!.attempts).toBe(1);
    ctx.db
      .prepare(
        "INSERT INTO pending_op (account_id, kind, payload_json, created_at) VALUES ('acc-1','flag','{oops',1)",
      )
      .run();
    const again = new PendingQueue(ctx.db, () => 0);
    expect(again.count('acc-1')).toBe(1);
    expect((ctx.db.prepare('SELECT COUNT(*) AS n FROM pending_op').get() as { n: number }).n).toBe(1);
  });

  it('keeps folder ops across a restart and never batches them', () => {
    const { q, ctx } = setup();
    q.addRaw('acc-1', 'folderCreate', { folderId: 5, path: 'A' });
    q.addRaw('acc-1', 'folderCreate', { folderId: 6, path: 'B' });
    q.addRaw('acc-1', 'replied', { msgId: 1, mid: null, folderId: 1, flag: '$Forwarded' });
    expect(q.nextBatch('acc-1')).toHaveLength(1);
    const again = new PendingQueue(ctx.db, () => 0);
    expect(again.forAccount('acc-1').map((o) => o.kind)).toEqual(['folderCreate', 'folderCreate', 'replied']);
    expect(again.lastFolderOp('acc-1')?.kind).toBe('folderCreate');
  });

  it('serverPath undoes waiting renames, also for folders below the renamed one', () => {
    const { q } = setup();
    q.addRaw('acc-1', 'folderRename', { folderId: 1, fromPath: 'A', toPath: 'B' });
    q.addRaw('acc-1', 'folderRename', { folderId: 1, fromPath: 'B', toPath: 'C' });
    expect(q.serverPath('acc-1', 'C', '/')).toBe('A');
    expect(q.serverPath('acc-1', 'C/Sub', '/')).toBe('A/Sub');
    expect(q.serverPath('acc-1', 'Other', '/')).toBe('Other');
    expect(q.serverPath('acc-1', 'CC', '/')).toBe('CC');
  });
});
