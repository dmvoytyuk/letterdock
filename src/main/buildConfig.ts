// Build-time constants (ARCHITECTURE section 0, item 3).
// A Microsoft client ID is a public identifier, not a secret. The project registers one app
// (Appendix A) and puts its ID here before release. Dev builds may set LETTERDOCK_MS_CLIENT_ID.
//
// The product was called "Mailroom" until 0.2.9. The old MAILROOM_* names are still read as a
// fallback for one release (remove together with legacyMigration.ts).
export function readEnv(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env[`LETTERDOCK_${name}`] ?? env[`MAILROOM_${name}`];
}

export const BUILT_IN_MICROSOFT_CLIENT_ID: string | null = readEnv('MS_CLIENT_ID')?.trim() || null;

export const APP_ID = 'app.letterdock';
export const APP_NAME = 'Letterdock';

export const DEV_APP_ID = `${APP_ID}.dev`;

// Unpackaged runs (npm run dev, electron.exe) must never share the installed app's AppUserModelID,
// or Windows can attach the installed app's taskbar/Start entries to electron.exe.
export function resolveAppUserModelId(isPackaged: boolean): string {
  return isPackaged ? APP_ID : DEV_APP_ID;
}
