// mailto: handling (pure helpers; the Electron calls live in index.ts / handlers.ts).

const MAX_MAILTO_CHARS = 8000;

/**
 * Finds a mailto: link in a command line (Windows passes the clicked link as an argument).
 * Returns it only when it is plain text of a sane size, so nothing odd reaches the compose window.
 */
export function findMailtoArg(argv: readonly string[]): string | null {
  for (const raw of argv) {
    if (typeof raw !== 'string') continue;
    const arg = raw.trim();
    if (!/^mailto:/i.test(arg)) continue;
    if (arg.length > MAX_MAILTO_CHARS) continue;
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(arg)) continue;
    return arg;
  }
  return null;
}

export interface MailtoStatusInput {
  isPackaged: boolean;
  /** `app.isDefaultProtocolClient('mailto')`: our command is registered for mailto:. */
  registeredCommand: boolean;
  /** `app.getApplicationNameForProtocol('mailto:')`: who Windows would open (may be empty). */
  currentHandlerName: string;
  appName: string;
}

export function computeMailtoStatus(i: MailtoStatusInput): { registered: boolean; isDefault?: boolean } {
  if (!i.isPackaged) return { registered: false };
  const handler = i.currentHandlerName.trim().toLowerCase();
  const me = i.appName.trim().toLowerCase();
  return {
    registered: i.registeredCommand,
    isDefault: handler.length > 0 && me.length > 0 && handler === me,
  };
}

/** The only address ever passed to shell.openExternal for the Default apps page. */
export const DEFAULT_APPS_URI = 'ms-settings:defaultapps';
