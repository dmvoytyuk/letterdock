// The Snooze menu (DESIGN-SPEC 3.13.2). Built when it opens and removed when it closes; the code loads on first use.
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as RKE } from 'react';
import { Icon } from '../../components/Icon';
import { useApp } from '../../store/app';
import { useUi } from '../../store/ui';
import { snoozeOptions } from '../../lib/snooze';
import { snoozeMessages } from '../../lib/light';
import { SchedulePickerDialog } from '../scheduled/SchedulePickerDialog';
import './snooze.css';

const WIDTH = 280;

export default function SnoozeHost() {
  const req = useUi((s) => s.snooze);
  const close = () => useUi.getState().set({ snooze: null });
  if (!req) return null;
  if (req.step === 'pick') {
    return (
      <SchedulePickerDialog
        mode="snooze"
        onClose={close}
        onConfirm={async (at) => {
          close();
          await snoozeMessages(req.ids, at, !!req.change);
        }}
      />
    );
  }
  return <SnoozeMenu key={`${req.x},${req.y}`} ids={req.ids} x={req.x} y={req.y} change={!!req.change} onClose={close} />;
}

function SnoozeMenu({ ids, x, y, change, onClose }: { ids: number[]; x: number; y: number; change: boolean; onClose: () => void }) {
  const times = useApp((s) => s.settings?.snoozeTimes);
  const seen = useUi((s) => s.snoozeCount);
  const [options] = useState(() => snoozeOptions(Date.now(), times));
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [returnTo] = useState(() => document.activeElement as HTMLElement | null);

  useLayoutEffect(() => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    setPos({
      left: Math.max(8, Math.min(x, window.innerWidth - r.width - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - r.height - 8)),
    });
  }, [x, y]);
  useEffect(() => {
    if (pos) ref.current?.querySelector<HTMLElement>('.sn-item')?.focus();
  }, [pos]);
  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener('mousedown', down, true);
    window.addEventListener('blur', onClose);
    window.addEventListener('resize', onClose);
    return () => {
      window.removeEventListener('mousedown', down, true);
      window.removeEventListener('blur', onClose);
      window.removeEventListener('resize', onClose);
      if (returnTo && document.contains(returnTo)) returnTo.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pickTime = () => {
    useUi.getState().set({ snooze: { ids, x, y, step: 'pick', ...(change ? { change } : {}) } });
  };
  const choose = (i: number) => {
    const o = options[i];
    onClose();
    if (o) void snoozeMessages(ids, o.at, change);
    else pickTime();
  };

  const onKey = (e: RKE<HTMLDivElement>) => {
    const items = [...(ref.current?.querySelectorAll<HTMLElement>('.sn-item') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    e.stopPropagation(); // keys such as H and 1 to 5 must not reach the app's shortcuts
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      items[(i + 1) % items.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      items[(i - 1 + items.length) % items.length]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      items[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      items[items.length - 1]?.focus();
    } else if (e.key === 'Tab') {
      e.preventDefault();
    } else if (/^[1-9]$/.test(e.key) && Number(e.key) <= options.length + 1) {
      e.preventDefault();
      choose(Number(e.key) - 1);
    }
  };

  return (
    <div
      ref={ref}
      className="light-pop snooze-pop"
      role="menu"
      aria-label={change ? 'Change snooze time' : 'Snooze until'}
      style={{ width: WIDTH, left: pos?.left ?? x, top: pos?.top ?? y, visibility: pos ? 'visible' : 'hidden' }}
      onKeyDown={onKey}
    >
      {options.map((o, i) => (
        <button key={o.id} type="button" role="menuitem" className="sn-item" aria-label={`${o.label}, ${o.hint}`} onClick={() => choose(i)}>
          <span className="sn-l">{o.label}</span>
          <span className="sn-t">{o.hint}</span>
        </button>
      ))}
      <button type="button" role="menuitem" className="sn-item" onClick={() => choose(options.length)}>
        <Icon name="calendar" />
        <span className="sn-l">Pick date &amp; time...</span>
      </button>
      {seen < 3 ? (
        <p className="sn-foot">Snooze works on this PC only. Other apps still show the message in your Inbox.</p>
      ) : null}
    </div>
  );
}
