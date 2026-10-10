// The quick replies menu of the compose window (DESIGN-SPEC 3.13.4). Built when it opens, removed when it
// closes; its code loads on the first click or Ctrl+Shift+Q.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as RKE } from 'react';
import type { AccountId } from '../../../../shared/ipc';
import { useApp } from '../../store/app';
import { call } from '../../lib/api';
import { foldChars } from '../../lib/fuzzy';
import { toastError } from '../../store/toasts';
import './quickReplies.css';

const SEARCH_FROM = 9;

const fold = (s: string) => foldChars(s).join('');

export default function QuickReplyMenu({
  accountId,
  x,
  y,
  onPick,
  onClose,
}: {
  accountId: AccountId;
  x: number;
  y: number;
  onPick: (text: string) => void;
  onClose: () => void;
}) {
  const all = useApp((s) => s.settings?.quickReplies ?? []);
  // Only replies for all accounts or the current From account; rebuilt each time the menu opens.
  const mine = useMemo(() => all.filter((q) => q.accountId === null || q.accountId === accountId), [all, accountId]);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const showSearch = mine.length >= SEARCH_FROM;
  const shown = useMemo(() => {
    const q = fold(query.trim());
    return q ? mine.filter((r) => fold(r.name).includes(q) || fold(r.text).includes(q)) : mine;
  }, [mine, query]);

  useLayoutEffect(() => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    setPos({
      left: Math.max(8, Math.min(x, window.innerWidth - r.width - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - r.height - 8)),
    });
  }, [x, y]);
  useEffect(() => {
    if (!pos) return;
    if (showSearch) searchRef.current?.focus();
    else ref.current?.focus();
  }, [pos, showSearch]);
  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener('mousedown', down, true);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('mousedown', down, true);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);
  useEffect(() => {
    ref.current?.querySelector('.qr-item.act')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const manage = () => {
    onClose();
    call('ui.openSettings', { section: 'mail' }).catch((e) => toastError((e as { message?: string }).message ?? 'Could not open Settings.'));
  };
  const onKey = (e: RKE<HTMLDivElement>) => {
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(shown.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const q = shown[active];
      if (q) onPick(q.text);
    } else if (!showSearch && /^[1-9]$/.test(e.key) && shown[Number(e.key) - 1]) {
      e.preventDefault();
      onPick(shown[Number(e.key) - 1]!.text);
    }
  };

  return (
    <div
      ref={ref}
      className="qr-pop"
      role="menu"
      aria-label="Quick replies"
      tabIndex={-1}
      style={{ left: pos?.left ?? x, top: pos?.top ?? y, visibility: pos ? 'visible' : 'hidden' }}
      onKeyDown={onKey}
    >
      {showSearch ? (
        <input
          ref={searchRef}
          className="inp qr-search"
          role="combobox"
          aria-expanded="true"
          aria-label="Search quick replies"
          placeholder="Search"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
        />
      ) : null}
      {mine.length === 0 ? (
        <div className="qr-none">
          <b>No quick replies yet</b>
          <div>
            <button type="button" className="link" onClick={manage}>
              Create one...
            </button>
          </div>
        </div>
      ) : shown.length === 0 ? (
        <div className="qr-none">No quick replies match.</div>
      ) : (
        <ul>
          {shown.map((q, i) => (
            <li key={q.id}>
              <button
                type="button"
                role="menuitem"
                className={`qr-item ${i === active ? 'act' : ''}`}
                onMouseMove={() => setActive(i)}
                onClick={() => onPick(q.text)}
              >
                <span className="qn">{q.name}</span>
                <span className="qp">{q.text.replace(/\s+/g, ' ')}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="qr-foot">
        <button type="button" role="menuitem" onClick={manage}>
          Manage quick replies...
        </button>
      </div>
    </div>
  );
}
