import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BoundsStore,
  COMPOSE_RULES,
  isGrabbable,
  parseSavedBounds,
  resolveBounds,
  type Rect,
} from '../../src/main/windowBounds';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/main/settings';

const screen1: Rect = { x: 0, y: 0, width: 1920, height: 1040 };
const screen2: Rect = { x: 1920, y: 0, width: 1280, height: 984 };
const base = { rules: COMPOSE_RULES, workAreas: [screen1], mainWorkArea: screen1, open: [] as Rect[] };

describe('parseSavedBounds', () => {
  it('reads size, position and maximized; bad data gives null', () => {
    expect(parseSavedBounds('{"x":10,"y":20,"width":800,"height":600,"maximized":true}', COMPOSE_RULES)).toEqual({
      x: 10, y: 20, width: 800, height: 600, maximized: true,
    });
    expect(parseSavedBounds(null, COMPOSE_RULES)).toBeNull();
    expect(parseSavedBounds('nope', COMPOSE_RULES)).toBeNull();
    expect(parseSavedBounds('{"width":"a","height":1}', COMPOSE_RULES)).toBeNull();
    expect(parseSavedBounds('{"width":10,"height":99999}', COMPOSE_RULES)).toMatchObject({ width: 520, height: 8000 });
    // An older file without position keeps working.
    expect(parseSavedBounds('{"width":900,"height":700}', COMPOSE_RULES)).toEqual({ width: 900, height: 700, maximized: false });
  });
});

describe('resolveBounds', () => {
  it('first run: 760x720 centered on the main display', () => {
    const r = resolveBounds({ ...base, saved: null });
    expect(r).toMatchObject({ width: 760, height: 720, x: 580, y: 160, maximized: false, cascaded: false });
  });

  it('restores the saved size, position and maximized state', () => {
    const r = resolveBounds({ ...base, saved: { x: 100, y: 50, width: 900, height: 650, maximized: true } });
    expect(r).toMatchObject({ x: 100, y: 50, width: 900, height: 650, maximized: true });
  });

  it('cascades by 24 px when a compose window is open at that place', () => {
    const open = [{ x: 100, y: 50, width: 900, height: 650 }];
    const r = resolveBounds({ ...base, open, saved: { x: 100, y: 50, width: 900, height: 650, maximized: false } });
    expect(r).toMatchObject({ x: 124, y: 74, cascaded: true });
    const two = resolveBounds({ ...base, open: [...open, { x: 124, y: 74, width: 900, height: 650 }], saved: { x: 100, y: 50, width: 900, height: 650, maximized: false } });
    expect(two).toMatchObject({ x: 148, y: 98 });
  });

  it('a window on a display that is gone moves to the main display, centered', () => {
    const r = resolveBounds({ ...base, saved: { x: 2500, y: 100, width: 800, height: 600, maximized: false } });
    expect(r).toMatchObject({ x: 560, y: 220, width: 800, height: 600 });
    expect(isGrabbable({ x: r.x!, y: r.y!, width: r.width, height: r.height }, [screen1])).toBe(true);
  });

  it('keeps a position on the second display while it is connected', () => {
    const r = resolveBounds({ ...base, workAreas: [screen1, screen2], saved: { x: 2200, y: 100, width: 800, height: 600, maximized: false } });
    expect(r).toMatchObject({ x: 2200, y: 100 });
  });

  it('shrinks a too big window to the work area but never below 520x480', () => {
    const small: Rect = { x: 0, y: 0, width: 640, height: 400 };
    const r = resolveBounds({ ...base, workAreas: [small], mainWorkArea: small, saved: { x: 5000, y: 5000, width: 3000, height: 2000, maximized: false } });
    expect(r.width).toBe(640);
    expect(r.height).toBe(480);
  });

  it('title bar nearly off screen counts as lost', () => {
    expect(isGrabbable({ x: -700, y: 10, width: 760, height: 720 }, [screen1])).toBe(false); // 60 px visible
    expect(isGrabbable({ x: -600, y: 10, width: 760, height: 720 }, [screen1])).toBe(true); // 160 px visible
    expect(isGrabbable({ x: 100, y: -40, width: 760, height: 720 }, [screen1])).toBe(false); // title bar above
  });
});

describe('BoundsStore', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  it('saves and reloads', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mailroom-bounds-'));
    dirs.push(dir);
    const file = join(dir, 'compose-window-state.json');
    const a = new BoundsStore(file, COMPOSE_RULES);
    expect(a.get()).toBeNull();
    a.save({ x: 1, y: 2, width: 800, height: 600, maximized: false });
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ width: 800, x: 1 });
    expect(new BoundsStore(file, COMPOSE_RULES).get()).toMatchObject({ width: 800, height: 600 });
  });
});

describe('new settings', () => {
  it('have defaults and merge over old files', () => {
    expect(DEFAULT_SETTINGS.alwaysShowCcBcc).toBe(false);
    expect(DEFAULT_SETTINGS.rememberComposeBounds).toBe(true);
    expect(mergeSettings({ markReadDelayMs: 0 }).rememberComposeBounds).toBe(true);
    expect(mergeSettings({ alwaysShowCcBcc: true }).alwaysShowCcBcc).toBe(true);
  });
});
