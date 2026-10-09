import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as RKE, type MouseEvent as RME, type ReactNode } from 'react';
import { create } from 'zustand';
import type { AccountId, Address, ContactInfo } from '../../../shared/ipc';
import { Icon, type IconName } from './Icon';
import { AccountBadge } from './ui';
import { useApp } from '../store/app';
import { useUi } from '../store/ui';
import { toast, toastError } from '../store/toasts';
import { asAppError, call } from '../lib/api';
import { openCompose } from '../lib/actions';
import { useAccountColor } from '../lib/hooks';
import { initials } from '../lib/format';
import { createRuleFromSender } from '../features/rules/ruleActions';
import { showsForget } from '../lib/contactPopoverRules';

/**
 * The address popover (DESIGN-SPEC 3.6, 3.12.3, 7.4 `ContactPopover`): click a sender or recipient
 * and get Copy address, New message, Search from this sender, Create rule from this sender... and
 * Remove from suggestions, with what Letterdock knows about the address (`contacts.get`).
 */
interface Target {
  address: string;
  /** The name shown in the mail (the address book may know a better one). */
  name: string | undefined;
  /** The account of the message: new mail and rules start from it. */
  accountId: AccountId | undefined;
  /** False for Sent, Drafts and similar mail (DESIGN-SPEC 3.12.3). */
  allowRule: boolean;
  anchor: HTMLElement;
  rect: DOMRect;
}

interface PopoverState {
  target: Target | null;
  open: (t: Target) => void;
  close: (returnFocus?: boolean) => void;
}

export const useContactPopover = create<PopoverState>((set, get) => ({
  target: null,
  open: (target) => set({ target }),
  close: (returnFocus = false) => {
    const t = get().target;
    set({ target: null });
    if (returnFocus && t && document.contains(t.anchor)) t.anchor.focus();
  },
}));

/** The message window has no list and no rule editor: Search and Create rule are left out there. */
const inMessageWindow = () => document.documentElement.dataset.window === 'message';

/** A sender or recipient that opens the address popover. */
export function AddressButton({
  address,
  accountId,
  allowRule = true,
  className,
  children,
}: {
  address: Address;
  accountId?: AccountId | undefined;
  allowRule?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const onClick = (e: RME<HTMLButtonElement>) => {
    e.stopPropagation();
    const anchor = e.currentTarget;
    // A second click on the same name closes it.
    if (useContactPopover.getState().target?.anchor === anchor) {
      useContactPopover.getState().close();
      return;
    }
    useContactPopover.getState().open({
      address: address.address,
      name: address.name?.trim() || undefined,
      accountId,
      allowRule,
      anchor,
      rect: anchor.getBoundingClientRect(),
    });
  };
  return (
    <button type="button" className={`addr-link ${className ?? ''}`} aria-haspopup="dialog" title={address.address} onClick={onClick}>
      {children}
    </button>
  );
}

/** A list of addresses as popover buttons, separated by commas. */
export function AddressLinks({
  list,
  accountId,
  allowRule = true,
  max,
  full = false,
}: {
  list: Address[];
  accountId?: AccountId | undefined;
  allowRule?: boolean;
  max?: number;
  /** Show "Name <address>" instead of the name. */
  full?: boolean;
}) {
  const shown = max === undefined ? list : list.slice(0, max);
  return (
    <>
      {shown.map((a, i) => (
        <span key={`${a.address}-${i}`}>
          {i > 0 ? ', ' : ''}
          <AddressButton address={a} accountId={accountId} allowRule={allowRule}>
            {full && a.name?.trim() ? `${a.name.trim()} <${a.address}>` : a.name?.trim() || a.address}
          </AddressButton>
        </span>
      ))}
      {max !== undefined && list.length > max ? `, +${list.length - max}` : ''}
    </>
  );
}

const when = (ms: number) => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const times = (n: number) => (n === 1 ? 'once' : `${n} times`);

/** What Letterdock knows about the address, in plain words. */
export function infoLines(info: ContactInfo): string[] {
  if (info.isOwn) return ['This is one of your own addresses.'];
  const out: string[] = [];
  if (info.forgotten) out.push('You removed it from your suggestions.');
  else if (!info.known) out.push("Letterdock hasn't seen this address in your mail yet.");
  if (info.sentCount > 0) out.push(`You wrote to it ${times(info.sentCount)}.`);
  if (info.receivedCount > 0) out.push(`${info.receivedCount} ${info.receivedCount === 1 ? 'message' : 'messages'} from it or with it.`);
  if (info.lastUsed > 0) out.push(`Last used ${when(info.lastUsed)}.`);
  return out;
}

export function ContactPopoverHost() {
  const target = useContactPopover((s) => s.target);
  if (!target) return null;
  return <Popover key={`${target.address}-${target.rect.left}-${target.rect.top}`} target={target} />;
}

function Popover({ target }: { target: Target }) {
  const close = useContactPopover((s) => s.close);
  const accounts = useApp((s) => s.accounts);
  const colorOf = useAccountColor();
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const [info, setInfo] = useState<ContactInfo | null>(null);
  const [failed, setFailed] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const win = inMessageWindow();

  useEffect(() => {
    let alive = true;
    call('contacts.get', { address: target.address })
      .then((r) => alive && setInfo(r))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [target.address]);

  // Place it under the name (above when there is no room), inside the window.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const t = target.rect;
    const left = Math.max(8, Math.min(t.left, window.innerWidth - r.width - 8));
    const below = t.bottom + 4;
    const top = below + r.height <= window.innerHeight - 8 ? below : Math.max(8, t.top - r.height - 4);
    setPos({ left, top });
  }, [target, info, failed]);

  // First button gets the focus once the popover is placed.
  useEffect(() => {
    if (pos) ref.current?.querySelector<HTMLElement>('button:not([disabled])')?.focus();
    // Only when it first appears.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pos === null]);

  useEffect(() => {
    const down = (e: MouseEvent) => {
      const t = e.target as Node;
      // A click on the name that opened it is a toggle: the button itself closes it.
      if (ref.current && !ref.current.contains(t) && !target.anchor.contains(t)) close();
    };
    const away = () => close();
    window.addEventListener('mousedown', down, true);
    window.addEventListener('blur', away);
    window.addEventListener('resize', away);
    window.addEventListener('scroll', away, true);
    return () => {
      window.removeEventListener('mousedown', down, true);
      window.removeEventListener('blur', away);
      window.removeEventListener('resize', away);
      window.removeEventListener('scroll', away, true);
    };
  }, [close, target.anchor]);

  const name = info?.name?.trim() || target.name || '';
  const shownName = name || target.address;
  const own = !!info?.isOwn;
  const accountList = (info?.accountIds ?? []).map((id) => accounts.find((a) => a.id === id)).filter((a): a is NonNullable<typeof a> => !!a);

  const run = (fn: () => void) => () => {
    close();
    fn();
  };
  const copy = () =>
    void navigator.clipboard.writeText(target.address).then(
      () => toast('Address copied.'),
      () => toastError('Could not copy.'),
    );
  const remove = () => {
    void call('contacts.forget', { address: target.address })
      .then(() => toast(`${shownName} removed from suggestions.`))
      .catch((e) => toastError(asAppError(e).message));
  };

  const actions: { key: string; label: string; icon: IconName; disabled?: boolean; why?: string; danger?: boolean; on: () => void }[] = [
    { key: 'copy', label: 'Copy address', icon: 'copy', on: run(copy) },
    {
      key: 'new',
      label: 'New message',
      icon: 'pencil',
      on: run(() => openCompose({ mode: 'new', mailto: `mailto:${target.address}`, ...(target.accountId ? { accountId: target.accountId } : {}) })),
    },
    ...(!win && !own
      ? [
          {
            key: 'search',
            label: 'Search from this sender',
            icon: 'search' as const,
            on: run(() => useUi.getState().startSearch(`from:${target.address}`, null)),
          },
        ]
      : []),
    ...(!win && !own && target.allowRule && target.accountId
      ? [
          {
            key: 'rule',
            label: 'Create rule from this sender...',
            icon: 'rules' as const,
            on: run(() => createRuleFromSender(target.accountId!, { ...(name ? { name } : {}), address: target.address })),
          },
        ]
      : []),
    ...(showsForget(info)
      ? [
          {
            key: 'forget',
            label: 'Remove from suggestions',
            icon: 'trash' as const,
            disabled: !info || info.forgotten || !info.known,
            why: !info ? undefined : info.forgotten ? 'Already removed.' : !info.known ? 'Not in your suggestions.' : undefined,
            on: run(remove),
          },
        ]
      : []),
  ];

  const onKey = (e: RKE<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close(true);
      return;
    }
    const btns = [...(ref.current?.querySelectorAll<HTMLElement>('button:not([disabled])') ?? [])];
    if (btns.length === 0) return;
    const i = btns.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey && i === btns.length - 1)) {
      e.preventDefault();
      btns[(i + 1) % btns.length]?.focus();
    } else if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey && i <= 0)) {
      e.preventDefault();
      btns[(i - 1 + btns.length) % btns.length]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      btns[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      btns[btns.length - 1]?.focus();
    }
  };

  return (
    <div
      ref={ref}
      className="cpop"
      role="dialog"
      aria-labelledby={titleId}
      style={{ left: pos?.left ?? target.rect.left, top: pos?.top ?? target.rect.bottom + 4, visibility: pos ? 'visible' : 'hidden' }}
      onKeyDown={onKey}
    >
      <div className="cpop-head">
        <span className="cpop-av" aria-hidden="true">
          {initials(shownName)}
        </span>
        <div className="cpop-who">
          <div id={titleId} className="cpop-nm">
            {shownName}
          </div>
          {name ? <div className="cpop-ad">{target.address}</div> : null}
        </div>
      </div>
      <div className="cpop-info" aria-live="polite">
        {failed ? <p>Could not read what is known about this address.</p> : info ? infoLines(info).map((l) => <p key={l}>{l}</p>) : <p>Loading...</p>}
        {accountList.length > 0 ? (
          <p className="cpop-accts">
            {accountList.map((a) => (
              <span key={a.id} className="cpop-acct">
                <AccountBadge color={colorOf(a.id)} name={a.displayName} letter={a.badge} /> {a.displayName}
              </span>
            ))}
          </p>
        ) : null}
      </div>
      <div className="cpop-acts">
        {actions.map((a) => (
          <button key={a.key} type="button" className={`cpop-act ${a.danger ? 'danger' : ''}`} disabled={a.disabled} title={a.why} onClick={a.on}>
            <Icon name={a.icon} />
            <span>{a.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
