// Tiny symmetric request/response layer used between main and the engine process.
// Pure TS: the transport (utility process port) is injected.
import type { AppError, AppEvent } from './ipc';
import { makeError, toAppError } from './errors';

export type WireMessage =
  | { t: 'req'; id: number; ch: string; p: unknown }
  | { t: 'res'; id: number; ok: true; v: unknown }
  | { t: 'res'; id: number; ok: false; e: AppError }
  | { t: 'evt'; e: AppEvent };

export type RequestHandler = (channel: string, payload: unknown) => Promise<unknown>;

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: AppError) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

export class RpcPeer {
  private nextId = 1;
  private pending = new Map<number, Pending>();

  constructor(
    private readonly send: (msg: WireMessage) => void,
    private readonly handler: RequestHandler,
    private readonly onEvent: (e: AppEvent) => void = () => {},
  ) {}

  request<T = unknown>(channel: string, payload?: unknown, timeoutMs = 0): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const entry: Pending = {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer: null,
      };
      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(makeError('TIMEOUT', `Request ${channel} timed out.`));
        }, timeoutMs);
      }
      this.pending.set(id, entry);
      try {
        this.send({ t: 'req', id, ch: channel, p: payload });
      } catch (e) {
        this.pending.delete(id);
        if (entry.timer) clearTimeout(entry.timer);
        reject(toAppError(e));
      }
    });
  }

  emitEvent(e: AppEvent): void {
    this.send({ t: 'evt', e });
  }

  /** Feed an incoming wire message. */
  handleMessage(msg: WireMessage): void {
    if (msg.t === 'evt') {
      this.onEvent(msg.e);
    } else if (msg.t === 'req') {
      this.handler(msg.ch, msg.p).then(
        (v) => this.send({ t: 'res', id: msg.id, ok: true, v }),
        (err) => this.send({ t: 'res', id: msg.id, ok: false, e: toAppError(err) }),
      );
    } else {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (entry.timer) clearTimeout(entry.timer);
      if (msg.ok) entry.resolve(msg.v);
      else entry.reject(msg.e);
    }
  }

  /** Reject everything in flight (engine died / shutting down). */
  failAll(error: AppError): void {
    for (const [, entry] of this.pending) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }
}
