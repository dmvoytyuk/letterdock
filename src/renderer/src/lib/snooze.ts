// Times for Snooze (DESIGN-SPEC 3.13.2). Pure functions, so the rules can be tested without a screen.
// All times are the local wall clock of this PC.
import type { SnoozeTimes } from '../../../shared/ipc';
import { at, scheduledGroup, timeText, whenText } from './schedule';

export const DEFAULT_SNOOZE_TIMES: SnoozeTimes = { morning: '08:00', evening: '18:00', weekendMorning: '09:00' };
/** "Later today" is only offered before this hour. */
const LATER_TODAY_BEFORE_HOUR = 16;

export type SnoozeId = 'today' | 'tomorrow' | 'weekend' | 'nextweek';
export interface SnoozeOption {
  id: SnoozeId;
  label: string;
  /** Right-aligned text: "18:00", "Tomorrow 08:00", "Sat 09:00", "Mon 08:00". */
  hint: string;
  at: number;
}

/** "08:30" to hour and minute. Anything else gives the fallback. */
export function parseHm(text: string | undefined, fallback: string): { h: number; m: number } {
  const m = /^(\d{1,2}):(\d{2})$/.exec((text ?? '').trim()) ?? /^(\d{1,2}):(\d{2})$/.exec(fallback)!;
  return { h: Math.min(23, Number(m[1])), m: Math.min(59, Number(m[2])) };
}

function weekdayShort(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { weekday: 'short' });
}

/**
 * The quick times of the Snooze menu. "Later today" only before 16:00, "This weekend" only Monday to
 * Friday and on Saturday before the weekend time, "Next week" is the next Monday (a Monday means the
 * Monday after it).
 */
export function snoozeOptions(now: number, times: SnoozeTimes = DEFAULT_SNOOZE_TIMES): SnoozeOption[] {
  const d = new Date(now);
  const morning = parseHm(times.morning, DEFAULT_SNOOZE_TIMES.morning);
  const evening = parseHm(times.evening, DEFAULT_SNOOZE_TIMES.evening);
  const weekend = parseHm(times.weekendMorning, DEFAULT_SNOOZE_TIMES.weekendMorning);
  const out: SnoozeOption[] = [];

  const eveningAt = at(d, evening.h, evening.m);
  if (d.getHours() < LATER_TODAY_BEFORE_HOUR && eveningAt > now) {
    out.push({ id: 'today', label: 'Later today', hint: timeText(eveningAt), at: eveningAt });
  }

  const tomorrow = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
  const tomorrowAt = at(tomorrow, morning.h, morning.m);
  out.push({ id: 'tomorrow', label: 'Tomorrow', hint: `Tomorrow ${timeText(tomorrowAt)}`, at: tomorrowAt });

  const dow = d.getDay(); // 0 Sunday, 6 Saturday
  const satAt = at(new Date(d.getFullYear(), d.getMonth(), d.getDate() + ((6 - dow + 7) % 7)), weekend.h, weekend.m);
  const weekdayOrEarlySaturday = (dow >= 1 && dow <= 5) || (dow === 6 && satAt > now);
  if (weekdayOrEarlySaturday) {
    out.push({ id: 'weekend', label: 'This weekend', hint: `${weekdayShort(satAt)} ${timeText(satAt)}`, at: satAt });
  }

  const toMonday = (8 - dow) % 7 || 7;
  const mondayAt = at(new Date(d.getFullYear(), d.getMonth(), d.getDate() + toMonday), morning.h, morning.m);
  out.push({ id: 'nextweek', label: 'Next week', hint: `${weekdayShort(mondayAt)} ${timeText(mondayAt)}`, at: mondayAt });
  return out;
}

/** "Today 18:00", "Tomorrow 08:00", else "Mon 12 Oct, 08:00". */
export function snoozeUntilText(ms: number, now = Date.now()): string {
  const g = scheduledGroup(ms, now);
  const day = new Date(now);
  const startToday = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
  if (ms < startToday + 86_400_000) return `Today ${timeText(ms)}`;
  if (g === 'Tomorrow') return `Tomorrow ${timeText(ms)}`;
  return whenText(ms, now);
}

/** Header of a group in the Snoozed view. */
export const snoozeGroup = scheduledGroup;
