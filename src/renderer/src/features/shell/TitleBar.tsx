import { useEffect, useRef, useState } from 'react';
import { Icon } from '../../components/Icon';
import { AccountBadge, Button, IconButton } from '../../components/ui';
import { pendingText, syncKindOf, syncText } from '../../components/Sync';
import { useApp } from '../../store/app';
import { useUi } from '../../store/ui';
import { useAccountColor } from '../../lib/hooks';
import { call } from '../../lib/api';
import { reportActionError, toast } from '../../store/toasts';
import { SearchBox } from './SearchBox';
import appIcon from '../../../../../build/icon-small.svg';

export function syncAll(): void {
  call('sync.all').catch((e) => reportActionError(e));
  toast('Checking all accounts...');
}

export function TitleBar() {
  const online = useApp((s) => s.online);
  const [focused, setFocused] = useState(true);
  const [searchOpen, setSearchOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const [tiny, setTiny] = useState(window.innerWidth < 600);

  useEffect(() => {
    const on = () => setFocused(true);
    const off = () => setFocused(false);
    const resize = () => setTiny(window.innerWidth < 600);
    window.addEventListener('focus', on);
    window.addEventListener('blur', off);
    window.addEventListener('resize', resize);
    return () => {
      window.removeEventListener('focus', on);
      window.removeEventListener('blur', off);
      window.removeEventListener('resize', resize);
    };
  }, []);

  // Ctrl+E / Ctrl+K / F3 focus the search box.
  useEffect(() => {
    return useUi.subscribe((s, prev) => {
      if (s.searchFocusTick === prev.searchFocusTick) return;
      setSearchOpen(true);
      setTimeout(() => inputRef.current?.focus(), 0);
    });
  }, []);

  const hideBox = tiny && !searchOpen;

  return (
    <header className={`titlebar ${focused ? '' : 'unfocused'}`} role="banner">
      <img className="appico" src={appIcon} alt="" aria-hidden="true" draggable={false} />
      {hideBox ? (
        <IconButton
          icon="search"
          label="Search (Ctrl+E)"
          className="search-narrow-btn"
          onClick={() => {
            setSearchOpen(true);
            setTimeout(() => inputRef.current?.focus(), 0);
          }}
        />
      ) : (
        <SearchBox inputRef={inputRef} tiny={tiny} onDismiss={() => setSearchOpen(false)} />
      )}
      <div className="tb-right nodrag">
        {!online ? (
          <span className="offline-pill" role="status">
            <Icon name="cloud-off" /> You&apos;re offline
          </span>
        ) : null}
        <SyncButton />
      </div>
    </header>
  );
}

function SyncButton() {
  const accounts = useApp((s) => s.accounts);
  const statuses = useApp((s) => s.statuses);
  const authRequired = useApp((s) => s.authRequired);
  const online = useApp((s) => s.online);
  const colorOf = useAccountColor();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', down);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('mousedown', down);
      window.removeEventListener('keydown', key);
    };
  }, [open]);

  const kinds = accounts.map((a) => ({ a, kind: syncKindOf(statuses[a.id], !!authRequired[a.id], online) }));
  const syncing = kinds.some((k) => k.kind === 'syncing');
  const problem = kinds.some((k) => k.kind === 'error' || k.kind === 'auth');

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        type="button"
        className="ibtn"
        title="Sync status (F9 to check all accounts)"
        aria-label={syncing ? 'Sync status: syncing' : problem ? 'Sync status: problem with an account' : 'Sync status'}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {syncing ? <i className="spin" /> : <Icon name="sync" />}
        {problem ? <i className="pulse" /> : null}
      </button>
      {open ? (
        <div className="sdrop" role="dialog" aria-label="Sync status" style={{ left: 'auto', right: 0, width: 340, minWidth: 0, top: 36 }}>
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
            <b style={{ fontWeight: 600, flex: 1 }}>Accounts</b>
            <Button size="sm" icon="sync" onClick={syncAll}>
              Check all
            </Button>
          </div>
          {accounts.length === 0 ? <div className="hint">No accounts yet.</div> : null}
          <div className="scroll" style={{ maxHeight: 320 }}>
            {kinds.map(({ a, kind }) => (
              <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0' }}>
                <AccountBadge color={colorOf(a.id)} name={a.displayName} letter={a.badge} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.displayName}</div>
                  <div className="hint">{syncText(kind === 'pending' ? 'idle' : kind, statuses[a.id])}</div>
                  {kind !== 'offline' && (statuses[a.id]?.pendingCount ?? 0) > 0 ? (
                    <div className="hint">{pendingText(statuses[a.id]!.pendingCount)}</div>
                  ) : null}
                </div>
                <Button
                  size="sm"
                  variant="subtle"
                  onClick={() => {
                    call('sync.account', { accountId: a.id }).catch((e) => reportActionError(e));
                  }}
                >
                  Sync now
                </Button>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
