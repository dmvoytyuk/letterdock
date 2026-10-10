// What happens when the user presses something on a notification (DESIGN-SPEC 3.13.3).
// Pure logic with injected parts, so it can be tested without Electron.
import type { AppEvent } from '../shared/ipc';
import { parseActivationArgs } from './toast';

export interface ToastActionDeps {
  /** Engine request (internal channel `notifications.action`). */
  engine: <T>(channel: string, payload?: unknown) => Promise<T>;
  /** The main window is on screen (not hidden in the tray, not minimized). */
  mainVisible: () => boolean;
  /** Sends an event to the main window only. */
  sendToMain: (e: AppEvent) => void;
  /** Bring the app to the front and open this message. */
  openMessage: (messageId: number) => void;
  /** A plain notification, for a button that could not do its work. */
  showPlain: (title: string, body: string) => void;
}

/**
 * `details` is what `Notification.handleActivation` gives. Anything that is not ours (wrong shape)
 * is ignored. A button runs in the background: no window comes to the front.
 */
export async function onToastActivation(
  d: ToastActionDeps,
  details: { arguments?: string; type?: string },
): Promise<void> {
  const a = parseActivationArgs(details.arguments);
  if (!a) return;
  if (a.action === 'open') {
    d.openMessage(a.messageId);
    return;
  }
  try {
    const res = await d.engine<{ done: boolean; undoToken?: string }>('notifications.action', {
      accountId: a.accountId,
      messageId: a.messageId,
      action: a.action,
    });
    // Gone, read or archived already: nothing to say. Hidden or in the tray: nothing more either.
    if (!res.done || !d.mainVisible()) return;
    d.sendToMain({
      type: 'notify:actionDone',
      action: a.action,
      accountId: a.accountId,
      messageId: a.messageId,
      ...(res.undoToken ? { undoToken: res.undoToken } : {}),
    });
  } catch {
    d.showPlain(
      a.action === 'archive' ? "Couldn't archive" : "Couldn't mark as read",
      'Open Letterdock to try again.',
    );
  }
}
