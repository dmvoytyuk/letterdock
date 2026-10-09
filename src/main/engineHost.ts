// Forks and supervises the engine utility process (ARCHITECTURE section 2).
import { utilityProcess, type UtilityProcess } from 'electron';
import type { AppEvent } from '../shared/ipc';
import { makeError, toAppError } from '../shared/errors';
import type { EngineInit } from '../shared/internal';
import { RpcPeer, type WireMessage } from '../shared/rpcPeer';
import type { Logger } from './logger';

export interface EngineHostOptions {
  entry: string;
  buildInit: () => EngineInit;
  onEvent: (e: AppEvent) => void;
  /** Requests initiated by the engine (secrets). */
  handleEngineRequest: (channel: string, payload: unknown) => Promise<unknown>;
  onFatal: () => void;
  log: Logger;
}

const MAX_RESTARTS = 5;
const RESTART_WINDOW_MS = 10 * 60_000;

export class EngineHost {
  private child: UtilityProcess | null = null;
  private peer: RpcPeer | null = null;
  private ready: Promise<void> = Promise.resolve();
  private restarts: number[] = [];
  private stopping = false;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly opts: EngineHostOptions) {}

  start(): void {
    this.spawn(false);
  }

  private spawn(isRestart: boolean): void {
    const child = utilityProcess.fork(this.opts.entry, [], { serviceName: 'mail-engine' });
    this.child = child;
    const peer = new RpcPeer(
      (msg) => child.postMessage(msg),
      (ch, p) => this.opts.handleEngineRequest(ch, p),
      (e) => this.opts.onEvent(e),
    );
    this.peer = peer;
    child.on('message', (msg: WireMessage) => peer.handleMessage(msg));
    child.on('exit', (code) => this.onExit(child, peer, code));
    this.ready = peer.request('engine.init', this.opts.buildInit(), 30_000).then(
      () => {
        if (isRestart) this.opts.onEvent({ type: 'engine:restarted' });
      },
      (e) => {
        this.opts.log.error({ err: toAppError(e) }, 'engine init failed');
        throw e;
      },
    );
    this.ready.catch(() => undefined);
  }

  private onExit(child: UtilityProcess, peer: RpcPeer, code: number): void {
    if (child !== this.child) return;
    peer.failAll(
      makeError('INTERNAL', 'The mail engine stopped. Restarting.', { retryable: true }),
    );
    this.child = null;
    this.peer = null;
    if (this.stopping) return;
    this.opts.log.error({ code }, 'engine exited unexpectedly');
    const now = Date.now();
    this.restarts = this.restarts.filter((t) => now - t < RESTART_WINDOW_MS);
    if (this.restarts.length >= MAX_RESTARTS) {
      this.opts.onFatal();
      return;
    }
    this.restarts.push(now);
    const delay = Math.min(1000 * 2 ** (this.restarts.length - 1), 30_000);
    this.restartTimer = setTimeout(() => this.spawn(true), delay);
  }

  async request<T = unknown>(channel: string, payload?: unknown): Promise<T> {
    await this.ready;
    if (!this.peer)
      throw makeError('INTERNAL', 'The mail engine is restarting. Try again.', { retryable: true });
    return this.peer.request<T>(channel, payload);
  }

  stop(): void {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.child?.kill();
    this.child = null;
  }
}
