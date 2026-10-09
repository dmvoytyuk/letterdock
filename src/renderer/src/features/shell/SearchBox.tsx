import { useRef, useState, type RefObject } from 'react';
import { Icon } from '../../components/Icon';
import { IconButton } from '../../components/ui';
import { useApp } from '../../store/app';
import { useUi } from '../../store/ui';
import { useAccountColor } from '../../lib/hooks';
import { SEARCH_OPERATORS } from '../../lib/search';

const QUICK: { label: string; text: string }[] = [
  { label: 'Unread', text: 'is:unread' },
  { label: 'Flagged', text: 'is:flagged' },
  { label: 'Has attachment', text: 'has:attachment' },
];

/** The title-bar search box with its dropdown (DESIGN-SPEC 3.8). */
export function SearchBox({
  inputRef,
  tiny,
  onDismiss,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  tiny: boolean;
  onDismiss: () => void;
}) {
  const view = useUi((s) => s.view);
  const recent = useUi((s) => s.recentSearches);
  const accounts = useApp((s) => s.accounts);
  const colorOf = useAccountColor();
  const [text, setText] = useState('');
  const [accountId, setAccountId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [help, setHelp] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  // Keep the box in step when a search starts somewhere else (for example "search this sender").
  const activeQuery = view.kind === 'search' ? view.query : null;
  const activeAccount = view.kind === 'search' ? view.accountId : null;
  const [seen, setSeen] = useState(activeQuery);
  if (seen !== activeQuery) {
    setSeen(activeQuery);
    setText(activeQuery ?? '');
    if (activeQuery !== null) setAccountId(activeAccount);
  }

  const run = (q: string, acc: string | null = accountId) => {
    const t = q.trim();
    if (!t) return;
    setText(t);
    useUi.getState().startSearch(t, acc);
    setOpen(false);
    setHelp(false);
    inputRef.current?.blur();
  };

  const clear = () => {
    setText('');
    if (useUi.getState().view.kind === 'search') useUi.getState().exitSearch();
  };

  const add = (extra: string) => {
    const t = text.trim();
    const next = t ? `${t} ${extra}` : extra;
    setText(next);
    inputRef.current?.focus();
  };

  const accountName = accounts.find((a) => a.id === accountId)?.displayName;

  return (
    <div
      className="search"
      role="search"
      ref={wrap}
      style={tiny ? { left: 48, right: 142, width: 'auto', minWidth: 0, transform: 'none' } : undefined}
    >
      <div className="box">
        <Icon name="search" />
        <input
          ref={inputRef}
          placeholder="Search all accounts"
          aria-label="Search all accounts"
          aria-expanded={open}
          aria-controls="search-drop"
          autoComplete="off"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onFocus={() => setOpen(true)}
          onBlur={(e) => {
            // Clicking inside the dropdown keeps it open.
            if (wrap.current?.contains(e.relatedTarget as Node | null)) return;
            setOpen(false);
            setHelp(false);
            if (tiny) onDismiss();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              run(text);
            } else if (e.key === 'Escape') {
              e.stopPropagation();
              e.preventDefault();
              setText('');
              setOpen(false);
              if (useUi.getState().view.kind === 'search') useUi.getState().exitSearch();
              inputRef.current?.blur();
            }
          }}
        />
        {text ? (
          <IconButton icon="x" label="Clear search" size="xs" onClick={clear} />
        ) : null}
      </div>
      {open ? (
        <div
          className="sdrop"
          id="search-drop"
          role="region"
          aria-label="Search options"
          onMouseDown={(e) => {
            if (!(e.target instanceof HTMLInputElement)) e.preventDefault();
          }}
        >
          {accounts.length > 1 ? (
            <div className="sd-row">
              <span className="sd-lbl">Search in</span>
              <div className="schips">
                <button
                  type="button"
                  className={`schip ${accountId === null ? 'on' : ''}`}
                  aria-pressed={accountId === null}
                  onClick={() => setAccountId(null)}
                >
                  All accounts
                </button>
                {accounts.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    className={`schip ${accountId === a.id ? 'on' : ''}`}
                    aria-pressed={accountId === a.id}
                    onClick={() => setAccountId(a.id)}
                    title={a.email}
                  >
                    <i className="dot" style={{ ['--ac' as string]: colorOf(a.id) }} />
                    {a.displayName}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          <div className="sd-row">
            <span className="sd-lbl">Filters</span>
            <div className="schips">
              {QUICK.map((q) => (
                <button key={q.text} type="button" className="schip" onClick={() => add(q.text)}>
                  {q.label}
                </button>
              ))}
              <button type="button" className="schip" onClick={() => add('from:')}>
                From...
              </button>
              <button type="button" className="schip" onClick={() => add('after:')}>
                Date...
              </button>
              <button
                type="button"
                className="schip help"
                aria-expanded={help}
                aria-label="Search tips"
                title="Search tips"
                onClick={() => setHelp((h) => !h)}
              >
                ?
              </button>
            </div>
          </div>
          {help ? (
            <dl className="sd-help">
              {SEARCH_OPERATORS.map((o) => (
                <div key={o.op}>
                  <dt>
                    <button type="button" className="link plain" onClick={() => add(o.example)}>
                      {o.example}
                    </button>
                  </dt>
                  <dd>{o.help}</dd>
                </div>
              ))}
              <div>
                <dt>&ldquo;exact words&rdquo;</dt>
                <dd>Put words in quotes to find them together</dd>
              </div>
            </dl>
          ) : null}
          {recent.length > 0 && !text ? (
            <div className="sd-recent">
              <div className="sd-lbl">Recent searches</div>
              {recent.map((r) => (
                <button key={r} type="button" className="sd-item" onClick={() => run(r)}>
                  <Icon name="search" />
                  <span>{r}</span>
                </button>
              ))}
              <button
                type="button"
                className="link plain"
                onClick={() => useUi.setState({ recentSearches: [] })}
              >
                Clear recent searches
              </button>
            </div>
          ) : null}
          {text.trim() ? (
            <button type="button" className="sd-item go" onClick={() => run(text)}>
              <Icon name="search" />
              <span>
                Search for <b>{text.trim()}</b>
                {accountName ? ` in ${accountName}` : ' in all accounts'}
              </span>
              <span className="kbd">Enter</span>
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
