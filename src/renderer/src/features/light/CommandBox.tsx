// The command box, Ctrl+K (DESIGN-SPEC 3.13.5). Mounted only while open; its code loads on the first Ctrl+K.
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as RKE } from 'react';
import { MAX_RECENT_COMMANDS } from '../../../../shared/ipc';
import { Icon } from '../../components/Icon';
import { AccountBadge } from '../../components/ui';
import { useApp } from '../../store/app';
import { useUi } from '../../store/ui';
import { useAccountColor } from '../../lib/hooks';
import { rankItems } from '../../lib/fuzzy';
import { buildCommands, SUGGESTION_IDS, type Command } from './commands';
import './commandBox.css';

const SHOWN_RECENT = 5;

interface Row {
  key: string;
  command: Command | null; // null = the "Search mail for ..." row
  label: string;
  icon: Command['icon'];
  positions: number[];
}

/** Label with the matched letters in bold. */
function Marked({ text, positions }: { text: string; positions: number[] }) {
  if (positions.length === 0) return <>{text}</>;
  const chars = [...text];
  const at = new Set(positions);
  const out: React.ReactNode[] = [];
  let run = '';
  let bold = false;
  chars.forEach((c, i) => {
    const b = at.has(i);
    if (b !== bold && run) {
      out.push(bold ? <b key={i}>{run}</b> : run);
      run = '';
    }
    bold = b;
    run += c;
  });
  if (run) out.push(bold ? <b key="last">{run}</b> : run);
  return <>{out}</>;
}

export default function CommandBox() {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [said, setSaid] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const colorOf = useAccountColor();
  const listId = useId();
  const recent = useApp((s) => s.settings?.recentCommands ?? []);
  const [returnTo] = useState(() => document.activeElement as HTMLElement | null);
  // Built once when the box opens, from the stores in memory.
  const commands = useMemo(() => buildCommands(), []);

  const { rows, sections } = useMemo(() => {
    const q = query.trim();
    const byId = new Map(commands.map((c) => [c.id, c]));
    const mk = (c: Command, positions: number[] = []): Row => ({ key: c.id, command: c, label: c.label, icon: c.icon, positions });
    if (q === '') {
      const rec = recent
        .map((id) => byId.get(id))
        .filter((c): c is Command => !!c)
        .slice(0, SHOWN_RECENT);
      const recIds = new Set(rec.map((c) => c.id));
      const sug = SUGGESTION_IDS.map((id) => byId.get(id)).filter((c): c is Command => !!c && !recIds.has(c.id));
      const list = [...rec, ...sug].map((c) => mk(c));
      return {
        rows: list,
        sections: new Map<number, string>([
          ...(rec.length > 0 ? ([[0, 'Recent']] as [number, string][]) : []),
          ...(sug.length > 0 ? ([[rec.length, 'Suggestions']] as [number, string][]) : []),
        ]),
      };
    }
    const ranked = rankItems(commands, q, (c) => c.label, (c) => {
      const i = recent.indexOf(c.id);
      return i < 0 ? null : i;
    });
    const list = ranked.map((r) => mk(r.item, r.positions));
    list.push({ key: 'search', command: null, label: `Search mail for '${q}'`, icon: 'search', positions: [] });
    return { rows: list, sections: new Map<number, string>() };
  }, [query, commands, recent]);

  useEffect(() => {
    inputRef.current?.focus();
    return () => {
      if (returnTo && document.contains(returnTo)) returnTo.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active, rows]);
  // A hidden status says how many results there are, 400 ms after typing stops.
  useEffect(() => {
    const h = setTimeout(() => {
      const n = rows.filter((r) => r.command).length;
      setSaid(n === 0 ? 'No results' : `${n} ${n === 1 ? 'result' : 'results'}`);
    }, 400);
    return () => clearTimeout(h);
  }, [rows]);

  const close = () => useUi.getState().set({ commandBoxOpen: false });
  const runRow = (r: Row | undefined) => {
    if (!r) return;
    close();
    if (!r.command) {
      const text = query.trim();
      setTimeout(() => useUi.getState().startSearch(text, null), 0);
      return;
    }
    const cmd = r.command;
    // Remember it first (newest first, max 8), then run it after the box is gone so dialogs open in the right place.
    const next = [cmd.id, ...recent.filter((x) => x !== cmd.id)].slice(0, MAX_RECENT_COMMANDS);
    void useApp.getState().updateSettings({ recentCommands: next }).catch(() => undefined);
    setTimeout(cmd.run, 0);
  };

  const onKey = (e: RKE<HTMLDivElement>) => {
    const n = rows.length;
    if (e.key === 'Escape' || (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'k')) {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    // The box owns the keys while it is open.
    e.stopPropagation();
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => (n ? Math.min(n - 1, a + 1) : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'PageDown') {
      e.preventDefault();
      setActive((a) => Math.min(n - 1, a + 8));
    } else if (e.key === 'PageUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 8));
    } else if (e.key === 'Home' && e.ctrlKey) {
      e.preventDefault();
      setActive(0);
    } else if (e.key === 'End' && e.ctrlKey) {
      e.preventDefault();
      setActive(Math.max(0, n - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      runRow(rows[active]);
    } else if (e.key === 'Tab') {
      e.preventDefault(); // Tab stays on the input
    }
  };

  const noMatch = query.trim() !== '' && rows.length === 1;
  return (
    <div className="modal cmd-modal" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="cmd-sheet" role="dialog" aria-modal="true" aria-label="Command box" onKeyDown={onKey}>
        <div className="cmd-input">
          <Icon name="search" />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={rows[active] ? `${listId}-${active}` : undefined}
            aria-autocomplete="list"
            aria-label="Command"
            placeholder="Type a command or a folder name"
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
          />
          <kbd className="cmd-esc">Esc</kbd>
        </div>
        <ul ref={listRef} id={listId} className="cmd-list scroll" role="listbox" aria-label="Commands">
          {rows.map((r, i) => (
            <li key={r.key} role="presentation">
              {sections.has(i) ? (
                <div className="cmd-sec" role="presentation">
                  {sections.get(i)}
                </div>
              ) : null}
              <div
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                aria-label={r.command?.hint ? `${r.label}, ${r.command.hint}` : r.label}
                className={`cmd-row ${i === active ? 'active' : ''}`}
                onMouseMove={() => i !== active && setActive(i)}
                onClick={() => runRow(r)}
              >
                <Icon name={r.icon} />
                <span className="cmd-l">
                  <Marked text={r.label} positions={r.positions} />
                </span>
                {r.command?.account ? (
                  <AccountBadge color={colorOf(r.command.account.id)} name={r.command.account.displayName} letter={r.command.account.badge} />
                ) : r.command?.hint ? (
                  <span className="cmd-hint">{r.command.hint}</span>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
        {noMatch ? (
          <div className="cmd-none">
            <b>No matching commands</b>
            <span>Try a folder name or a word like &apos;archive&apos;</span>
          </div>
        ) : null}
        <div className="cmd-foot">Up and Down to choose, Enter to run, Esc to close</div>
        <div className="sr-only" role="status">
          {said}
        </div>
      </div>
    </div>
  );
}
