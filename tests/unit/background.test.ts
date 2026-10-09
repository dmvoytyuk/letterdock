import { describe, expect, it } from 'vitest';
import {
  isHiddenOnlyLaunch,
  loginItemOptions,
  mainCloseAction,
  shouldStartHidden,
  trayTooltip,
} from '../../src/main/background';

describe('background decisions', () => {
  it('starts hidden only at sign-in, with the setting on and a tray', () => {
    const on = { startMinimizedToTray: true };
    expect(shouldStartHidden(['--hidden'], on, true)).toBe(true);
    expect(shouldStartHidden([], on, true)).toBe(false);
    expect(shouldStartHidden(['--hidden'], on, false)).toBe(false);
    expect(shouldStartHidden(['--hidden'], { startMinimizedToTray: false }, true)).toBe(false);
  });

  it('close hides the window only when asked, not while quitting, and only with a tray', () => {
    expect(mainCloseAction({ closeToTray: true }, false, true)).toBe('hide');
    expect(mainCloseAction({ closeToTray: true }, true, true)).toBe('close');
    expect(mainCloseAction({ closeToTray: false }, false, true)).toBe('close');
    expect(mainCloseAction({ closeToTray: true }, false, false)).toBe('close');
  });

  it('passes --hidden to the login item when start hidden is on', () => {
    expect(loginItemOptions({ launchAtLogin: true, startMinimizedToTray: true })).toEqual({
      openAtLogin: true,
      args: ['--hidden'],
    });
    expect(loginItemOptions({ launchAtLogin: true, startMinimizedToTray: false })).toEqual({
      openAtLogin: true,
      args: [],
    });
    expect(loginItemOptions({ launchAtLogin: false, startMinimizedToTray: true }).openAtLogin).toBe(
      false,
    );
  });

  it('tooltip shows the unread count', () => {
    expect(trayTooltip(0)).toBe('Mailroom');
    expect(trayTooltip(7)).toBe('Mailroom - 7 unread');
  });

  it('a second launch with only --hidden does not restore the window', () => {
    expect(isHiddenOnlyLaunch(['--hidden'], false)).toBe(true);
    expect(isHiddenOnlyLaunch(['--hidden'], true)).toBe(false);
    expect(isHiddenOnlyLaunch([], false)).toBe(false);
  });
});
