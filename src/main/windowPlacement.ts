// Electron side of "remember where the window was": decides the start bounds of a new window and
// saves them when the user moves, resizes or maximizes it. The decisions are in windowBounds.ts.
import { screen, type BrowserWindow } from 'electron';
import {
  resolveBounds,
  type BoundsRules,
  type BoundsStore,
  type ResolvedBounds,
} from './windowBounds';

export interface PlacementOptions {
  rules: BoundsRules;
  store: BoundsStore;
  /** False = do not restore and do not save (always the default size, centered). */
  remember: boolean;
  /** Windows of the same kind that are open now. */
  others: BrowserWindow[];
  /** The main window, if any (new windows open on its display). */
  main: BrowserWindow | null;
}

/** The size and position a new window of this kind should open with. */
export function placeNewWindow(o: PlacementOptions): ResolvedBounds {
  const displays = screen.getAllDisplays();
  const workAreas = displays.map((d) => d.workArea);
  const mainDisplay =
    o.main && !o.main.isDestroyed() && !o.main.isMinimized()
      ? screen.getDisplayMatching(o.main.getBounds())
      : screen.getPrimaryDisplay();
  return resolveBounds({
    rules: o.rules,
    saved: o.remember ? o.store.get() : null,
    workAreas,
    mainWorkArea: mainDisplay.workArea,
    open: o.others.filter((w) => !w.isDestroyed() && !w.isMaximized()).map((w) => w.getNormalBounds()),
  });
}

/**
 * Save the window's bounds 500 ms after it was moved, resized or (un)maximized, and when it closes.
 * A window that was only placed by the cascade does not overwrite the saved record until the user
 * moves or resizes it.
 */
export function trackWindowBounds(
  win: BrowserWindow,
  o: { store: BoundsStore; remember: () => boolean; cascaded: boolean },
): void {
  let touched = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const save = () => {
    if (win.isDestroyed() || !o.remember()) return;
    if (o.cascaded && !touched) return;
    const b = win.getNormalBounds();
    o.store.save({ x: b.x, y: b.y, width: b.width, height: b.height, maximized: win.isMaximized() });
  };
  const later = () => {
    touched = true;
    if (timer) clearTimeout(timer);
    timer = setTimeout(save, 500);
  };
  // Listen only once the window is shown: the first placement must not count as "touched".
  win.once('ready-to-show', () => {
    setTimeout(() => {
      if (win.isDestroyed()) return;
      win.on('move', later);
      win.on('resize', later);
      win.on('maximize', later);
      win.on('unmaximize', later);
    }, 400);
  });
  win.on('close', () => {
    if (timer) clearTimeout(timer);
    save();
  });
}
