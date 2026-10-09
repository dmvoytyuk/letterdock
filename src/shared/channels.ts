import type { IpcChannel } from './ipc';

/** Channels handled by the main process itself. Every other channel goes to the engine. */
export const MAIN_CHANNELS = [
  'oauth.getSettings',
  'oauth.setSettings',
  'oauth.start',
  'oauth.complete',
  'oauth.cancel',
  'oauth.reauthorize',
  'attachments.open',
  'attachments.saveAs',
  'compose.pickFiles',
  'compose.openWindow',
  'message.openWindow',
  'message.print',
  'settings.get',
  'settings.set',
  'images.cacheInfo',
  'images.clearCache',
  'app.openExternal',
  'app.openLogs',
  'app.mailtoStatus',
  'app.openDefaultAppsSettings',
  'app.info',
  'log.write',
  'updates.status',
  'updates.check',
  'updates.install',
] as const satisfies readonly IpcChannel[];

export type MainChannel = (typeof MAIN_CHANNELS)[number];
export type EngineChannel = Exclude<IpcChannel, MainChannel>;

const mainSet = new Set<string>(MAIN_CHANNELS);
export function isMainChannel(c: string): c is MainChannel {
  return mainSet.has(c);
}
