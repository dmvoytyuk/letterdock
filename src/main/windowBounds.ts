// Pure helpers for remembering where a window was (no Electron, so tests can import them).
// Used by the compose window and the message window.

import { readFileSync, renameSync, writeFileSync } from 'node:fs';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What is saved on disk. Position is optional (older files only have the size). */
export interface SavedBounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized: boolean;
}

export interface BoundsRules {
  defaultWidth: number;
  defaultHeight: number;
  minWidth: number;
  minHeight: number;
}

/** Compose window rules (DESIGN-SPEC 3.7). */
export const COMPOSE_RULES: BoundsRules = {
  defaultWidth: 760,
  defaultHeight: 720,
  minWidth: 520,
  minHeight: 480,
};

/** Message window rules. */
export const VIEWER_RULES: BoundsRules = {
  defaultWidth: 900,
  defaultHeight: 760,
  minWidth: 480,
  minHeight: 400,
};

/** How far each new window is moved from the one before it. */
export const CASCADE_STEP = 24;
/** The part of the title bar that must stay visible so the user can grab the window. */
const GRAB_W = 100;
const GRAB_H = 60;

const ok = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/** Reads a saved record; anything odd gives null (= use the defaults). */
export function parseSavedBounds(raw: string | null, rules: BoundsRules): SavedBounds | null {
  try {
    const s = JSON.parse(raw ?? '') as Partial<SavedBounds>;
    if (!s || typeof s !== 'object' || !ok(s.width) || !ok(s.height)) return null;
    const out: SavedBounds = {
      width: Math.min(8000, Math.max(rules.minWidth, Math.round(s.width))),
      height: Math.min(8000, Math.max(rules.minHeight, Math.round(s.height))),
      maximized: s.maximized === true,
    };
    if (ok(s.x) && ok(s.y) && Math.abs(s.x) < 100000 && Math.abs(s.y) < 100000) {
      out.x = Math.round(s.x);
      out.y = Math.round(s.y);
    }
    return out;
  } catch {
    return null;
  }
}

function overlap(a: Rect, b: Rect): { w: number; h: number } {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return { w: Math.max(0, w), h: Math.max(0, h) };
}

/** Is enough of the window's title bar on some display to grab it with the mouse? */
export function isGrabbable(rect: Rect, workAreas: Rect[]): boolean {
  const bar: Rect = { x: rect.x, y: rect.y, width: rect.width, height: Math.min(GRAB_H, rect.height) };
  return workAreas.some((wa) => {
    const o = overlap(bar, wa);
    return o.w >= Math.min(GRAB_W, bar.width) && o.h >= Math.min(GRAB_H, bar.height);
  });
}

export interface ResolvedBounds {
  width: number;
  height: number;
  /** Absent = let the system center the window. */
  x?: number;
  y?: number;
  maximized: boolean;
  /** True when the window was moved because another window of the same kind sits there. */
  cascaded: boolean;
}

export interface ResolveInput {
  rules: BoundsRules;
  /** Saved record, or null (first run, or remembering is off). */
  saved: SavedBounds | null;
  /** Work areas of all connected displays. */
  workAreas: Rect[];
  /** Work area of the display of the main window (or the primary display). */
  mainWorkArea: Rect;
  /** Bounds of the windows of this kind that are open now. */
  open: Rect[];
}

/** The size and position a new window should open with. */
export function resolveBounds(input: ResolveInput): ResolvedBounds {
  const { rules, saved, workAreas, mainWorkArea, open } = input;
  const base = saved ?? {
    width: rules.defaultWidth,
    height: rules.defaultHeight,
    maximized: false,
  };
  let width = Math.max(rules.minWidth, base.width);
  let height = Math.max(rules.minHeight, base.height);
  let x: number | undefined;
  let y: number | undefined;

  if (saved && saved.x !== undefined && saved.y !== undefined) {
    if (isGrabbable({ x: saved.x, y: saved.y, width, height }, workAreas)) {
      x = saved.x;
      y = saved.y;
    }
  }
  if (x === undefined || y === undefined) {
    // First run, or the saved place is gone (monitor unplugged): centered on the main window's display.
    width = Math.max(rules.minWidth, Math.min(width, mainWorkArea.width));
    height = Math.max(rules.minHeight, Math.min(height, mainWorkArea.height));
    x = Math.round(mainWorkArea.x + (mainWorkArea.width - width) / 2);
    y = Math.round(mainWorkArea.y + (mainWorkArea.height - height) / 2);
  }

  // Another window is at the same place: step down and to the right.
  let cascaded = false;
  const wa = workAreas.find((w) => isGrabbable({ x: x!, y: y!, width, height }, [w])) ?? mainWorkArea;
  for (let i = 0; i < 20 && open.some((o) => Math.abs(o.x - x!) < CASCADE_STEP && Math.abs(o.y - y!) < CASCADE_STEP); i++) {
    x += CASCADE_STEP;
    y += CASCADE_STEP;
    cascaded = true;
    if (x + width > wa.x + wa.width || y + height > wa.y + wa.height) {
      // No room: start again from the top left of the display.
      x = wa.x + CASCADE_STEP;
      y = wa.y + CASCADE_STEP;
    }
  }
  return { width, height, x, y, maximized: base.maximized, cascaded };
}

/** The saved record of one kind of window, kept in a small JSON file. */
export class BoundsStore {
  private current: SavedBounds | null;

  constructor(
    private readonly file: string,
    private readonly rules: BoundsRules,
  ) {
    let raw: string | null = null;
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      /* first run */
    }
    this.current = parseSavedBounds(raw, rules);
  }

  get(): SavedBounds | null {
    return this.current;
  }

  save(b: SavedBounds): void {
    const clean = parseSavedBounds(JSON.stringify(b), this.rules);
    if (!clean) return;
    this.current = clean;
    try {
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(clean));
      renameSync(tmp, this.file);
    } catch {
      /* not critical */
    }
  }
}
