// One-time move of the user data folder from the old product name (Mailroom, up to 0.2.9) to
// Letterdock. Runs very early in the main process, BEFORE Electron's userData path is set and
// before anything opens a file in it. Free of Electron imports so it can be unit tested.
//
// The whole folder must move, not only our own files: Chromium's "Local State" holds the key
// (wrapped by Windows DPAPI) that Electron's safeStorage uses to decrypt secrets.bin. Without it
// the saved passwords cannot be read any more.
//
// Remove this file (and legacyCleanup.ts) once nobody can still be updating from 0.2.9.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

export const LEGACY_APP_NAME = 'Mailroom';
export const MIGRATION_MARKER = 'migrated-from-mailroom.json';

/** Files the copy fallback must get across intact. */
export const CRITICAL_FILES = [
  'Local State',
  'mail.db',
  'mail.db-wal',
  'mail.db-shm',
  'secrets.bin',
  'settings.json',
] as const;

/** Files Chromium keeps open and locked while it runs. They are rebuilt and need no copy. */
const SKIP_COPY = /^(lockfile|Singleton(Lock|Cookie|Socket))$/i;

export type MigrationStatus =
  | 'none' // nothing to migrate (no old folder)
  | 'already' // a previous run migrated
  | 'renamed' // the old folder was renamed
  | 'copied' // the old folder was copied (rename was not possible); the old one is kept
  | 'both-exist' // old and new folders both hold data: nothing is touched
  | 'failed'; // migration could not be completed; the old folder is untouched

export interface MigrationResult {
  status: MigrationStatus;
  /** Log lines to replay once the logger exists. */
  messages: Array<['info' | 'warn' | 'error', string]>;
}

export interface MigrationDeps {
  oldDir: string;
  newDir: string;
  /** Stops a still-running old app that holds files open. Called once, when the rename fails. */
  stopOldApp?: () => void;
  /** Blocks for the given time. Replaceable for tests. */
  sleep?: (ms: number) => void;
  now?: () => Date;
  /** Replaceable for tests; defaults to fs.renameSync. */
  rename?: (from: string, to: string) => void;
  appVersion?: string;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Files only the app itself writes. If one exists, the folder holds real data. Chromium alone
 * can leave "Local State" and cache folders behind, so those do not count.
 */
const OWN_FILES = ['mail.db', 'secrets.bin', 'settings.json'] as const;

function hasUserData(dir: string): boolean {
  return OWN_FILES.some((f) => existsSync(join(dir, f)));
}

function copyTree(src: string, dst: string, rel: string, failed: string[]): void {
  mkdirSync(dst, { recursive: true });
  for (const e of readdirSync(src, { withFileTypes: true })) {
    if (SKIP_COPY.test(e.name)) continue;
    const s = join(src, e.name);
    const d = join(dst, e.name);
    const r = rel ? `${rel}/${e.name}` : e.name;
    try {
      if (e.isDirectory()) copyTree(s, d, r, failed);
      else if (e.isFile()) copyFileSync(s, d);
    } catch {
      failed.push(r);
    }
  }
}

/** Every file that is in `src` (except the skipped ones) must be in `dst` with the same size. */
function verifyTree(src: string, dst: string, rel: string, problems: string[]): void {
  for (const e of readdirSync(src, { withFileTypes: true })) {
    if (SKIP_COPY.test(e.name)) continue;
    const s = join(src, e.name);
    const d = join(dst, e.name);
    const r = rel ? `${rel}/${e.name}` : e.name;
    try {
      if (e.isDirectory()) {
        if (!existsSync(d)) problems.push(r);
        else verifyTree(s, d, r, problems);
      } else if (e.isFile()) {
        if (!existsSync(d) || statSync(d).size !== statSync(s).size) problems.push(r);
      }
    } catch {
      problems.push(r);
    }
  }
}

export function migrateUserData(d: MigrationDeps): MigrationResult {
  const messages: MigrationResult['messages'] = [];
  const say = (level: 'info' | 'warn' | 'error', msg: string) => messages.push([level, msg]);
  const sleep = d.sleep ?? sleepSync;
  const rename = d.rename ?? renameSync;
  const now = d.now ?? (() => new Date());
  const marker = join(d.newDir, MIGRATION_MARKER);
  const done = (status: MigrationStatus): MigrationResult => ({ status, messages });

  try {
    if (existsSync(marker)) return done('already');
    if (!existsSync(d.oldDir) || !statSync(d.oldDir).isDirectory()) return done('none');

    if (existsSync(d.newDir)) {
      if (hasUserData(d.newDir)) {
        say(
          'warn',
          `Both ${d.oldDir} and ${d.newDir} hold data. Nothing was migrated; the old folder was left as it is.`,
        );
        return done('both-exist');
      }
      // Only stub files from Chromium (an empty profile). Clear them so the move can happen.
      say('info', `Clearing empty data folder ${d.newDir} before the migration`);
      rmSync(d.newDir, { recursive: true, force: true });
    }

    const writeMarker = (dir: string, method: 'renamed' | 'copied', warnings: string[]) => {
      writeFileSync(
        join(dir, MIGRATION_MARKER),
        JSON.stringify(
          {
            from: d.oldDir,
            to: d.newDir,
            method,
            migratedAt: now().toISOString(),
            appVersion: d.appVersion ?? null,
            warnings,
          },
          null,
          2,
        ),
      );
    };

    // 1. Rename: instant, atomic, and nothing is duplicated.
    say('info', `Migrating user data: renaming ${d.oldDir} to ${d.newDir}`);
    let renameError: unknown = null;
    try {
      rename(d.oldDir, d.newDir);
    } catch (e) {
      renameError = e;
    }
    if (renameError !== null) {
      say('warn', `Rename failed (${String(renameError)}). Stopping the old app and retrying`);
      try {
        d.stopOldApp?.();
      } catch (e) {
        say('warn', `Could not stop the old app: ${String(e)}`);
      }
      sleep(1500);
      try {
        rename(d.oldDir, d.newDir);
        renameError = null;
      } catch (e) {
        renameError = e;
      }
    }
    if (renameError === null) {
      writeMarker(d.newDir, 'renamed', []);
      say('info', 'User data folder renamed');
      return done('renamed');
    }

    // 2. Copy into a temporary sibling, check it, then rename that into place. A half-finished
    //    copy never looks like a real data folder, so the next start tries again.
    say('warn', `Rename failed again (${String(renameError)}). Falling back to a verified copy`);
    const tmp = `${d.newDir}.migrating`;
    rmSync(tmp, { recursive: true, force: true });
    const failed: string[] = [];
    copyTree(d.oldDir, tmp, '', failed);
    const problems: string[] = [];
    verifyTree(d.oldDir, tmp, '', problems);
    const all = [...new Set([...problems, ...failed])];
    const critical = all.filter((p) => (CRITICAL_FILES as readonly string[]).includes(p));
    if (critical.length > 0) {
      say(
        'error',
        `Copy not verified (critical files: ${critical.join(', ')}). The old folder is untouched`,
      );
      rmSync(tmp, { recursive: true, force: true });
      return done('failed');
    }
    if (all.length > 0) {
      say(
        'warn',
        `Copy finished with ${all.length} non-critical difference(s): ${all.slice(0, 20).join(', ')}`,
      );
    }
    writeMarker(tmp, 'copied', all);
    renameSync(tmp, d.newDir);
    say('info', `User data copied and verified. The old folder ${d.oldDir} was kept`);
    return done('copied');
  } catch (e) {
    say('error', `User data migration failed: ${String(e)}`);
    return done('failed');
  }
}
