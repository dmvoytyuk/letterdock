import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as RKE } from 'react';
import type { AppError, ConversationMessage, GetConversationRes, ListScope, MessageHeader } from '../../../../shared/ipc';
import { Icon } from '../../components/Icon';
import { AccountBadge, Banner, Button, IconButton, Skeleton, openMenuAt, type MenuEntry } from '../../components/ui';
import { useApp } from '../../store/app';
import { useList, type ListItem } from '../../store/list';
import { useUi } from '../../store/ui';
import { touches, useConvSignal } from '../../store/conversations';
import { useAccountColor } from '../../lib/hooks';
import { applyToMessages, applyToRealMessages, deleteMessages, editDraft, noteThreadRead, openCompose, openInWindow } from '../../lib/actions';
import { printMessage } from '../../lib/print';
import { asAppError, call } from '../../lib/api';
import { addressList, fullDate, initials, senderName } from '../../lib/format';
import { toastError } from '../../store/toasts';
import { CardBody, MessageView, SourceDialog } from './ReadingPane';

/** At most this many cards open by themselves when a conversation is opened (DESIGN-SPEC 3.10.4). */
const MAX_AUTO_OPEN = 8;

type Load =
  | { status: 'loading' }
  | { status: 'error'; error: AppError }
  | { status: 'gone' }
  | { status: 'ready'; data: GetConversationRes };

/** The cards that start open: the newest message and every unread one (the newest 8 of those). */
export function initialOpen(messages: ConversationMessage[]): Set<number> {
  const real = messages.filter((m) => !m.isDraft);
  const latest = real[real.length - 1];
  const wanted = real.filter((m) => m === latest || !m.header.seen);
  return new Set(wanted.slice(-MAX_AUTO_OPEN).map((m) => m.header.id));
}

const CHIP_NAMES: Record<string, string> = { inbox: 'Inbox', sent: 'Sent', archive: 'Archive', all: 'Archive', drafts: 'Draft', junk: 'Spam', trash: 'Trash' };
export function chipLabel(m: ConversationMessage): string {
  return (m.folderRole && CHIP_NAMES[m.folderRole]) || m.folderName;
}

/** "Mon 5 Oct", or the time for today. */
function cardDate(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) });
}

/**
 * The reading pane for a conversation of 2 or more messages (DESIGN-SPEC 3.10.4): the title once, then
 * the messages as cards, oldest first. The newest and the unread ones are open; the rest are one line.
 */
export function ConversationView({
  threadId,
  accountId,
  scope,
  itemId,
  onBack,
}: {
  threadId: string;
  accountId: string;
  scope?: ListScope | undefined;
  /** The list row of this conversation (toolbar actions use it). Absent when opened from a search result. */
  itemId?: number | null;
  onBack?: (() => void) | undefined;
}) {
  const epoch = useApp((s) => s.epoch);
  const accounts = useApp((s) => s.accounts);
  const colorOf = useAccountColor();
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [focusedId, setFocusedId] = useState<number | null>(null);
  const [announce, setAnnounce] = useState('');
  const [newIds, setNewIds] = useState<number[]>([]);
  const [source, setSource] = useState<number | null>(null);
  const [attempt, setAttempt] = useState(0);
  const known = useRef<Set<number> | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const didScroll = useRef(false);
  const [reload, setReload] = useState(0);
  const scopeKey = JSON.stringify(scope ?? null);

  // Messages or conversations changed somewhere: load again (quietly) when this one is meant.
  useEffect(
    () =>
      useConvSignal.subscribe((sig) => {
        if (touches(sig.threadIds, threadId)) setReload((n) => n + 1);
      }),
    [threadId],
  );

  // Load now; load again (quietly) when something changed.
  useEffect(() => {
    let alive = true;
    const run = () => {
      call('conversations.get', { threadId, accountId, ...(scope ? { scope } : {}) })
        .then((data) => {
          if (!alive) return;
          const ids = data.messages.map((m) => m.header.id);
          if (known.current === null) {
            known.current = new Set(ids);
            setOpen(initialOpen(data.messages));
          } else {
            const fresh = data.messages.filter((m) => !known.current!.has(m.header.id));
            if (fresh.length > 0) {
              fresh.forEach((m) => known.current!.add(m.header.id));
              setOpen((o) => {
                const next = new Set(o);
                fresh.filter((m) => !m.isDraft && !m.header.seen).forEach((m) => next.add(m.header.id));
                return next;
              });
              const real = fresh.filter((m) => !m.isDraft);
              if (real.length > 0) {
                setNewIds(real.map((m) => m.header.id));
                setAnnounce(`${real.length} new ${real.length === 1 ? 'message' : 'messages'} in this conversation`);
              }
            }
          }
          setLoad({ status: 'ready', data });
        })
        .catch((e) => {
          if (!alive) return;
          const err = asAppError(e);
          setLoad(err.code === 'NOT_FOUND' ? { status: 'gone' } : { status: 'error', error: err });
        });
    };
    const h = setTimeout(run, reload === 0 ? 0 : 250);
    return () => {
      alive = false;
      clearTimeout(h);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, accountId, scopeKey, epoch, reload, attempt]);

  const data = load.status === 'ready' ? load.data : null;
  const real = useMemo(() => (data ? data.messages.filter((m) => !m.isDraft) : []), [data]);
  const allOpen = real.length > 0 && real.every((m) => open.has(m.header.id));

  // Scroll to the first unread open card, or to the newest one (once).
  useEffect(() => {
    if (!data || didScroll.current) return;
    didScroll.current = true;
    const frame = requestAnimationFrame(() => {
      const el = scroller.current;
      if (!el) return;
      const firstUnread = data.messages.find((m) => !m.isDraft && !m.header.seen && open.has(m.header.id));
      const target = firstUnread ?? real[real.length - 1];
      const card = target ? el.querySelector<HTMLElement>(`[data-mid="${target.header.id}"]`) : null;
      if (card && el.scrollHeight > el.clientHeight) el.scrollTop = Math.max(0, card.offsetTop - el.offsetTop - 8);
    });
    return () => cancelAnimationFrame(frame);
  }, [data, open, real]);

  const toggle = useCallback((id: number) => {
    setOpen((o) => {
      const next = new Set(o);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const expandAll = () => {
    if (!data) return;
    if (allOpen) {
      setOpen(new Set());
      setAnnounce('All messages collapsed');
    } else {
      setOpen(new Set(real.map((m) => m.header.id)));
      setAnnounce('All messages expanded');
    }
  };

  // Alt+Down / Alt+Up: next or previous card header.
  const onKeyDown = (e: RKE<HTMLDivElement>) => {
    if (!e.altKey || e.ctrlKey || e.shiftKey || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
    const heads = [...(scroller.current?.querySelectorAll<HTMLElement>('.chead') ?? [])];
    if (heads.length === 0) return;
    e.preventDefault();
    const at = heads.findIndex((h) => h === document.activeElement || h.closest('.ccard')?.contains(document.activeElement));
    const next = e.key === 'ArrowDown' ? Math.min(heads.length - 1, at + 1) : Math.max(0, at < 0 ? 0 : at - 1);
    heads[next]?.focus();
    heads[next]?.scrollIntoView({ block: 'nearest' });
  };

  const gone = load.status === 'gone';
  const replyTarget = (): number | null => {
    if (!data) return null;
    if (focusedId !== null && real.some((m) => m.header.id === focusedId)) return focusedId;
    const theirs = real.filter((m) => !m.fromMe);
    return (theirs[theirs.length - 1] ?? real[real.length - 1])?.header.id ?? null;
  };
  const reply = (mode: 'reply' | 'replyAll' | 'forward') => {
    const id = replyTarget();
    if (id !== null) openCompose({ mode, sourceMessageId: id });
  };
  const row = itemId !== null && itemId !== undefined ? useList.getState().items.find((m) => m.id === itemId) : undefined;

  const title = data?.title ?? row?.subject ?? '';
  const account = accounts.find((a) => a.id === accountId);
  const count = data?.count ?? row?.conv?.count ?? 0;
  const flagged = row?.flagged ?? false;
  const seen = row?.seen ?? true;

  return (
    <>
      <div className="rtool" role="toolbar" aria-label="Conversation actions" style={{ overflow: 'hidden' }}>
        {onBack ? (
          <button type="button" className="tbtn" onClick={onBack}>
            <Icon name="back" size={20} />
            <span className="lbl">Back to message</span>
          </button>
        ) : null}
        <button type="button" className="tbtn" title="Reply (Ctrl+R)" disabled={!data} onClick={() => reply('reply')}>
          <Icon name="reply" size={20} />
          <span className="lbl">Reply</span>
        </button>
        <button type="button" className="tbtn" title="Reply all (Ctrl+Shift+R)" aria-label="Reply all" disabled={!data} onClick={() => reply('replyAll')}>
          <Icon name="replyall" size={20} />
          <span className="lbl">Reply all</span>
        </button>
        <button type="button" className="tbtn" title="Forward (Ctrl+F)" disabled={!data} onClick={() => reply('forward')}>
          <Icon name="fwd" size={20} />
          <span className="lbl">Forward</span>
        </button>
        {row ? (
          <>
            <span className="tsep" />
            <button type="button" className="tbtn ico" title="Archive conversation (E)" aria-label="Archive conversation" disabled={gone} onClick={() => void applyToMessages([row.id], { type: 'archive' })}>
              <Icon name="archive" size={20} />
            </button>
            <button type="button" className="tbtn ico" title="Delete conversation (Delete)" aria-label="Delete conversation" disabled={gone} onClick={() => deleteMessages([row.id])}>
              <Icon name="trash" size={20} />
            </button>
            <button type="button" className="tbtn" title="Move conversation to... (Ctrl+Shift+M)" disabled={gone} onClick={() => useUi.getState().set({ moveDialog: [row.id] })}>
              <Icon name="folder" size={20} />
              <span className="lbl">Move</span>
              <Icon name="chev-d" />
            </button>
            <span className="tsep" />
            <button
              type="button"
              className={`tbtn ico ${flagged ? 'flagged' : ''}`}
              title={flagged ? 'Unflag conversation' : 'Flag conversation'}
              aria-label={flagged ? 'Unflag conversation' : 'Flag conversation'}
              aria-pressed={flagged}
              disabled={gone}
              onClick={() => void applyToMessages([row.id], { type: 'flag', flagged: !flagged })}
            >
              <Icon name="flag" size={20} filled={flagged} />
            </button>
            <button
              type="button"
              className="tbtn ico"
              title={seen ? 'Mark conversation as unread' : 'Mark conversation as read'}
              aria-label={seen ? 'Mark conversation as unread' : 'Mark conversation as read'}
              disabled={gone}
              onClick={() => void applyToMessages([row.id], { type: 'markRead', read: !seen })}
            >
              <Icon name={seen ? 'unread' : 'mail-open'} size={20} />
            </button>
          </>
        ) : null}
      </div>
      <div className="rbody conv-scroll" ref={scroller} onKeyDown={onKeyDown}>
        <div className="rin centered cstack">
          {gone ? (
            <div className="rbanner gone" role="status">
              <span className="ic"><Icon name="info" size={20} /></span>
              <div style={{ flex: 1 }}>This conversation was moved or deleted.</div>
            </div>
          ) : (
            <>
              <h2 className="rsub">{title || '(no subject)'}</h2>
              <div className="ctitle">
                <span className="cap">
                  {count} {count === 1 ? 'message' : 'messages'}
                  {account ? (
                    <>
                      {' '}&middot;{' '}
                      <AccountBadge color={colorOf(account.id)} name={account.displayName} letter={account.badge} /> {account.displayName}
                    </>
                  ) : null}
                </span>
                {data ? (
                  <Button size="sm" variant="subtle" onClick={expandAll}>
                    {allOpen ? 'Collapse all' : 'Expand all'}
                  </Button>
                ) : null}
              </div>
            </>
          )}
          {load.status === 'loading' ? (
            <div className="cloading" aria-busy="true" aria-label="Loading conversation">
              {[0, 1, 2].map((i) => (
                <div key={i} className="ccard skel-card">
                  <Skeleton w="40%" h={12} />
                  <Skeleton w="90%" h={10} />
                </div>
              ))}
            </div>
          ) : null}
          {load.status === 'error' ? (
            <Banner tone="danger" actions={<Button size="sm" onClick={() => { setLoad({ status: 'loading' }); setAttempt((n) => n + 1); }}>Retry</Button>}>
              Couldn&apos;t load this conversation. {load.error.message}
            </Banner>
          ) : null}
          {data
            ? data.messages.map((m) => (
                <Card
                  key={m.header.id}
                  m={m}
                  open={open.has(m.header.id)}
                  chip={!m.inCurrentFolder && scope !== undefined}
                  focused={focusedId === m.header.id}
                  onToggle={() => toggle(m.header.id)}
                  onFocusCard={() => setFocusedId(m.header.id)}
                  onSource={() => setSource(m.header.id)}
                  threadId={threadId}
                  scroller={scroller}
                />
              ))
            : null}
        </div>
        {newIds.length > 0 ? (
          <button
            type="button"
            className="newpill"
            onClick={() => {
              const el = scroller.current?.querySelector<HTMLElement>(`[data-mid="${newIds[0]}"]`);
              el?.scrollIntoView({ block: 'start' });
              setNewIds([]);
            }}
          >
            {newIds.length === 1 ? '1 new message' : `${newIds.length} new messages`}
          </button>
        ) : null}
        <div className="sr-only" role="status" aria-live="polite">
          {announce}
        </div>
      </div>
      {source !== null ? <SourceDialog id={source} onClose={() => setSource(null)} /> : null}
    </>
  );
}

function Card({
  m,
  open,
  chip,
  focused,
  onToggle,
  onFocusCard,
  onSource,
  threadId,
  scroller,
}: {
  m: ConversationMessage;
  open: boolean;
  chip: boolean;
  focused: boolean;
  onToggle: () => void;
  onFocusCard: () => void;
  onSource: () => void;
  threadId: string;
  scroller: React.RefObject<HTMLDivElement | null>;
}) {
  const h = m.header;
  const name = m.fromMe ? 'You' : senderName(h.from);
  const unread = !h.seen && !m.isDraft;
  const [details, setDetails] = useState(false);
  const ref = useRef<HTMLElement>(null);
  const markDelay = useApp((s) => s.settings?.markReadDelayMs ?? 1500);
  const [seenLocal, setSeenLocal] = useState(h.seen);
  const isUnread = unread && !seenLocal;

  // Mark as read once the open card is at least half visible (Settings > Mail > Mark a message as read).
  useEffect(() => {
    if (!open || !unread || seenLocal || markDelay < 0 || m.isDraft) return;
    const el = ref.current;
    if (!el) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const mark = () => {
      void applyToRealMessages([h.id], { type: 'markRead', read: true }).then((ok) => {
        if (ok) {
          setSeenLocal(true);
          noteThreadRead(threadId);
        }
      });
    };
    const io = new IntersectionObserver(
      (entries) => {
        const visible = entries.some((e) => e.isIntersecting && e.intersectionRatio >= 0.5);
        if (visible && timer === null) timer = setTimeout(mark, markDelay);
        if (!visible && timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
      },
      { root: scroller.current, threshold: [0, 0.5, 1] },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      if (timer !== null) clearTimeout(timer);
    };
  }, [open, unread, seenLocal, markDelay, m.isDraft, h.id, threadId, scroller]);

  const label = `Message from ${name}, ${cardDate(h.date)}, ${m.isDraft ? 'draft, ' : ''}${open ? 'expanded' : 'collapsed'}${isUnread ? ', unread' : ''}`;
  const activate = () => (m.isDraft ? editDraft(h.id) : onToggle());
  const onHeadKey = (e: RKE<HTMLButtonElement>) => {
    if (m.isDraft || e.altKey || e.ctrlKey) return;
    if (e.key === 'ArrowRight' && !open) {
      e.preventDefault();
      onToggle();
    } else if (e.key === 'ArrowLeft' && open) {
      e.preventDefault();
      onToggle();
    }
  };

  return (
    <section
      ref={ref}
      data-mid={h.id}
      aria-label={label}
      className={`ccard ${open ? 'open' : ''} ${isUnread ? 'unread' : ''} ${m.isDraft ? 'isdraft' : ''} ${focused ? 'cfocus' : ''}`}
      onFocusCapture={onFocusCard}
    >
      <h3 className="chh">
        <button type="button" className="chead" aria-expanded={m.isDraft ? undefined : open} aria-controls={`cb-${h.id}`} onClick={activate} onKeyDown={onHeadKey}>
          {isUnread ? <i className="ud" aria-hidden="true" /> : null}
          <span className="cav" aria-hidden="true">{initials(name)}</span>
          <span className="cmain">
            <span className="cl1">
              <span className="cnm">{name}</span>
              {m.isDraft ? <span className="fchip">Draft</span> : chip ? <span className="fchip">{chipLabel(m)}</span> : null}
              <span className="cdt">{cardDate(h.date)}</span>
              {m.isDraft ? null : <Icon name={open ? 'chev-up' : 'chev-d'} />}
            </span>
            {!open ? (
              <span className="cl2">
                <span className="csn">{h.snippet}</span>
                {h.hasAttachments ? <Icon name="clip" /> : null}
              </span>
            ) : null}
          </span>
        </button>
      </h3>
      {open && !m.isDraft ? (
        <div id={`cb-${h.id}`} className="cbody">
          <div className="cmeta">
            <span className="cap">
              To: {h.to.length ? h.to.slice(0, 3).map((a) => a.name || a.address).join(', ') + (h.to.length > 3 ? `, +${h.to.length - 3}` : '') : '(no recipients)'}{' '}
              <button type="button" className="link plain" aria-expanded={details} onClick={() => setDetails((d) => !d)}>
                {details ? 'Hide details' : 'Details'}
              </button>
            </span>
            <span className="cbtns" role="group" aria-label={`Actions for the message from ${name}`}>
              <IconButton icon="reply" label="Reply" size="sm" onClick={() => openCompose({ mode: 'reply', sourceMessageId: h.id })} />
              <IconButton icon="replyall" label="Reply all" size="sm" onClick={() => openCompose({ mode: 'replyAll', sourceMessageId: h.id })} />
              <IconButton icon="fwd" label="Forward" size="sm" onClick={() => openCompose({ mode: 'forward', sourceMessageId: h.id })} />
              <IconButton icon="more" label="More actions for this message" size="sm" aria-haspopup="menu" onClick={(e) => openMenuAt(e.currentTarget, cardMenu(h, onSource, () => setSeenLocal(false)))} />
            </span>
          </div>
          {details ? (
            <dl className="rdetails">
              <dt>From</dt>
              <dd>{h.from ? addressList([h.from]) : 'Unknown'}</dd>
              <dt>To</dt>
              <dd>{addressList(h.to) || '-'}</dd>
              {h.cc.length ? (<><dt>Cc</dt><dd>{addressList(h.cc)}</dd></>) : null}
              <dt>Date</dt>
              <dd>{fullDate(h.date)}</dd>
            </dl>
          ) : null}
          <CardBody header={h} />
        </div>
      ) : null}
    </section>
  );
}

function cardMenu(h: MessageHeader, onSource: () => void, onUnread: () => void): MenuEntry[] {
  return [
    {
      label: h.seen ? 'Mark as unread' : 'Mark as read',
      icon: h.seen ? 'unread' : 'mail-open',
      onSelect: () => {
        void applyToRealMessages([h.id], { type: 'markRead', read: !h.seen }).then((ok) => {
          if (ok) {
            onUnread();
            void useList.getState().refresh();
          }
        });
      },
    },
    { label: 'Print', icon: 'print', onSelect: () => void printMessage(h.id) },
    { label: 'View source', onSelect: onSource },
    { label: 'Open in new window', icon: 'open-window', onSelect: () => openInWindow(h) },
    'sep',
    {
      label: 'Delete this message only',
      icon: 'trash',
      danger: true,
      onSelect: () => {
        void applyToRealMessages([h.id], { type: 'delete' }).then(() => {
          useList.getState().refresh().catch(() => toastError('Could not refresh the list.'));
        });
      },
    },
  ];
}

/**
 * The reading pane for a list row that is a conversation. With 2 or more messages it is the stack;
 * with one it is the normal single-message layout (DESIGN-SPEC 3.10.4).
 */
export function ConversationPane({ item }: { item: ListItem }) {
  const scope = useList((s) => s.scope);
  const conv = item.conv!;
  if (conv.count >= 2) {
    return <ConversationView threadId={conv.threadId} accountId={conv.accountId} scope={scope ?? undefined} itemId={item.id} />;
  }
  return <SingleMessageOfRow item={item} />;
}

function SingleMessageOfRow({ item }: { item: ListItem }) {
  const [header, setHeader] = useState<MessageHeader | null>(null);
  const epoch = useApp((s) => s.epoch);
  useEffect(() => {
    let alive = true;
    call('messages.getHeaders', { messageIds: [item.id] })
      .then((r) => alive && setHeader(r[0] ?? null))
      .catch(() => alive && setHeader(null));
    return () => {
      alive = false;
    };
  }, [item.id, epoch]);
  if (!header) {
    return (
      <div className="rbody">
        <div className="rin centered">
          <h2 className="rsub">{item.subject || '(no subject)'}</h2>
          <div className="mbody-skel" aria-busy="true" aria-label="Loading message">
            {[90, 100, 80, 95].map((w, i) => (
              <Skeleton key={i} w={`${w}%`} h={12} />
            ))}
          </div>
        </div>
      </div>
    );
  }
  return <MessageView key={header.id} header={{ ...header, seen: item.seen, flagged: item.flagged }} />;
}
