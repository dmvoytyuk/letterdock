import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';
import { create } from 'zustand';
import { Icon, type IconName } from './Icon';
import { onColor } from '../lib/colors';
import { useToasts } from '../store/toasts';

// ---------- buttons ----------
type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'subtle' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  icon?: IconName;
  loading?: boolean;
};

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  loading,
  className,
  children,
  disabled,
  type = 'button',
  ...rest
}: BtnProps) {
  const cls = [
    'btn',
    variant === 'secondary' ? '' : variant,
    size === 'md' ? '' : size,
    loading ? 'loading' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button type={type} className={cls} disabled={disabled} aria-busy={loading || undefined} {...rest}>
      {loading ? <span className="spin" aria-hidden="true" /> : icon ? <Icon name={icon} /> : null}
      {children}
    </button>
  );
}

export function IconButton({
  icon,
  label,
  size = 'md',
  pressed,
  className,
  iconSize,
  ...rest
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label'> & {
  icon: IconName;
  label: string;
  size?: 'md' | 'sm' | 'xs';
  pressed?: boolean;
  iconSize?: 16 | 20;
}) {
  return (
    <button
      type="button"
      className={`ibtn ${size === 'md' ? '' : size} ${pressed ? 'on' : ''} ${className ?? ''}`}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      {...rest}
    >
      <Icon name={icon} size={iconSize ?? 16} />
    </button>
  );
}

// ---------- form controls ----------
export function TextField({
  label,
  error,
  hint,
  mono,
  className,
  id,
  inputRef,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  error?: string | null;
  hint?: string;
  mono?: boolean;
  inputRef?: React.Ref<HTMLInputElement>;
}) {
  const auto = useId();
  const fid = id ?? auto;
  const desc = error ? `${fid}-err` : hint ? `${fid}-hint` : undefined;
  return (
    <div className="field">
      <label htmlFor={fid}>{label}</label>
      <input
        id={fid}
        ref={inputRef}
        className={`inp ${mono ? 'mono' : ''} ${error ? 'err' : ''} ${className ?? ''}`}
        aria-invalid={error ? true : undefined}
        aria-describedby={desc}
        {...rest}
      />
      {error ? (
        <div className="bad" id={`${fid}-err`}>
          <Icon name="warn" />
          {error}
        </div>
      ) : hint ? (
        <div className="hint" id={`${fid}-hint`}>
          {hint}
        </div>
      ) : null}
    </div>
  );
}

export function PasswordField({
  label,
  error,
  hint,
  inputRef,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & {
  label: string;
  error?: string | null;
  hint?: string;
  inputRef?: React.Ref<HTMLInputElement>;
}) {
  const [shown, setShown] = useState(false);
  const fid = useId();
  return (
    <div className="field">
      <label htmlFor={fid}>{label}</label>
      <div className="iw">
        <input
          id={fid}
          ref={inputRef}
          className={`inp ${error ? 'err' : ''}`}
          type={shown ? 'text' : 'password'}
          autoComplete="off"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${fid}-err` : undefined}
          {...rest}
        />
        <IconButton
          icon={shown ? 'eye-off' : 'eye'}
          label={shown ? 'Hide password' : 'Show password'}
          size="sm"
          onClick={() => setShown((v) => !v)}
          style={{ top: 2 }}
        />
      </div>
      {error ? (
        <div className="bad" id={`${fid}-err`}>
          <Icon name="warn" />
          {error}
        </div>
      ) : hint ? (
        <div className="hint">{hint}</div>
      ) : null}
    </div>
  );
}

export function SelectField({
  label,
  children,
  className,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & { label: string }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} className={`inp ${className ?? ''}`} {...rest}>
        {children}
      </select>
    </div>
  );
}

export function Checkbox({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className={`cbx ${disabled ? 'dis' : ''}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <i>
        <Icon name="check" />
      </i>
      {label}
    </label>
  );
}

/** An on/off switch (role="switch"). The label sits to its right unless `label` is left out. */
export function Switch({
  checked,
  onChange,
  label,
  ariaLabel,
  disabled,
  describedBy,
  id,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: ReactNode;
  ariaLabel?: string;
  disabled?: boolean;
  describedBy?: string;
  id?: string;
}) {
  return (
    <label className={`sw ${disabled ? 'dis' : ''}`}>
      <input
        id={id}
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-describedby={describedBy}
        onChange={(e) => onChange(e.target.checked)}
      />
      <i aria-hidden="true" />
      {label ? <span className="swl">{label}</span> : null}
    </label>
  );
}

export function Radio({
  name,
  checked,
  onChange,
  label,
  disabled,
}: {
  name: string;
  checked: boolean;
  onChange: () => void;
  label: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className={`rad ${disabled ? 'dis' : ''}`}>
      <input type="radio" name={name} checked={checked} onChange={onChange} disabled={disabled} />
      <i />
      {label}
    </label>
  );
}

// ---------- account marks ----------
export function AccountAvatar({
  color,
  letter,
  size = 20,
  round,
  square8,
}: {
  color: string;
  letter: string;
  size?: 20 | 24 | 40;
  round?: boolean;
  square8?: boolean;
}) {
  const cls = size === 40 ? 'badge l' : size === 24 ? 'badge m' : 'badge';
  return (
    <span
      className={`${cls} ${square8 ? 'sq' : ''}`}
      style={{
        ['--ac' as string]: color,
        ['--on-ac' as string]: onColor(color),
        borderRadius: round ? 999 : undefined,
      }}
      aria-hidden="true"
    >
      {letter}
    </span>
  );
}

/** 16px rounded square with the account's letter (DESIGN-SPEC 3.5). Shape and letter carry the meaning, not color alone. */
export function AccountBadge({ color, name, letter }: { color: string; name: string; letter: string }) {
  const label = `Account: ${name}`;
  return (
    <span className="abadge" style={{ ['--ac' as string]: color }} title={label} role="img" aria-label={label}>
      {letter}
    </span>
  );
}

// ---------- banner / empty / skeleton ----------
export function Banner({
  tone = 'info',
  children,
  actions,
  onDismiss,
  role,
  className,
}: {
  tone?: 'info' | 'warning' | 'danger' | 'success';
  children: ReactNode;
  actions?: ReactNode;
  onDismiss?: () => void;
  role?: 'alert' | 'status';
  className?: string;
}) {
  const icon: IconName = tone === 'danger' || tone === 'warning' ? 'warn' : tone === 'success' ? 'check' : 'info';
  return (
    <div className={`banner ${tone} ${className ?? ''}`} role={role ?? (tone === 'danger' ? 'alert' : 'status')}>
      <span className="ic">
        <Icon name={icon} />
      </span>
      <div>
        {children}
        {actions ? <div className="acts">{actions}</div> : null}
      </div>
      {onDismiss ? <IconButton icon="x" label="Dismiss" size="xs" className="x" onClick={onDismiss} /> : null}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  text,
  action,
}: {
  icon: IconName;
  title: string;
  text?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <Icon name={icon} size={48} />
      <h3>{title}</h3>
      {text ? <p>{text}</p> : null}
      {action}
    </div>
  );
}

export function Skeleton({ w = '100%', h = 12 }: { w?: number | string; h?: number }) {
  return <div className="skel" style={{ width: w, height: h }} aria-hidden="true" />;
}

// ---------- dialog ----------
const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Dialog({
  title,
  onClose,
  children,
  size = 'md',
  titleSize,
  busy,
  initialFocus,
  hideClose,
  leading,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  titleSize?: number;
  busy?: boolean;
  /** CSS selector inside the dialog to focus first. Defaults to the first focusable field. */
  initialFocus?: string;
  hideClose?: boolean;
  leading?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    if (el) {
      const target =
        (initialFocus && el.querySelector<HTMLElement>(initialFocus)) ||
        el.querySelector<HTMLElement>('input:not([disabled]), select, textarea') ||
        el.querySelector<HTMLElement>('.foot .btn.primary:not([disabled])') ||
        el.querySelector<HTMLElement>(FOCUSABLE);
      target?.focus();
    }
    return () => {
      if (prev && document.contains(prev)) prev.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      e.preventDefault();
      onCloseRef.current();
      return;
    }
    if (e.key === 'Tab' && ref.current) {
      const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (x) => x.offsetParent !== null,
      );
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  return (
    <div
      className="modal"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        ref={ref}
        className={`dlg ${size === 'md' ? '' : size}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={busy || undefined}
        onKeyDown={onKey}
      >
        <h3 id={titleId} style={titleSize ? { fontSize: titleSize, lineHeight: '22px' } : undefined}>
          {leading}
          {title}
          {hideClose ? null : <IconButton icon="x" label="Close" onClick={onClose} />}
        </h3>
        {children}
      </div>
    </div>
  );
}

// ---------- menus ----------
export type MenuEntry =
  | {
      label: string;
      icon?: IconName;
      hint?: string;
      danger?: boolean;
      disabled?: boolean;
      /** A choice out of a group (sort order, filter): shows a check mark and says so to screen readers. */
      checked?: boolean;
      /** Tooltip, for example why an item is off. */
      title?: string;
      /** A submenu (opens on hover, Enter or Right arrow). `onSelect` is not used then. */
      children?: MenuEntry[];
      onSelect: () => void;
    }
  /** A label for the group below it. Not selectable. */
  | { heading: string }
  | 'sep';

interface MenuOptions {
  /** Minimum width in px. The menu still grows to fit its items (default: as wide as they need). */
  minWidth?: number;
  /** Called when the menu closes by any way (Esc, outside click, a choice). */
  onClose?: () => void;
}
interface MenuState {
  menu: { x: number; y: number; items: MenuEntry[]; returnFocus: HTMLElement | null; opts: MenuOptions } | null;
  open: (x: number, y: number, items: MenuEntry[], opts?: MenuOptions) => void;
  close: () => void;
}
export const useMenu = create<MenuState>((set, get) => ({
  menu: null,
  open: (x, y, items, opts = {}) =>
    set({ menu: { x, y, items, returnFocus: document.activeElement as HTMLElement | null, opts } }),
  close: () => {
    const m = get().menu;
    set({ menu: null });
    m?.opts.onClose?.();
  },
}));

/** Open a menu below a button. */
export function openMenuAt(el: HTMLElement, items: MenuEntry[], opts?: MenuOptions): void {
  const r = el.getBoundingClientRect();
  useMenu.getState().open(r.left, r.bottom + 2, items, opts);
}

export function MenuHost() {
  const menu = useMenu((s) => s.menu);
  const close = useMenu((s) => s.close);
  const ref = useRef<HTMLDivElement>(null);
  const [placed, setPlaced] = useState<{ for: unknown; left: number; top: number } | null>(null);
  const pos = placed && placed.for === menu ? placed : null;
  // Which item has its submenu open, and whether that submenu opens to the left (no room on the right).
  const [subRaw, setSub] = useState<(SubPos & { for: unknown }) | null>(null);
  const sub = subRaw && subRaw.for === menu ? subRaw : null;
  const openSub = (index: number, el: HTMLElement, focusFirst: boolean, count: number) => {
    const r = el.getBoundingClientRect();
    const left = r.right + 260 > window.innerWidth;
    const y = Math.max(8, Math.min(r.top - 6, window.innerHeight - count * 32 - 20));
    setSub({ for: menu, index, x: left ? r.left - 252 : r.right - 4, y });
    if (focusFirst) setTimeout(() => el.parentElement?.querySelector<HTMLElement>('.menu.sub .mi:not([disabled])')?.focus(), 0);
  };

  useLayoutEffect(() => {
    if (!menu || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    setPlaced({
      for: menu,
      left: Math.max(8, Math.min(menu.x, window.innerWidth - r.width - 8)),
      top: Math.max(8, Math.min(menu.y, window.innerHeight - r.height - 8)),
    });
  }, [menu]);

  // Focus the first item once the menu is placed (a hidden menu cannot take focus).
  useEffect(() => {
    if (!menu || !pos) return;
    ref.current?.querySelector<HTMLElement>('.mi:not([disabled])')?.focus();
  }, [menu, pos]);

  useEffect(() => {
    if (!menu) return;
    const down = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const blur = () => close();
    window.addEventListener('mousedown', down, true);
    window.addEventListener('blur', blur);
    window.addEventListener('resize', blur);
    return () => {
      window.removeEventListener('mousedown', down, true);
      window.removeEventListener('blur', blur);
      window.removeEventListener('resize', blur);
    };
  }, [menu, close]);

  if (!menu) return null;

  const closeAndReturn = () => {
    const rf = menu.returnFocus;
    close();
    if (rf && document.contains(rf)) rf.focus();
  };

  const onKey = (e: ReactKeyboardEvent) => {
    const active = document.activeElement as HTMLElement | null;
    const inSub = !!active?.closest('.menu.sub');
    const scope = inSub ? active!.closest('.menu.sub')! : ref.current;
    const items = [
      ...(scope?.querySelectorAll<HTMLElement>(inSub ? ':scope > .mi:not([disabled])' : ':scope > .mi:not([disabled]), :scope > .msubwrap > .mi:not([disabled])') ?? []),
    ];
    const i = items.indexOf(active as HTMLElement);
    if (e.key === 'ArrowRight' && active?.dataset.sub) {
      e.preventDefault();
      e.stopPropagation();
      openSub(Number(active.dataset.sub), active, true, Number(active.dataset.count));
    } else if ((e.key === 'Escape' || e.key === 'ArrowLeft') && inSub) {
      e.preventDefault();
      e.stopPropagation();
      const parent = active!.closest('.msubwrap')?.querySelector<HTMLElement>(':scope > .mi');
      setSub(null);
      parent?.focus();
    } else if (e.key === 'Escape' || e.key === 'ArrowLeft') {
      e.preventDefault();
      e.stopPropagation();
      closeAndReturn();
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
    } else if (e.key.length === 1) {
      const next = items.find((el, idx) => idx > i && el.textContent?.toLowerCase().startsWith(e.key.toLowerCase()));
      (next ?? items.find((el) => el.textContent?.toLowerCase().startsWith(e.key.toLowerCase())))?.focus();
    }
  };

  return (
    <div
      ref={ref}
      className="menu"
      role="menu"
      style={{
        left: pos?.left ?? menu.x,
        top: pos?.top ?? menu.y,
        visibility: pos ? 'visible' : 'hidden',
        ...(menu.opts.minWidth ? { minWidth: menu.opts.minWidth } : {}),
      }}
      onKeyDown={onKey}
      onContextMenu={(e) => e.preventDefault()}
    >
      {menu.items.map((it, i) =>
        it === 'sep' ? (
          <div key={i} className="msep" role="separator" />
        ) : 'heading' in it ? (
          <div key={i} className="mhead" role="presentation">
            {it.heading}
          </div>
        ) : (
          <MenuItem
            key={i}
            item={it}
            index={i}
            subOpen={sub?.index === i ? sub : null}
            onOpenSub={openSub}
            onCloseSub={() => setSub(null)}
            onChoose={(entry) => {
              closeAndReturn();
              entry.onSelect();
            }}
          />
        ),
      )}
    </div>
  );
}


type ActionEntry = Extract<MenuEntry, { label: string }>;
interface SubPos {
  index: number;
  x: number;
  y: number;
}

function MenuItem({
  item: it,
  index,
  subOpen,
  onOpenSub,
  onCloseSub,
  onChoose,
}: {
  item: ActionEntry;
  index: number;
  subOpen: SubPos | null;
  onOpenSub: (index: number, el: HTMLElement, focusFirst: boolean, count: number) => void;
  onCloseSub: () => void;
  onChoose: (e: ActionEntry) => void;
}) {
  const icon =
    it.checked !== undefined ? (
      it.checked ? <Icon name="check" /> : <span className="mi-gap" aria-hidden="true" />
    ) : it.icon ? (
      <Icon name={it.icon} />
    ) : (
      <span className="mi-gap" aria-hidden="true" />
    );
  if (it.children) {
    return (
      <div className="msubwrap" onMouseLeave={onCloseSub}>
        <button
          type="button"
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={!!subOpen}
          data-sub={index}
          data-count={it.children.length}
          className="mi"
          disabled={it.disabled}
          title={it.title}
          onMouseEnter={(e) => onOpenSub(index, e.currentTarget, false, it.children!.length)}
          onClick={(e) => onOpenSub(index, e.currentTarget, true, it.children!.length)}
        >
          {icon}
          <span className="ml">{it.label}</span>
          <span className="a" aria-hidden="true">
            <Icon name="chev-r" />
          </span>
        </button>
        {subOpen ? (
          <div className="menu sub" role="menu" aria-label={it.label} style={{ left: subOpen.x, top: subOpen.y }}>
            {it.children.map((c, j) =>
              c === 'sep' ? (
                <div key={j} className="msep" role="separator" />
              ) : 'heading' in c ? (
                <div key={j} className="mhead" role="presentation">
                  {c.heading}
                </div>
              ) : (
                <button key={j} type="button" role="menuitem" className={`mi ${c.danger ? 'danger' : ''}`} disabled={c.disabled} title={c.title} onClick={() => onChoose(c)}>
                  {c.icon ? <Icon name={c.icon} /> : <span className="mi-gap" aria-hidden="true" />}
                  <span className="ml">{c.label}</span>
                  {c.hint ? <span className="a">{c.hint}</span> : null}
                </button>
              ),
            )}
          </div>
        ) : null}
      </div>
    );
  }
  return (
    <button
      type="button"
      role={it.checked === undefined ? 'menuitem' : 'menuitemradio'}
      aria-checked={it.checked}
      className={`mi ${it.danger ? 'danger' : ''}`}
      disabled={it.disabled}
      title={it.title}
      onClick={() => onChoose(it)}
    >
      {icon}
      <span className="ml">{it.label}</span>
      {it.hint ? <span className="a">{it.hint}</span> : null}
    </button>
  );
}

// ---------- toasts ----------
export function ToastHost() {
  const items = useToasts((s) => s.items);
  return (
    <div className="toasts">
      {items.map((t) => (
        <ToastView key={t.id} id={t.id} />
      ))}
    </div>
  );
}

function ToastView({ id }: { id: number }) {
  const t = useToasts((s) => s.items.find((x) => x.id === id));
  const dismiss = useToasts((s) => s.dismiss);
  const [paused, setPaused] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const duration = t?.duration ?? 0;
  useEffect(() => {
    if (!duration || paused) return;
    const h = setTimeout(() => dismiss(id), duration);
    return () => clearTimeout(h);
  }, [duration, paused, id, dismiss]);
  if (!t) return null;
  return (
    <div
      className={`toast ${t.tone}`}
      role={t.tone === 'danger' ? 'alert' : 'status'}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <span className="tx">{t.message}</span>
      {t.details && t.details.length > 0 ? (
        <button type="button" className="link" aria-expanded={showDetails} onClick={() => setShowDetails((v) => !v)}>
          {showDetails ? 'Hide details' : 'Details'}
        </button>
      ) : null}
      {t.actionLabel ? (
        <button
          type="button"
          className="link"
          onClick={() => {
            t.onAction?.();
            dismiss(id);
          }}
        >
          {t.actionLabel}
        </button>
      ) : null}
      {t.secondaryLabel ? (
        <button
          type="button"
          className="link"
          onClick={() => {
            t.onSecondary?.();
            dismiss(id);
          }}
        >
          {t.secondaryLabel}
        </button>
      ) : null}
      {t.tone === 'danger' || t.duration === 0 ? (
        <IconButton icon="x" label="Dismiss" size="xs" onClick={() => dismiss(id)} />
      ) : null}
      {showDetails && t.details ? (
        <ul className="tdet">
          {t.details.map((d, i) => (
            <li key={i}>{d}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// ---------- resize handle ----------
export function ResizeHandle({
  value,
  min,
  max,
  label,
  onChange,
  onReset,
  invert,
}: {
  value: number;
  min: number;
  max: number;
  label: string;
  onChange: (v: number) => void;
  onReset: () => void;
  /** Dragging right shrinks the pane (used when the pane sits right of the handle). */
  invert?: boolean;
}) {
  const [drag, setDrag] = useState(false);
  const start = useRef({ x: 0, v: 0 });
  const clamp = (v: number) => Math.max(min, Math.min(max, v));
  return (
    <div
      className={`handle ${drag ? 'drag' : ''}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={(e) => {
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        start.current = { x: e.clientX, v: value };
        setDrag(true);
      }}
      onPointerMove={(e) => {
        if (!drag) return;
        const dx = e.clientX - start.current.x;
        onChange(clamp(start.current.v + (invert ? -dx : dx)));
      }}
      onPointerUp={() => setDrag(false)}
      onPointerCancel={() => setDrag(false)}
      onDoubleClick={onReset}
      onKeyDown={(e) => {
        const step = invert ? -16 : 16;
        if (e.key === 'ArrowLeft') onChange(clamp(value - step));
        else if (e.key === 'ArrowRight') onChange(clamp(value + step));
        else if (e.key === 'Home') onChange(min);
        else if (e.key === 'End') onChange(max);
        else return;
        e.preventDefault();
      }}
    />
  );
}
