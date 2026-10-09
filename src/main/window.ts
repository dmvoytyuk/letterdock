import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BrowserWindow, nativeTheme, screen, shell } from 'electron';
import { isSafeExternalUrl } from '../shared/safety';
import { appIconPath } from './appIcon';

interface WindowState {
  width: number;
  height: number;
  x?: number;
  y?: number;
  maximized: boolean;
}

const DEFAULT_STATE: WindowState = { width: 1280, height: 800, maximized: false };

function loadState(file: string): WindowState {
  try {
    const s = JSON.parse(readFileSync(file, 'utf8')) as WindowState;
    if (!Number.isFinite(s.width) || !Number.isFinite(s.height)) return DEFAULT_STATE;
    // Ignore saved positions that are no longer on any display.
    if (s.x !== undefined && s.y !== undefined) {
      const onScreen = screen.getAllDisplays().some((d) => {
        const b = d.workArea;
        return (
          s.x! >= b.x - 50 &&
          s.x! < b.x + b.width - 100 &&
          s.y! >= b.y - 50 &&
          s.y! < b.y + b.height - 100
        );
      });
      if (!onScreen) return { width: s.width, height: s.height, maximized: s.maximized };
    }
    return s;
  } catch {
    return DEFAULT_STATE;
  }
}

/** Colors from DESIGN-SPEC 1.6 (bg.app / text.primary). */
function themeColors(): { bg: string; symbol: string } {
  return nativeTheme.shouldUseDarkColors
    ? { bg: '#202020', symbol: '#FFFFFF' }
    : { bg: '#F3F3F3', symbol: '#1A1A1A' };
}

export function createMainWindow(opts: {
  preload: string;
  stateFile: string;
  rendererUrl: string | undefined;
  rendererFile: string;
  startHidden: boolean;
}): BrowserWindow {
  const state = loadState(opts.stateFile);
  const { bg, symbol } = themeColors();
  const win = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: 480,
    minHeight: 560,
    show: false,
    backgroundColor: bg,
    title: 'Mailroom',
    icon: appIconPath(),
    // DESIGN-SPEC 2.1: custom 36px title bar; native caption buttons stay (Snap Layouts work).
    titleBarStyle: 'hidden',
    titleBarOverlay: { height: 36, color: '#00000000', symbolColor: symbol },
    webPreferences: {
      preload: opts.preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
    },
  });
  if (state.maximized) win.maximize();

  nativeTheme.on('updated', () => {
    if (win.isDestroyed()) return;
    const c = themeColors();
    win.setBackgroundColor(c.bg);
    win.setTitleBarOverlay({ height: 36, color: '#00000000', symbolColor: c.symbol });
  });

  win.once('ready-to-show', () => {
    if (!opts.startHidden) win.show();
  });

  let timer: ReturnType<typeof setTimeout> | null = null;
  const save = () => {
    if (win.isDestroyed()) return;
    const b = win.getNormalBounds();
    const s: WindowState = { ...b, maximized: win.isMaximized() };
    try {
      writeFileSync(opts.stateFile, JSON.stringify(s));
    } catch {
      /* not critical */
    }
  };
  const debounced = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(save, 500);
  };
  win.on('resize', debounced);
  win.on('move', debounced);
  win.on('close', save);

  // Links in the app shell never navigate the window; web links go to the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url) && isSafeExternalUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (opts.rendererUrl) void win.loadURL(opts.rendererUrl);
  else void win.loadFile(join(opts.rendererFile));
  return win;
}
