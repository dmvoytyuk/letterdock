// Pure decisions for running in the background (tray, close to tray, start hidden, login item).
// Kept free of Electron imports so they can be unit tested.
import type { AppSettings } from '../shared/ipc';

/** Argument added to the login item so a start at sign-in can stay hidden. */
export const HIDDEN_ARG = '--hidden';

/** Start without showing the window: only when launched at sign-in and the setting is on. */
export function shouldStartHidden(
  argv: readonly string[],
  s: Pick<AppSettings, 'startMinimizedToTray'>,
  trayAvailable: boolean,
): boolean {
  return s.startMinimizedToTray && trayAvailable && argv.includes(HIDDEN_ARG);
}

/** What closing the main window does. */
export function mainCloseAction(
  s: Pick<AppSettings, 'closeToTray'>,
  isQuitting: boolean,
  trayAvailable: boolean,
): 'close' | 'hide' {
  return !isQuitting && s.closeToTray && trayAvailable ? 'hide' : 'close';
}

/** Options for `app.setLoginItemSettings`. */
export function loginItemOptions(
  s: Pick<AppSettings, 'launchAtLogin' | 'startMinimizedToTray'>,
): { openAtLogin: boolean; args: string[] } {
  return { openAtLogin: s.launchAtLogin, args: s.startMinimizedToTray ? [HIDDEN_ARG] : [] };
}

export function trayTooltip(unread: number): string {
  return unread > 0 ? `Mailroom - ${unread} unread` : 'Mailroom';
}

/** A second launch that only carries the login-item argument must not pop the window up. */
export function isHiddenOnlyLaunch(argvWithoutExe: readonly string[], hasMailto: boolean): boolean {
  return !hasMailto && argvWithoutExe.includes(HIDDEN_ARG);
}
