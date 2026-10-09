// The quit prompt for scheduled messages: when it is asked and what it says.
import { describe, expect, it } from 'vitest';
import { QUIT_BUTTONS, quitPromptText, shouldAskBeforeQuit } from '../../src/main/quitGuard';

describe('quit prompt', () => {
  it('asks only when scheduled messages are due within 24 hours', () => {
    const due = { count: 2, nextSendAt: 1 };
    expect(shouldAskBeforeQuit({ quitConfirmed: false, sessionEnding: false, due })).toBe(true);
    expect(shouldAskBeforeQuit({ quitConfirmed: false, sessionEnding: false, due: { count: 0, nextSendAt: null } })).toBe(false);
    expect(shouldAskBeforeQuit({ quitConfirmed: false, sessionEnding: false, due: null })).toBe(false);
  });

  it('never holds up Windows shutdown or an answer that was already given', () => {
    const due = { count: 1, nextSendAt: 1 };
    expect(shouldAskBeforeQuit({ quitConfirmed: false, sessionEnding: true, due })).toBe(false);
    expect(shouldAskBeforeQuit({ quitConfirmed: true, sessionEnding: false, due })).toBe(false);
  });

  it('says how many, and keeps "Keep Letterdock open" as the first (default) button', () => {
    expect(quitPromptText(1).message).toBe('You have a scheduled message.');
    expect(quitPromptText(2).message).toBe('You have 2 scheduled messages.');
    expect(quitPromptText(2).detail).toContain("can't send");
    expect(QUIT_BUTTONS[0]).toBe('Keep Letterdock open');
    expect(QUIT_BUTTONS[1]).toBe('Quit anyway');
  });
});
