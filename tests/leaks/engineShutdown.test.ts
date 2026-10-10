// Engine shutdown leaves nothing behind: no timers or sockets stay active, the engine can be
// garbage-collected (nothing keeps a reference to it), and 10 create -> shutdown cycles do not grow
// the JS heap. A leftover timer closure used to keep a whole engine alive for 30 s (about 6 MB per
// engine on a big mailbox), which this catches.
import { createHook } from 'node:async_hooks';
import { runInNewContext } from 'node:vm';
import { setFlagsFromString } from 'node:v8';
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, waitForInboxCursors, type Harness } from '../fakes/engineHarness';
import { rawMessage, startFakeImap, type FakeImapServer } from '../fakes/fakeImapServer';

setFlagsFromString('--expose-gc');
const forceGc = runInNewContext('gc') as () => void;
const gc = async (): Promise<void> => {
  // A WeakRef target is only released after the next turn of the event loop.
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, 0));
    forceGc();
  }
};
const heapMb = async (): Promise<number> => {
  await gc();
  return process.memoryUsage().heapUsed / 1_048_576;
};

const HOUR = 3_600_000;
const inbox = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    raw: rawMessage({ subject: `Leak ${i}`, messageId: `<leak-${i}@fake.test>` }),
    flags: [] as string[],
    internaldate: new Date(Date.now() - (i + 1) * HOUR),
  }));

let server: FakeImapServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

/** One full life: boot, add an account, sync, use it, shut down. Returns a weak reference to the engine. */
async function lifeCycle(srv: FakeImapServer): Promise<WeakRef<object>> {
  const h: Harness = await createHarness(srv, { settings: { groupConversations: true } });
  h.engine.start();
  const acc = await h.addAccount();
  await waitForInboxCursors(h, [acc.id]);
  const req = { scope: { kind: 'unifiedInbox' }, cursor: null, limit: 50 };
  await h.engine.handle('messages.list', req);
  await h.engine.handle('conversations.list', req);
  await h.engine.handle('search.local', { query: 'leak', limit: 20 });
  const ref = new WeakRef(h.engine);
  await h.cleanup();
  return ref;
}

describe('engine shutdown', () => {
  it('leaves no timer behind, even one that does not keep the process alive', async () => {
    // process.getActiveResourcesInfo() does not list unref'd timers, so watch every timer directly.
    const live = new Map<number, string>();
    const hook = createHook({
      init(id, type, _trigger, resource) {
        if (type !== 'Timeout') return;
        const fn = (resource as { _onTimeout?: () => void })._onTimeout;
        live.set(id, String(fn).slice(0, 90));
      },
      destroy(id) {
        live.delete(id);
      },
    });
    server = await startFakeImap({ inbox: inbox(10) });
    await lifeCycle(server); // warm-up
    await new Promise((r) => setTimeout(r, 200));
    hook.enable();
    try {
      await lifeCycle(server);
      await new Promise((r) => setTimeout(r, 200)); // destroy events arrive a tick later
      await server.close();
      server = null;
      await new Promise((r) => setImmediate(r)); // not a timer: the test's own waits are done
      expect([...live.values()], 'timers still waiting after shutdown').toEqual([]);
    } finally {
      hook.disable();
    }
  });


  it('leaves no active timers, sockets or handles', async () => {
    server = await startFakeImap({ inbox: inbox(20) });
    await lifeCycle(server); // warm-up: lazy module loads may open handles once
    await server.close();
    server = await startFakeImap({ inbox: inbox(20) });
    await gc();
    const count = (l: string[]) => {
      const m: Record<string, number> = {};
      for (const k of l) m[k] = (m[k] ?? 0) + 1;
      return m;
    };
    const before = count(process.getActiveResourcesInfo());
    await lifeCycle(server);
    await new Promise((r) => setTimeout(r, 100)); // closing sockets finish on the next ticks
    const after = count(process.getActiveResourcesInfo());
    // Only the fake server's own listening socket (and its open connections) may differ; it is
    // closed in afterEach, so compare everything that is not a socket.
    for (const kind of Object.keys(after)) {
      if (/TCP|Pipe|TLS/i.test(kind)) continue;
      expect(after[kind] ?? 0, `active ${kind}`).toBeLessThanOrEqual(before[kind] ?? 0);
    }
    await server.close();
    server = null;
    await new Promise((r) => setTimeout(r, 100));
    const closed = count(process.getActiveResourcesInfo());
    for (const kind of Object.keys(closed)) {
      expect(closed[kind] ?? 0, `active ${kind} after the server closed`).toBeLessThanOrEqual(
        before[kind] ?? 0,
      );
    }
  });

  it('lets the engine be garbage-collected after shutdown', async () => {
    server = await startFakeImap({ inbox: inbox(10) });
    const ref = await lifeCycle(server);
    await new Promise((r) => setTimeout(r, 100));
    await gc();
    expect(ref.deref(), 'the engine is still referenced after shutdown').toBeUndefined();
  });

  it('does not grow the heap over 10 create / shutdown cycles', async () => {
    server = await startFakeImap({ inbox: inbox(40) });
    await lifeCycle(server);
    await lifeCycle(server);
    const base = await heapMb();
    for (let i = 0; i < 10; i++) await lifeCycle(server);
    const growth = (await heapMb()) - base;
    console.log(`[leak] 10 cycles grew the heap by ${growth.toFixed(2)} MB`);
    expect(growth, `heap grew ${growth.toFixed(2)} MB`).toBeLessThan(2);
  });

  it('shutdown can be called twice', async () => {
    server = await startFakeImap({ inbox: inbox(3) });
    const h = await createHarness(server);
    h.engine.start();
    await h.engine.shutdown();
    await expect(h.engine.shutdown()).resolves.toBeUndefined();
    if (h.dataDir) await h.cleanup();
  });
});
