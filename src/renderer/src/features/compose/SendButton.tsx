import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Icon } from '../../components/Icon';
import { openMenuAt, type MenuEntry } from '../../components/ui';
import { quickTimes, type QuickTime } from '../../lib/schedule';

export interface SendButtonHandle {
  /** Open the Send later menu (Ctrl+Shift+Enter). */
  openMenu: () => void;
}

/**
 * The split Send button (DESIGN-SPEC 3.11.1): "Send" and a chevron that opens the Send later menu.
 * The menu lists quick times (hidden by the time rules) and "Pick date & time...".
 */
export const SendButton = forwardRef<
  SendButtonHandle,
  {
    disabled?: boolean;
    busy?: boolean;
    /** The old time of a message that was being scheduled (shown as "Same time" if still ahead). */
    sameTime?: number | null;
    /** 100 scheduled messages: the menu items are off. */
    limitReached?: boolean;
    onSend: () => void;
    onSendLater: (at: number) => void;
    onPick: () => void;
  }
>(function SendButton({ disabled, busy, sameTime, limitReached, onSend, onSendLater, onPick }, ref) {
  const pill = useRef<HTMLDivElement>(null);
  const chev = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const off = !!disabled || !!busy;

  const openMenu = () => {
    const el = pill.current;
    if (!el || off) return;
    const times = quickTimes(Date.now(), sameTime ?? null);
    const items: MenuEntry[] = [{ heading: 'Send later' }];
    if (limitReached) items.push({ heading: 'You have 100 scheduled messages. Send or cancel some first.' });
    for (const t of times as QuickTime[]) {
      items.push({ label: t.label, hint: t.hint, disabled: limitReached, onSelect: () => onSendLater(t.at) });
    }
    items.push('sep', { label: 'Pick date & time...', icon: 'calendar', disabled: limitReached, onSelect: onPick });
    setOpen(true);
    openMenuAt(el, items, {
      width: 280,
      onClose: () => {
        setOpen(false);
        chev.current?.focus();
      },
    });
  };
  const openRef = useRef(openMenu);
  useEffect(() => {
    openRef.current = openMenu;
  });
  useImperativeHandle(ref, () => ({ openMenu: () => openRef.current() }), []);

  return (
    <div className={`splitsend ${off ? 'off' : ''}`} ref={pill} role="group" aria-label="Send">
      <button
        type="button"
        className="seg main"
        disabled={off}
        aria-busy={busy || undefined}
        title="Send (Ctrl+Enter)"
        onClick={onSend}
        onKeyDown={(e) => {
          if (e.altKey && e.key === 'ArrowDown') {
            e.preventDefault();
            openMenu();
          }
        }}
      >
        {busy ? <span className="spin" aria-hidden="true" /> : null}
        Send
      </button>
      <span className="segdiv" aria-hidden="true" />
      <button
        type="button"
        ref={chev}
        className="seg chev"
        disabled={off}
        aria-label="More send options"
        aria-haspopup="menu"
        aria-expanded={open}
        title="More send options (Ctrl+Shift+Enter)"
        onClick={openMenu}
      >
        <Icon name="chev-d" />
      </button>
    </div>
  );
});
