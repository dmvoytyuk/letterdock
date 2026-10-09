import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as RKE } from 'react';
import { createPortal } from 'react-dom';
import type { Account, AccountId } from '../../../shared/ipc';
import { Icon } from './Icon';
import { AccountBadge } from './ui';

interface Choice {
  /** null = "All accounts". */
  id: AccountId | null;
  name: string;
  email: string | null;
  account: Account | null;
}

/**
 * Account picker with the letter badge of each account (DESIGN-SPEC 3.12.2). A "select-only combobox":
 * focus stays on the button; the arrow keys move through the list, Enter or Space picks, Esc closes,
 * letters jump to the next account that starts with them. Used instead of a native select, which
 * cannot show badges.
 */
export function AccountSelect({
  id,
  accounts,
  value,
  onChange,
  colorOf,
  allLabel,
  labelledBy,
}: {
  id: string;
  accounts: Account[];
  value: AccountId | null;
  onChange: (id: AccountId | null) => void;
  colorOf: (id: AccountId) => string;
  /** Adds a first choice that stands for no account (for example "All accounts"). */
  allLabel?: string;
  labelledBy?: string;
}) {
  const listId = useId();
  const btn = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [box, setBox] = useState<{ left: number; top: number; width: number } | null>(null);

  const choices = useMemo<Choice[]>(
    () => [
      ...(allLabel ? [{ id: null, name: allLabel, email: null, account: null } satisfies Choice] : []),
      ...accounts.map((a): Choice => ({ id: a.id, name: a.displayName, email: a.email, account: a })),
    ],
    [accounts, allLabel],
  );
  const selectedIndex = Math.max(0, choices.findIndex((c) => c.id === value));
  const selected = choices[selectedIndex];

  const openList = () => {
    setActive(selectedIndex);
    setOpen(true);
  };
  const close = (focus = true) => {
    setOpen(false);
    if (focus) btn.current?.focus();
  };
  const pick = (i: number) => {
    const c = choices[i];
    close();
    if (c && c.id !== value) onChange(c.id);
  };

  // Place the list under the button (a fixed box, so the dialog does not clip or scroll it).
  useLayoutEffect(() => {
    if (!open || !btn.current) return;
    const r = btn.current.getBoundingClientRect();
    const rows = Math.min(choices.length, 7);
    const height = rows * 40 + 8;
    const below = window.innerHeight - r.bottom - 8;
    const top = below >= height || below >= r.top ? r.bottom + 2 : Math.max(8, r.top - height - 2);
    setBox({ left: r.left, top, width: r.width });
  }, [open, choices.length]);

  // Close on a click outside, when the window loses focus or is resized.
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!list.current?.contains(t) && !btn.current?.contains(t)) setOpen(false);
    };
    const away = () => setOpen(false);
    window.addEventListener('mousedown', down, true);
    window.addEventListener('blur', away);
    window.addEventListener('resize', away);
    return () => {
      window.removeEventListener('mousedown', down, true);
      window.removeEventListener('blur', away);
      window.removeEventListener('resize', away);
    };
  }, [open]);

  // Keep the active row in view.
  useEffect(() => {
    if (open) list.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active, box]);

  const onKey = (e: RKE<HTMLButtonElement>) => {
    const last = choices.length - 1;
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
        e.preventDefault();
        openList();
      }
      return;
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActive((a) => Math.min(last, a + 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActive((a) => Math.max(0, a - 1));
        break;
      case 'Home':
        e.preventDefault();
        setActive(0);
        break;
      case 'End':
        e.preventDefault();
        setActive(last);
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        pick(active);
        break;
      case 'Escape':
        // The dialog must stay open: only the list closes.
        e.preventDefault();
        e.stopPropagation();
        close();
        break;
      case 'Tab':
        setOpen(false);
        break;
      default:
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          const ch = e.key.toLowerCase();
          const from = active + 1;
          const hit = [...choices.keys()].map((_, k) => (from + k) % choices.length).find((i) => choices[i]!.name.toLowerCase().startsWith(ch));
          if (hit !== undefined) setActive(hit);
        }
    }
  };

  return (
    <>
      <button
        ref={btn}
        id={id}
        type="button"
        className="inp asel"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
        {...(labelledBy ? { 'aria-labelledby': `${labelledBy} ${id}-val` } : {})}
        onClick={() => (open ? close(false) : openList())}
        onKeyDown={onKey}
      >
        {selected ? <ChoiceView c={selected} colorOf={colorOf} /> : null}
        <span id={`${id}-val`} className="asel-val">
          {selected?.name}
        </span>
        <Icon name="chev-d" />
      </button>
      {open && box
        ? createPortal(
            <div
              ref={list}
              id={listId}
              className="asel-list"
              role="listbox"
              aria-label="Accounts"
              style={{ left: box.left, top: box.top, width: box.width }}
            >
              {choices.map((c, i) => (
                <div
                  key={c.id ?? 'all'}
                  id={`${listId}-${i}`}
                  data-idx={i}
                  role="option"
                  aria-selected={c.id === value}
                  className={`asel-opt ${i === active ? 'act' : ''}`}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(i)}
                >
                  <ChoiceView c={c} colorOf={colorOf} />
                  <span className="asel-txt">
                    <span className="asel-nm">{c.name}</span>
                    {c.email ? <span className="asel-em">{c.email}</span> : null}
                  </span>
                  {c.id === value ? <Icon name="check" /> : <span className="asel-gap" aria-hidden="true" />}
                </div>
              ))}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

function ChoiceView({ c, colorOf }: { c: Choice; colorOf: (id: AccountId) => string }) {
  if (c.account)
    return (
      <span aria-hidden="true" style={{ display: 'inline-flex' }}>
        <AccountBadge color={colorOf(c.account.id)} name={c.account.displayName} letter={c.account.badge} />
      </span>
    );
  return (
    <span className="asel-all" aria-hidden="true">
      <Icon name="stack" size={16} />
    </span>
  );
}
