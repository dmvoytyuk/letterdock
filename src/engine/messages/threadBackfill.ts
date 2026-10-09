// One-time pass over messages stored before conversations existed (migration 007 gave each one its
// own conversation). Runs in small chunks so the engine stays responsive; resumes after a restart.
import type { EngineContext } from '../context';

const CHUNK = 400;
const PAUSE_MS = 8;
const KEY = 'threads_backfill_id';

function getKv(ctx: EngineContext, key: string): string | null {
  const r = ctx.db.prepare('SELECT v FROM kv WHERE k = ?').get(key) as { v: string } | undefined;
  return r?.v ?? null;
}
function setKv(ctx: EngineContext, key: string, value: string): void {
  ctx.db
    .prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
    .run(key, value);
}

export class ThreadBackfill {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private finished: Promise<void> = Promise.resolve();

  constructor(private readonly ctx: EngineContext) {}

  /** Start in the background. Resolves `whenDone()` when every old row is threaded. */
  start(): void {
    this.stopped = false;
    if (getKv(this.ctx, 'threads_backfill_done') === '1') return;
    this.finished = new Promise<void>((resolve) => {
      const step = () => {
        this.timer = null;
        if (this.stopped) return resolve();
        try {
          const after = Number(getKv(this.ctx, KEY) ?? '0');
          const res = this.ctx.messages.threads.backfillChunk(after, CHUNK);
          setKv(this.ctx, KEY, String(res.lastId));
          if (res.touched.length > 0) {
            this.ctx.messages.touchThreads(res.touched);
            this.ctx.hub.touchThreads();
          }
          if (res.done) {
            setKv(this.ctx, 'threads_backfill_done', '1');
            return resolve();
          }
        } catch (e) {
          this.ctx.log.warn({ err: String((e as Error)?.message ?? e) }, 'conversation backfill failed');
          return resolve();
        }
        this.timer = setTimeout(step, PAUSE_MS);
        this.timer.unref?.();
      };
      this.timer = setTimeout(step, 0);
      this.timer.unref?.();
    });
  }

  whenDone(): Promise<void> {
    return this.finished;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
