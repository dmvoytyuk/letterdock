import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  app,
  BrowserWindow,
  nativeTheme,
  net,
  Notification,
  protocol,
  safeStorage,
  session,
  shell,
} from 'electron';
import type { Account, AppEvent, AppSettings, PrepareComposeReq } from '../shared/ipc';
import type { EngineInit } from '../shared/internal';
import { appIconPath } from './appIcon';
import {
  isHiddenOnlyLaunch,
  loginItemOptions,
  mainCloseAction,
  shouldStartHidden,
} from './background';
import { AppTray } from './tray';
import { APP_NAME, resolveAppUserModelId } from './buildConfig';
import { createComposeWindow } from './composeWindow';
import { EngineHost } from './engineHost';
import { createEngineBridge } from './engineBridge';
import { createMainHandlers } from './handlers';
import { isSafeExternalUrl } from '../shared/safety';
import { broadcast, registerIpc, waitForPendingSaves } from './ipcRouter';
import { IMAGE_SCHEME } from '../shared/imageProxy';
import { ImageDiskCache } from './imageCache/store';
import { ImageService } from './imageCache/service';
import { createLogger, type Logger } from './logger';
import { Notifier } from './notifications';
import { MicrosoftOAuth } from './oauth/microsoft';
import { OAuthService } from './oauth/service';
import { APP_CSP } from '../shared/appCsp';
import { TokenManager } from './oauth/tokenManager';
import { SecretStore } from './secrets/secretStore';
import { SettingsStore } from './settings';
import { createMainWindow } from './window';
import { findMailtoArg } from './mailto';
import { cleanPrintTemp } from './print/printWindow';
import { ViewerWindows } from './viewerWindow';
import { BoundsStore, COMPOSE_RULES } from './windowBounds';

app.setName(APP_NAME);
app.setPath('userData', process.env.MAILROOM_DATA_DIR ?? join(app.getPath('appData'), APP_NAME));
app.setAppUserModelId(resolveAppUserModelId(app.isPackaged));

// Must run before the app is ready. Remote email images load through this scheme (local cache).
protocol.registerSchemesAsPrivileged([
  { scheme: IMAGE_SCHEME, privileges: { standard: true, secure: true } },
]);

const isDev = !app.isPackaged && !!process.env['ELECTRON_RENDERER_URL'];

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void boot();
}

async function boot(): Promise<void> {
  const dataDir = app.getPath('userData');
  const settings = new SettingsStore(join(dataDir, 'settings.json'));
  const logsDir = join(dataDir, 'logs');
  const log = createLogger(logsDir, 'main', settings.get().verboseLogging);
  log.info({ version: app.getVersion() }, 'starting');

  await app.whenReady();
  nativeTheme.themeSource = settings.get().theme;

  const secrets = new SecretStore(join(dataDir, 'secrets.bin'), safeStorage);
  await secrets.load();
  if (!secrets.available) {
    log.error('safeStorage encryption is not available; passwords cannot be stored');
  }

  // ---- remote image cache ----
  const imageCache = new ImageDiskCache(
    join(dataDir, 'image-cache'),
    settings.get().imageCacheMaxMb * 1024 * 1024,
  );
  const images = new ImageService({ cache: imageCache, log });
  protocol.handle(IMAGE_SCHEME, images.handle);
  imageCache.setMaxAgeDays(settings.get().imageCacheMaxAgeDays);
  // Clean up (size cap and age) at startup, then about once a day. Runs in the background.
  const cleanImages = () =>
    void imageCache.trim().catch((e) => log.warn({ err: String(e) }, 'image cache cleanup failed'));
  void imageCache
    .init()
    .then(cleanImages)
    .catch((e) => log.warn({ err: String(e) }, 'image cache startup failed'));
  setInterval(cleanImages, 24 * 60 * 60 * 1000).unref();

  let mainWindow: BrowserWindow | null = null;
  /** Main window and compose windows: the only windows allowed to call the API. */
  const appWindows = new Set<BrowserWindow>();
  const windows = () => BrowserWindow.getAllWindows();
  const send = (e: AppEvent) => broadcast(windows, e);

  // ---- tray icon (always there; close-to-tray and start-hidden depend on it) ----
  const tray = new AppTray();
  /** Set when the app is really quitting, so closing the main window then does not hide it. */
  let isQuitting = false;

  // ---- notifications ----
  const accountNames = new Map<string, string>();
  let engineRef: EngineHost | null = null;
  const accountName = async (accountId: string): Promise<string> => {
    let n = accountNames.get(accountId);
    if (n === undefined && engineRef) {
      const list = await engineRef.request<Account[]>('accounts.list');
      accountNames.clear();
      for (const a of list) accountNames.set(a.id, a.displayName || a.email);
      n = accountNames.get(accountId);
    }
    return n ?? 'your account';
  };
  const focusMain = (messageId?: number) => {
    const w = ensureMainWindow(false);
    if (w.isMinimized()) w.restore();
    w.show();
    w.focus();
    if (messageId !== undefined) send({ type: 'ui:openMessage', messageId });
  };
  const notifier = new Notifier({
    settings: () => settings.get(),
    isMainFocused: () =>
      !!mainWindow &&
      !mainWindow.isDestroyed() &&
      mainWindow.isVisible() &&
      !mainWindow.isMinimized() &&
      mainWindow.isFocused(),
    accountName,
    focusMain,
    show: (t) => {
      if (!Notification.isSupported()) return;
      const n = new Notification({
        title: t.title,
        body: t.body,
        silent: t.silent,
        icon: appIconPath(),
      });
      n.on('click', t.onClick);
      n.show();
    },
  });
  const onEngineEvent = (e: AppEvent) => {
    send(e);
    if (e.type === 'notify:newMail') notifier.newMail(e.accountId, e.messages);
    else if (e.type === 'account:authRequired') void notifier.authRequired(e.accountId);
    else if (e.type === 'accounts:changed') accountNames.clear();
    else if (e.type === 'counts:changed') tray.setUnread(e.unifiedInboxUnread);
  };

  // ---- Sign in with Microsoft ----
  const microsoft = new MicrosoftOAuth({
    clientId: () => settings.getOAuth().microsoft.effectiveClientId,
    tenant: () => settings.getOAuth().microsoft.tenant,
    openExternal: (url) => shell.openExternal(url),
  });
  const tokens = new TokenManager(secrets, microsoft);
  const oauth = new OAuthService({
    microsoft,
    tokens,
    getAccount: async (id) => {
      const list = await engineRef!.request<Account[]>('accounts.list');
      return list.find((a) => a.id === id) ?? null;
    },
    reconnect: (accountId) => engineRef!.request('accounts.reconnect', { accountId }),
  });

  const engine = new EngineHost({
    entry: join(__dirname, 'engine.js'),
    log,
    buildInit: (): EngineInit => ({
      dataDir,
      settings: settings.get(),
      appVersion: app.getVersion(),
    }),
    onEvent: onEngineEvent,
    onFatal: () => {
      log.fatal('engine crashed repeatedly');
      void import('electron').then(({ dialog }) =>
        dialog.showErrorBox(
          'Mailroom cannot continue',
          'The mail engine keeps stopping. Open the log folder from Settings and report the problem.',
        ),
      );
    },
    handleEngineRequest: createEngineBridge({ secrets, tokens, oauth }),
  });
  engineRef = engine;

  const preload = join(__dirname, '../preload/index.js');
  const rendererUrl = process.env['ELECTRON_RENDERER_URL'];
  const composeBounds = new BoundsStore(join(dataDir, 'compose-window-state.json'), COMPOSE_RULES);
  const composeWindows = new Set<BrowserWindow>();
  const openCompose = (req: PrepareComposeReq) => {
    const w = createComposeWindow({
      store: composeBounds,
      remember: () => settings.get().rememberComposeBounds,
      others: [...composeWindows],
      main: mainWindow,
      preload,
      rendererUrl,
      rendererDir: join(__dirname, '../renderer'),
      request: req,
    });
    appWindows.add(w);
    composeWindows.add(w);
    w.on('closed', () => {
      appWindows.delete(w);
      composeWindows.delete(w);
    });
  };

  const viewers = new ViewerWindows({
    preload,
    rendererUrl,
    rendererDir: join(__dirname, '../renderer'),
    stateFile: join(dataDir, 'viewer-window-state.json'),
    getMain: () => mainWindow,
    onCreated: (w) => {
      appWindows.add(w);
      w.on('closed', () => appWindows.delete(w));
    },
  });
  const printTemp = join(app.getPath('temp'), 'mailroom-print');
  void cleanPrintTemp(printTemp);

  const mainHandlers = createMainHandlers({
    settings,
    imageCache,
    engine,
    log,
    logsDir,
    dbPath: join(dataDir, 'mail.db'),
    getWindow: () => mainWindow,
    oauth,
    openCompose,
    openViewer: (messageId) => void viewers.open(messageId),
    onSettingsChanged: (patch) => applySettingsChange(patch),
    print: { imagesHandle: images.handle, tempDir: printTemp },
  });

  registerIpc({
    engine,
    mainHandlers: mainHandlers as never,
    log,
    isTrustedSender: (event) => {
      for (const w of appWindows) {
        if (
          !w.isDestroyed() &&
          event.sender === w.webContents &&
          event.senderFrame === w.webContents.mainFrame
        ) {
          return true;
        }
      }
      return false;
    },
  });

  hardenSessions(isDev);
  engine.start();

  const trayOk = tray.create({
    open: () => focusMain(),
    newMail: () => openCompose({ mode: 'new' }),
    checkMail: () => void engine.request('sync.all').catch(() => undefined),
    quit: () => app.quit(),
  });
  if (!trayOk) log.warn('could not create the tray icon; close-to-tray is off for this run');

  /** Creates the main window if it does not exist (or was closed) and returns it. */
  function ensureMainWindow(startHidden: boolean): BrowserWindow {
    if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
    const w = createMainWindow({
      preload,
      stateFile: join(dataDir, 'window-state.json'),
      rendererUrl,
      rendererFile: join(__dirname, '../renderer/index.html'),
      startHidden,
    });
    mainWindow = w;
    appWindows.add(w);
    w.on('close', (e) => {
      if (mainCloseAction(settings.get(), isQuitting, tray.available) === 'hide') {
        e.preventDefault();
        w.hide();
      }
    });
    // Windows is signing out or shutting down: never hold that up.
    w.on('session-end', () => {
      isQuitting = true;
    });
    w.on('closed', () => {
      appWindows.delete(w);
      if (mainWindow === w) mainWindow = null;
    });
    return w;
  }

  /** Reacts to a changed setting: login item, log level, and tells every window. */
  function applySettingsChange(patch: Partial<AppSettings> | null): void {
    const next = settings.get();
    if (patch === null || patch.verboseLogging !== undefined) {
      log.level = next.verboseLogging ? 'debug' : 'info';
    }
    if (
      patch !== null &&
      (patch.launchAtLogin !== undefined || patch.startMinimizedToTray !== undefined)
    ) {
      applyLoginItem();
    }
    send({ type: 'settings:changed', settings: next, oauth: settings.getOAuth() });
  }

  /** Windows start-at-sign-in. Packaged builds only: a dev run must never register itself. */
  function applyLoginItem(): void {
    if (!app.isPackaged) return;
    try {
      app.setLoginItemSettings(loginItemOptions(settings.get()));
    } catch (e) {
      log.warn({ err: String(e) }, 'could not set the start-at-sign-in option');
    }
  }
  applyLoginItem();

  ensureMainWindow(shouldStartHidden(process.argv.slice(1), settings.get(), trayOk));

  // mailto: links. A second launch (the user clicked a link while we run) arrives as an argument.
  const openMailto = (url: string) => openCompose({ mode: 'new', mailto: url });
  app.on('second-instance', (_e, argv) => {
    const args = argv.slice(1);
    const mailto = findMailtoArg(args);
    if (mailto) openMailto(mailto);
    else if (!isHiddenOnlyLaunch(args, false)) focusMain();
  });
  app.on('open-url', (e, url) => {
    // macOS-style delivery; kept so the handler works if the code is ever built there.
    const mailto = findMailtoArg([url]);
    if (!mailto) return;
    e.preventDefault();
    openMailto(mailto);
  });
  registerMailtoHandler(dataDir, log);
  const firstMailto = findMailtoArg(process.argv.slice(1));
  if (firstMailto) openMailto(firstMailto);

  // Tell the engine when the network goes up or down.
  let online = net.isOnline();
  setInterval(() => {
    const now = net.isOnline();
    if (now === online) return;
    online = now;
    void engine.request('system.networkChanged', { online }).catch(() => undefined);
  }, 5000).unref();

  app.on('window-all-closed', () => {
    app.quit();
  });
  let quitReady = false;
  app.on('before-quit', (e) => {
    isQuitting = true;
    if (!quitReady) {
      // A draft that was just saved must reach the database before the engine process is stopped.
      e.preventDefault();
      quitReady = true;
      void waitForPendingSaves(3000).finally(() => {
        tray.destroy();
        engine.stop();
        app.quit();
      });
    }
  });
}

/**
 * Registers Mailroom as a mailto: handler. Packaged builds only (a dev run must never take over
 * mailto: links). Windows still asks the user to choose the default app (Settings > Default apps);
 * this just makes us a candidate. Done once per installed version and path.
 */
function registerMailtoHandler(dataDir: string, log: Logger): void {
  if (!app.isPackaged) return;
  const marker = join(dataDir, 'mailto-registered.txt');
  const stamp = `${app.getVersion()}|${process.execPath}`;
  try {
    if (existsSync(marker) && readFileSync(marker, 'utf8') === stamp) return;
    const ok = app.setAsDefaultProtocolClient('mailto');
    log.info({ ok }, 'registered as mailto: handler');
    if (ok) writeFileSync(marker, stamp);
  } catch (e) {
    log.warn({ err: String(e) }, 'could not register as mailto: handler');
  }
}

/** CSP header (production), permission lockdown, navigation guards. */
function hardenSessions(dev: boolean): void {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);

  if (!dev) {
    const csp = APP_CSP;
    ses.webRequest.onHeadersReceived((details, cb) => {
      cb({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } });
    });
  }

  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-attach-webview', (ev) => ev.preventDefault());
    contents.on('will-navigate', (ev, url) => {
      const allowed = dev ? process.env['ELECTRON_RENDERER_URL'] : undefined;
      const isApp = url.startsWith('file://') || (allowed !== undefined && url.startsWith(allowed));
      if (!isApp) {
        ev.preventDefault();
        if (/^https?:/i.test(url) && isSafeExternalUrl(url)) void shell.openExternal(url);
      }
    });
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url) && isSafeExternalUrl(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
  });
}
