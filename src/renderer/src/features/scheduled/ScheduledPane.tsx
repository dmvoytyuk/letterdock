import { useEffect, useMemo, useRef, useState, type KeyboardEvent as RKE } from 'react';
import type { Account, Address, MessageBody, ScheduledDetail, ScheduledItem } from '../../../../shared/ipc';
import { Icon } from '../../components/Icon';
import { AccountBadge, Banner, Button, Dialog, EmptyState, IconButton, Skeleton, useMenu, type MenuEntry } from '../../components/ui';
import { useApp } from '../../store/app';
import { useScheduled } from '../../store/scheduled';
import { useUi } from '../../store/ui';
import { useAccountColor, useAccountMap } from '../../lib/hooks';
import { asAppError, call } from '../../lib/api';
import { addressList, fileKind, fileSize, initials } from '../../lib/format';
import { agoText, relText, rowWhenText, scheduledGroup, whenText } from '../../lib/schedule';
import {
  askDeleteScheduled,
  cancelScheduled,
  changeTimeScheduled,
  deleteScheduled,
  editScheduled,
  rescheduleTo,
  sendNowScheduled,
} from '../../lib/scheduledActions';
import { SidebarToggle } from '../sidebar/SidebarToggle';
import { BodyPanel } from '../reading/ReadingPane';
import { SchedulePickerDialog } from './SchedulePickerDialog';

/** The current time, refreshed now and then so "in 14 hours" stays true. */
function useNow(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const h = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(h);
  }, [ms]);
  return now;
}

function toLine(to: Address[]): string {
  if (to.length === 0) return 'To: (no recipient)';
  const first = to[0]!.name?.trim() || to[0]!.address;
  return `To: ${first}${to.length > 1 ? ` +${to.length - 1}` : ''}`;
}

/** What replaces the send time on a row when something needs attention. */
function statusOf(it: ScheduledItem): { text: string; tone: 'busy' | 'warn' | 'bad' | 'mute'; icon?: 'cloud-off' } | null {
  if (it.status === 'sending') return { text: 'Sending...', tone: 'busy' };
  if (it.status === 'failed') return { text: "Couldn't send", tone: 'bad' };
  if (it.status === 'held') return { text: `Due ${agoText(it.overdueMs)}`, tone: 'warn' };
  if (it.waiting === 'signIn') return { text: 'Sign in to send', tone: 'bad' };
  if (it.waiting === 'offline') return { text: 'Waiting for connection', tone: 'mute', icon: 'cloud-off' };
  return null;
}

function rowMenu(it: ScheduledItem): MenuEntry[] {
  const busy = it.status === 'sending';
  return [
    { label: 'Send now', icon: 'send', disabled: busy, onSelect: () => void sendNowScheduled(it) },
    { label: 'Edit', icon: 'pencil', disabled: busy, onSelect: () => void editScheduled(it) },
    { label: 'Change time...', icon: 'clock', disabled: busy, onSelect: () => changeTimeScheduled(it) },
    { label: 'Cancel send', icon: 'x', disabled: busy, onSelect: () => void cancelScheduled(it) },
    'sep',
    { label: 'Delete', icon: 'trash', danger: true, disabled: busy, onSelect: () => askDeleteScheduled(it) },
  ];
}

// ---------- list ----------
export function ScheduledList() {
  const view = useUi((s) => s.view);
  const mode = useUi((s) => s.mode);
  const density = useUi((s) => s.density);
  const accounts = useApp((s) => s.accounts);
  const items = useScheduled((s) => s.items);
  const loaded = useScheduled((s) => s.loaded);
  const selectedId = useScheduled((s) => s.selectedId);
  const accountMap = useAccountMap();
  const colorOf = useAccountColor();
  const now = useNow();
  const scroller = useRef<HTMLDivElement>(null);
  const accountId = view.kind === 'scheduled' ? view.accountId : null;

  useEffect(() => {
    void useScheduled.getState().refetch();
  }, []);

  const shown = useMemo(() => items.filter((i) => accountId === null || i.accountId === accountId), [items, accountId]);
  const title =
    accountId === null ? 'Scheduled · all accounts' : `${accountMap.get(accountId)?.displayName ?? 'Account'} / Scheduled`;
  // In the all-accounts view the account badge is always shown (DESIGN-SPEC 3.11.4).
  const showBadge = accountId === null && accounts.length > 1;

  const flat = useMemo(() => {
    const out: ({ type: 'head'; label: string } | { type: 'row'; item: ScheduledItem })[] = [];
    let last = '';
    for (const it of shown) {
      const g = scheduledGroup(it.sendAt, now);
      if (g !== last) {
        out.push({ type: 'head', label: g });
        last = g;
      }
      out.push({ type: 'row', item: it });
    }
    return out;
  }, [shown, now]);

  const select = (id: number | null) => {
    useScheduled.getState().select(id);
    if (id !== null) useUi.setState({ readerOpen: true });
  };
  const move = (delta: number | 'first' | 'last') => {
    if (shown.length === 0) return;
    const cur = shown.findIndex((x) => x.id === selectedId);
    const next = delta === 'first' ? 0 : delta === 'last' ? shown.length - 1 : Math.max(0, Math.min(shown.length - 1, (cur < 0 ? (delta > 0 ? 0 : shown.length - 1) : cur + delta)));
    const id = shown[next]!.id;
    useScheduled.getState().select(id);
    scroller.current?.querySelector<HTMLElement>(`#sch-${id}`)?.scrollIntoView({ block: 'nearest' });
  };
  const onKeyDown = (e: RKE<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const cur = shown.find((x) => x.id === selectedId);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      move(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      move(-1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      move('first');
    } else if (e.key === 'End') {
      e.preventDefault();
      move('last');
    } else if (e.key === 'Delete' && cur) {
      e.preventDefault();
      askDeleteScheduled(cur);
    } else if (e.key === 'Enter' && cur) {
      e.preventDefault();
      useUi.setState({ readerOpen: true });
    } else if ((e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) && cur) {
      e.preventDefault();
      const el = scroller.current?.querySelector<HTMLElement>(`#sch-${cur.id}`);
      const r = el?.getBoundingClientRect();
      useMenu.getState().open(r ? r.left + 40 : 100, r ? r.top + 30 : 100, rowMenu(cur));
    }
  };

  return (
    <section className="list fill" aria-label="Scheduled messages" id="pane-list">
      <div className="lhead">
        {mode === 'narrow' ? <SidebarToggle className="lhead-toggle" /> : null}
        <h2>{title}</h2>
      </div>
      {!loaded ? (
        <div aria-busy="true" aria-label="Loading scheduled messages">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="skel-row" style={{ height: 68 }}>
              <Skeleton w="45%" h={12} />
              <Skeleton w="80%" h={12} />
              <Skeleton w="95%" h={10} />
            </div>
          ))}
        </div>
      ) : shown.length === 0 ? (
        <EmptyState icon="clock" title="No scheduled messages" text="Messages you schedule with Send later appear here." />
      ) : (
        <div
          ref={scroller}
          className="msg-scroll scroll"
          role="listbox"
          aria-label="Scheduled messages"
          aria-activedescendant={selectedId !== null ? `sch-${selectedId}` : undefined}
          tabIndex={0}
          onKeyDown={onKeyDown}
          onFocus={() => {
            if (selectedId === null && shown.length > 0) useScheduled.getState().select(shown[0]!.id);
          }}
        >
          {flat.map((f) =>
            f.type === 'head' ? (
              <div key={`h-${f.label}`} className="ghead static" role="presentation">
                {f.label}
              </div>
            ) : (
              <ScheduledRow
                key={f.item.id}
                item={f.item}
                now={now}
                density={density}
                selected={selectedId === f.item.id}
                account={accountMap.get(f.item.accountId)}
                color={colorOf(f.item.accountId)}
                showBadge={showBadge}
                onSelect={() => {
                  select(f.item.id);
                  scroller.current?.focus({ preventScroll: true });
                }}
              />
            ),
          )}
        </div>
      )}
    </section>
  );
}

function ScheduledRow({
  item: it,
  now,
  density,
  selected,
  account,
  color,
  showBadge,
  onSelect,
}: {
  item: ScheduledItem;
  now: number;
  density: 'compact' | 'comfortable' | 'roomy';
  selected: boolean;
  account: Account | undefined;
  color: string;
  showBadge: boolean;
  onSelect: () => void;
}) {
  const st = statusOf(it);
  const who = toLine(it.to);
  const when = rowWhenText(it.sendAt, now);
  const busy = it.status === 'sending';
  const aria = `${who}, ${it.subject || '(no subject)'}, ${st ? st.text : `scheduled for ${whenText(it.sendAt, now)}`}${it.hasAttachments ? ', has attachment' : ''}${account ? `, account ${account.displayName}` : ''}. ${it.snippet}`;
  return (
    <div
      id={`sch-${it.id}`}
      role="option"
      aria-selected={selected}
      aria-label={aria}
      className={`row d-${density} ${selected ? 'sel' : ''} sch ${st ? `sch-${st.tone}` : ''}`}
      onClick={onSelect}
      onContextMenu={(e) => {
        e.preventDefault();
        useScheduled.getState().select(it.id);
        useMenu.getState().open(e.clientX, e.clientY, rowMenu(it));
      }}
    >
      <div className="l1">
        <span className="snd" title={addressList(it.to)}>{who}</span>
        <span className="ico">{it.hasAttachments ? <Icon name="clip" /> : null}</span>
        <span className={`tm schwhen ${st ? st.tone : ''}`} title={`${whenText(it.sendAt, now)} (${relText(it.sendAt, now)})`}>
          {st ? (
            <>
              {st.tone === 'busy' ? <i className="spin" aria-hidden="true" /> : st.icon ? <Icon name={st.icon} /> : null}
              {st.text}
            </>
          ) : (
            <>
              <Icon name="clock" />
              {when}
            </>
          )}
        </span>
      </div>
      <div className="sub2">
        <span className="t">{it.subject || '(no subject)'}</span>
        {density === 'compact' && showBadge && account ? <AccountBadge color={color} name={account.displayName} letter={account.badge} /> : null}
      </div>
      {density !== 'compact' ? (
        <div className="snp">
          <span className="t">{it.snippet}</span>
          {showBadge && account ? <AccountBadge color={color} name={account.displayName} letter={account.badge} /> : null}
        </div>
      ) : null}
      {!busy ? (
        <div className="hov" role="group" aria-label={`Actions for ${it.subject || 'this message'}`}>
          <IconButton icon="send" label="Send now" size="sm" tabIndex={-1} onClick={(e) => { e.stopPropagation(); void sendNowScheduled(it); }} />
          <IconButton icon="pencil" label="Edit" size="sm" tabIndex={-1} onClick={(e) => { e.stopPropagation(); void editScheduled(it); }} />
          <IconButton icon="x" label="Cancel send" size="sm" tabIndex={-1} onClick={(e) => { e.stopPropagation(); void cancelScheduled(it); }} />
        </div>
      ) : null}
    </div>
  );
}

// ---------- reading pane ----------
export function ScheduledReader() {
  const selectedId = useScheduled((s) => s.selectedId);
  const item = useScheduled((s) => s.items.find((x) => x.id === selectedId));
  const mode = useUi((s) => s.mode);
  const readerOpen = useUi((s) => s.readerOpen);
  return (
    <main className="reading" aria-label="Scheduled message" id="pane-reading" style={{ containerType: 'inline-size' }}>
      {mode === 'narrow' && readerOpen ? (
        <div style={{ padding: '4px 8px', borderBottom: '1px solid var(--border)' }}>
          <button type="button" className="tbtn" onClick={() => useUi.setState({ readerOpen: false })}>
            <Icon name="back" size={20} /> Back
          </button>
        </div>
      ) : null}
      {item ? (
        <ScheduledMessage key={item.id} item={item} />
      ) : (
        <div className="empty" style={{ height: '100%' }}>
          <Icon name="clock" size={48} />
          <h3>Select a message to read it</h3>
          <p>Scheduled messages are sent from this PC at the time you chose.</p>
        </div>
      )}
    </main>
  );
}

function ScheduledMessage({ item }: { item: ScheduledItem }) {
  const [detail, setDetail] = useState<ScheduledDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const account = useApp((s) => s.accounts.find((a) => a.id === item.accountId));
  const now = useNow(30_000);
  useEffect(() => {
    let alive = true;
    call('scheduled.get', { id: item.id })
      .then((d) => alive && setDetail(d))
      .catch((e) => alive && setError(asAppError(e).message));
    return () => {
      alive = false;
    };
  }, [item.id]);

  const body = useMemo<MessageBody | null>(
    () =>
      detail
        ? {
            id: 0,
            header: {} as MessageBody['header'],
            bcc: detail.bcc,
            replyTo: [],
            inReplyTo: null,
            references: null,
            html: detail.html,
            text: null,
            attachments: [],
            hasRemoteImages: false,
            senderImagesAllowed: false,
            truncated: false,
          }
        : null,
    [detail],
  );

  return (
    <div className="rbody">
      <div className="rin centered">
        <ScheduledBanner item={item} now={now} />
        <div className="rsub">{item.subject || '(no subject)'}</div>
        <div className="rhead">
          <div className="av" aria-hidden="true">{initials(account?.displayName ?? '?')}</div>
          <div className="who">
            <dl className="rdetails always">
              <dt>From</dt>
              <dd>{account ? `${account.displayName} <${account.email}>` : 'Unknown'}</dd>
              <dt>To</dt>
              <dd>{addressList(item.to) || '-'}</dd>
              {item.cc.length ? (<><dt>Cc</dt><dd>{addressList(item.cc)}</dd></>) : null}
              {detail && detail.bcc.length ? (<><dt>Bcc</dt><dd>{addressList(detail.bcc)}</dd></>) : null}
            </dl>
          </div>
        </div>
        {error ? (
          <div style={{ marginTop: 16 }}>
            <Banner tone="danger">Couldn&apos;t open this message. {error}</Banner>
          </div>
        ) : !body ? (
          <div className="mbody-skel" aria-busy="true" aria-label="Loading message">
            {[90, 100, 80, 95, 60].map((w, i) => (
              <Skeleton key={i} w={`${w}%`} h={12} />
            ))}
          </div>
        ) : (
          <BodyPanel
            body={body}
            senderAddress={null}
            trackerNote={false}
            attachments={
              detail && detail.attachments.length > 0 ? (
                <div className="atts">
                  <h4>ATTACHMENTS ({detail.attachments.length})</h4>
                  <div className="achips">
                    {detail.attachments.map((a, i) => {
                      const kind = fileKind(a.filename, a.contentType);
                      return (
                        <div className="achip" key={i}>
                          <span className={`ft ${kind.cls}`}>{kind.label}</span>
                          <span className="tx">
                            <div className="n" title={a.filename}>{a.filename}</div>
                            <div className="z">{fileSize(a.size)}</div>
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : null
            }
          />
        )}
      </div>
    </div>
  );
}

/** The banner above a scheduled message with its buttons (DESIGN-SPEC 3.11.4, 3.11.5). */
function ScheduledBanner({ item, now }: { item: ScheduledItem; now: number }) {
  const busy = item.status === 'sending';
  const held = item.status === 'held';
  const failed = item.status === 'failed';
  const account = useApp((s) => s.accounts.find((a) => a.id === item.accountId));
  let head: string;
  let sub: string | null = 'Letterdock has to be running then. It can stay in the tray.';
  if (busy) {
    head = 'Sending now...';
    sub = null;
  } else if (held) {
    head = `This message was due ${agoText(item.overdueMs)}. Send it now or change the time.`;
    sub = null;
  } else if (failed) {
    head = "Letterdock couldn't hand this message over to be sent.";
    sub = item.lastError;
  } else {
    head = `Scheduled for ${whenText(item.sendAt, now)} (${relText(item.sendAt, now)}).`;
  }
  return (
    <div className={`schbanner ${held ? 'warn' : failed ? 'bad' : ''}`} role="group" aria-label="Scheduled message">
      <span className="ic">
        <Icon name={held || failed ? 'warn' : 'clock'} size={20} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="schhead">{head}</div>
        {sub ? <div className="schsub">{sub}</div> : null}
        {item.waiting === 'signIn' && !busy ? (
          <div className="schsub bad">
            Sign in to send.{' '}
            <button type="button" className="link" onClick={() => useUi.getState().set({ addAccount: { reauthAccountId: item.accountId } })}>
              Sign in again
            </button>
          </div>
        ) : item.waiting === 'offline' && !busy ? (
          <div className="schsub">Waiting for connection. It is sent when you are back online.</div>
        ) : null}
        {account && useApp.getState().accounts.length > 1 ? <div className="schsub">From {account.displayName}</div> : null}
        <div className="acts">
          <Button size="sm" variant="primary" disabled={busy} onClick={() => void sendNowScheduled(item)}>
            Send now
          </Button>
          <Button size="sm" disabled={busy} onClick={() => changeTimeScheduled(item)}>
            Change time...
          </Button>
          {!held ? (
            <Button size="sm" disabled={busy} onClick={() => void editScheduled(item)}>
              Edit
            </Button>
          ) : null}
          <Button size="sm" variant="subtle" disabled={busy} onClick={() => void cancelScheduled(item)}>
            Cancel send
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------- dialogs (hosted once in the app) ----------
export function ScheduledDialogsHost() {
  const pick = useScheduled((s) => s.pick);
  const del = useScheduled((s) => s.confirmDelete);
  return (
    <>
      {pick ? (
        <SchedulePickerDialog
          mode="change"
          initial={pick.sendAt}
          onClose={() => useScheduled.setState({ pick: null })}
          onConfirm={async (at) => {
            useScheduled.setState({ pick: null });
            await rescheduleTo(pick, at);
          }}
        />
      ) : null}
      {del ? (
        <Dialog title="Delete this scheduled message?" size="sm" onClose={() => useScheduled.setState({ confirmDelete: null })} initialFocus=".foot .btn:not(.danger)">
          <p>It will not be sent.</p>
          <div className="foot">
            <Button onClick={() => useScheduled.setState({ confirmDelete: null })}>Cancel</Button>
            <Button
              variant="danger"
              onClick={() => {
                useScheduled.setState({ confirmDelete: null });
                void deleteScheduled(del);
              }}
            >
              Delete
            </Button>
          </div>
        </Dialog>
      ) : null}
    </>
  );
}

