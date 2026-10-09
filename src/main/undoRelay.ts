// A message window that archives / deletes / moves a message closes itself. The Undo for that must
// not die with it: it is shown as the normal toast in the main window.
import type { AppEvent } from '../shared/ipc';

/** The part of a BrowserWindow this needs (so it can be tested without Electron). */
export interface RelayTarget {
  isDestroyed(): boolean;
  isVisible(): boolean;
  isMinimized(): boolean;
  webContents: { send(channel: string, ...args: unknown[]): void };
}

/**
 * Sends `ui:undoAvailable` to the main window ONLY (not to every window). Returns false when the user
 * cannot see a main window (closed, hidden in the tray, minimized): the toast would be missed, so the
 * message window keeps its own Undo panel.
 */
export function relayUndoToMain(
  main: RelayTarget | null,
  e: { label: string; undoToken: string; count: number },
): boolean {
  if (!main || main.isDestroyed() || !main.isVisible() || main.isMinimized()) return false;
  const event: AppEvent = { type: 'ui:undoAvailable', label: e.label, undoToken: e.undoToken, count: e.count };
  main.webContents.send('event', event);
  return true;
}
