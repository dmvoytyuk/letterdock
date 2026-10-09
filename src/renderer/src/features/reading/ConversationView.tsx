import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as RKE, type ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { AppError, ConversationMessage, GetConversationRes, ListScope, MessageHeader } from '../../../../shared/ipc';
import { Icon } from '../../components/Icon';
import { AccountBadge, Banner, Button, IconButton, Skeleton, openMenuAt, type MenuEntry } from '../../components/ui';
import { useApp } from '../../store/app';
import { useList, type ListItem } from '../../store/list';
import { useUi } from '../../store/ui';
import { touches, useConvSignal } from '../../store/conversations';
import { useAccountColor } from '../../lib/hooks';
import { applyToMessages, applyToRealMessages, deleteMessages, editDraft, noteThreadRead, openCompose, openInWindow, saveAsEml } from '../../lib/actions';
import { printMessage } from '../../lib/print';
import { asAppError, call } from '../../lib/api';
import { CONV_MOVE_EVENT } from '../../lib/shortcuts';
import { fullDate, initials, senderName } from '../../lib/format';
import { toastError } from '../../store/toasts';
import { CardBody, MessageView, SourceDialog } from './ReadingPane';
import { canMakeRuleFrom, createRuleFromSender } from '../rules/ruleActions';
import { AddressButton, AddressLinks } from '../../components/ContactPopover';

/** At most this many cards open by themselves when a conversation is opened (DESIGN-SPEC 3.10.4). */
const MAX_AUTO_OPEN = 8;
/** Over this many messages the cards are a virtual list: only the ones near the screen exist (DESIGN-SPEC 3.10.8). */
export const VIRTUAL_MIN = 50;
/** Cards open and close over this long (DESIGN-SPEC 1.9 `motion.base`). */
const MOTION_MS = 167;

const reducedMotion = (): boolean => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/**
 * The body of a card: it slides open and closed over 167 ms, or instantly with reduced motion. The content
 * only exists while the card is open or closing, so collapsed bodies are never fetched (DESIGN-SPEC 3.10.4).
 */
function Collapsible({ open, children }: { open: boolean; children: ReactNode }) {
  const [mounted, setMounted] = useState(open);
  const [on, setOn] = useState(open);
  // Opening: the content is there at once, closed for one frame, then open (so the height can change).
  if (open && !mounted) setMounted(true);
  useEffect(() => {
    if (open) {
      const f = requestAnimationFrame(() => requestAnimationFrame(() => setOn(true)));
      return () => cancelAnimationFrame(f);
    }
    // Closing: the class flips at once (below); the content goes after the slide.
    const t = setTimeout(
      () => {
        setMounted(false);
        setOn(false);
      },
      reducedMotion() ? 0 : MOTION_MS,
    );
    return () => clearTimeout(t);
  }, [open]);
  if (!mounted) return null;
  return (
    <div className={`cexp ${open && on ? 'on' : ''}`}>
      <div className="cexp-in">{children}</div>
    </div>
  );
}

/** A card whose message left the conversation (moved or deleted elsewhere): it closes over 167 ms and goes. */
function Leaving({ children }: { children: ReactNode }) {
  const [gone, setGone] = useState(false);
  useEffect(() => {
    const f = requestAnimationFrame(() => requestAnimationFrame(() => setGone(true)));
    return () => cancelAnimationFrame(f);
  }, []);
  return (
    <div className={`cexp cleave ${gone ? '' : 'on'}`} aria-hidden="true">
      <div className="cexp-in">{children}</div>
    </div>
  );
}

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
  const [leaving, setLeaving] = useState<ConversationMessage[]>([]);
  const lastMessages = useRef<ConversationMessage[]>([]);
  const listRef = useRef<HTMLDivElement>(null);
  const [margin, setMargin] = useState(0);
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
          // Cards whose message is gone close over 167 ms (DESIGN-SPEC 3.10.6).
          const still = new Set(ids);
          const left = lastMessages.current.filter((m) => !still.has(m.header.id));
          lastMessages.current = data.messages;
          if (left.length > 0 && !reducedMotion()) {
            setLeaving((l) => [...l, ...left]);
            setTimeout(() => setLeaving((l) => l.filter((m) => !left.includes(m))), MOTION_MS + 60);
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

  // The cards on screen: the messages plus the ones that are still closing.
  const shown = useMemo(() => {
    if (!data) return [] as { m: ConversationMessage; leaving: boolean }[];
    const all = [
      ...data.messages.map((m) => ({ m, leaving: false })),
      ...leaving.filter((l) => !data.messages.some((m) => m.header.id === l.header.id)).map((m) => ({ m, leaving: true })),
    ];
    return all.sort((a, b) => a.m.header.date - b.m.header.date || a.m.header.id - b.m.header.id);
  }, [data, leaving]);
  const virtual = shown.length > VIRTUAL_MIN;

  // Where the list of cards starts inside the scrolling pane (the title block above it can change height).
  useEffect(() => {
    const list = listRef.current;
    const sc = scroller.current;
    if (!virtual || !list || !sc) return;
    const measure = () => {
      const at = Math.round(list.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop);
      setMargin((m) => (m === at ? m : at));
    };
    const ro = new ResizeObserver(measure);
    ro.observe(sc);
    ro.observe(list);
    return () => ro.disconnect();
  }, [virtual]);
  // eslint-disable-next-line react-hooks/incompatible-library
  const virt = useVirtualizer({
    count: virtual ? shown.length : 0,
    getScrollElement: () => scroller.current,
    estimateSize: (i) => (open.has(shown[i]?.m.header.id ?? -1) ? 360 : 64),
    getItemKey: (i) => shown[i]?.m.header.id ?? i,
    overscan: 12,
    scrollMargin: margin,
  });
  const indexOfCard = useCallback((id: number) => shown.findIndex((x) => x.m.header.id === id), [shown]);
  /** Bring a card into view. Over 50 messages it may not exist yet, so the virtual list scrolls to it first. */
  const showCard = useCallback(
    (id: number, align: 'start' | 'auto') => {
      if (virtual) {
        const i = indexOfCard(id);
        if (i >= 0) virt.scrollToIndex(i, { align });
        return;
      }
      scroller.current?.querySelector<HTMLElement>(`[data-mid="${id}"]`)?.scrollIntoView({ block: align === 'start' ? 'start' : 'nearest' });
    },
    [virtual, indexOfCard, virt],
  );

  // Scroll to the first unread open card, or to the newest one (once).
  useEffect(() => {
    if (!data || didScroll.current) return;
    didScroll.current = true;
    const frame = requestAnimationFrame(() => {
      const el = scroller.current;
      if (!el) return;
      const firstUnread = data.messages.find((m) => !m.isDraft && !m.header.seen && open.has(m.header.id));
      const target = firstUnread ?? real[real.length - 1];
      if (virtual && target) {
        const i = indexOfCard(target.header.id);
        if (i >= 0) virt.scrollToIndex(i, { align: 'start' });
        return;
      }
      const card = target ? el.querySelector<HTMLElement>(`[data-mid="${target.header.id}"]`) : null;
      if (card && el.scrollHeight > el.clientHeight) el.scrollTop = Math.max(0, card.offsetTop - el.offsetTop - 8);
    });
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // Alt+Down / Alt+Up (Gmail style: n / p): next or previous card header. Returns false when there is nothing to move.
  const moveCard = (dir: 1 | -1): boolean => {
    if (virtual) {
      // Over 50 messages the next card may not exist yet: scroll to it, then put the focus on its header.
      const cardEl = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('.ccard[data-mid]');
      const cur = cardEl ? indexOfCard(Number(cardEl.dataset.mid)) : -1;
      const want = dir === 1 ? Math.min(shown.length - 1, cur + 1) : Math.max(0, cur < 0 ? 0 : cur - 1);
      const target = shown[want];
      if (!target) return true;
      virt.scrollToIndex(want, { align: 'auto' });
      let tries = 0;
      const focusIt = () => {
        const head = scroller.current?.querySelector<HTMLElement>(`.ccard[data-mid="${target.m.header.id}"] .chead`);
        if (head) head.focus();
        else if (++tries < 20) requestAnimationFrame(focusIt);
      };
      requestAnimationFrame(focusIt);
      return true;
    }
    const heads = [...(scroller.current?.querySelectorAll<HTMLElement>('.chead') ?? [])];
    if (heads.length === 0) return false;
    const at = heads.findIndex((h) => h === document.activeElement || h.closest('.ccard')?.contains(document.activeElement));
    const next = dir === 1 ? Math.min(heads.length - 1, at + 1) : Math.max(0, at < 0 ? 0 : at - 1);
    heads[next]?.focus();
    heads[next]?.scrollIntoView({ block: 'nearest' });
    return true;
  };
  const onKeyDown = (e: RKE<HTMLDivElement>) => {
    if (!e.altKey || e.ctrlKey || e.shiftKey || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
    if (moveCard(e.key === 'ArrowDown' ? 1 : -1)) e.preventDefault();
  };
  // Gmail style: n and p come from useGlobalShortcuts.
  const moveCardRef = useRef(moveCard);
  moveCardRef.current = moveCard;
  useEffect(() => {
    const onMove = (e: Event) => void moveCardRef.current((e as CustomEvent<number>).detail > 0 ? 1 : -1);
    window.addEventListener(CONV_MOVE_EVENT, onMove);
    return () => window.removeEventListener(CONV_MOVE_EVENT, onMove);
  }, []);

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

  const renderCard = (m: ConversationMessage, isLeaving: boolean): ReactNode => {
    const card = (
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
    );
    return isLeaving ? <Leaving key={m.header.id}>{card}</Leaving> : card;
  };

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
          {data ? (
            virtual ? (
              <div ref={listRef} className="cvirt" style={{ height: virt.getTotalSize(), position: 'relative' }}>
                {virt.getVirtualItems().map((v) => {
                  const x = shown[v.index];
                  if (!x) return null;
                  return (
                    <div
                      key={v.key}
                      data-index={v.index}
                      ref={virt.measureElement}
                      className="cvitem"
                      style={{ transform: `translateY(${v.start - margin}px)` }}
                    >
                      {renderCard(x.m, x.leaving)}
                    </div>
                  );
                })}
              </div>
            ) : (
              shown.map((x) => renderCard(x.m, x.leaving))
            )
          ) : null}
        </div>
        {newIds.length > 0 ? (
          <button
            type="button"
            className="newpill"
            onClick={() => {
              if (newIds[0] !== undefined) showCard(newIds[0], 'start');
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
        <div className="chrow">
          <button
            type="button"
            className="chead"
            aria-expanded={m.isDraft ? undefined : open}
            aria-controls={`cb-${h.id}`}
            aria-label={`${name}, ${cardDate(h.date)}${m.isDraft ? ', draft' : ''}${open ? '' : `, ${h.snippet}`}`}
            onClick={activate}
            onKeyDown={onHeadKey}
          />
          {isUnread ? <i className="ud" aria-hidden="true" /> : null}
          <span className="cav" aria-hidden="true">{initials(name)}</span>
          <span className="cmain">
            <span className="cl1">
              {open && !m.isDraft && !m.fromMe && h.from ? (
                <AddressButton className="cnm" address={h.from} accountId={h.accountId} allowRule={canMakeRuleFrom(h)}>
                  {name}
                </AddressButton>
              ) : (
                <span className="cnm" aria-hidden="true">{name}</span>
              )}
              {m.isDraft ? <span className="fchip" aria-hidden="true">Draft</span> : chip ? <span className="fchip" aria-hidden="true">{chipLabel(m)}</span> : null}
              <span className="cdt" aria-hidden="true">{cardDate(h.date)}</span>
              {m.isDraft ? null : <Icon name={open ? 'chev-up' : 'chev-d'} />}
            </span>
            {!open ? (
              <span className="cl2" aria-hidden="true">
                <span className="csn">{h.snippet}</span>
                {h.hasAttachments ? <Icon name="clip" /> : null}
              </span>
            ) : null}
          </span>
        </div>
      </h3>
      {!m.isDraft ? (
        <Collapsible open={open}>
        <div id={`cb-${h.id}`} className="cbody">
          <div className="cmeta">
            <span className="cap">
              To: {h.to.length ? <AddressLinks list={h.to} max={3} accountId={h.accountId} allowRule={canMakeRuleFrom(h)} /> : '(no recipients)'}{' '}
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
              <dd>{h.from ? <AddressLinks list={[h.from]} full accountId={h.accountId} allowRule={canMakeRuleFrom(h)} /> : 'Unknown'}</dd>
              <dt>To</dt>
              <dd>{h.to.length ? <AddressLinks list={h.to} full accountId={h.accountId} allowRule={canMakeRuleFrom(h)} /> : '-'}</dd>
              {h.cc.length ? (<><dt>Cc</dt><dd><AddressLinks list={h.cc} full accountId={h.accountId} allowRule={canMakeRuleFrom(h)} /></dd></>) : null}
              <dt>Date</dt>
              <dd>{fullDate(h.date)}</dd>
            </dl>
          ) : null}
          <CardBody header={h} />
        </div>
      </Collapsible>
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
    { label: 'Save as .eml...', icon: 'download', onSelect: () => void saveAsEml(h.id) },
    { label: 'Open in new window', icon: 'open-window', onSelect: () => openInWindow(h) },
    ...(h.from && canMakeRuleFrom(h)
      ? ([{ label: 'Create rule from this sender...', icon: 'rules', onSelect: () => createRuleFromSender(h.accountId, h.from) }] as MenuEntry[])
      : []),
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
