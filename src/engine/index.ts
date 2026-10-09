// Entry point of the engine utility process (ARCHITECTURE section 2).
import { join } from 'node:path';
import type { AppSettings } from '../shared/ipc';
import type { Credential, EngineInit, OAuthSessionInfo } from '../shared/internal';
import { RpcPeer, type WireMessage } from '../shared/rpcPeer';
import { createEngine, type Engine } from './engine';
import { createLogger, type Logger } from './logger';

interface ParentPort {
  postMessage(msg: unknown): void;
  on(event: 'message', cb: (e: { data: unknown }) => void): void;
}

const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort;
if (!parentPort) {
  throw new Error('The engine must be started as an Electron utility process.');
}

let engine: Engine | null = null;
let settings: AppSettings | null = null;
let log: Logger | null = null;

const peer: RpcPeer = new RpcPeer(
  (msg) => parentPort.postMessage(msg),
  async (channel, payload) => {
    if (channel === 'engine.init') return init(payload as EngineInit);
    if (!engine) throw new Error('Engine not initialised');
    if (channel === 'engine.settings') {
      settings = payload as AppSettings;
      if (log) log.level = settings.verboseLogging ? 'debug' : 'info';
      return engine.handle(channel, payload);
    }
    return engine.handle(channel, payload);
  },
);

parentPort.on('message', (e) => peer.handleMessage(e.data as WireMessage));

async function init(i: EngineInit): Promise<void> {
  settings = i.settings;
  log = createLogger(join(i.dataDir, 'logs'), 'engine', i.settings.verboseLogging);
  engine = createEngine({
    dataDir: i.dataDir,
    nativeBinding: i.nativeBinding,
    log,
    settings: () => settings!,
    send: (event) => peer.emitEvent(event),
    secrets: {
      getCredential: (accountId, forceRefresh) =>
        peer.request<Credential>('secrets.getCredential', { accountId, forceRefresh }),
      set: (accountId, secret) => peer.request<void>('secrets.set', { accountId, secret }),
      delete: (accountId) => peer.request<void>('secrets.delete', { accountId }),
      peekOAuthSession: (sessionId) =>
        peer.request<OAuthSessionInfo>('secrets.peekOAuthSession', { sessionId }),
      adoptOAuthSession: (sessionId, accountId) =>
        peer.request<OAuthSessionInfo>('secrets.adoptOAuthSession', { sessionId, accountId }),
    },
  });
  log.info({ version: i.appVersion }, 'engine started');
  engine.start();
}

process.on('uncaughtException', (err) => {
  log?.fatal({ err: err.message, stack: err.stack }, 'uncaught exception in engine');
  // Main restarts the engine with backoff.
  setTimeout(() => process.exit(1), 50);
});
process.on('unhandledRejection', (reason) => {
  log?.error({ reason: String(reason) }, 'unhandled rejection in engine');
});
