// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { OutboxItem, ScheduledCount } from '../../src/shared/ipc';
import {
  agoText,
  checkPick,
  defaultPick,
  inText,
  monthGrid,
  parseDateText,
  parseTimeText,
  quickTimes,
  scheduledGroup,
  summaryText,
} from '../../src/renderer/src/lib/schedule';
import { rightItems } from '../../src/renderer/src/lib/statusBar';

const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m, d, h, min).getTime();
// Friday 9 October 2026, 10:42 (the date of the design spec).
const FRI_MORNING = at(2026, 9, 9, 10, 42);

describe('quickTimes (3.11.1)', () => {
  it('Friday morning: later today, tomorrow morning and Monday morning', () => {
    const q = quickTimes(FRI_MORNING);
    expect(q.map((x) => x.id)).toEqual(['today', 'tomorrow', 'monday']);
    expect(q[0]!.at).toBe(at(2026, 9, 9, 18));
    expect(q[1]!.at).toBe(at(2026, 9, 10, 8));
    expect(q[2]!.at).toBe(at(2026, 9, 12, 8));
  });
  it('"Later today" needs 18:00 to be at least 60 minutes away', () => {
    expect(quickTimes(at(2026, 9, 9, 17, 1)).some((x) => x.id === 'today')).toBe(false); // 59 minutes away
    expect(quickTimes(at(2026, 9, 9, 16, 59)).some((x) => x.id === 'today')).toBe(true); // 61 minutes away
    expect(quickTimes(at(2026, 9, 9, 17, 0)).some((x) => x.id === 'today')).toBe(true); // exactly 60
    expect(quickTimes(at(2026, 9, 9, 20, 0)).some((x) => x.id === 'today')).toBe(false);
  });
  it('Monday morning is hidden on Sunday and on Monday', () => {
    expect(quickTimes(at(2026, 9, 11, 10)).some((x) => x.id === 'monday')).toBe(false); // Sunday
    expect(quickTimes(at(2026, 9, 12, 10)).some((x) => x.id === 'monday')).toBe(false); // Monday
    expect(quickTimes(at(2026, 9, 13, 10)).some((x) => x.id === 'monday')).toBe(true); // Tuesday
    expect(quickTimes(at(2026, 9, 10, 10)).find((x) => x.id === 'monday')!.at).toBe(at(2026, 9, 12, 8)); // Saturday
  });
  it('"Same time" comes first, only while it is still in the future', () => {
    const later = at(2026, 9, 11, 9);
    expect(quickTimes(FRI_MORNING, later)[0]).toMatchObject({ id: 'same', at: later });
    expect(quickTimes(FRI_MORNING, at(2026, 9, 9, 10, 0)).some((x) => x.id === 'same')).toBe(false);
    expect(quickTimes(FRI_MORNING, null).some((x) => x.id === 'same')).toBe(false);
  });
  it('the default of "Pick date & time..." is tomorrow at 08:00', () => {
    expect(defaultPick(FRI_MORNING)).toBe(at(2026, 9, 10, 8));
  });
});

describe('typed date and time (3.11.2)', () => {
  it('reads times with and without AM/PM', () => {
    expect(parseTimeText('8')).toEqual({ h: 8, min: 0 });
    expect(parseTimeText('08:30')).toEqual({ h: 8, min: 30 });
    expect(parseTimeText('8:30 pm')).toEqual({ h: 20, min: 30 });
    expect(parseTimeText('12 am')).toEqual({ h: 0, min: 0 });
    expect(parseTimeText('2030')).toEqual({ h: 20, min: 30 });
    expect(parseTimeText('25:00')).toBeNull();
    expect(parseTimeText('8:75')).toBeNull();
    expect(parseTimeText('later')).toBeNull();
  });
  it('reads dates written in words and in numbers', () => {
    expect(parseDateText('2026-10-10', FRI_MORNING)).toEqual({ y: 2026, m: 9, d: 10 });
    expect(parseDateText('Sat, 10 Oct 2026', FRI_MORNING)).toEqual({ y: 2026, m: 9, d: 10 });
    expect(parseDateText('Oct 10, 2026', FRI_MORNING)).toEqual({ y: 2026, m: 9, d: 10 });
    expect(parseDateText('10 Oct', FRI_MORNING)).toEqual({ y: 2026, m: 9, d: 10 });
    expect(parseDateText('31 Feb 2026', FRI_MORNING)).toBeNull();
    expect(parseDateText('tomorrow-ish', FRI_MORNING)).toBeNull();
  });
  it('a date without a year that has passed means next year', () => {
    expect(parseDateText('3 Mar', FRI_MORNING)).toEqual({ y: 2027, m: 2, d: 3 });
  });
  it('checks the rules: future, one year, valid input', () => {
    expect(checkPick('2026-10-10', '08:00', FRI_MORNING).at).toBe(at(2026, 9, 10, 8));
    expect(checkPick('2026-10-09', '10:42', FRI_MORNING).error).toEqual({ field: 'time', text: 'Pick a time in the future.' });
    expect(checkPick('2026-10-09', '10:43', FRI_MORNING + 30_000).error?.text).toBe('Pick a time in the future.'); // 30 seconds ahead
    expect(checkPick('2026-10-09', '10:43', FRI_MORNING).at).not.toBeNull(); // exactly 1 minute ahead
    expect(checkPick('2026-10-09', '10:44', FRI_MORNING).at).not.toBeNull();
    expect(checkPick('2027-10-20', '08:00', FRI_MORNING).error).toEqual({ field: 'date', text: 'Letterdock can schedule up to one year ahead.' });
    expect(checkPick('nonsense', '08:00', FRI_MORNING).error).toEqual({ field: 'date', text: 'Enter a valid date.' });
    expect(checkPick('2026-10-10', 'x', FRI_MORNING).error).toEqual({ field: 'time', text: 'Enter a valid time.' });
  });
  it('a time that does not exist (spring forward) moves forward', () => {
    // The check works on whatever the clock of this PC does; the result is always a real time ahead.
    const r = checkPick('2026-03-29', '02:30', at(2026, 2, 1));
    expect(r.at).not.toBeNull();
  });
});

describe('texts', () => {
  it('relative time: minutes under an hour, hours under a day, then days', () => {
    expect(inText(FRI_MORNING + 5 * 60_000, FRI_MORNING)).toBe('in 5 minutes');
    expect(inText(FRI_MORNING + 60_000, FRI_MORNING)).toBe('in 1 minute');
    expect(inText(FRI_MORNING + 14 * 3_600_000, FRI_MORNING)).toBe('in 14 hours');
    expect(inText(FRI_MORNING + 3 * 86_400_000, FRI_MORNING)).toBe('in 3 days');
  });
  it('"Due 3 days ago"', () => {
    expect(agoText(3 * 86_400_000)).toBe('3 days ago');
    expect(agoText(2 * 3_600_000)).toBe('2 hours ago');
  });
  it('summary line', () => {
    const s = summaryText(at(2026, 9, 10, 8), FRI_MORNING);
    expect(s.startsWith('Sends ')).toBe(true);
    expect(s.endsWith('(in 21 hours).')).toBe(true);
  });
  it('groups of the Scheduled view: Today, Tomorrow, This week, Later', () => {
    expect(scheduledGroup(at(2026, 9, 9, 18), FRI_MORNING)).toBe('Today');
    expect(scheduledGroup(FRI_MORNING - 3 * 86_400_000, FRI_MORNING)).toBe('Today'); // held mail is on top
    expect(scheduledGroup(at(2026, 9, 10, 8), FRI_MORNING)).toBe('Tomorrow');
    expect(scheduledGroup(at(2026, 9, 11, 8), FRI_MORNING)).toBe('This week'); // Sunday still belongs to this week
    expect(scheduledGroup(at(2026, 9, 12, 8), FRI_MORNING)).toBe('Later');
  });
  it('month grid starts on Monday and always has 6 weeks', () => {
    const g = monthGrid(2026, 9); // October 2026 starts on a Thursday
    expect(g).toHaveLength(42);
    expect(g[0]).toMatchObject({ m: 8, d: 28, inMonth: false });
    expect(g[3]).toMatchObject({ m: 9, d: 1, inMonth: true });
  });
});

describe('status bar item (3.11.6)', () => {
  const NOW = FRI_MORNING;
  const count = (o: Partial<ScheduledCount>): ScheduledCount => ({ total: 0, scheduled: 0, held: 0, nextSendAt: null, perAccount: [], ...o });
  const failed: OutboxItem = { id: 1, accountId: 'a', subject: 's', to: [], attempts: 1, state: 'failed', sendAt: 0, lastError: 'x' } as never;

  it('is hidden when nothing is scheduled', () => {
    expect(rightItems(null, [], NOW, count({}))).toEqual([]);
    expect(rightItems(null, [], NOW, null)).toEqual([]);
  });
  it('"3 scheduled" with the next time in the tooltip', () => {
    const r = rightItems(null, [], NOW, count({ total: 3, scheduled: 3, nextSendAt: at(2026, 9, 10, 8) }));
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ id: 'scheduled', text: '3 scheduled', main: '3 scheduled', overdue: null });
    expect((r[0] as { tip: string }).tip.startsWith('Next: ')).toBe(true);
  });
  it('held messages: "1 scheduled, 1 overdue"', () => {
    const r = rightItems(null, [], NOW, count({ total: 2, scheduled: 1, held: 1, nextSendAt: NOW + 1000 }));
    expect(r[0]).toMatchObject({ text: '1 scheduled, 1 overdue', main: '1 scheduled', overdue: '1 overdue' });
  });
  it('only overdue mail: "1 overdue"', () => {
    const r = rightItems(null, [], NOW, count({ total: 1, scheduled: 0, held: 1 }));
    expect(r[0]).toMatchObject({ text: '1 overdue', main: '', overdue: '1 overdue' });
  });
  it('lowest priority: at most 2 items, update and Outbox come first', () => {
    const r = rightItems({ state: 'ready', currentVersion: '1', newVersion: '2' }, [failed], NOW, count({ total: 1, scheduled: 1 }));
    expect(r.map((x) => x.id)).toEqual(['ready', 'outbox']);
    const r2 = rightItems(null, [failed], NOW, count({ total: 1, scheduled: 1 }));
    expect(r2.map((x) => x.id)).toEqual(['outbox', 'scheduled']);
  });
  it('is announced without numbers', () => {
    const r = rightItems(null, [], NOW, count({ total: 3, scheduled: 3 }));
    expect(r[0]!.announce).toBe('Scheduled messages waiting');
  });
});
