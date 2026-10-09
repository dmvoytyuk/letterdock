import { useEffect, useId, useLayoutEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import type { Address, ContactSuggestion } from '../../../../shared/ipc';
import { Icon } from '../../components/Icon';
import { useMenu } from '../../components/ui';
import { addAddresses, chipLabel, isValidAddress, parseRecipients, resolvePending } from '../../lib/compose';
import { call, logRenderer } from '../../lib/api';
import { isValidEmail } from '../../lib/format';
import { RecipientSuggestions, type SuggestionsPlacement } from './RecipientSuggestions';

export type RecipientKind = 'to' | 'cc' | 'bcc';
const KIND_LABEL: Record<RecipientKind, string> = { to: 'To', cc: 'Cc', bcc: 'Bcc' };
const COLLAPSE_AFTER = 5;

/** One recipient row: chips plus a text box (DESIGN-SPEC 3.7). */
export function RecipientField({
  kind,
  value,
  onChange,
  onMove,
  inputRef,
  error,
  extra,
  accountId,
  exclude,
  className,
  placeholder,
  onHide,
  onPending,
}: {
  kind: RecipientKind;
  className?: string;
  /** Hint inside the empty input (only shown while there are no chips). */
  placeholder?: string;
  /** Tells the window what is typed but not yet a chip, so save and send can handle it. */
  onPending?: (kind: RecipientKind, text: string) => void;
  /** Esc in an empty row with no chips hides the row again (Cc / Bcc). */
  onHide?: () => void;
  value: Address[];
  onChange: (next: Address[]) => void;
  /** Move one address to another field (chip menu). */
  onMove: (a: Address, to: RecipientKind) => void;
  inputRef?: React.Ref<HTMLInputElement>;
  error?: string | null;
  extra?: React.ReactNode;
  /** Suggest only contacts seen through this account (the From account). Default: all accounts. */
  accountId?: string;
  /** Lower case addresses that are already chips in To, Cc or Bcc: they are not suggested again. */
  exclude?: string[];
}) {
  const [text, setTextState] = useState('');
  const setText = (t: string) => {
    setTextState(t);
    onPending?.(kind, t);
  };
  const [expanded, setExpanded] = useState(false);
  const [focused, setFocused] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const label = KIND_LABEL[kind];
  const listId = `${useId().replace(/:/g, '')}-sug`;

  // ----- suggestions (DESIGN-SPEC 3.7.1) -----
  const [sugs, setSugs] = useState<ContactSuggestion[]>([]);
  const [active, setActive] = useState(-1);
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  const [removing, setRemoving] = useState<ReadonlySet<string>>(new Set());
  const [announce, setAnnounce] = useState('');
  const [placement, setPlacement] = useState<SuggestionsPlacement | null>(null);
  const seq = useRef(0);
  const pasted = useRef(false);
  const open = focused && text.trim().length > 0 && sugs.length > 0 && dismissedFor !== text;

  const closeSuggestions = () => {
    seq.current++;
    setSugs([]);
    setActive(-1);
  };

  const lookup = (t: string) => {
    const q = t.trim();
    const mine = ++seq.current;
    if (!q) {
      setSugs([]);
      setActive(-1);
      return;
    }
    call('contacts.suggest', { query: q, ...(accountId ? { accountId } : {}), limit: 16 })
      .then((res) => {
        if (mine !== seq.current) return;
        const skip = new Set(exclude ?? []);
        const kept = res.filter((c) => !skip.has(c.address.toLowerCase()));
        // Own addresses go last. The rest keeps the order the backend chose.
        const ordered = [...kept.filter((c) => !c.isOwn), ...kept.filter((c) => c.isOwn)].slice(0, 8);
        setSugs(ordered);
        // A complete address wins over the first suggestion.
        setActive(ordered.length === 0 || isValidEmail(q) ? -1 : 0);
      })
      .catch((e) => {
        // Typing keeps working without suggestions.
        if (mine !== seq.current) return;
        setSugs([]);
        setActive(-1);
        logRenderer('warn', `contacts.suggest failed: ${(e as { message?: string }).message ?? 'unknown'}`);
      });
  };

  const pick = (c: ContactSuggestion) => {
    onChange(addAddresses(value, [c.name ? { name: c.name, address: c.address } : { address: c.address }]));
    setText('');
    closeSuggestions();
  };

  const forget = (c: ContactSuggestion) => {
    call('contacts.forget', { address: c.address }).catch((e) =>
      logRenderer('warn', `contacts.forget failed: ${(e as { message?: string }).message ?? 'unknown'}`),
    );
    setRemoving((r) => new Set(r).add(c.address));
    setAnnounce(`${c.name ?? c.address} removed from suggestions`);
    setTimeout(() => {
      setRemoving((r) => {
        const next = new Set(r);
        next.delete(c.address);
        return next;
      });
      const at = sugs.findIndex((x) => x.address === c.address);
      const next = sugs.filter((x) => x.address !== c.address);
      setSugs(next);
      // The next row becomes active.
      setActive(next.length === 0 ? -1 : Math.min(Math.max(at, 0), next.length - 1));
    }, 100);
  };

  // Place the list under the field (flips above when there is little room below).
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const chips = wrap.current;
      const row = chips?.closest('.crow');
      if (!chips || !row) return;
      const c = chips.getBoundingClientRect();
      const r = row.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const width = Math.min(Math.max(c.width, 360), vw - 32);
      const left = Math.max(16, Math.min(c.left, vw - width - 16));
      const below = vh - r.bottom - 4 - 16;
      const above = r.top - 4 - 16;
      const flip = below < 160 && above > below;
      setPlacement(
        flip
          ? { left, width, bottom: vh - r.top + 4, maxHeight: Math.min(392, above) }
          : { left, width, top: r.bottom + 4, maxHeight: Math.min(392, below) },
      );
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open, sugs.length]);

  // Tell screen readers how many suggestions there are (not for zero, and not on every key).
  useEffect(() => {
    if (!open) return;
    const h = setTimeout(() => setAnnounce(`${sugs.length} ${sugs.length === 1 ? 'suggestion' : 'suggestions'}`), 300);
    return () => clearTimeout(h);
  }, [open, sugs]);

  const commit = (raw: string) => {
    const parsed = parseRecipients(raw);
    if (parsed.length === 0) return;
    onChange(addAddresses(value, parsed));
    setText('');
  };

  const focusInput = () => wrap.current?.querySelector<HTMLInputElement>('input')?.focus();
  const chips = () => [...(wrap.current?.querySelectorAll<HTMLElement>('.rchip') ?? [])];

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (open) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((a) => Math.min(sugs.length - 1, a + 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((a) => (a <= 0 ? -1 : a - 1));
        return;
      }
      if ((e.key === 'Enter' || (e.key === 'Tab' && !e.shiftKey)) && active >= 0 && sugs[active]) {
        e.preventDefault();
        pick(sugs[active]!);
        return;
      }
      if (e.key === 'Escape') {
        // Closes the list only. A second Esc reaches the window and closes compose.
        e.preventDefault();
        e.stopPropagation();
        setDismissedFor(text);
        return;
      }
      if (e.key === 'Delete' && e.shiftKey && active >= 0 && sugs[active] && !sugs[active]!.isOwn) {
        e.preventDefault();
        forget(sugs[active]!);
        return;
      }
    }
    if (e.key === 'Escape' && onHide && !text && value.length === 0) {
      e.preventDefault();
      e.stopPropagation();
      onHide();
      return;
    }
    if (e.key === 'Enter' || e.key === ',' || e.key === ';') {
      if (text.trim()) {
        e.preventDefault();
        commit(text);
      } else if (e.key !== 'Enter') {
        e.preventDefault();
      }
    } else if (e.key === 'Tab' && text.trim() && !e.shiftKey) {
      commit(text);
    } else if (e.key === 'Backspace' && !text && value.length > 0) {
      e.preventDefault();
      onChange(value.slice(0, -1));
    } else if (e.key === 'ArrowLeft' && !text && e.currentTarget.selectionStart === 0) {
      const all = chips();
      all[all.length - 1]?.focus();
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    pasted.current = true; // pasting never opens the list
    const t = e.clipboardData.getData('text');
    if (/[,;\n<]/.test(t)) {
      e.preventDefault();
      commit(text + t);
    }
  };

  const shown = !expanded && !focused && value.length > COLLAPSE_AFTER ? value.slice(0, COLLAPSE_AFTER) : value;
  const hidden = value.length - shown.length;
  const id = `rcpt-${kind}`;

  const chipMenu = (a: Address, x: number, y: number) => {
    const others = (['to', 'cc', 'bcc'] as RecipientKind[]).filter((k) => k !== kind);
    useMenu.getState().open(x, y, [
      ...others.map((k) => ({
        label: `Move to ${KIND_LABEL[k]}`,
        onSelect: () => onMove(a, k),
      })),
      'sep' as const,
      {
        label: 'Copy address',
        icon: 'copy' as const,
        onSelect: () => void navigator.clipboard.writeText(a.address).catch(() => undefined),
      },
      { label: 'Remove', icon: 'x' as const, onSelect: () => onChange(value.filter((v) => v !== a)) },
    ]);
  };

  return (
    <div className={`crow ${className ?? ''}`} role="group" aria-label={label}>
      <label htmlFor={id}>{label}</label>
      <div
        className="chips"
        ref={wrap}
        onClick={(e) => {
          if (e.target === e.currentTarget) focusInput();
        }}
      >
        {shown.map((a) => {
          const bad = !isValidAddress(a);
          const remove = () => {
            onChange(value.filter((v) => v !== a));
            focusInput();
          };
          return (
            <span
              key={a.address + (a.name ?? '')}
              className={`rchip ${bad ? 'inv' : ''}`}
              tabIndex={0}
              role="button"
              title={bad ? `${a.address} is not a valid email address` : a.address}
              aria-label={`${chipLabel(a)}${bad ? ', not a valid email address' : ''}. Press Delete to remove.`}
              onKeyDown={(e) => {
                const all = chips();
                const i = all.indexOf(e.currentTarget);
                if (e.key === 'Backspace' || e.key === 'Delete') {
                  e.preventDefault();
                  remove();
                } else if (e.key === 'ArrowLeft') {
                  e.preventDefault();
                  all[i - 1]?.focus();
                } else if (e.key === 'ArrowRight') {
                  e.preventDefault();
                  if (all[i + 1]) all[i + 1]!.focus();
                  else focusInput();
                } else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
                  e.preventDefault();
                  const r = e.currentTarget.getBoundingClientRect();
                  chipMenu(a, r.left, r.bottom);
                }
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                chipMenu(a, e.clientX, e.clientY);
              }}
            >
              {bad ? <Icon name="warn" /> : null}
              <span className="ct">{chipLabel(a)}</span>
              <button
                type="button"
                className="ibtn"
                tabIndex={-1}
                aria-label={`Remove ${chipLabel(a)}`}
                onClick={(e) => {
                  e.stopPropagation();
                  remove();
                }}
              >
                <Icon name="x" />
              </button>
            </span>
          );
        })}
        {hidden > 0 ? (
          <button type="button" className="link plain" onClick={() => setExpanded(true)}>
            +{hidden} more
          </button>
        ) : null}
        <input
          id={id}
          ref={inputRef}
          value={text}
          autoComplete="off"
          spellCheck={false}
          placeholder={value.length === 0 ? placeholder : undefined}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-err` : undefined}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listId}
          aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
          onChange={(e) => {
            setText(e.target.value);
            if (pasted.current) {
              pasted.current = false;
              closeSuggestions();
            } else lookup(e.target.value);
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            closeSuggestions();
            // Only a complete address becomes a chip on leaving the box. Half-typed text such as "dm"
            // stays in the box and is never stored as a recipient.
            if (text.trim()) {
              const r = resolvePending(value, text);
              if (!r.bad) commit(text);
            }
          }}
        />
        {open && placement ? (
          <RecipientSuggestions
            listId={listId}
            items={sugs}
            activeIndex={active}
            query={text}
            placement={placement}
            removing={removing}
            onPick={pick}
            onHover={setActive}
            onForget={forget}
          />
        ) : null}
        <span className="sr-only" role="status">
          {announce}
        </span>
      </div>
      {extra}
      {error ? (
        <div className="bad cerr" id={`${id}-err`} role="alert">
          <Icon name="warn" />
          {error}
        </div>
      ) : null}
    </div>
  );
}
