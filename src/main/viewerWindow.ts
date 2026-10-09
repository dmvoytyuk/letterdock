// "Open in new window": one BrowserWindow per message, same security settings as the compose window.
// It loads the third renderer entry (viewer.html); the message id travels in the URL hash.
// Size, position and maximized state are remembered between runs (see windowBounds.ts).
import { join } from 'node:path';
import { BrowserWindow, nativeTheme, shell } from 'electron';
import { isSafeExternalUrl } from '../shared/safety';
import { appIconPath } from './appIcon';
import { viewerHash } from './viewerState';
import { BoundsStore, VIEWER_RULES } from './windowBounds';
import { placeNewWindow, trackWindowBounds } from './windowPlacement';

export interface ViewerWindowsOptions {
  preload: string;
  rendererUrl: string | undefined;
  rendererDir: string;
  stateFile: string;
  /** The main window (new windows open on its display). */
  getMain: () => BrowserWindow | null;
  /** Called for every new window (main adds it to the trusted-sender set). */
  onCreated: (w: BrowserWindow) => void;
}

export class ViewerWindows {
  private windows = new Map<number, BrowserWindow>();
  private store: BoundsStore;

  constructor(private readonly opts: ViewerWindowsOptions) {
    this.store = new BoundsStore(opts.stateFile, VIEWER_RULES);
  }

  /** Opens the message, or focuses the window that already shows it. */
  open(messageId: number): BrowserWindow {
    const existing = this.windows.get(messageId);
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore();
      existing.show();
      existing.focus();
      return existing;
    }
    const win = this.create(messageId);
    this.windows.set(messageId, win);
    win.on('closed', () => {
      if (this.windows.get(messageId) === win) this.windows.delete(messageId);
    });
    this.opts.onCreated(win);
    return win;
  }

  private create(messageId: number): BrowserWindow {
    const dark = nativeTheme.shouldUseDarkColors;
    const place = placeNewWindow({
      rules: VIEWER_RULES,
      store: this.store,
      remember: true,
      others: [...this.windows.values()],
      main: this.opts.getMain(),
    });
    const win = new BrowserWindow({
      width: place.width,
      height: place.height,
      x: place.x,
      y: place.y,
      minWidth: 480,
      minHeight: 400,
      show: false,
      backgroundColor: dark ? '#202020' : '#F3F3F3',
      icon: appIconPath(),
      title: 'Message',
      titleBarStyle: 'hidden',
      titleBarOverlay: { height: 36, color: '#00000000', symbolColor: dark ? '#FFFFFF' : '#1A1A1A' },
      webPreferences: {
        preload: this.opts.preload,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        spellcheck: false,
      },
    });
    if (place.maximized) win.maximize();
    win.once('ready-to-show', () => win.show());
    trackWindowBounds(win, { store: this.store, remember: () => true, cascaded: place.cascaded });

    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url) && isSafeExternalUrl(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    const hash = viewerHash(messageId);
    if (this.opts.rendererUrl) {
      void win.loadURL(`${this.opts.rendererUrl.replace(/\/$/, '')}/viewer.html#${hash}`);
    } else {
      void win.loadFile(join(this.opts.rendererDir, 'viewer.html'), { hash });
    }
    return win;
  }
}
