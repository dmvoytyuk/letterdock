// Build-time constants (ARCHITECTURE section 0, item 3).
// A Microsoft client ID is a public identifier, not a secret. The project registers one app
// (Appendix A) and puts its ID here before release. Dev builds may set MAILROOM_MS_CLIENT_ID.
export const BUILT_IN_MICROSOFT_CLIENT_ID: string | null =
  process.env.MAILROOM_MS_CLIENT_ID?.trim() || null;

export const APP_ID = 'app.mailroom';
export const APP_NAME = 'Mailroom';

export const DEV_APP_ID = `${APP_ID}.dev`;

// Unpackaged runs (npm run dev, electron.exe) must never share the installed app's AppUserModelID,
// or Windows can attach the installed app's taskbar/Start entries to electron.exe.
export function resolveAppUserModelId(isPackaged: boolean): string {
  return isPackaged ? APP_ID : DEV_APP_ID;
}
