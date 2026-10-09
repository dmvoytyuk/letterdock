import { Icon } from '../../components/Icon';
import { Button, EmptyState } from '../../components/ui';
import { useApp } from '../../store/app';
import { useList } from '../../store/list';
import { useUi } from '../../store/ui';
import { useAccountColor } from '../../lib/hooks';
import { asAppError } from '../../lib/api';
import { toast, toastError } from '../../store/toasts';

export async function runServerSearch(): Promise<void> {
  try {
    await useList.getState().searchOnServer();
    const added = useList.getState().search?.serverAdded ?? 0;
    toast(added > 0 ? `The server found ${added} more ${added === 1 ? 'message' : 'messages'}.` : 'The server had nothing more.');
  } catch (e) {
    toastError(`Search on the server failed. ${asAppError(e).message}`);
  }
}

/** Header of the results view: title, count, sort, Clear, and the "search in" account chips. */
export function SearchHeader({ count }: { count: number }) {
  const search = useList((s) => s.search);
  const sort = useList((s) => s.searchSort);
  const accounts = useApp((s) => s.accounts);
  const colorOf = useAccountColor();
  if (!search) return null;
  const setAccount = (accountId: string | null) =>
    useUi.getState().startSearch(search.query, accountId);
  return (
    <>
      <div className="lhead">
        <h2 title={`Results for "${search.query}"`}>Search results</h2>
        <span className="cnt-note" role="status">
          {count} {count === 1 ? 'result' : 'results'}
        </span>
        <select
          className="tbtn sortsel"
          aria-label="Sort results"
          value={sort}
          onChange={(e) => useList.getState().setSearchSort(e.target.value as 'rank' | 'date')}
        >
          <option value="rank">Best match</option>
          <option value="date">Newest first</option>
        </select>
        <Button size="sm" variant="subtle" onClick={() => useUi.getState().exitSearch()}>
          Clear
        </Button>
      </div>
      {accounts.length > 1 ? (
        <div className="schips" role="group" aria-label="Search in">
          <span className="hint">Search in:</span>
          <button
            type="button"
            className={`schip ${search.accountId === null ? 'on' : ''}`}
            aria-pressed={search.accountId === null}
            onClick={() => setAccount(null)}
          >
            All accounts
          </button>
          {accounts.map((a) => (
            <button
              key={a.id}
              type="button"
              className={`schip ${search.accountId === a.id ? 'on' : ''}`}
              aria-pressed={search.accountId === a.id}
              onClick={() => setAccount(a.id)}
              title={a.email}
            >
              <i className="dot" style={{ ['--ac' as string]: colorOf(a.id) }} />
              {a.displayName || a.email}
            </button>
          ))}
        </div>
      ) : null}
      {search.parsedFilters.length > 0 ? (
        <div className="schips" aria-label="Filters in your search">
          <span className="hint">Filters:</span>
          {search.parsedFilters.map((f) => (
            <span key={f} className="schip static">
              {f}
            </span>
          ))}
        </div>
      ) : null}
    </>
  );
}

/** Note under the header: results come from this PC; the server may have more. */
export function SearchNotes() {
  const search = useList((s) => s.search);
  const busy = useList((s) => s.serverSearching);
  const loading = useList((s) => s.loading);
  if (!search || loading) return null;
  const partial = search.coverage.messagesIndexed > search.coverage.bodiesIndexed;
  return (
    <div className="search-note" role="status">
      <Icon name="info" />
      <span>
        {search.serverAdded !== null
          ? 'Included results from the server.'
          : partial
            ? 'Searched mail on this PC. Some message text is not ready to search yet.'
            : 'Searched mail on this PC.'}
      </span>
      {search.serverAdded === null ? (
        <Button size="sm" variant="subtle" loading={busy} onClick={() => void runServerSearch()}>
          Search on server
        </Button>
      ) : null}
    </div>
  );
}

export function SearchEmpty() {
  const search = useList((s) => s.search);
  const busy = useList((s) => s.serverSearching);
  if (!search) return null;
  return (
    <EmptyState
      icon="search"
      title={`No messages match "${search.query}"`}
      text="Try fewer words, or check the spelling."
      action={
        search.serverAdded === null ? (
          <Button loading={busy} onClick={() => void runServerSearch()}>
            Search on server too
          </Button>
        ) : (
          <Button onClick={() => useUi.getState().exitSearch()}>Clear search</Button>
        )
      }
    />
  );
}
