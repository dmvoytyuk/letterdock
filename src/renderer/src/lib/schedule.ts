// Times for "Send later" (DESIGN-SPEC 3.11). Pure functions, so the rules can be tested without a screen.
// All times are the local wall clock of this PC; a time that does not exist (spring forward) moves
// forward by one hour, which is what `new Date(y, m, d, h, min)` does.

export const EVENING_HOUR = 18;
export const MORNING_HOUR = 8;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Scheduling must be at least this far ahead ("Pick a time in the future"). */
export const MIN_AHEAD_MS = MINUTE;
/** About one year (the engine allows up to this far ahead). */
export const MAX_AHEAD_DAYS = 365;

export type QuickId = 'same' | 'today' | 'tomorrow' | 'monday';
export interface QuickTime {
  id: QuickId;
  label: string;
  /** Text on the right of the menu item: the time only for "Later today", else weekday, date and time. */
  hint: string;
  at: number;
}

export function at(date: Date, hour: number, minute = 0): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, minute, 0, 0).getTime();
}

/** "08:00" or "8:00 AM", following the system locale. */
export function timeText(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** "Fri 10 Oct, 08:00" (no year when it is this year). */
export function whenText(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  const date = d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) });
  return `${date}, ${timeText(ms)}`;
}

/** For list rows: "Today 18:00", else "Fri 10 Oct, 08:00". */
export function rowWhenText(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const today = new Date(now);
  if (d.toDateString() === today.toDateString()) return `Today ${timeText(ms)}`;
  return whenText(ms, now);
}

/** "in 14 hours", "in 5 minutes", "in 3 days". */
export function inText(ms: number, now = Date.now()): string {
  const diff = ms - now;
  if (diff < HOUR) {
    const m = Math.max(1, Math.round(diff / MINUTE));
    return `in ${m} ${m === 1 ? 'minute' : 'minutes'}`;
  }
  if (diff < DAY) {
    const h = Math.round(diff / HOUR);
    return `in ${h} ${h === 1 ? 'hour' : 'hours'}`;
  }
  const d = Math.round(diff / DAY);
  return `in ${d} ${d === 1 ? 'day' : 'days'}`;
}

/** "in 14 hours", or "due now" when the time has come and the message waits (offline, signed out). */
export function relText(ms: number, now = Date.now()): string {
  return ms <= now ? 'due now' : inText(ms, now);
}

/** "3 days ago", for a held message. */
export function agoText(overdueMs: number): string {
  if (overdueMs < HOUR) {
    const m = Math.max(1, Math.round(overdueMs / MINUTE));
    return `${m} ${m === 1 ? 'minute' : 'minutes'} ago`;
  }
  if (overdueMs < DAY) {
    const h = Math.round(overdueMs / HOUR);
    return `${h} ${h === 1 ? 'hour' : 'hours'} ago`;
  }
  const d = Math.round(overdueMs / DAY);
  return `${d} ${d === 1 ? 'day' : 'days'} ago`;
}

/**
 * The quick times of the Send later menu (3.11.1). Evening 18:00 and morning 08:00, PC time.
 * "Later today" only when 18:00 is at least 60 minutes away. "Monday morning" is hidden on
 * Sunday and Monday. "Same time" comes first when a scheduled message is being edited and its old
 * time is still in the future.
 */
export function quickTimes(now: number, sameTime?: number | null): QuickTime[] {
  const d = new Date(now);
  const out: QuickTime[] = [];
  if (sameTime && sameTime > now + MIN_AHEAD_MS) {
    out.push({ id: 'same', label: 'Same time', hint: whenText(sameTime, now), at: sameTime });
  }
  const evening = at(d, EVENING_HOUR);
  if (evening - now >= HOUR) out.push({ id: 'today', label: 'Later today', hint: timeText(evening), at: evening });
  const tomorrow = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
  const tomorrowAt = at(tomorrow, MORNING_HOUR);
  out.push({ id: 'tomorrow', label: 'Tomorrow morning', hint: whenText(tomorrowAt, now), at: tomorrowAt });
  const dow = d.getDay(); // 0 = Sunday, 1 = Monday
  if (dow !== 0 && dow !== 1) {
    const toMonday = (8 - dow) % 7 || 7;
    const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() + toMonday);
    const mondayAt = at(monday, MORNING_HOUR);
    out.push({ id: 'monday', label: 'Monday morning', hint: whenText(mondayAt, now), at: mondayAt });
  }
  return out;
}

/** Default for "Pick date & time...": tomorrow at 08:00. */
export function defaultPick(now: number): number {
  const d = new Date(now);
  return at(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1), MORNING_HOUR);
}

// ---------- typed date and time ----------

/** True when the system clock shows AM/PM. */
export function uses12Hours(): boolean {
  try {
    return !!new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hour12;
  } catch {
    return false;
  }
}

/** The text shown in the date field, e.g. "Fri, 10 Oct 2026". */
export function dateFieldText(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}

/** The text shown in the time field, e.g. "08:00" or "8:00 AM". */
export function timeFieldText(ms: number): string {
  return timeText(ms);
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function validYmd(y: number, m: number, d: number): { y: number; m: number; d: number } | null {
  const t = new Date(y, m, d);
  return t.getFullYear() === y && t.getMonth() === m && t.getDate() === d ? { y, m, d } : null;
}

/** True when this system writes the month before the day (en-US). */
function dateOrderMonthFirst(): boolean {
  try {
    const parts = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(2000, 0, 31));
    return parts.findIndex((p) => p.type === 'month') < parts.findIndex((p) => p.type === 'day');
  } catch {
    return false;
  }
}

/**
 * Reads a typed date. Accepts "2026-10-09", "10/09/2026"-style numbers (day first or month first as
 * the system writes them), "10 Oct 2026", "Oct 10", with or without a weekday. Without a year it is
 * this year, or next year when this year's date has already passed.
 */
export function parseDateText(text: string, now: number): { y: number; m: number; d: number } | null {
  const t = text.trim().toLowerCase().replace(/,/g, ' ').replace(/\s+/g, ' ');
  if (!t) return null;
  const today = new Date(now);
  const yearFor = (m: number, d: number): number => {
    const thisYear = today.getFullYear();
    const cand = new Date(thisYear, m, d);
    return cand.getTime() < new Date(thisYear, today.getMonth(), today.getDate()).getTime() ? thisYear + 1 : thisYear;
  };
  let m: RegExpMatchArray | null;
  if ((m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) return validYmd(+m[1]!, +m[2]! - 1, +m[3]!);
  if ((m = t.match(/^(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2,4}))?$/))) {
    const a = +m[1]!;
    const b = +m[2]!;
    // Which comes first follows the system's date order.
    let [day, mon] = dateOrderMonthFirst() ? [b, a] : [a, b];
    if (mon > 12 && day <= 12) [day, mon] = [mon, day];
    const y = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : yearFor(mon - 1, day);
    return validYmd(y, mon - 1, day);
  }
  // Words: optional weekday, a day number, a month name, optional year (in any order of day/month).
  const words = t.split(' ').filter((w) => !/^(mon|tue|wed|thu|fri|sat|sun)[a-z]*$/.test(w));
  let day: number | null = null;
  let mon: number | null = null;
  let year: number | null = null;
  for (const w of words) {
    const idx = MONTHS.findIndex((x) => w.startsWith(x));
    if (idx >= 0 && /^[a-z]+\.?$/.test(w)) mon = idx;
    else if (/^\d{4}$/.test(w)) year = +w;
    else if (/^\d{1,2}(st|nd|rd|th)?$/.test(w)) day = parseInt(w, 10);
    else return null;
  }
  if (day === null || mon === null) return null;
  return validYmd(year ?? yearFor(mon, day), mon, day);
}

/** Reads a typed time: "8", "08:30", "8:30 pm", "2030". */
export function parseTimeText(text: string): { h: number; min: number } | null {
  const t = text.trim().toLowerCase().replace(/\s+/g, '');
  const m = t.match(/^(\d{1,2})(?::?(\d{2}))?(a|p|am|pm)?$/);
  if (!m) return null;
  let h = +m[1]!;
  const min = m[2] ? +m[2] : 0;
  if (min > 59) return null;
  if (m[3]) {
    if (h < 1 || h > 12) return null;
    h = h % 12 + (m[3].startsWith('p') ? 12 : 0);
  } else if (h > 23) return null;
  return { h, min };
}

export interface PickResult {
  /** The chosen time, when it is valid. */
  at: number | null;
  /** The one error to show, in plain words. */
  error: { field: 'date' | 'time'; text: string } | null;
}

/** Checks the two typed fields against the rules of 3.11.2. */
export function checkPick(dateText: string, timeTextValue: string, now: number): PickResult {
  const date = parseDateText(dateText, now);
  if (!date) return { at: null, error: { field: 'date', text: 'Enter a valid date.' } };
  const time = parseTimeText(timeTextValue);
  if (!time) return { at: null, error: { field: 'time', text: 'Enter a valid time.' } };
  const ms = new Date(date.y, date.m, date.d, time.h, time.min, 0, 0).getTime();
  if (ms < now + MIN_AHEAD_MS) return { at: null, error: { field: 'time', text: 'Pick a time in the future.' } };
  if (ms > now + MAX_AHEAD_DAYS * DAY) return { at: null, error: { field: 'date', text: 'Letterdock can schedule up to one year ahead.' } };
  return { at: ms, error: null };
}

/** "Sends Fri 10 Oct 2026 at 08:00 (in 14 hours)." */
export function summaryText(ms: number, now: number, verb = 'Sends'): string {
  const d = new Date(ms);
  const date = d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  return `${verb} ${date} at ${timeText(ms)} (${inText(ms, now)}).`;
}

/** Half-hour suggestions for the time field. */
export function timeSuggestions(): string[] {
  const out: string[] = [];
  for (let i = 0; i < 48; i++) out.push(timeText(new Date(2000, 0, 1, Math.floor(i / 2), (i % 2) * 30).getTime()));
  return out;
}

/** Group labels of the Scheduled view: Today, Tomorrow, This week, Later. */
export function scheduledGroup(ms: number, now = Date.now()): 'Today' | 'Tomorrow' | 'This week' | 'Later' {
  const today = new Date(now);
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (ms < start + DAY) return 'Today';
  if (ms < start + 2 * DAY) return 'Tomorrow';
  // Weeks start on Monday.
  const dow = (today.getDay() + 6) % 7;
  const weekEnd = start + (7 - dow) * DAY;
  if (ms < weekEnd) return 'This week';
  return 'Later';
}

/** Days of the month grid (Monday first), with the days of the neighbour months that fill the weeks. */
export function monthGrid(year: number, month: number): { y: number; m: number; d: number; inMonth: boolean }[] {
  const first = new Date(year, month, 1);
  const lead = (first.getDay() + 6) % 7;
  const out: { y: number; m: number; d: number; inMonth: boolean }[] = [];
  for (let i = 0; i < 42; i++) {
    const day = new Date(year, month, 1 - lead + i);
    out.push({ y: day.getFullYear(), m: day.getMonth(), d: day.getDate(), inMonth: day.getMonth() === month });
  }
  return out;
}
