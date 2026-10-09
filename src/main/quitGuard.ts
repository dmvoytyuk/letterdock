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
