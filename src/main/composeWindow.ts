// The compose window: its own BrowserWindow with the same security settings as the main window
// (DESIGN-SPEC 3.7, ARCHITECTURE section 0 item 6). It loads the second renderer entry
// (compose.html); the request that describes what to open travels in the URL hash.
import { join } from 'node:path';
import { BrowserWindow, nativeTheme, shell } from 'electron';
import type { PrepareComposeReq } from '../shared/ipc';
import { isSafeExternalUrl } from '../shared/safety';
import { appIconPath } from './appIcon';
import { COMPOSE_RULES, type BoundsStore } from './windowBounds';
import { placeNewWindow, trackWindowBounds } from './windowPlacement';

/** Hash value the compose renderer reads: `#req=<url-encoded JSON of PrepareComposeReq>`. */
export function composeHash(req: PrepareComposeReq): string {
  return `req=${encodeURIComponent(JSON.stringify(req))}`;
}

export function createComposeWindow(opts: {
  preload: string;
  rendererUrl: string | undefined;
  rendererDir: string;
  request: PrepareComposeReq;
  /** One saved record shared by new mail, reply, reply all and forward. */
  store: BoundsStore;
  /** Settings > Remember compose window size and position. */
  remember: () => boolean;
  /** The other compose windows that are open. */
  others: BrowserWindow[];
  main: BrowserWindow | null;
}): BrowserWindow {
  const dark = nativeTheme.shouldUseDarkColors;
  const remember = opts.remember();
  const place = placeNewWindow({
    rules: COMPOSE_RULES,
    store: opts.store,
    remember,
    others: opts.others,
    main: opts.main,
  });
  const win = new BrowserWindow({
    width: place.width,
    height: place.height,
    x: place.x,
    y: place.y,
    minWidth: COMPOSE_RULES.minWidth,
    minHeight: COMPOSE_RULES.minHeight,
    show: false,
    backgroundColor: dark ? '#202020' : '#F3F3F3',
    icon: appIconPath(),
    title: opts.request.mode === 'new' ? 'New message' : 'Message',
    titleBarStyle: 'hidden',
    titleBarOverlay: { height: 36, color: '#00000000', symbolColor: dark ? '#FFFFFF' : '#1A1A1A' },
    webPreferences: {
      preload: opts.preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: true,
    },
  });
  if (place.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());
  trackWindowBounds(win, { store: opts.store, remember: opts.remember, cascaded: place.cascaded });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url) && isSafeExternalUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  const hash = composeHash(opts.request);
  if (opts.rendererUrl) void win.loadURL(`${opts.rendererUrl.replace(/\/$/, '')}/compose.html#${hash}`);
  else void win.loadFile(join(opts.rendererDir, 'compose.html'), { hash });
  return win;
}
