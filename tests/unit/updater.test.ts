import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AppUpdater,
  CHECK_INTERVAL_MS,
  FIRST_CHECK_DELAY_MS,
  NO_CACHE_HEADERS,
  toUpdateError,
  type UpdaterLike,
} from '../../src/main/updater';
import type { UpdateStatus } from '../../src/shared/ipc';
import { AppException } from '../../src/shared/errors';
import { updateLine } from '../../src/renderer/src/lib/updateText';

class FakeUpdater implements UpdaterLike {
  autoDownload = false;
  autoInstallOnAppQuit = false;
  allowPrerelease = true;
  allowDowngrade = true;
  handlers = new Map<string, (...a: never[]) => void>();
  checkForUpdates = vi.fn(async () => null as unknown);
  quitAndInstall = vi.fn();
  on(event: string, l: (...a: never[]) => void) {
    this.handlers.set(event, l);
    return this;
  }
  fire(event: string, ...args: unknown[]) {
    (this.handlers.get(event) as (...a: unknown[]) => void)(...args);
  }
}

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function make(over: { packaged?: boolean; auto?: boolean } = {}) {
  const fake = new FakeUpdater();
  const events: UpdateStatus[] = [];
  const order: string[] = [];
  const prepareInstall = vi.fn(async () => {
    order.push('prepare');
  });
  fake.quitAndInstall.mockImplementation(() => order.push('quitAndInstall'));
  let auto = over.auto ?? true;
  const u = new AppUpdater({
    updater: fake,
    currentVersion: '0.2.6',
    isPackaged: over.packaged ?? true,
    log,
    autoCheckEnabled: () => auto,
    emit: (s) => events.push(s),
    prepareInstall,
    now: () => 1000,
  });
  return { u, fake, events, order, prepareInstall, setAuto: (v: boolean) => (auto = v) };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('AppUpdater', () => {
  it('sends no-cache headers, keeps existing ones, and starts every check with a fresh provider', async () => {
    const reset = vi.fn(async () => undefined);
    const fake = new FakeUpdater() as FakeUpdater & UpdaterLike;
    fake.requestHeaders = { 'X-Test': '1' };
    const u = new AppUpdater({
      updater: fake,
      currentVersion: '0.2.6',
      isPackaged: true,
      log,
      autoCheckEnabled: () => true,
      emit: () => undefined,
      prepareInstall: async () => undefined,
      resetNetwork: reset,
    });
    u.start();
    expect(fake.requestHeaders).toEqual({ 'X-Test': '1', ...NO_CACHE_HEADERS });
    fake.clientPromise = Promise.resolve('old provider');
    fake.checkForUpdates.mockImplementation(async () => {
      expect(fake.clientPromise).toBeNull();
      expect(reset).toHaveBeenCalledTimes(1);
      return null;
    });
    await u.check();
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it('is unavailable and never checks in a development build', async () => {
    const { u, fake } = make({ packaged: false });
    u.start();
    expect(u.status()).toMatchObject({ state: 'unavailable', reason: 'dev-build' });
    expect(await u.check()).toMatchObject({ state: 'unavailable' });
    vi.advanceTimersByTime(FIRST_CHECK_DELAY_MS + CHECK_INTERVAL_MS);
    expect(fake.checkForUpdates).not.toHaveBeenCalled();
    await expect(u.install()).rejects.toBeInstanceOf(AppException);
  });

  it('configures electron-updater: background download, install on quit, no prerelease', () => {
    const { u, fake } = make();
    u.start();
    expect(fake.autoDownload).toBe(true);
    expect(fake.autoInstallOnAppQuit).toBe(true);
    expect(fake.allowPrerelease).toBe(false);
    expect(fake.allowDowngrade).toBe(false);
    expect(u.status()).toEqual({ state: 'idle', currentVersion: '0.2.6' });
  });

  it('checks 30 seconds after start and then every 6 hours', () => {
    const { u, fake } = make();
    u.start();
    vi.advanceTimersByTime(FIRST_CHECK_DELAY_MS - 1);
    expect(fake.checkForUpdates).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(1);
    fake.fire('update-not-available');
    vi.advanceTimersByTime(CHECK_INTERVAL_MS);
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it('skips background checks when the setting is off, but a manual check still works', async () => {
    const { u, fake } = make({ auto: false });
    u.start();
    vi.advanceTimersByTime(FIRST_CHECK_DELAY_MS + CHECK_INTERVAL_MS);
    expect(fake.checkForUpdates).not.toHaveBeenCalled();
    await u.check();
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it('goes checking -> upToDate', async () => {
    const { u, fake, events } = make();
    u.start();
    fake.checkForUpdates.mockImplementation(async () => {
      fake.fire('update-not-available', { version: '0.2.6' });
      return null;
    });
    const s = await u.check();
    expect(s).toEqual({ state: 'upToDate', currentVersion: '0.2.6', checkedAt: 1000 });
    expect(events.map((e) => e.state)).toEqual(['checking', 'upToDate']);
  });

  it('goes checking -> available -> downloading -> ready, with release notes', async () => {
    const { u, fake, events } = make();
    u.start();
    fake.checkForUpdates.mockImplementation(async () => {
      fake.fire('update-available', { version: '0.2.7', releaseNotes: 'Fixes' });
      return null;
    });
    await u.check();
    expect(u.status()).toMatchObject({
      state: 'available',
      newVersion: '0.2.7',
      releaseNotes: 'Fixes',
    });
    fake.fire('download-progress', { percent: 41.6 });
    fake.fire('download-progress', { percent: 41.9 }); // same rounded value: no new event
    fake.fire('download-progress', { percent: 100 });
    expect(u.status()).toMatchObject({ state: 'downloading', newVersion: '0.2.7', percent: 100 });
    fake.fire('update-downloaded', {
      version: '0.2.7',
      releaseNotes: [{ version: '0.2.7', note: 'Fixes' }],
    });
    expect(u.status()).toEqual({
      state: 'ready',
      currentVersion: '0.2.6',
      newVersion: '0.2.7',
      releaseNotes: 'Fixes',
    });
    expect(events.filter((e) => e.state === 'downloading')).toHaveLength(2);
  });

  it('does not start a second check once an update is downloaded', async () => {
    const { u, fake } = make();
    u.start();
    fake.checkForUpdates.mockImplementation(async () => {
      fake.fire('update-available', { version: '0.2.7' });
      fake.fire('update-downloaded', { version: '0.2.7' });
      return null;
    });
    await u.check();
    await u.check();
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it('reports a failed check as a plain error and recovers on the next check', async () => {
    const { u, fake, events } = make();
    u.start();
    fake.checkForUpdates.mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND github.com'));
    const s = await u.check();
    expect(s.state).toBe('error');
    if (s.state === 'error') {
      expect(s.error.message).toMatch(/internet connection/);
      expect(s.error.details).toMatch(/ENOTFOUND/);
    }
    expect(log.error).toHaveBeenCalled();
    fake.checkForUpdates.mockImplementationOnce(async () => {
      fake.fire('update-not-available');
      return null;
    });
    expect((await u.check()).state).toBe('upToDate');
    expect(events.map((e) => e.state)).toEqual(['checking', 'error', 'checking', 'upToDate']);
  });

  it('shows one error when electron-updater both emits "error" and rejects', async () => {
    const { u, fake, events } = make();
    u.start();
    fake.checkForUpdates.mockImplementation(async () => {
      const err = new Error('boom');
      fake.fire('error', err);
      throw err;
    });
    await u.check();
    expect(events.filter((e) => e.state === 'error')).toHaveLength(1);
  });

  it('install refuses when nothing is downloaded', async () => {
    const { u, fake } = make();
    u.start();
    await expect(u.install()).rejects.toMatchObject({ appError: { code: 'UNSUPPORTED' } });
    expect(fake.quitAndInstall).not.toHaveBeenCalled();
  });

  it('install flushes first, then runs quitAndInstall silently with relaunch', async () => {
    const { u, fake, order, prepareInstall } = make();
    u.start();
    fake.fire('update-available', { version: '0.2.7' });
    fake.fire('update-downloaded', { version: '0.2.7' });
    await u.install();
    expect(prepareInstall).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['prepare', 'quitAndInstall']);
    expect(fake.quitAndInstall).toHaveBeenCalledWith(true, true);
  });
});

describe('update messages', () => {
  it('maps raw errors to plain words', () => {
    expect(toUpdateError(new Error('net::ERR_INTERNET_DISCONNECTED')).message).toMatch(/internet/);
    expect(toUpdateError(new Error('HTTP 404 latest.yml')).message).toMatch(
      /No update information/,
    );
    expect(toUpdateError(new Error('weird')).message).toMatch(/couldn't check/);
  });

  it('writes the status line for Settings', () => {
    expect(updateLine({ state: 'upToDate', currentVersion: '0.2.6', checkedAt: 1 })).toBe(
      'Letterdock is up to date (0.2.6)',
    );
    expect(
      updateLine({
        state: 'downloading',
        currentVersion: '0.2.6',
        newVersion: '0.2.7',
        percent: 42,
      }),
    ).toBe('Downloading 0.2.7... 42%');
    expect(updateLine({ state: 'ready', currentVersion: '0.2.6', newVersion: '0.2.7' })).toBe(
      'Version 0.2.7 is ready. It installs when you restart.',
    );
  });
});

describe('electron-builder publish config', () => {
  const yml = readFileSync(join(__dirname, '../../electron-builder.yml'), 'utf8');

  it('publishes to GitHub voydapps/letterdock', () => {
    expect(yml).toMatch(
      /^publish:\r?\n\s+provider: github\r?\n\s+owner: voydapps\r?\n\s+repo: letterdock\b/m,
    );
    expect(yml).not.toContain('example.invalid');
  });

  it('names installers exactly like the release workflow uploads them', () => {
    expect(yml).toMatch(/artifactName: Letterdock-Setup-\$\{version\}\.\$\{ext\}/);
    const wf = readFileSync(join(__dirname, '../../.github/workflows/release.yml'), 'utf8');
    expect(wf).toContain('release/Letterdock-Setup-*.exe');
    expect(wf).toContain('release/latest.yml');
    expect(wf).toContain('--publish never');
  });

  it('does not require a signature while installers are unsigned', () => {
    expect(yml).toMatch(/verifyUpdateCodeSignature: false/);
    expect(yml).not.toMatch(/^\s*publisherName:/m);
  });
});
