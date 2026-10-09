// The ONLY thing exposed to the renderer: window.api = { invoke, on }.
import { contextBridge, ipcRenderer } from 'electron';
import type { AppEvent, IpcChannel, PreloadApi } from '../shared/ipc';

type Envelope = { ok: true; value: unknown } | { ok: false; error: unknown };

const api: PreloadApi = {
  async invoke(channel: IpcChannel, ...args: unknown[]) {
    const env = (await ipcRenderer.invoke('rpc', channel, args[0])) as Envelope;
    // Rejects with a plain AppError object (Electron loses Error subclasses across IPC).
    if (!env.ok) throw env.error;
    return env.value as never;
  },
  on(cb: (e: AppEvent) => void) {
    const listener = (_: unknown, e: AppEvent) => cb(e);
    ipcRenderer.on('event', listener);
    return () => {
      ipcRenderer.removeListener('event', listener);
    };
  },
};

contextBridge.exposeInMainWorld('api', api);
