// Renderer <-> main <-> engine routing. Validates channel + payload with zod, then dispatches.
import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import type { AppError, IpcChannel } from '../shared/ipc';
import { isMainChannel, type MainChannel } from '../shared/channels';
import { AppException, makeError, toAppError } from '../shared/errors';
import type { EngineHost } from './engineHost';
import type { Logger } from './logger';
import { isKnownChannel, schemas } from './ipcSchemas';

export type RpcEnvelope = { ok: true; value: unknown } | { ok: false; error: AppError };

export interface RouterDeps {
  engine: EngineHost;
  mainHandlers: Record<MainChannel, (req: never) => unknown>;
  /** Windows allowed to call the API (main window, later compose windows). */
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean;
  log: Logger;
}

/** Pure dispatch used by the IPC handler (and tests). */
export async function dispatch(
  deps: Pick<RouterDeps, 'engine' | 'mainHandlers' | 'log'>,
  channel: unknown,
  payload: unknown,
): Promise<RpcEnvelope> {
  try {
    if (!isKnownChannel(channel)) {
      throw new AppException('INVALID_INPUT', 'Unknown request.');
    }
    const parsed = schemas[channel as IpcChannel].safeParse(payload);
    if (!parsed.success) {
      throw new AppException('INVALID_INPUT', 'The request was not valid.', {
        details: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      });
    }
    const value = isMainChannel(channel)
      ? await deps.mainHandlers[channel](parsed.data as never)
      : await deps.engine.request(channel, parsed.data);
    return { ok: true, value };
  } catch (e) {
    const err = toAppError(e);
    if (err.code === 'INTERNAL') {
      deps.log.error({ channel: String(channel), details: err.details }, 'rpc failed');
    }
    return { ok: false, error: err };
  }
}

/** Requests that save the user's text. The app waits for these before it quits. */
const SAVE_CHANNELS = new Set(['compose.saveDraft', 'compose.discard', 'compose.send']);
const pendingSaves = new Set<Promise<unknown>>();

/** Resolves when the saves in progress are done, or after `timeoutMs`. */
export async function waitForPendingSaves(timeoutMs: number): Promise<void> {
  if (pendingSaves.size === 0) return;
  await Promise.race([
    Promise.allSettled([...pendingSaves]),
    new Promise((r) => setTimeout(r, timeoutMs)),
  ]);
}

export function registerIpc(deps: RouterDeps): void {
  ipcMain.handle('rpc', async (event, channel: unknown, payload: unknown): Promise<RpcEnvelope> => {
    if (!deps.isTrustedSender(event)) {
      return { ok: false, error: makeError('INVALID_INPUT', 'Request rejected.') };
    }
    const p = dispatch(deps, channel, payload);
    if (typeof channel === 'string' && SAVE_CHANNELS.has(channel)) {
      pendingSaves.add(p);
      void p.finally(() => pendingSaves.delete(p));
    }
    return p;
  });
}

export function broadcast(windows: () => BrowserWindow[], event: unknown): void {
  for (const w of windows()) {
    if (!w.isDestroyed()) w.webContents.send('event', event);
  }
}
