import { useEffect, useRef, useState } from 'react';
import { Icon } from '../../components/Icon';
import { useApp } from '../../store/app';
import { useList } from '../../store/list';
import { useOutbox } from '../../store/outbox';
import { useUi } from '../../store/ui';
import { useUpdates } from '../../store/updates';
import { toast, reportActionError } from '../../store/toasts';
import { call } from '../../lib/api';
import {
  leftModel,
  middleText,
  nextOutboxReveal,
  rightItems,
  tierOf,
  type LeftModel,
  type RightItem,
  type Tier,
} from '../../lib/statusBar';
import { SyncPopover } from './SyncPopover';

/** The bar shows when the data is loaded, there is at least one account and the setting is on. */
export function useStatusBarVisible(): boolean {
  const on = useUi((s) => s.showStatusBar);
  const ready = useApp((s) => s.loaded && !s.loadError && s.accounts.length > 0);
  return on && ready;
}

function useTier(): Tier {
  const [tier, setTier] = useState<Tier>(() => tierOf(window.innerWidth));
  useEffect(() => {
    const on = () => setTier(tierOf(window.innerWidth));
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return tier;
}

/** The current time, refreshed now and then so "checked just now" and the retry time stay true. */
function useNow(ms: number): [number, () => void] {
  const [now, set] = useState(() => Date.now());
  useEffect(() => {
    const h = setInterval(() => set(Date.now()), ms);
    return () => clearInterval(h);
  }, [ms]);
  return [now, () => set(Date.now())];
}

/**
 * One calm text for screen readers (DESIGN-SPEC 4.8): wait 1.5 s and say only the final text, at most
 * once every 5 s, never numbers that change all the time. "Update ready" is said once per version.
 */
function useAnnouncer(parts: string[], ready: { phrase: string; version: string } | null): string {
  const [spoken, setSpoken] = useState('');
  const last = useRef({ key: '', at: 0 });
  const readySpoken = useRef<string | null>(null);
  const latest = useRef({ parts, ready });
  const key = parts.join('. ');
  useEffect(() => {
    latest.current = { parts, ready };
  });
  useEffect(() => {
    if (key === last.current.key) return;
    const delay = Math.max(1500, last.current.at + 5000 - Date.now());
    const h = setTimeout(() => {
      const { parts: p, ready: r } = latest.current;
      const skipReady = r !== null && readySpoken.current === r.version;
      const text = p.filter((x) => !(skipReady && x === r?.phrase)).join('. ');
      if (r && !skipReady && p.includes(r.phrase)) readySpoken.current = r.version;
      last.current = { key: p.join('. '), at: Date.now() };
      setSpoken(text);
    }, delay);
    return () => clearTimeout(h);
  }, [key]);
  return spoken;
}

export function StatusBar() {
  const accounts = useApp((s) => s.accounts);
  const statuses = useApp((s) => s.statuses);
  const authRequired = useApp((s) => s.authRequired);
  const online = useApp((s) => s.online);
  const progress = useApp((s) => s.progress);
  const folders = useApp((s) => s.folders);
  const counts = useApp((s) => s.counts);
  const view = useUi((s) => s.view);
  const page = useUi((s) => s.page);
  const popover = useUi((s) => s.syncPopover === 'bar');
  const listScopeKind = useList((s) => s.scope?.kind ?? null);
  const isSearch = useList((s) => s.search !== null);
  const loading = useList((s) => s.loading);
  const total = useList((s) => s.total);
  const itemCount = useList((s) => s.items.length);
  const grouped = useList((s) => s.grouped);
  const selectedCount = useList((s) => s.selectedIds.length);
  const outbox = useOutbox((s) => s.items);
  const update = useUpdates((s) => s.status);
  const tier = useTier();
  const [busy, setBusy] = useState(false);
  const [now, refreshNow] = useNow(30_000);
  const left = leftModel({ accounts, statuses, authRequired, online, progress, now });
  const middle = middleText({
    page,
    view,
    accounts,
    folders,
    counts,
    outboxCount: outbox.length,
    list: { scopeKind: listScopeKind, isSearch, loading, total, itemCount, selectedCount, grouped },
  });
  const rightAll = rightItems(update, outbox, now);
  const right = tier >= 3 ? rightAll.slice(0, 1) : rightAll;

  // Mail that is still inside the "Undo send" wait appears when the wait ends.
  useEffect(() => {
    const t = Date.now();
    refreshNow();
    const wait = nextOutboxReveal(outbox, t);
    if (wait === null) return;
    const h = setTimeout(refreshNow, wait + 50);
    return () => clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outbox]);

  const restart = () => {
    setBusy(true);
    call('updates.install').catch((e) => {
      setBusy(false);
      reportActionError(e);
    });
  };

  // The one "is ready" toast per version (DESIGN-SPEC 4.8). The bar's Restart link stays after it.
  const readyVersion = update?.state === 'ready' ? update.newVersion : null;
  useEffect(() => {
    if (!readyVersion || useUpdates.getState().toastedVersion === readyVersion) return;
    useUpdates.setState({ toastedVersion: readyVersion });
    toast(`Letterdock ${readyVersion} is ready.`, {
      duration: 8000,
      actionLabel: 'Restart',
      onAction: restart,
      secondaryLabel: 'Later',
    });
  }, [readyVersion]);

  const readyItem = rightAll.find((r) => r.id === 'ready');
  const spoken = useAnnouncer(
    [left.announce, ...rightAll.map((r) => r.announce)],
    readyItem && readyItem.id === 'ready' ? { phrase: readyItem.announce, version: readyItem.version } : null,
  );

  // Close the popover with a click outside or Esc.
  const leftBtn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!popover) return;
    const close = () => useUi.setState((s) => (s.syncPopover === 'bar' ? { syncPopover: null } : s));
    const down = (e: MouseEvent) => {
      const t = e.target as Node;
      if (pop.current?.contains(t) || leftBtn.current?.contains(t)) return;
      close();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        close();
        leftBtn.current?.focus();
      }
    };
    window.addEventListener('mousedown', down);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('mousedown', down);
      window.removeEventListener('keydown', key);
    };
  }, [popover]);

  const onLeft = () => {
    if (left.reauthAccountId) useUi.getState().set({ addAccount: { reauthAccountId: left.reauthAccountId } });
    else useUi.setState({ syncPopover: popover ? null : 'bar' });
  };

  const short = tier === 4;
  const fullLeft = [left.text, left.progress, left.checked && `· ${left.checked}`].filter(Boolean).join(' ');
  const showExtras = tier === 0;

  return (
    <div className="statusbar" role="region" aria-label="Status">
      <div className="sb-left">
        <button
          type="button"
          ref={leftBtn}
          className={`sb-btn ${left.tone === 'normal' ? '' : 'sb-' + left.tone}`}
          title={fullLeft}
          aria-label={fullLeft}
          aria-haspopup={left.reauthAccountId ? undefined : 'dialog'}
          aria-expanded={left.reauthAccountId ? undefined : popover}
          onClick={onLeft}
        >
          <LeftGlyph kind={left.kind} />
          <span className="sb-tx">
            {short ? left.short : left.text}
            {showExtras && left.progress ? <span className="sb-q"> {left.progress}</span> : null}
            {showExtras && left.checked ? <span className="sb-q"> · {left.checked}</span> : null}
          </span>
        </button>
      </div>
      {tier < 2 ? (
        <div className="sb-mid" title={middle || undefined}>
          {middle}
        </div>
      ) : (
        <div className="sb-fill" />
      )}
      {right.length > 0 ? (
        <div className="sb-right">
          {right.map((r, i) => (
            <RightView
              key={r.id}
              item={r}
              tier={tier}
              busy={busy}
              onRestart={restart}
              divider={i > 0}
            />
          ))}
        </div>
      ) : null}
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {spoken}
      </div>
      {popover ? <SyncPopover ref={pop} placement="above" /> : null}
    </div>
  );
}

function LeftGlyph({ kind }: { kind: LeftModel['kind'] }) {
  switch (kind) {
    case 'syncing':
      return <i className="spin sb-gl" aria-hidden="true" />;
    case 'error':
      return (
        <span className="sb-gl warnT" aria-hidden="true">
          <Icon name="warn" />
        </span>
      );
    case 'auth':
      return (
        <span className="sb-gl dgl" aria-hidden="true">
          !
        </span>
      );
    case 'offline':
      return (
        <span className="sb-gl sb-mute" aria-hidden="true">
          <Icon name="cloud-off" />
        </span>
      );
    case 'pending':
      return (
        <span className="sb-gl sb-mute" aria-hidden="true">
          <Icon name="pending" />
        </span>
      );
    default:
      return null;
  }
}

function RightView({
  item,
  tier,
  busy,
  onRestart,
  divider,
}: {
  item: RightItem;
  tier: Tier;
  busy: boolean;
  onRestart: () => void;
  divider: boolean;
}) {
  const glyphOnly = tier === 4;
  const div = divider ? <span className="sb-div" aria-hidden="true" /> : null;

  if (item.id === 'ready') {
    if (glyphOnly)
      return (
        <>
          {div}
          <button
            type="button"
            className="sb-btn sb-icon sb-link"
            title={`${item.text}. Restart`}
            aria-label={`${item.text}. Restart`}
            disabled={busy}
            onClick={onRestart}
          >
            <Icon name="download" />
          </button>
        </>
      );
    return (
      <>
        {div}
        <span className="sb-item" title={item.tip}>
          {item.text}
        </span>
        <button type="button" className="sb-btn sb-link" disabled={busy} onClick={onRestart} title={item.tip}>
          Restart
        </button>
      </>
    );
  }

  if (item.id === 'downloading') {
    if (glyphOnly)
      return (
        <>
          {div}
          <span className="sb-icon sb-mute" role="img" title={item.text} aria-label={item.text}>
            <Icon name="download" />
          </span>
        </>
      );
    return (
      <>
        {div}
        <span className="sb-item" title={item.tip}>
          {item.text}
          {tier === 0 ? (
            <span
              className="sb-prog"
              role="progressbar"
              aria-label="Update download"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={item.percent}
              aria-live="off"
            >
              <i style={{ width: `${item.percent}%` }} />
            </span>
          ) : null}
        </span>
      </>
    );
  }

  const glyph =
    item.state === 'sending' ? (
      <i className="spin sb-gl" aria-hidden="true" />
    ) : item.state === 'failed' ? (
      <span className="sb-gl sb-bad" aria-hidden="true">
        <Icon name="warn" />
      </span>
    ) : (
      <span className="sb-gl sb-mute" aria-hidden="true">
        <Icon name="pending" />
      </span>
    );
  return (
    <>
      {div}
      <button
        type="button"
        className={`sb-btn ${item.state === 'failed' ? 'sb-danger' : ''} ${glyphOnly ? 'sb-icon' : ''}`}
        title={item.text}
        aria-label={item.text}
        onClick={() => useUi.getState().setView({ kind: 'outbox' })}
      >
        {glyph}
        {glyphOnly ? null : <span className="sb-tx">{item.text}</span>}
      </button>
    </>
  );
}
