// Automatic updates from GitHub Releases (electron-updater). Packaged builds only.
// The state machine is kept free of Electron imports so it can be tested with a fake updater.
import type { AppError, UpdateStatus } from '../shared/ipc';
import { AppException, makeError } from '../shared/errors';

/** The small part of electron-updater's `autoUpdater` that we use. */
export interface UpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  allowDowngrade: boolean;
  logger?: unknown;
  /** Extra headers on every update request (feed pages and files). */
  requestHeaders?: Record<string, string> | null;
  /** electron-updater keeps its provider here between checks. Clearing it forces a fresh one. */
  clientPromise?: unknown;
  on(event: string, listener: (...args: never[]) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export interface UpdaterLog {
  info(obj: object | string, msg?: string): void;
  warn(obj: object | string, msg?: string): void;
  error(obj: object | string, msg?: string): void;
}

export interface AppUpdaterDeps {
  updater: UpdaterLike;
  currentVersion: string;
  /** False for development runs: no checks are made and the status is "unavailable". */
  isPackaged: boolean;
  log: UpdaterLog;
  /** The user's "Check for updates automatically" setting, read each time a timer fires. */
  autoCheckEnabled: () => boolean;
  emit: (status: UpdateStatus) => void;
  /** Runs before quitAndInstall: flush drafts and sends, stop the engine, allow the app to quit. */
  prepareInstall: () => Promise<void>;
  /** Drops network state the updater could reuse (HTTP cache, kept-alive connections). */
  resetNetwork?: () => void | Promise<void>;
  now?: () => number;
  startDelayMs?: number;
  intervalMs?: number;
}

export const FIRST_CHECK_DELAY_MS = 30_000;
/** GitHub answers its release pages with "max-age=0, must-revalidate". Ask every proxy and cache to revalidate. */
export const NO_CACHE_HEADERS: Record<string, string> = {
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
};
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

interface ReleaseInfo {
  version?: string;
  releaseNotes?: unknown;
}

function notesToText(notes: unknown): string | null {
  if (typeof notes === 'string') return notes.trim() || null;
  if (Array.isArray(notes)) {
    const parts = notes
      .map((n) => (n && typeof n === 'object' ? (n as { note?: unknown }).note : null))
      .filter((n): n is string => typeof n === 'string' && n.trim() !== '');
    return parts.length > 0 ? parts.join('\n\n') : null;
  }
  return null;
}

/** Plain-language error for the Settings page. The raw text goes to `details` and the log. */
export function toUpdateError(raw: unknown): AppError {
  const text = raw instanceof Error ? raw.message : String(raw ?? '');
  const lower = text.toLowerCase();
  let message = "Mailroom couldn't check for updates. Try again later.";
  if (
    /enotfound|econnreset|econnrefused|etimedout|eai_again|net::|network|socket|offline|timed out/.test(
      lower,
    )
  ) {
    message =
      "Mailroom couldn't reach the update server. Check your internet connection and try again.";
  } else if (/\b404\b|cannot find latest|no published versions/.test(lower)) {
    message = 'No update information was found yet. Try again later.';
  } else if (/\b403\b|rate limit/.test(lower)) {
    message = 'GitHub is limiting requests right now. Try again in a while.';
  } else if (/sha512|checksum|signature/.test(lower)) {
    message = 'The downloaded update did not pass its safety check, so it was not used.';
  }
  return makeError('INTERNAL', message, { retryable: true, details: text.slice(0, 500) });
}

export class AppUpdater {
  private state: UpdateStatus;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private started = false;
  private readonly now: () => number;

  constructor(private readonly d: AppUpdaterDeps) {
    this.now = d.now ?? Date.now;
    this.state = d.isPackaged
      ? { state: 'idle', currentVersion: d.currentVersion }
      : { state: 'unavailable', currentVersion: d.currentVersion, reason: 'dev-build' };
  }

  status(): UpdateStatus {
    return this.state;
  }

  /** Configures electron-updater, listens to it and schedules the background checks. */
  start(): void {
    if (!this.d.isPackaged || this.started) return;
    this.started = true;
    const u = this.d.updater;
    u.autoDownload = true;
    u.autoInstallOnAppQuit = true;
    u.allowPrerelease = false;
    u.allowDowngrade = false;
    u.requestHeaders = { ...u.requestHeaders, ...NO_CACHE_HEADERS };

    u.on('checking-for-update', () => {
      this.d.log.info('update check started');
    });
    u.on('update-available', (info: ReleaseInfo) => {
      this.d.log.info({ version: info?.version }, 'update available, downloading');
      this.set({
        state: 'available',
        currentVersion: this.d.currentVersion,
        newVersion: info?.version ?? '',
        releaseNotes: notesToText(info?.releaseNotes),
      });
    });
    u.on('update-not-available', () => {
      this.d.log.info('no update available');
      this.set({ state: 'upToDate', currentVersion: this.d.currentVersion, checkedAt: this.now() });
    });
    u.on('download-progress', (p: { percent?: number }) => {
      const prev = this.state;
      const newVersion = 'newVersion' in prev ? prev.newVersion : '';
      const percent = Math.max(0, Math.min(100, Math.round(p?.percent ?? 0)));
      // Progress comes often. Only tell the window when the number changes.
      if (prev.state === 'downloading' && prev.percent === percent) return;
      this.set({
        state: 'downloading',
        currentVersion: this.d.currentVersion,
        newVersion,
        percent,
      });
    });
    u.on('update-downloaded', (info: ReleaseInfo) => {
      this.d.log.info({ version: info?.version }, 'update downloaded');
      const prev = this.state;
      const notes = notesToText(info?.releaseNotes);
      const newVersion = info?.version ?? ('newVersion' in prev ? prev.newVersion : '');
      this.set({
        state: 'ready',
        currentVersion: this.d.currentVersion,
        newVersion,
        ...(notes ? { releaseNotes: notes } : {}),
      });
    });
    u.on('error', (err: unknown) => this.fail(err));

    const delay = this.d.startDelayMs ?? FIRST_CHECK_DELAY_MS;
    const every = this.d.intervalMs ?? CHECK_INTERVAL_MS;
    const background = () => {
      if (this.d.autoCheckEnabled()) void this.check();
    };
    const first = setTimeout(background, delay);
    const loop = setInterval(background, every);
    first.unref?.();
    loop.unref?.();
    this.timers.push(first, loop as unknown as ReturnType<typeof setTimeout>);
  }

  stop(): void {
    for (const t of this.timers) {
      clearTimeout(t);
      clearInterval(t);
    }
    this.timers = [];
  }

  /** Checks now. Never throws: problems end up in the returned `error` status. */
  async check(): Promise<UpdateStatus> {
    if (!this.d.isPackaged) return this.state;
    // A check, download, or finished download is already in progress: do not start another.
    if (
      this.state.state === 'checking' ||
      this.state.state === 'downloading' ||
      this.state.state === 'ready'
    ) {
      return this.state;
    }
    this.set({ state: 'checking', currentVersion: this.d.currentVersion });
    try {
      // Every check starts clean: a new provider and no reused cache or connection.
      this.d.updater.clientPromise = null;
      try {
        const reset = this.d.resetNetwork?.();
        if (reset) await reset;
      } catch (e) {
        this.d.log.warn({ err: String(e) }, 'could not reset update network state');
      }
      await this.d.updater.checkForUpdates();
    } catch (e) {
      // electron-updater also emits 'error'; fail() ignores the second report.
      this.fail(e);
    }
    return this.state;
  }

  /** Flushes pending work, then quits and runs the installer silently. The app starts again. */
  async install(): Promise<void> {
    if (this.state.state !== 'ready') {
      throw new AppException('UNSUPPORTED', 'There is no update to install.');
    }
    this.d.log.info({ version: this.state.newVersion }, 'installing update');
    await this.d.prepareInstall();
    this.d.updater.quitAndInstall(true, true);
  }

  private fail(raw: unknown): void {
    const text = raw instanceof Error ? raw.message : String(raw);
    // A failed download after "ready" cannot happen; a late error after a final state is stale.
    if (
      this.state.state === 'error' ||
      this.state.state === 'ready' ||
      this.state.state === 'upToDate'
    ) {
      this.d.log.warn({ err: text }, 'update error (ignored, already settled)');
      return;
    }
    this.d.log.error({ err: text }, 'update error');
    this.set({ state: 'error', currentVersion: this.d.currentVersion, error: toUpdateError(raw) });
  }

  private set(next: UpdateStatus): void {
    this.state = next;
    this.d.emit(next);
  }
}
