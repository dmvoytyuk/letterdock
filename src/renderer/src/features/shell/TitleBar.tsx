import { useEffect, useRef, useState } from 'react';
import { Icon } from '../../components/Icon';
import { IconButton } from '../../components/ui';
import { syncKindOf } from '../../components/Sync';
import { useApp } from '../../store/app';
import { useUi } from '../../store/ui';
import { SearchBox } from './SearchBox';
import { SyncPopover } from './SyncPopover';
import appIcon from '../../../../../build/icon-small.svg';

export { syncAll } from './SyncPopover';

export function TitleBar() {
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
  const open = useUi((s) => s.syncPopover === 'title');
  const ref = useRef<HTMLDivElement>(null);
  const close = () => useUi.setState((s) => (s.syncPopover === 'title' ? { syncPopover: null } : s));

  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('mousedown', down);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('mousedown', down);
      window.removeEventListener('keydown', key);
    };
  }, [open]);

  const kinds = accounts.map((a) => syncKindOf(statuses[a.id], !!authRequired[a.id], online));
  const syncing = kinds.some((k) => k === 'syncing');
  const problem = kinds.some((k) => k === 'error' || k === 'auth');

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        type="button"
        className="ibtn"
        title="Sync status (F9 to check all accounts)"
        aria-label={syncing ? 'Sync status: syncing' : problem ? 'Sync status: problem with an account' : 'Sync status'}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => useUi.setState({ syncPopover: open ? null : 'title' })}
      >
        {syncing ? <i className="spin" /> : <Icon name="sync" />}
        {problem ? <i className="pulse" /> : null}
      </button>
      {open ? <SyncPopover placement="below" /> : null}
    </div>
  );
}
