// The quit prompt for scheduled messages (DESIGN-SPEC 3.11.5). Pure parts, so they can be tested.
import type { ScheduledNextDue } from '../shared/ipc';

/** Windows signing out or restarting is never held up; an update install relaunches the app. */
export function shouldAskBeforeQuit(s: {
  quitConfirmed: boolean;
  sessionEnding: boolean;
  due: ScheduledNextDue | null;
}): boolean {
  if (s.quitConfirmed || s.sessionEnding) return false;
  return (s.due?.count ?? 0) > 0;
}

export function quitPromptText(count: number): { message: string; detail: string } {
  const n = count === 1 ? 'a scheduled message' : `${count} scheduled messages`;
  return {
    message: `You have ${n}.`,
    detail: "Letterdock can't send scheduled messages while it is closed.",
  };
}

export const QUIT_BUTTONS = ['Keep Letterdock open', 'Quit anyway'] as const;

/**
 * Whether the user already answered the quit prompt. The answer only holds while Letterdock is really
 * on its way out. It is forgotten as soon as the app keeps running (for example the main window was
 * closed through the prompt, but a compose window stays open): the next quit asks again.
 */
export class QuitState {
  private answered = false;

  get confirmed(): boolean {
    return this.answered;
  }

  /** The user chose "Quit anyway", or no prompt was needed: quitting goes on. */
  confirm(): void {
    this.answered = true;
  }

  /** The quit was cancelled ("Keep Letterdock open") or did not happen. */
  cancel(): void {
    this.answered = false;
  }

  /**
   * The main window is gone. With other windows left, and no quit under way, the app continues:
   * the answer is void. With no window left the app quits next, so the answer stays (no second prompt).
   */
  mainWindowClosed(s: { windowsLeft: number; quitting: boolean }): void {
    if (!s.quitting && s.windowsLeft > 0) this.answered = false;
  }
}
