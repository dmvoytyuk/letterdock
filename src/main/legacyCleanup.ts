// Removes the old per-user install of "Mailroom" (0.2.9 and older) after Letterdock has taken over
// its data folder. Windows only. Free of Electron imports so the decisions can be unit tested.
//
// Why this is needed: the app id changed (app.mailroom -> app.letterdock), so the Letterdock
// installer does not replace Mailroom. It installs next to it, and the old copy stays until it is
// removed here. The old uninstaller is used first (it removes files, shortcuts and its registry
// keys). Whatever it leaves behind, for example when Windows blocks the unsigned uninstaller, is
// removed by hand afterwards. The data folder is never touched: the old uninstaller only deletes
// %APPDATA% data when it is started with --delete-app-data, and we do not pass that flag.
//
// Every registry entry and file is only removed when it points into the old install folder,
// because another program called "Mailroom" may exist on the same PC.
//
// Remove this file (and legacyMigration.ts) once nobody can still be updating from 0.2.9.
import { execFile, spawn, spawnSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const UNINSTALL_ROOT = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall';
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const STARTUP_APPROVED_KEY =
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run';
const OLD_PROGID_KEY = 'HKCU\\Software\\Classes\\Mailroom.Url.mailto';
const OLD_APP_KEY = 'HKCU\\Software\\Mailroom';
const REGISTERED_APPS_KEY = 'HKCU\\Software\\RegisteredApplications';

export const CLEANUP_MARKER = 'legacy-install-removed.json';

/** True when a path or command line points into the old install folder (...\Programs\mailroom\). */
export function pointsIntoLegacyInstall(text: string): boolean {
  return text.toLowerCase().replace(/\//g, '\\').includes('\\programs\\mailroom\\');
}

export interface RegValue {
  name: string;
  type: string;
  data: string;
}
export interface RegBlock {
  key: string;
  values: RegValue[];
}

/** Parses the text printed by `reg query` into keys with their values. */
export function parseRegQuery(text: string): RegBlock[] {
  const blocks: RegBlock[] = [];
  let cur: RegBlock | null = null;
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim() === '') continue;
    if (/^HKEY_/i.test(raw)) {
      cur = { key: raw.trim(), values: [] };
      blocks.push(cur);
      continue;
    }
    const m = /^\s+(.+?)\s+(REG_[A-Z_]+)\s*(.*)$/.exec(raw);
    if (m && cur) cur.values.push({ name: m[1]!, type: m[2]!, data: m[3] ?? '' });
  }
  return blocks;
}

export interface RunResult {
  code: number;
  stdout: string;
}

export interface CleanupDeps {
  /** %LOCALAPPDATA% */
  localAppData: string;
  /** %APPDATA% */
  appData: string;
  /** The user's desktop folder. */
  desktopDir: string;
  /** Folder that holds the marker file written when the cleanup is complete. */
  dataDir: string;
  run: (file: string, args: string[]) => Promise<RunResult>;
  /** Starts a program that keeps running after this process exits. False if it could not start. */
  spawnDetached: (file: string, args: string[]) => Promise<boolean>;
  /** Target of a .lnk shortcut, or null when it cannot be read. */
  readShortcutTarget: (lnk: string) => string | null;
  exists: (p: string) => boolean;
  removeDir: (p: string) => void;
  removeFile: (p: string) => void;
  writeFile: (p: string, text: string) => void;
  sleep: (ms: number) => Promise<void>;
  log: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
  };
  /** How long to wait for the old uninstaller before cleaning up by hand. */
  waitMs?: number;
  pollMs?: number;
  now?: () => Date;
}

export type CleanupResult = 'already-done' | 'nothing-found' | 'removed';

/** PowerShell that stops running copies of the old app (matched by their full path). */
const STOP_OLD_PS =
  'Get-CimInstance Win32_Process -Filter "Name=\'Mailroom.exe\'" | ' +
  "Where-Object { $_.ExecutablePath -and $_.ExecutablePath.ToLower().StartsWith(($env:LOCALAPPDATA + '\\Programs\\mailroom\\').ToLower()) } | " +
  'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }';

/** Synchronous version for the early data migration (runs before the app is ready). */
export function stopLegacyProcessesSync(): void {
  if (process.platform !== 'win32') return;
  spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', STOP_OLD_PS], {
    timeout: 20_000,
    windowsHide: true,
  });
}

export function nodeCleanupDeps(
  base: Pick<CleanupDeps, 'localAppData' | 'appData' | 'desktopDir' | 'dataDir' | 'log'> & {
    readShortcutTarget: CleanupDeps['readShortcutTarget'];
  },
): CleanupDeps {
  return {
    ...base,
    run: (file, args) =>
      new Promise((resolve) => {
        execFile(
          file,
          args,
          { windowsHide: true, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 },
          (err, stdout) => {
            const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
            resolve({ code, stdout: String(stdout ?? '') });
          },
        );
      }),
    spawnDetached: (file, args) =>
      new Promise((resolve) => {
        const child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: true });
        child.once('error', () => resolve(false));
        child.once('spawn', () => {
          child.unref();
          resolve(true);
        });
      }),
    exists: existsSync,
    removeDir: (p) => rmSync(p, { recursive: true, force: true }),
    removeFile: (p) => rmSync(p, { force: true }),
    writeFile: (p, t) => writeFileSync(p, t),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

export async function removeLegacyInstall(d: CleanupDeps): Promise<CleanupResult> {
  const marker = join(d.dataDir, CLEANUP_MARKER);
  if (d.exists(marker)) return 'already-done';

  const installDir = join(d.localAppData, 'Programs', 'mailroom');
  const uninstaller = join(installDir, 'Uninstall Mailroom.exe');
  const reg = async (args: string[]) => d.run('reg.exe', args);

  // Uninstall entries that belong to the old app (not to some other program named Mailroom).
  const findEntries = async (): Promise<string[]> => {
    const r = await reg(['query', UNINSTALL_ROOT, '/s', '/v', 'UninstallString']);
    return parseRegQuery(r.stdout)
      .filter((b) => b.values.some((v) => pointsIntoLegacyInstall(v.data)))
      .map((b) => b.key);
  };
  const entries = await findEntries();
  const hasInstall = d.exists(installDir);

  // Run entries (start at sign-in) and the mailto registration of the old app.
  const runR = await reg(['query', RUN_KEY]);
  const runNames = (parseRegQuery(runR.stdout)[0]?.values ?? [])
    .filter((v) => v.name.toLowerCase() === 'app.mailroom' || pointsIntoLegacyInstall(v.data))
    .map((v) => v.name);
  const cmdR = await reg(['query', `${OLD_PROGID_KEY}\\shell\\open\\command`, '/ve']);
  const hasMailto = parseRegQuery(cmdR.stdout).some((b) =>
    b.values.some((v) => pointsIntoLegacyInstall(v.data)),
  );
  const startMenu = join(
    d.appData,
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    'Mailroom.lnk',
  );
  const desktop = join(d.desktopDir, 'Mailroom.lnk');
  const ownLinks = [startMenu, desktop].filter((p) => {
    if (!d.exists(p)) return false;
    const t = d.readShortcutTarget(p);
    return t !== null && pointsIntoLegacyInstall(t);
  });

  const anything =
    entries.length > 0 || hasInstall || runNames.length > 0 || hasMailto || ownLinks.length > 0;
  const staleCache = join(d.localAppData, 'mailroom-updater');
  if (!anything && !d.exists(staleCache)) {
    d.writeFile(
      marker,
      JSON.stringify({ at: (d.now ?? (() => new Date()))().toISOString(), found: false }),
    );
    return 'nothing-found';
  }

  // 1. The old app must not be running while it is removed.
  if (hasInstall || entries.length > 0) {
    d.log.info('Removing the old Mailroom install');
    try {
      await d.run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', STOP_OLD_PS]);
    } catch (e) {
      d.log.warn(`Could not stop the old app: ${String(e)}`);
    }
    // 2. Its own uninstaller first. /S = silent. No --delete-app-data: user data stays.
    if (d.exists(uninstaller)) {
      const started = await d.spawnDetached(uninstaller, ['/S']).catch(() => false);
      if (!started) d.log.warn('Could not start the old uninstaller (blocked by Windows?)');
      const waitMs = started ? (d.waitMs ?? 60_000) : 0;
      const pollMs = d.pollMs ?? 1500;
      for (let t = 0; t < waitMs && d.exists(installDir); t += pollMs) await d.sleep(pollMs);
    }
    if (d.exists(installDir)) {
      d.log.warn('The old uninstaller left files behind. Removing them directly.');
      try {
        d.removeDir(installDir);
      } catch (e) {
        d.log.warn(`Could not remove ${installDir}: ${String(e)}`);
      }
    }
  }

  // 3. Whatever the uninstaller did not remove.
  for (const key of await findEntries()) {
    await reg(['delete', key, '/f']);
  }
  for (const name of runNames) {
    await reg(['delete', RUN_KEY, '/v', name, '/f']);
    await reg(['delete', STARTUP_APPROVED_KEY, '/v', name, '/f']);
  }
  if (hasMailto) {
    await reg(['delete', OLD_PROGID_KEY, '/f']);
    await reg(['delete', OLD_APP_KEY, '/f']);
    await reg(['delete', REGISTERED_APPS_KEY, '/v', 'Mailroom', '/f']);
  }
  for (const lnk of ownLinks) {
    try {
      d.removeFile(lnk);
    } catch (e) {
      d.log.warn(`Could not remove shortcut ${lnk}: ${String(e)}`);
    }
  }
  // Update download cache of the old app. Best effort: the installer that started us may still be
  // running from inside this folder.
  try {
    if (d.exists(staleCache)) d.removeDir(staleCache);
  } catch (e) {
    d.log.warn(`Could not remove ${staleCache}: ${String(e)}`);
  }

  const left = d.exists(installDir) || (await findEntries()).length > 0;
  if (left) {
    // Try again at the next start.
    d.log.warn('Some parts of the old Mailroom install are still there; will retry at next start');
    return 'removed';
  }
  d.writeFile(
    marker,
    JSON.stringify({ at: (d.now ?? (() => new Date()))().toISOString(), found: true }),
  );
  d.log.info('The old Mailroom install was removed');
  return 'removed';
}
