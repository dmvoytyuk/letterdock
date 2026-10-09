import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MIGRATION_MARKER, migrateUserData } from '../../src/main/legacyMigration';
import {
  CLEANUP_MARKER,
  parseRegQuery,
  pointsIntoLegacyInstall,
  removeLegacyInstall,
  type CleanupDeps,
} from '../../src/main/legacyCleanup';
import { readEnv } from '../../src/main/buildConfig';

let root: string;
let oldDir: string;
let newDir: string;

function seedOld(): void {
  mkdirSync(join(oldDir, 'image-cache'), { recursive: true });
  mkdirSync(join(oldDir, 'logs'), { recursive: true });
  writeFileSync(join(oldDir, 'settings.json'), '{"a":1}');
  writeFileSync(join(oldDir, 'mail.db'), 'DB-BYTES');
  writeFileSync(join(oldDir, 'mail.db-wal'), 'WAL-BYTES');
  writeFileSync(join(oldDir, 'mail.db-shm'), 'SHM');
  writeFileSync(join(oldDir, 'secrets.bin'), 'SECRET');
  writeFileSync(join(oldDir, 'Local State'), '{"os_crypt":{}}');
  writeFileSync(join(oldDir, 'window-state.json'), '{}');
  writeFileSync(join(oldDir, 'image-cache', 'a.bin'), 'img');
  writeFileSync(join(oldDir, 'lockfile'), '');
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'letterdock-mig-'));
  oldDir = join(root, 'Mailroom');
  newDir = join(root, 'Letterdock');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('migrateUserData', () => {
  it('does nothing when there is no old folder', () => {
    const r = migrateUserData({ oldDir, newDir });
    expect(r.status).toBe('none');
    expect(existsSync(newDir)).toBe(false);
  });

  it('renames the whole folder and writes the marker', () => {
    seedOld();
    const r = migrateUserData({ oldDir, newDir, appVersion: '0.3.0' });
    expect(r.status).toBe('renamed');
    expect(existsSync(oldDir)).toBe(false);
    for (const f of [
      'settings.json',
      'mail.db',
      'mail.db-wal',
      'mail.db-shm',
      'secrets.bin',
      'Local State',
      'window-state.json',
    ]) {
      expect(existsSync(join(newDir, f)), f).toBe(true);
    }
    expect(readFileSync(join(newDir, 'image-cache', 'a.bin'), 'utf8')).toBe('img');
    const marker = JSON.parse(readFileSync(join(newDir, MIGRATION_MARKER), 'utf8'));
    expect(marker).toMatchObject({
      method: 'renamed',
      from: oldDir,
      to: newDir,
      appVersion: '0.3.0',
    });
  });

  it('is a no-op once migrated', () => {
    seedOld();
    migrateUserData({ oldDir, newDir });
    mkdirSync(oldDir);
    writeFileSync(join(oldDir, 'settings.json'), 'new old');
    const r = migrateUserData({ oldDir, newDir });
    expect(r.status).toBe('already');
    expect(existsSync(join(oldDir, 'settings.json'))).toBe(true);
  });

  it('leaves both folders alone when both hold data', () => {
    seedOld();
    mkdirSync(newDir);
    writeFileSync(join(newDir, 'settings.json'), 'mine');
    const r = migrateUserData({ oldDir, newDir });
    expect(r.status).toBe('both-exist');
    expect(readFileSync(join(newDir, 'settings.json'), 'utf8')).toBe('mine');
    expect(existsSync(join(oldDir, 'mail.db'))).toBe(true);
    expect(existsSync(join(newDir, MIGRATION_MARKER))).toBe(false);
    expect(r.messages.some(([l]) => l === 'warn')).toBe(true);
  });

  it('replaces a stub folder that only holds Chromium leftovers', () => {
    seedOld();
    mkdirSync(join(newDir, 'GPUCache'), { recursive: true });
    writeFileSync(join(newDir, 'Local State'), '{"stub":true}');
    const r = migrateUserData({ oldDir, newDir });
    expect(r.status).toBe('renamed');
    expect(readFileSync(join(newDir, 'Local State'), 'utf8')).toBe('{"os_crypt":{}}');
    expect(existsSync(join(newDir, 'GPUCache'))).toBe(false);
  });

  it('stops the old app and retries when the first rename fails', () => {
    seedOld();
    let calls = 0;
    const stopOldApp = vi.fn();
    const r = migrateUserData({
      oldDir,
      newDir,
      stopOldApp,
      sleep: () => undefined,
      rename: (a, b) => {
        if (++calls === 1) throw new Error('EBUSY');
        renameSync(a, b);
      },
    });
    expect(stopOldApp).toHaveBeenCalledTimes(1);
    expect(r.status).toBe('renamed');
    expect(existsSync(oldDir)).toBe(false);
  });

  describe('when rename keeps failing', () => {
    const failing = (): void => {
      throw new Error('EPERM');
    };

    it('copies, verifies, keeps the old folder and writes the marker', () => {
      seedOld();
      const r = migrateUserData({ oldDir, newDir, sleep: () => undefined, rename: failing });
      expect(r.status).toBe('copied');
      expect(existsSync(oldDir)).toBe(true); // never deleted after a copy
      expect(existsSync(join(oldDir, 'mail.db'))).toBe(true);
      for (const f of [
        'settings.json',
        'mail.db',
        'mail.db-wal',
        'mail.db-shm',
        'secrets.bin',
        'Local State',
      ]) {
        expect(readFileSync(join(newDir, f), 'utf8'), f).toBe(
          readFileSync(join(oldDir, f), 'utf8'),
        );
      }
      expect(existsSync(join(newDir, 'lockfile'))).toBe(false);
      expect(existsSync(`${newDir}.migrating`)).toBe(false);
      expect(JSON.parse(readFileSync(join(newDir, MIGRATION_MARKER), 'utf8')).method).toBe(
        'copied',
      );
      // A second start does not copy again.
      expect(migrateUserData({ oldDir, newDir }).status).toBe('already');
    });
  });
});

describe('readEnv', () => {
  it('prefers the new name and falls back to the old one', () => {
    expect(readEnv('X', { LETTERDOCK_X: 'new', MAILROOM_X: 'old' })).toBe('new');
    expect(readEnv('X', { MAILROOM_X: 'old' })).toBe('old');
    expect(readEnv('X', {})).toBeUndefined();
  });
});

describe('parseRegQuery', () => {
  it('reads keys and values', () => {
    const out = [
      'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\abc',
      '    UninstallString    REG_SZ    "C:\\Users\\u\\AppData\\Local\\Programs\\mailroom\\Uninstall Mailroom.exe" /currentuser',
      '',
      'End of search: 1 match(es) found.',
    ].join('\r\n');
    const b = parseRegQuery(out);
    expect(b).toHaveLength(1);
    expect(b[0]!.values[0]!.name).toBe('UninstallString');
    expect(pointsIntoLegacyInstall(b[0]!.values[0]!.data)).toBe(true);
    expect(
      pointsIntoLegacyInstall('C:\\Users\\u\\AppData\\Local\\Programs\\letterdock\\x.exe'),
    ).toBe(false);
    expect(pointsIntoLegacyInstall('C:\\Program Files\\Mailroom Other\\x.exe')).toBe(false);
  });
});

describe('removeLegacyInstall', () => {
  const OLD_DIR = 'C:\\L\\Programs\\mailroom';
  const UNINSTALL_KEY =
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\old-guid';
  const OTHER_KEY =
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\other-mailroom';

  function makeDeps(opts: { uninstallerRemovesDir: boolean; uninstallerStarts?: boolean }) {
    const files = new Set<string>([
      OLD_DIR,
      `${OLD_DIR}\\Uninstall Mailroom.exe`,
      'C:\\L\\mailroom-updater',
      'C:\\A\\Microsoft\\Windows\\Start Menu\\Programs\\Mailroom.lnk',
    ]);
    const calls: string[][] = [];
    const written: Record<string, string> = {};
    let keyAlive = true;
    const deps: CleanupDeps = {
      localAppData: 'C:\\L',
      appData: 'C:\\A',
      desktopDir: 'C:\\D',
      dataDir: 'C:\\Data',
      log: { info: () => undefined, warn: () => undefined },
      waitMs: 10,
      pollMs: 5,
      run: (file, args) => {
        calls.push([file, ...args]);
        if (file === 'reg.exe' && args[0] === 'query' && args[1].endsWith('\\Uninstall')) {
          const text = [
            keyAlive
              ? `${UNINSTALL_KEY}\r\n    UninstallString    REG_SZ    "${OLD_DIR}\\Uninstall Mailroom.exe" /currentuser`
              : '',
            `${OTHER_KEY}\r\n    UninstallString    REG_SZ    "C:\\Program Files\\Mailroom\\unins.exe"`,
          ].join('\r\n');
          return Promise.resolve({ code: 0, stdout: text });
        }
        if (file === 'reg.exe' && args[0] === 'query' && args[1].endsWith('\\Run')) {
          return Promise.resolve({
            code: 0,
            stdout:
              'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\r\n    app.mailroom    REG_SZ    "C:\\L\\Programs\\mailroom\\Mailroom.exe" --hidden\r\n    Other    REG_SZ    "C:\\x.exe"',
          });
        }
        if (file === 'reg.exe' && args[0] === 'query' && args[1].includes('Mailroom.Url.mailto')) {
          return Promise.resolve({
            code: 0,
            stdout:
              'HKEY_CURRENT_USER\\Software\\Classes\\Mailroom.Url.mailto\\shell\\open\\command\r\n    (Default)    REG_SZ    "C:\\L\\Programs\\mailroom\\Mailroom.exe" "%1"',
          });
        }
        if (file === 'reg.exe' && args[0] === 'delete' && args[1] === UNINSTALL_KEY)
          keyAlive = false;
        return Promise.resolve({ code: 0, stdout: '' });
      },
      spawnDetached: () => {
        if (opts.uninstallerRemovesDir) {
          files.delete(OLD_DIR);
          keyAlive = false;
        }
        return Promise.resolve(opts.uninstallerStarts ?? true);
      },
      readShortcutTarget: () => `${OLD_DIR}\\Mailroom.exe`,
      exists: (p) => files.has(p),
      removeDir: (p) => void files.delete(p),
      removeFile: (p) => void files.delete(p),
      writeFile: (p, t) => void (written[p] = t),
      sleep: () => Promise.resolve(),
    };
    return { deps, files, calls, written };
  }

  it('runs the old uninstaller silently without the delete-data flag, then cleans up', async () => {
    const { deps, files, calls, written } = makeDeps({ uninstallerRemovesDir: true });
    const spawn = vi.spyOn(deps, 'spawnDetached');
    expect(await removeLegacyInstall(deps)).toBe('removed');
    expect(spawn).toHaveBeenCalledWith(`${OLD_DIR}\\Uninstall Mailroom.exe`, ['/S']);
    expect(calls.some((c) => c.join(' ').includes('--delete-app-data'))).toBe(false);
    // Run entry of the old app removed, the unrelated one is not touched.
    expect(calls).toContainEqual([
      'reg.exe',
      'delete',
      expect.stringContaining('\\Run'),
      '/v',
      'app.mailroom',
      '/f',
    ]);
    expect(calls.some((c) => c.includes('Other'))).toBe(false);
    // Another program called Mailroom keeps its uninstall entry.
    expect(calls.some((c) => c[0] === 'reg.exe' && c[1] === 'delete' && c[2] === OTHER_KEY)).toBe(
      false,
    );
    expect(calls).toContainEqual([
      'reg.exe',
      'delete',
      'HKCU\\Software\\Classes\\Mailroom.Url.mailto',
      '/f',
    ]);
    expect(files.has('C:\\L\\mailroom-updater')).toBe(false);
    expect(files.has('C:\\A\\Microsoft\\Windows\\Start Menu\\Programs\\Mailroom.lnk')).toBe(false);
    expect(Object.keys(written)).toEqual([`C:\\Data\\${CLEANUP_MARKER}`]);
  });

  it('removes the files by hand when the old uninstaller cannot start', async () => {
    const { deps, files } = makeDeps({ uninstallerRemovesDir: false, uninstallerStarts: false });
    expect(await removeLegacyInstall(deps)).toBe('removed');
    expect(files.has(OLD_DIR)).toBe(false);
  });

  it('does nothing after it has finished once', async () => {
    const { deps, written } = makeDeps({ uninstallerRemovesDir: true });
    await removeLegacyInstall(deps);
    const again = makeDeps({ uninstallerRemovesDir: true });
    again.files.add(`C:\\Data\\${CLEANUP_MARKER}`);
    expect(await removeLegacyInstall(again.deps)).toBe('already-done');
    expect(Object.keys(written)).toHaveLength(1);
  });
});
