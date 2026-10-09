import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as RKE } from 'react';
import { MAX_SCHEDULED } from '../../../../shared/ipc';
import { Icon } from '../../components/Icon';
import { Banner, Button, Dialog } from '../../components/ui';
import { useApp } from '../../store/app';
import { reportActionError } from '../../store/toasts';
import {
  MAX_AHEAD_DAYS,
  checkPick,
  dateFieldText,
  defaultPick,
  monthGrid,
  summaryText,
  timeFieldText,
  timeSuggestions,
} from '../../lib/schedule';

/** The text under the field after the user stopped typing for a moment (so a screen reader is not flooded). */
function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const h = setTimeout(() => setV(value), ms);
    return () => clearTimeout(h);
  }, [value, ms]);
  return v;
}

/**
 * "Send later" date and time dialog (DESIGN-SPEC 3.11.2). `mode` 'change' is used to change the time
 * of a message that is already scheduled ("Save time").
 */
export function SchedulePickerDialog({
  mode,
  initial,
  total,
  onConfirm,
  onClose,
}: {
  mode: 'schedule' | 'change';
  initial?: number | null;
  /** Scheduled messages now (to stop at 100). Not needed when changing a time. */
  total?: number;
  onConfirm: (at: number) => void | Promise<void>;
  onClose: () => void;
}) {
  const [start] = useState(() => (initial && initial > Date.now() ? initial : defaultPick(Date.now())));
  const [dateText, setDateText] = useState(dateFieldText(start));
  const [timeValue, setTimeValue] = useState(timeFieldText(start));
  const [touched, setTouched] = useState({ date: false, time: false });
  const [calOpen, setCalOpen] = useState(false);
  const [timesOpen, setTimesOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const closeToTray = useApp((s) => s.settings?.closeToTray ?? true);
  const dateId = useId();
  const timeId = useId();
  const dateErr = `${dateId}-err`;
  const timeErr = `${timeId}-err`;
  const dateRef = useRef<HTMLInputElement>(null);
  const timeRef = useRef<HTMLInputElement>(null);

  // The clock moves while the dialog is open ("in 14 hours", "Pick a time in the future").
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const h = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(h);
  }, []);
  const check = checkPick(dateText, timeValue, now);
  const full = mode === 'schedule' && (total ?? 0) >= MAX_SCHEDULED;
  const showDateErr = check.error?.field === 'date' && touched.date;
  const showTimeErr = check.error?.field === 'time' && (touched.time || touched.date);
  const summary = useDebounced(check.at ? summaryText(check.at, now) : '', 500);

  const submit = async () => {
    setTouched({ date: true, time: true });
    const fresh = checkPick(dateText, timeValue, Date.now());
    if (!fresh.at || full) {
      (fresh.error?.field === 'time' ? timeRef : dateRef).current?.focus();
      return;
    }
    setBusy(true);
    try {
      await onConfirm(fresh.at);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title="Send later" size="sm" onClose={onClose} busy={busy} initialFocus={`#${CSS.escape(dateId)}`}>
      <form
        className="schform"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="field">
          <label htmlFor={dateId}>Date</label>
          <div className="schrow">
            <input
              id={dateId}
              ref={dateRef}
              className={`inp ${showDateErr ? 'err' : ''}`}
              value={dateText}
              autoComplete="off"
              aria-invalid={showDateErr ? true : undefined}
              aria-describedby={showDateErr ? dateErr : undefined}
              onChange={(e) => setDateText(e.target.value)}
              onBlur={() => setTouched((t) => ({ ...t, date: true }))}
            />
            <button type="button" className="ibtn" aria-label="Choose a date" aria-haspopup="dialog" aria-expanded={calOpen} title="Choose a date" onClick={() => setCalOpen((o) => !o)}>
              <Icon name="calendar" />
            </button>
            {calOpen ? (
              <CalendarPopover
                selected={check.at ?? start}
                onPick={(y, m, d) => {
                  const base = new Date(check.at ?? start);
                  setDateText(dateFieldText(new Date(y, m, d, base.getHours(), base.getMinutes()).getTime()));
                  setTouched((t) => ({ ...t, date: true }));
                  setCalOpen(false);
                  dateRef.current?.focus();
                }}
                onClose={() => {
                  setCalOpen(false);
                  dateRef.current?.focus();
                }}
              />
            ) : null}
          </div>
          {showDateErr ? (
            <div className="bad" id={dateErr}>
              <Icon name="warn" />
              {check.error!.text}
            </div>
          ) : null}
        </div>
        <div className="field">
          <label htmlFor={timeId}>Time</label>
          <div className="schrow">
            <input
              id={timeId}
              ref={timeRef}
              className={`inp ${showTimeErr ? 'err' : ''}`}
              value={timeValue}
              autoComplete="off"
              role="combobox"
              aria-expanded={timesOpen}
              aria-controls={`${timeId}-list`}
              aria-autocomplete="list"
              aria-invalid={showTimeErr ? true : undefined}
              aria-describedby={showTimeErr ? timeErr : undefined}
              onChange={(e) => setTimeValue(e.target.value)}
              onFocus={() => setTimesOpen(false)}
              onBlur={() => setTouched((t) => ({ ...t, time: true }))}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown' && !timesOpen) {
                  e.preventDefault();
                  setTimesOpen(true);
                } else if (e.key === 'Escape' && timesOpen) {
                  e.stopPropagation();
                  e.preventDefault();
                  setTimesOpen(false);
                }
              }}
            />
            <button type="button" className="ibtn" aria-label="Suggested times" aria-haspopup="listbox" aria-expanded={timesOpen} title="Suggested times" tabIndex={-1} onClick={() => setTimesOpen((o) => !o)}>
              <Icon name="chev-d" />
            </button>
            {timesOpen ? (
              <TimeList
                id={`${timeId}-list`}
                value={timeValue}
                onPick={(t) => {
                  setTimeValue(t);
                  setTouched((x) => ({ ...x, time: true }));
                  setTimesOpen(false);
                  timeRef.current?.focus();
                }}
                onClose={() => {
                  setTimesOpen(false);
                  timeRef.current?.focus();
                }}
              />
            ) : null}
          </div>
          {showTimeErr ? (
            <div className="bad" id={timeErr}>
              <Icon name="warn" />
              {check.error!.text}
            </div>
          ) : null}
        </div>

        <div className="schsum" role="status">
          {summary ? (
            <>
              <Icon name="clock" />
              <span>{summary}</span>
            </>
          ) : null}
        </div>

        {full ? (
          <Banner tone="warning">You have {MAX_SCHEDULED} scheduled messages. Send or cancel some first.</Banner>
        ) : null}
        {!closeToTray ? (
          <Banner
            tone="warning"
            actions={
              <button
                type="button"
                className="link"
                onClick={() => void useApp.getState().updateSettings({ closeToTray: true }).catch((e) => reportActionError(e))}
              >
                Turn on
              </button>
            }
          >
            Letterdock stops when you close its window, so it can&apos;t send this message. Turn on &lsquo;Run in tray when closed&rsquo; so it keeps running.
          </Banner>
        ) : (
          <p className="hint schcap">
            Letterdock has to be running at that time. It can stay in the tray. The message is kept on this PC until then.
          </p>
        )}

        <div className="foot">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={busy} disabled={!check.at || full}>
            {mode === 'change' ? 'Save time' : 'Schedule send'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

// ---------- suggested times ----------
function TimeList({ id, value, onPick, onClose }: { id: string; value: string; onPick: (t: string) => void; onClose: () => void }) {
  const times = useMemo(() => timeSuggestions(), []);
  const [active, setActive] = useState(() => Math.max(0, times.indexOf(value)));
  const ref = useRef<HTMLUListElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'center' });
  }, [active]);
  const onKey = (e: RKE<HTMLUListElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(times.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onPick(times[active]!);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === 'Tab') {
      onClose();
    }
  };
  return (
    <ul id={id} ref={ref} className="timelist scroll" role="listbox" aria-label="Suggested times" tabIndex={0} onKeyDown={onKey}>
      {times.map((t, i) => (
        <li key={t} role="option" aria-selected={i === active} className={i === active ? 'act' : ''} onMouseDown={(e) => e.preventDefault()} onClick={() => onPick(t)}>
          {t}
        </li>
      ))}
    </ul>
  );
}

// ---------- calendar ----------
const WEEKDAYS = (() => {
  // Monday first, in the system language.
  const base = new Date(2024, 0, 1); // a Monday
  return Array.from({ length: 7 }, (_, i) => new Date(base.getFullYear(), base.getMonth(), base.getDate() + i).toLocaleDateString(undefined, { weekday: 'short' }));
})();

function CalendarPopover({ selected, onPick, onClose }: { selected: number; onPick: (y: number, m: number, d: number) => void; onClose: () => void }) {
  const sel = new Date(selected);
  const [view, setView] = useState({ y: sel.getFullYear(), m: sel.getMonth() });
  const [focus, setFocus] = useState({ y: sel.getFullYear(), m: sel.getMonth(), d: sel.getDate() });
  const ref = useRef<HTMLDivElement>(null);
  const now = new Date();
  const min = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const max = min + MAX_AHEAD_DAYS * 86_400_000;
  const grid = monthGrid(view.y, view.m);
  const title = new Date(view.y, view.m, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const inRange = (y: number, m: number, d: number) => {
    const t = new Date(y, m, d).getTime();
    return t >= min && t <= max;
  };

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('button[tabindex="0"]')?.focus();
  }, [focus.y, focus.m, focus.d, view.y, view.m]);

  const goto = (dayDelta: number, monthDelta = 0) => {
    const next = new Date(focus.y, focus.m + monthDelta, focus.d + dayDelta);
    // Keep within the allowed range.
    const clamped = Math.min(Math.max(next.getTime(), min), max);
    const c = new Date(clamped);
    setFocus({ y: c.getFullYear(), m: c.getMonth(), d: c.getDate() });
    setView({ y: c.getFullYear(), m: c.getMonth() });
  };
  const onKey = (e: RKE<HTMLDivElement>) => {
    switch (e.key) {
      case 'ArrowLeft':
        e.preventDefault();
        goto(-1);
        break;
      case 'ArrowRight':
        e.preventDefault();
        goto(1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        goto(-7);
        break;
      case 'ArrowDown':
        e.preventDefault();
        goto(7);
        break;
      case 'PageUp':
        e.preventDefault();
        goto(0, -1);
        break;
      case 'PageDown':
        e.preventDefault();
        goto(0, 1);
        break;
      case 'Escape':
        // Only the calendar closes, not the dialog.
        e.preventDefault();
        e.stopPropagation();
        onClose();
        break;
      default:
        break;
    }
  };
  const fullLabel = (y: number, m: number, d: number) =>
    new Date(y, m, d).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  return (
    <div className="cal" ref={ref} role="dialog" aria-label="Choose a date" onKeyDown={onKey}>
      <div className="calhead">
        <button type="button" className="ibtn sm" aria-label="Previous month" onClick={() => goto(0, -1)}>
          <Icon name="chev-l" />
        </button>
        <b aria-live="polite">{title}</b>
        <button type="button" className="ibtn sm" aria-label="Next month" onClick={() => goto(0, 1)}>
          <Icon name="chev-r" />
        </button>
      </div>
      <div role="grid" aria-label={title} className="calgrid">
        <div role="row" className="calrow calwd">
          {WEEKDAYS.map((w, i) => (
            <span key={i} role="columnheader" aria-label={w}>
              {w.slice(0, 2)}
            </span>
          ))}
        </div>
        {Array.from({ length: 6 }, (_, r) => (
          <div role="row" className="calrow" key={r}>
            {grid.slice(r * 7, r * 7 + 7).map((c) => {
              const ok = inRange(c.y, c.m, c.d);
              const isFocus = c.y === focus.y && c.m === focus.m && c.d === focus.d;
              const isSel = c.y === sel.getFullYear() && c.m === sel.getMonth() && c.d === sel.getDate();
              return (
                <button
                  key={`${c.m}-${c.d}`}
                  type="button"
                  role="gridcell"
                  className={`calday ${c.inMonth ? '' : 'out'} ${isSel ? 'on' : ''}`}
                  tabIndex={isFocus ? 0 : -1}
                  disabled={!ok}
                  aria-selected={isSel}
                  aria-label={fullLabel(c.y, c.m, c.d)}
                  onClick={() => onPick(c.y, c.m, c.d)}
                >
                  {c.d}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
