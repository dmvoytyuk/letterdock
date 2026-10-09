import { useEffect, useMemo, useRef, useState } from 'react';
import type { Account, AppError, AttachmentInfo, MessageBody, MessageHeader } from '../../../../shared/ipc';
import { isExecutableName } from '../../../../shared/safety';
import { Icon } from '../../components/Icon';
import {
  AccountBadge,
  Banner,
  Button,
  Dialog,
  IconButton,
  Skeleton,
  openMenuAt,
  useMenu,
} from '../../components/ui';
import { useApp } from '../../store/app';
import { openIdOf, useList, type ListItem } from '../../store/list';
import { useUi } from '../../store/ui';
import { useAccountColor, useThemeState } from '../../lib/hooks';
import { applyToMessages, composeFrom, deleteMessages, editDraft, openInWindow, roleOf } from '../../lib/actions';
import { printOpenMessage, registerPrintSource } from '../../lib/print';
import { asAppError, call } from '../../lib/api';
import { addressList, fileKind, fileSize, fullDate, initials, senderName } from '../../lib/format';
import { buildSrcdoc, cidRefs, sanitizeEmailHtml, type SanitizedHtml } from '../../lib/sanitize';
import { planBody, verifyContrast, type RenderPlan } from '../../lib/emailTheme';
import { reportActionError, toast, toastError } from '../../store/toasts';
import { folderLabel } from '../sidebar/Sidebar';
import { matchShortcut, type ShortcutId } from '../../lib/shortcuts';
import { ConversationPane, ConversationView } from './ConversationView';
import { canMakeRuleFrom, createRuleFromSender } from '../rules/ruleActions';

type BodyState =
  | { status: 'loading' }
  | { status: 'error'; error: AppError }
  | { status: 'ready'; body: MessageBody };

export function ReadingPane() {
  const selectedIds = useList((s) => s.selectedIds);
  const items = useList((s) => s.items);
  const openId = openIdOf({ selectedIds });
  const mode = useUi((s) => s.mode);
  const readerOpen = useUi((s) => s.readerOpen);

  const header = openId !== null ? items.find((m) => m.id === openId) : undefined;
  const search = useList((s) => s.search !== null);
  const groupSetting = useApp((s) => !!s.settings?.groupConversations);

  let content;
  if (selectedIds.length >= 2) content = <MultiCard ids={selectedIds} items={items} />;
  else if (openId === null || !header) {
    content = (
      <div className="empty" style={{ height: '100%' }}>
        <Icon name="mail" size={48} />
        <h3>Select a message to read it</h3>
        <p>Tip: press Ctrl+N to write a new message</p>
      </div>
    );
  } else if (header.conv) content = <ConversationPane key={header.conv.threadId} item={header} />;
  else if (search && groupSetting && header.threadId) content = <SearchMessage key={openId} header={header} />;
  else content = <MessageView key={openId} header={header} />;

  return (
    <main className="reading" aria-label="Message" id="pane-reading" style={{ containerType: 'inline-size' }}>
      {mode === 'narrow' && readerOpen && selectedIds.length < 2 ? (
        <div style={{ padding: '4px 8px', borderBottom: '1px solid var(--border)' }}>
          <button type="button" className="tbtn" onClick={() => useUi.setState({ readerOpen: false })}>
            <Icon name="back" size={20} /> Back
          </button>
        </div>
      ) : null}
      {content}
    </main>
  );
}

/** A search result with "Show conversation (N)" under the subject (DESIGN-SPEC 3.10.5). */
function SearchMessage({ header }: { header: MessageHeader }) {
  const [count, setCount] = useState<number | null>(null);
  const [showing, setShowing] = useState(false);
  const threadId = header.threadId;
  useEffect(() => {
    if (!threadId) return;
    let alive = true;
    call('conversations.get', { threadId, accountId: header.accountId })
      .then((r) => alive && setCount(r.count))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [threadId, header.accountId]);
  if (showing && threadId) {
    return <ConversationView threadId={threadId} accountId={header.accountId} onBack={() => setShowing(false)} />;
  }
  return (
    <MessageView
      header={header}
      underSubject={
        count !== null && count > 1 ? (
          <Button size="sm" variant="subtle" icon="stack" onClick={() => setShowing(true)}>
            Show conversation ({count})
          </Button>
        ) : null
      }
    />
  );
}

function MultiCard({ ids, items }: { ids: number[]; items: ListItem[] }) {
  const grouped = useList((s) => s.grouped);
  const sel = items.filter((m) => ids.includes(m.id));
  const sameAccount = new Set(sel.map((m) => m.accountId)).size <= 1;
  const allRead = sel.every((m) => m.seen);
  const allFlagged = sel.every((m) => m.flagged);
  return (
    <div className="empty" style={{ height: '100%' }}>
      <Icon name="stack" size={48} />
      <h3>
        {ids.length} {grouped ? 'conversations' : 'messages'} selected
      </h3>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center', marginTop: 8 }}>
        <Button icon="trash" onClick={() => deleteMessages(ids)}>Delete</Button>
        <Button icon="archive" onClick={() => void applyToMessages(ids, { type: 'archive' })}>Archive</Button>
        <Button icon="folder" disabled={!sameAccount} onClick={() => useUi.getState().set({ moveDialog: ids })}>
          Move
        </Button>
        <Button icon="unread" onClick={() => void applyToMessages(ids, { type: 'markRead', read: !allRead })}>
          {allRead ? 'Mark unread' : 'Mark read'}
        </Button>
        <Button icon="flag" onClick={() => void applyToMessages(ids, { type: 'flag', flagged: !allFlagged })}>
          {allFlagged ? 'Unflag' : 'Flag'}
        </Button>
        <Button variant="subtle" onClick={() => useList.getState().clearSelection()}>Clear selection</Button>
      </div>
      {!sameAccount ? <p>Messages are in different accounts, so they cannot be moved together.</p> : null}
    </div>
  );
}

/**
 * One message: toolbar, header, body, attachments. Used by the reading pane and by the message window
 * (`windowMode`, DESIGN-SPEC 3.9). In the window, `gone` means the message was moved or deleted elsewhere.
 */
export function MessageView({
  header,
  windowMode = false,
  gone = false,
  underSubject = null,
}: {
  header: MessageHeader;
  windowMode?: boolean;
  gone?: boolean;
  /** Something small shown under the subject (the "Show conversation" button of a search result). */
  underSubject?: React.ReactNode;
}) {
  const accounts = useApp((s) => s.accounts);
  const folders = useApp((s) => s.folders);
  const markDelaySetting = useApp((s) => s.settings?.markReadDelayMs ?? 1500);
  // A message window marks the message as read at once, unless the setting is "Never".
  const markDelay = windowMode && markDelaySetting >= 0 ? 0 : markDelaySetting;
  const epoch = useApp((s) => s.epoch);
  const colorOf = useAccountColor();
  const [state, setState] = useState<BodyState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [details, setDetails] = useState(false);
  const [imagesLoaded, setImagesLoaded] = useState(false);
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const remoteImages = useApp((s) => s.settings?.remoteImages ?? 'block');
  const [showSource, setShowSource] = useState(false);
  // Dark theme colors for Designed mail (DESIGN-SPEC 3.6.1 E). Memory only; a new message starts fresh (keyed view).
  const [colorOverride, setColorOverride] = useState<'original' | 'dark' | null>(null);
  const [autoFallback, setAutoFallback] = useState(false);
  const [colorInfo, setColorInfo] = useState<{ dark: boolean } | null>(null);
  const toggleColors = colorInfo
    ? {
        label: colorInfo.dark ? 'Show original colors' : 'Show in dark mode',
        icon: (colorInfo.dark ? 'sun' : 'moon') as 'sun' | 'moon',
        run: () => setColorOverride(colorInfo.dark ? 'original' : 'dark'),
      }
    : null;
  const account = accounts.find((a) => a.id === header.accountId);
  const folder = folders.find((f) => f.id === header.folderId);
  // Gives Ctrl+P and the Print buttons the sanitized light body of the message on screen.
  const printRef = useRef<() => string | undefined | null>(() => null);
  useEffect(
    () => registerPrintSource({ messageId: header.id, getBodyHtml: () => printRef.current() }),
    [header.id],
  );

  useEffect(() => {
    let alive = true;
    call('messages.get', { messageId: header.id })
      .then((body) => alive && setState({ status: 'ready', body }))
      .catch((e) => alive && setState({ status: 'error', error: asAppError(e) }));
    return () => {
      alive = false;
    };
  }, [header.id, attempt, epoch]);

  // Mark as read after the delay from Settings (-1 = never, 0 = right away).
  const seen = header.seen;
  const ready = state.status === 'ready';
  useEffect(() => {
    if (seen || !ready || markDelay < 0) return;
    const h = setTimeout(() => void applyToMessages([header.id], { type: 'markRead', read: true }), markDelay);
    return () => clearTimeout(h);
  }, [seen, ready, markDelay, header.id]);

  const body = state.status === 'ready' ? state.body : null;
  // Images load by themselves for senders the user allowed, when Settings says so.
  const autoImages = !!body?.senderImagesAllowed && remoteImages === 'allowKnownSenders';
  const senderAddress = header.from?.address ?? null;

  const alwaysLoad = async () => {
    if (!senderAddress) return;
    try {
      await call('senders.allowImages', { address: senderAddress, allow: true });
      if (remoteImages === 'block') await useApp.getState().updateSettings({ remoteImages: 'allowKnownSenders' });
      setImagesLoaded(true);
      toast(`Images from ${senderAddress} will load automatically. Change this in Settings, Mail.`);
    } catch (e) {
      reportActionError(e);
    }
  };

  return (
    <>
      <Toolbar
        header={header}
        onSource={() => setShowSource(true)}
        colorToggle={toggleColors}
        windowMode={windowMode}
        gone={gone}
      />
      {gone ? (
        <div className="rbanner gone" role="status">
          <span className="ic"><Icon name="info" size={20} /></span>
          <div style={{ flex: 1 }}>This message was moved or deleted.</div>
        </div>
      ) : null}
      <div className="rbody">
        <div className="rin centered">
          <div className="rsub">{header.subject || '(no subject)'}</div>
          {underSubject ? <div className="rsub-extra">{underSubject}</div> : null}
          <HeaderBlock
            header={header}
            body={body}
            account={account}
            folderName={folder ? folderLabel(folder) : ''}
            color={account ? colorOf(account.id) : 'var(--accent)'}
            details={details}
            onToggle={() => setDetails((d) => !d)}
          />
          {state.status === 'loading' ? (
            <div className="mbody-skel" aria-busy="true" aria-label="Loading message">
              {[90, 100, 80, 95, 60, 85].map((w, i) => (
                <Skeleton key={i} w={`${w}%`} h={12} />
              ))}
            </div>
          ) : state.status === 'error' ? (
            <div style={{ marginTop: 16 }}>
              <Banner
                tone="danger"
                actions={
                  <>
                    <Button size="sm" onClick={() => { setState({ status: 'loading' }); setAttempt((n) => n + 1); }}>Retry</Button>
                    <button type="button" className="link" onClick={() => setShowSource(true)}>
                      View source
                    </button>
                  </>
                }
              >
                {state.error.code === 'HOST_UNREACHABLE' || state.error.code === 'TIMEOUT'
                  ? "This message isn't available offline. Connect to the internet to read it."
                  : `Couldn't load this message. ${state.error.message}`}
              </Banner>
            </div>
          ) : (
            <BodyView
              body={state.body}
              imagesLoaded={imagesLoaded || autoImages}
              bannerDismissed={bannerDismissed}
              senderAddress={senderAddress}
              onLoadImages={() => setImagesLoaded(true)}
              onAlways={() => void alwaysLoad()}
              onDismiss={() => setBannerDismissed(true)}
              colorOverride={colorOverride}
              autoFallback={autoFallback}
              onAutoFallback={() => setAutoFallback(true)}
              onColorInfo={setColorInfo}
              onToggleColors={toggleColors?.run ?? null}
              printRef={printRef}
              toggleLabel={toggleColors ? { label: toggleColors.label, icon: toggleColors.icon } : null}
            />
          )}
          {body ? <Attachments list={body.attachments.filter((a) => !a.inline)} /> : null}
        </div>
      </div>
      {showSource ? <SourceDialog id={header.id} onClose={() => setShowSource(false)} /> : null}
    </>
  );
}

function Toolbar({
  header,
  onSource,
  colorToggle,
  windowMode,
  gone,
}: {
  header: MessageHeader;
  onSource: () => void;
  colorToggle: { label: string; icon: 'sun' | 'moon'; run: () => void } | null;
  windowMode: boolean;
  gone: boolean;
}) {
  const inJunk = roleOf(header) === 'junk';
  const isDraft = header.draft || roleOf(header) === 'drafts';
  const print = () => printOpenMessage(header.id);
  const readIcon = header.seen ? 'unread' : 'mail-open';
  const moreMenu = (el: HTMLElement) =>
    openMenuAt(
      el,
      windowMode
        ? [
            {
              label: header.flagged ? 'Unflag' : 'Flag',
              icon: 'flag',
              disabled: gone,
              onSelect: () => void applyToMessages([header.id], { type: 'flag', flagged: !header.flagged }),
            },
            {
              label: header.seen ? 'Mark as unread' : 'Mark as read',
              icon: readIcon,
              disabled: gone,
              hint: 'Ctrl+U',
              onSelect: () => void applyToMessages([header.id], { type: 'markRead', read: !header.seen }),
            },
            {
              label: 'Move to...',
              icon: 'folder',
              disabled: gone,
              hint: 'Ctrl+Shift+M',
              onSelect: () => useUi.getState().set({ moveDialog: [header.id] }),
            },
            'sep',
            ...(colorToggle ? [{ label: colorToggle.label, icon: colorToggle.icon, onSelect: colorToggle.run }] : []),
            { label: 'View source', onSelect: onSource },
            {
              label: inJunk ? 'Not spam' : 'Report spam',
              icon: 'spam',
              disabled: gone,
              onSelect: () => void applyToMessages([header.id], { type: inJunk ? 'notSpam' : 'spam' }),
            },
          ]
        : [
            { label: 'Open in new window', icon: 'open-window', hint: 'Enter', onSelect: () => openInWindow(header) },
            { label: 'Print', icon: 'print', hint: 'Ctrl+P', onSelect: print },
            'sep',
            {
              label: inJunk ? 'Not spam' : 'Report spam',
              icon: 'spam',
              onSelect: () => void applyToMessages([header.id], { type: inJunk ? 'notSpam' : 'spam' }),
            },
            ...(colorToggle ? [{ label: colorToggle.label, icon: colorToggle.icon, onSelect: colorToggle.run }] : []),
            { label: 'View source', onSelect: onSource },
            ...(header.from && canMakeRuleFrom(header)
              ? [{ label: 'Create rule from this sender...', icon: 'rules' as const, onSelect: () => createRuleFromSender(header.accountId, header.from) }]
              : []),
          ],
    );
  const moreButton = (
    <button
      type="button"
      className="tbtn ico"
      title="More"
      aria-label="More actions"
      aria-haspopup="menu"
      onClick={(e) => moreMenu(e.currentTarget)}
    >
      <Icon name="more" size={20} />
    </button>
  );
  return (
    <div className="rtool" role="toolbar" aria-label="Message actions" style={{ overflow: 'hidden' }}>
      {isDraft ? (
        <button type="button" className="tbtn" onClick={() => editDraft(header.id)}>
          <Icon name="pencil" size={20} />
          <span className="lbl">Edit draft</span>
        </button>
      ) : null}
      <button type="button" className="tbtn" title="Reply (Ctrl+R)" onClick={() => composeFrom('reply', header.id)}>
        <Icon name="reply" size={20} />
        <span className="lbl">Reply</span>
      </button>
      <button
        type="button"
        className="tbtn"
        onClick={() => composeFrom('replyAll', header.id)}
        aria-label="Reply all"
        title="Reply all (Ctrl+Shift+R)"
      >
        <Icon name="replyall" size={20} />
        <span className="lbl">Reply all</span>
      </button>
      <button type="button" className="tbtn" title="Forward (Ctrl+F)" onClick={() => composeFrom('forward', header.id)}>
        <Icon name="fwd" size={20} />
        <span className="lbl">Forward</span>
      </button>
      <span className="tsep" />
      <button
        type="button"
        className="tbtn ico"
        title="Archive (E)"
        aria-label="Archive"
        disabled={gone}
        onClick={() => void applyToMessages([header.id], { type: 'archive' })}
      >
        <Icon name="archive" size={20} />
      </button>
      <button
        type="button"
        className="tbtn ico"
        title="Delete (Delete)"
        aria-label="Delete"
        disabled={gone}
        onClick={() => deleteMessages([header.id])}
      >
        <Icon name="trash" size={20} />
      </button>
      {windowMode ? (
        <>
          <span className="tsep" />
          <button type="button" className="tbtn ico" title="Print (Ctrl+P)" aria-label="Print" onClick={print}>
            <Icon name="print" size={20} />
          </button>
          {moreButton}
        </>
      ) : (
        <>
          <button
            type="button"
            className="tbtn"
            title="Move to... (Ctrl+Shift+M)"
            onClick={() => useUi.getState().set({ moveDialog: [header.id] })}
          >
            <Icon name="folder" size={20} />
            <span className="lbl">Move</span>
            <Icon name="chev-d" />
          </button>
          <span className="tsep" />
          <button
            type="button"
            className={`tbtn ico ${header.flagged ? 'flagged' : ''}`}
            title={header.flagged ? 'Unflag' : 'Flag'}
            aria-label={header.flagged ? 'Unflag' : 'Flag'}
            aria-pressed={header.flagged}
            onClick={() => void applyToMessages([header.id], { type: 'flag', flagged: !header.flagged })}
          >
            <Icon name="flag" size={20} filled={header.flagged} />
          </button>
          <button
            type="button"
            className="tbtn ico"
            title={header.seen ? 'Mark as unread' : 'Mark as read'}
            aria-label={header.seen ? 'Mark as unread' : 'Mark as read'}
            onClick={() => void applyToMessages([header.id], { type: 'markRead', read: !header.seen })}
          >
            <Icon name={readIcon} size={20} />
          </button>
          <span style={{ marginLeft: 'auto' }} />
          {moreButton}
        </>
      )}
    </div>
  );
}

function HeaderBlock({
  header,
  body,
  account,
  folderName,
  color,
  details,
  onToggle,
}: {
  header: MessageHeader;
  body: MessageBody | null;
  account: Account | undefined;
  folderName: string;
  color: string;
  details: boolean;
  onToggle: () => void;
}) {
  const from = header.from;
  const name = senderName(from);
  const toLine = header.to.length
    ? header.to.slice(0, 3).map((a) => a.name || a.address).join(', ') + (header.to.length > 3 ? `, +${header.to.length - 3}` : '')
    : '(no recipients)';
  return (
    <div className="rhead">
      <div className="av" aria-hidden="true">{initials(name)}</div>
      <div className="who">
        <div>
          <span className="nm">{name}</span>{' '}
          {from && from.name ? <span className="ad">&lt;{from.address}&gt;</span> : null}
        </div>
        <div className="cap">
          To: {toLine} &nbsp;
          <button type="button" className="link plain" aria-expanded={details} onClick={onToggle}>
            {details ? 'Hide details' : 'Details'}
          </button>
        </div>
        {details ? (
          <dl className="rdetails">
            <dt>From</dt>
            <dd>{from ? addressList([from]) : 'Unknown'}</dd>
            <dt>To</dt>
            <dd>{addressList(header.to) || '-'}</dd>
            {header.cc.length ? (<><dt>Cc</dt><dd>{addressList(header.cc)}</dd></>) : null}
            {body && body.bcc.length ? (<><dt>Bcc</dt><dd>{addressList(body.bcc)}</dd></>) : null}
            {body && body.replyTo.length ? (<><dt>Reply-To</dt><dd>{addressList(body.replyTo)}</dd></>) : null}
            <dt>Date</dt>
            <dd>{fullDate(header.date)}</dd>
          </dl>
        ) : null}
        {account ? (
          <div className="acct-chip">
            <AccountBadge color={color} name={account.displayName} letter={account.badge} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {account.displayName}{' '}
              {folderName ? <span style={{ color: 'var(--t3)' }}>&middot; {folderName}</span> : null}
            </span>
          </div>
        ) : null}
      </div>
      <div className="dt">
        {fullDate(header.date)}
      </div>
    </div>
  );
}

// ---------- body ----------
function toDataUrl(type: string, data: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < data.length; i += 0x8000) {
    bin += String.fromCharCode(...data.subarray(i, i + 0x8000));
  }
  return `data:${type};base64,${btoa(bin)}`;
}

const EMPTY_CID: Record<string, string> = {};

function BodyView({
  body,
  imagesLoaded,
  bannerDismissed,
  senderAddress,
  onLoadImages,
  onAlways,
  onDismiss,
  colorOverride,
  autoFallback,
  onAutoFallback,
  onColorInfo,
  onToggleColors,
  printRef,
  toggleLabel,
}: {
  body: MessageBody;
  imagesLoaded: boolean;
  bannerDismissed: boolean;
  senderAddress: string | null;
  onLoadImages: () => void;
  onAlways: () => void;
  onDismiss: () => void;
  colorOverride: 'original' | 'dark' | null;
  autoFallback: boolean;
  onAutoFallback: () => void;
  onColorInfo: (info: { dark: boolean } | null) => void;
  onToggleColors: (() => void) | null;
  printRef: React.MutableRefObject<() => string | undefined | null>;
  toggleLabel: { label: string; icon: 'sun' | 'moon' } | null;
}) {
  const darkTheme = useThemeState((s) => s.dark);
  const emailDarkMode = useUi((s) => s.emailDarkMode);
  const refs = useMemo(() => (body.html ? cidRefs(body.html) : []), [body.html]);
  const [fetched, setFetched] = useState<{ body: MessageBody; map: Record<string, string> } | null>(null);
  const cidReady = refs.length === 0 || fetched?.body === body;
  const cid = refs.length === 0 || !fetched ? EMPTY_CID : fetched.map;

  // Fetch small inline images referenced with cid: (max 2 MB each).
  useEffect(() => {
    if (refs.length === 0) return;
    let alive = true;
    const byCid = new Map(
      body.attachments.filter((a) => a.contentId).map((a) => [a.contentId!.replace(/^<|>$/g, '').toLowerCase(), a]),
    );
    void Promise.all(
      refs.map(async (r) => {
        const att = byCid.get(r);
        if (!att || att.size > 2 * 1024 * 1024) return null;
        try {
          const res = await call('attachments.cidData', { messageId: body.id, contentId: att.contentId! });
          if (!res || res.data.length > 2 * 1024 * 1024) return null;
          return [r, toDataUrl(res.contentType, res.data)] as const;
        } catch {
          return null;
        }
      }),
    ).then((pairs) => {
      if (!alive) return;
      setFetched({ body, map: Object.fromEntries(pairs.filter((p): p is readonly [string, string] => p !== null)) });
    });
    return () => {
      alive = false;
    };
  }, [body, refs]);

  const sanitized: SanitizedHtml | null = useMemo(
    () => (body.html && cidReady ? sanitizeEmailHtml(body.html, cid) : null),
    [body.html, cid, cidReady],
  );

  const imagesOn = imagesLoaded;
  const plan: RenderPlan | null = useMemo(
    () =>
      sanitized
        ? planBody(
            {
              html: imagesOn ? sanitized.allowed : sanitized.blocked,
              kind: sanitized.classification.kind,
              darkAware: sanitized.darkAware,
            },
            { dark: darkTheme, setting: emailDarkMode, override: colorOverride, autoFallback },
          )
        : null,
    [sanitized, imagesOn, darkTheme, emailDarkMode, colorOverride, autoFallback],
  );
  // Print always uses the light variant, never the dark-theme transform.
  useEffect(() => {
    printRef.current = () => {
      if (body.truncated) return undefined;
      if (!body.html) return undefined;
      if (!sanitized) return null;
      return imagesLoaded ? sanitized.allowed : sanitized.blocked;
    };
  }, [printRef, body, sanitized, imagesLoaded]);
  const designedInDark = !!plan && darkTheme && plan.kind === 'designed';
  const colorsDark = !!plan && (plan.variant === 'transform' || plan.variant === 'darkaware');
  useEffect(() => {
    onColorInfo(designedInDark ? { dark: colorsDark } : null);
  }, [designedInDark, colorsDark, onColorInfo]);

  if (body.truncated) {
    return (
      <div style={{ marginTop: 16 }}>
        <Banner tone="warning">
          This message is too large to show here (over 25 MB). You can still open its attachments.
        </Banner>
      </div>
    );
  }

  const showBanner = !!sanitized?.hasRemote && !imagesLoaded && !bannerDismissed;
  return (
    <>
      {showBanner ? (
        <div className="rbanner" role="status">
          <span className="ic"><Icon name="info" size={20} /></span>
          <div style={{ flex: 1 }}>
            <div>Images in this message are blocked to protect your privacy.</div>
            <div className="acts">
              <Button size="sm" variant="primary" onClick={onLoadImages}>Load images</Button>
              {senderAddress ? (
                <button type="button" className="link" onClick={onAlways}>
                  Always load from {senderAddress}
                </button>
              ) : null}
            </div>
          </div>
          <IconButton icon="x" label="Dismiss" size="sm" onClick={onDismiss} />
        </div>
      ) : null}
      <div className="mbody">
        {body.html ? (
          plan ? (
            <>
              {toggleLabel && onToggleColors ? (
                <div className="mtoggle">
                  <button type="button" onClick={onToggleColors}>
                    <Icon name={toggleLabel.icon} size={16} />
                    {toggleLabel.label}
                  </button>
                </div>
              ) : null}
              <HtmlFrame
                html={buildSrcdoc(plan.html, imagesLoaded, { css: plan.css, scheme: plan.scheme, bodyPadding: plan.bodyPadding })}
                plan={plan}
                onReject={onAutoFallback}
              />
            </>
          ) : (
            <Skeleton h={120} />
          )
        ) : body.text ? (
          <TextBody text={body.text} />
        ) : (
          <p style={{ color: 'var(--t3)' }}>(This message has no text.)</p>
        )}
      </div>
    </>
  );
}

const MIN_FRAME_HEIGHT = 24;
const FRAME_KEYS: ShortcutId[] = ['back', 'closeWindow', 'print', 'reply', 'replyAll', 'forward', 'delete', 'archive', 'markUnread', 'move', 'nextPane', 'prevPane'];

function HtmlFrame({ html, plan, onReject }: { html: string; plan: RenderPlan; onReject: () => void }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [confirmLink, setConfirmLink] = useState<{ url: string; text: string } | null>(null);
  const planRef = useRef(plan);
  const rejectRef = useRef(onReject);
  // Keep the latest values for the load handler (runs before the frame effect below).
  useEffect(() => {
    planRef.current = plan;
    rejectRef.current = onReject;
  });

  useEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    let ro: ResizeObserver | null = null;
    let revealTimer: ReturnType<typeof setTimeout> | undefined;
    const reveal = () => {
      frame.style.visibility = '';
      if (revealTimer) clearTimeout(revealTimer);
    };
    // Colors are checked after load; keep the frame hidden meanwhile so nothing flashes.
    const p0 = planRef.current;
    if (p0.verify !== 'none') {
      frame.style.visibility = 'hidden';
      revealTimer = setTimeout(reveal, 1500);
    } else frame.style.visibility = '';
    const attach = () => {
      const doc = frame.contentDocument;
      if (!doc) return;
      // The frame height follows the content (DESIGN-SPEC 3.6.1 G): shrink to 0, measure, then set.
      const measure = () => {
        frame.style.height = '0px';
        const h = Math.max(doc.documentElement.scrollHeight, doc.body?.scrollHeight ?? 0);
        const fit = Math.max(MIN_FRAME_HEIGHT, Math.ceil(h));
        frame.style.height = `${fit}px`;
        // A horizontal scrollbar (wide email) takes room from the frame: add it so no vertical bar appears.
        const bar = (frame.contentWindow?.innerHeight ?? 0) - doc.documentElement.clientHeight;
        if (bar > 0 && bar < 40) frame.style.height = `${fit + bar}px`;
      };
      const p = planRef.current;
      if (p.verify !== 'none') {
        const r = verifyContrast(doc, { strict: p.verify === 'full', spentMs: p.transformMs });
        if (r.reject) {
          rejectRef.current();
          return;
        }
        reveal();
      }
      measure();
      ro?.disconnect();
      ro = new ResizeObserver(measure);
      ro.observe(doc.documentElement);
      if (doc.body) ro.observe(doc.body);
      // Images change the height when they finish loading (load/error do not bubble: use capture).
      doc.addEventListener('load', measure, true);
      doc.addEventListener('error', measure, true);
      const onClick = (ev: MouseEvent) => {
        const a = (ev.target as Element | null)?.closest?.('a');
        if (!a) return;
        ev.preventDefault();
        const href = a.getAttribute('href') ?? '';
        if (!/^(https?:|mailto:)/i.test(href)) return;
        const text = (a.textContent ?? '').trim();
        const looksLikeUrl = /^(https?:\/\/|www\.)/i.test(text);
        let mismatch = false;
        if (looksLikeUrl) {
          try {
            const shown = new URL(/^www\./i.test(text) ? 'https://' + text : text).hostname.replace(/^www\./, '');
            const real = new URL(href).hostname.replace(/^www\./, '');
            mismatch = shown !== real;
          } catch {
            mismatch = true;
          }
        }
        if (mismatch) setConfirmLink({ url: href, text });
        else call('app.openExternal', { url: href }).catch((e) => reportActionError(e));
      };
      doc.addEventListener('click', onClick);
      doc.addEventListener('auxclick', onClick);
      // Keys typed inside the message frame never reach the window. The message window forwards its own
      // shortcuts (reply, print, close...) so they work while the body has focus.
      if (document.documentElement.dataset.window === 'message') {
        doc.addEventListener('keydown', (ev) => {
          const sc = matchShortcut(ev);
          if (!sc || !FRAME_KEYS.includes(sc.id)) return;
          ev.preventDefault();
          window.dispatchEvent(
            new KeyboardEvent('keydown', {
              key: ev.key,
              ctrlKey: ev.ctrlKey,
              shiftKey: ev.shiftKey,
              altKey: ev.altKey,
              metaKey: ev.metaKey,
              bubbles: true,
              cancelable: true,
            }),
          );
        });
      }
    };
    frame.addEventListener('load', attach);
    return () => {
      frame.removeEventListener('load', attach);
      ro?.disconnect();
      if (revealTimer) clearTimeout(revealTimer);
    };
  }, [html]);

  const iframe = (
    <iframe
      ref={ref}
      className={plan.scheme === 'dark' ? 'themed' : undefined}
      title="Message body"
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      srcDoc={html}
      tabIndex={0}
    />
  );
  return (
    <>
      {plan.card ? <div className="mcard">{iframe}</div> : iframe}
      {confirmLink ? (
        <Dialog title="Open this link?" size="sm" onClose={() => setConfirmLink(null)} initialFocus=".foot .btn:not(.primary)">
          <p>The link says it goes to a different place than it really does.</p>
          <p style={{ marginTop: 8 }}>It says: <b>{confirmLink.text}</b></p>
          <p style={{ overflowWrap: 'anywhere' }}>It goes to: <b>{confirmLink.url}</b></p>
          <div className="foot">
            <Button onClick={() => setConfirmLink(null)}>Cancel</Button>
            <Button
              variant="primary"
              onClick={() => {
                const url = confirmLink.url;
                setConfirmLink(null);
                call('app.openExternal', { url }).catch((e) => reportActionError(e));
              }}
            >
              Open anyway
            </Button>
          </div>
        </Dialog>
      ) : null}
    </>
  );
}

function TextBody({ text }: { text: string }) {
  const parts = useMemo(() => {
    const out: (string | { url: string })[] = [];
    let last = 0;
    for (const m of text.matchAll(/https?:\/\/[^\s<>"')\]]+/g)) {
      const i = m.index ?? 0;
      if (i > last) out.push(text.slice(last, i));
      out.push({ url: m[0] });
      last = i + m[0].length;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
  }, [text]);
  return (
    <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: '21px' }}>
      {parts.map((p, i) =>
        typeof p === 'string' ? (
          p
        ) : (
          <a
            key={i}
            href={p.url}
            onClick={(e) => {
              e.preventDefault();
              call('app.openExternal', { url: p.url }).catch((err) => reportActionError(err));
            }}
          >
            {p.url}
          </a>
        ),
      )}
    </div>
  );
}

// ---------- attachments ----------
function Attachments({ list }: { list: AttachmentInfo[] }) {
  if (list.length === 0) return null;
  const saveAll = async () => {
    for (const a of list) {
      try {
        const r = await call('attachments.saveAs', { attachmentId: a.id });
        if (!r.saved) break;
      } catch (e) {
        reportActionError(e);
        break;
      }
    }
  };
  return (
    <div className="atts">
      <h4>
        ATTACHMENTS ({list.length})
        <button type="button" className="link" onClick={() => void saveAll()}>
          Save all
        </button>
      </h4>
      <div className="achips">
        {list.map((a) => (
          <AttachmentChip key={a.id} a={a} />
        ))}
      </div>
    </div>
  );
}

function AttachmentChip({ a }: { a: AttachmentInfo }) {
  const [busy, setBusy] = useState(false);
  const name = a.filename ?? 'attachment';
  const kind = fileKind(a.filename, a.contentType);
  const risky = isExecutableName(name);
  const open = async () => {
    setBusy(true);
    try {
      await call('attachments.open', { attachmentId: a.id });
    } catch (e) {
      reportActionError(e);
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    setBusy(true);
    try {
      await call('attachments.saveAs', { attachmentId: a.id });
    } catch (e) {
      reportActionError(e);
    } finally {
      setBusy(false);
    }
  };
  const items = () => [
    { label: 'Open', onSelect: () => void open() },
    { label: 'Save as...', onSelect: () => void save() },
    {
      label: 'Copy file name',
      onSelect: () => void navigator.clipboard.writeText(name).then(() => toast('File name copied.'), () => toastError('Could not copy.')),
    },
  ];
  return (
    <div
      className="achip"
      onContextMenu={(e) => {
        e.preventDefault();
        useMenu.getState().open(e.clientX, e.clientY, items());
      }}
    >
      <button
        type="button"
        style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0, textAlign: 'left', height: '100%' }}
        onClick={() => void open()}
        aria-label={`Open ${name}, ${fileSize(a.size)}${risky ? ', this type of file can run programs' : ''}`}
      >
        <span className={`ft ${risky ? 'risk' : kind.cls}`}>
          {busy ? <i className="spin" /> : risky ? <Icon name="warn" /> : kind.label}
        </span>
        <span className="tx">
          <div className="n" title={name}>{name}</div>
          <div className="z">{fileSize(a.size)}</div>
        </span>
      </button>
      <IconButton
        icon="more"
        label={`More for ${name}`}
        size="sm"
        onClick={(e) => openMenuAt(e.currentTarget, items())}
      />
    </div>
  );
}

export function SourceDialog({ id, onClose }: { id: number; onClose: () => void }) {
  const [src, setSrc] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    call('messages.rawSource', { messageId: id })
      .then((r) => setSrc(r.source))
      .catch((e) => setErr(asAppError(e).message));
  }, [id]);
  return (
    <Dialog title="Message source" size="lg" onClose={onClose}>
      {err ? (
        <Banner tone="danger">{err}</Banner>
      ) : src === null ? (
        <Skeleton h={160} />
      ) : (
        <pre
          tabIndex={0}
          style={{ fontFamily: 'var(--mono)', fontSize: 12, maxHeight: 360, overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', background: 'var(--bg-alt)', padding: 12, borderRadius: 8 }}
        >
          {src.slice(0, 200_000)}
        </pre>
      )}
      <div className="foot">
        <Button onClick={onClose}>Close</Button>
      </div>
    </Dialog>
  );
}


/**
 * A loaded message body with its own state for images and dark-mode colors, and its attachments.
 * Used by the cards of a conversation and by the read-only view of a scheduled message.
 */
export function BodyPanel({ body, senderAddress, attachments }: { body: MessageBody; senderAddress: string | null; attachments?: React.ReactNode }) {
  const remoteImages = useApp((s) => s.settings?.remoteImages ?? 'block');
  const [imagesLoaded, setImagesLoaded] = useState(false);
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const [colorOverride, setColorOverride] = useState<'original' | 'dark' | null>(null);
  const [autoFallback, setAutoFallback] = useState(false);
  const [colorInfo, setColorInfo] = useState<{ dark: boolean } | null>(null);
  const printRef = useRef<() => string | undefined | null>(() => null);
  const toggleColors = colorInfo
    ? {
        label: colorInfo.dark ? 'Show original colors' : 'Show in dark mode',
        icon: (colorInfo.dark ? 'sun' : 'moon') as 'sun' | 'moon',
        run: () => setColorOverride(colorInfo.dark ? 'original' : 'dark'),
      }
    : null;
  const autoImages = !!body.senderImagesAllowed && remoteImages === 'allowKnownSenders';
  const alwaysLoad = async () => {
    if (!senderAddress) return;
    try {
      await call('senders.allowImages', { address: senderAddress, allow: true });
      if (remoteImages === 'block') await useApp.getState().updateSettings({ remoteImages: 'allowKnownSenders' });
      setImagesLoaded(true);
      toast(`Images from ${senderAddress} will load automatically. Change this in Settings, Mail.`);
    } catch (e) {
      reportActionError(e);
    }
  };
  return (
    <>
      <BodyView
        body={body}
        imagesLoaded={imagesLoaded || autoImages}
        bannerDismissed={bannerDismissed}
        senderAddress={senderAddress}
        onLoadImages={() => setImagesLoaded(true)}
        onAlways={() => void alwaysLoad()}
        onDismiss={() => setBannerDismissed(true)}
        colorOverride={colorOverride}
        autoFallback={autoFallback}
        onAutoFallback={() => setAutoFallback(true)}
        onColorInfo={setColorInfo}
        onToggleColors={toggleColors?.run ?? null}
        printRef={printRef}
        toggleLabel={toggleColors ? { label: toggleColors.label, icon: toggleColors.icon } : null}
      />
      {attachments ?? <Attachments list={body.attachments.filter((a) => !a.inline)} />}
    </>
  );
}

/**
 * The body of one open card in a conversation (DESIGN-SPEC 3.10.4): the same picture, images and
 * attachments as a single message, without the toolbar and the subject (the card has its own header).
 */
export function CardBody({ header }: { header: MessageHeader }) {
  const epoch = useApp((s) => s.epoch);
  const [state, setState] = useState<BodyState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    call('messages.get', { messageId: header.id })
      .then((body) => alive && setState({ status: 'ready', body }))
      .catch((e) => alive && setState({ status: 'error', error: asAppError(e) }));
    return () => {
      alive = false;
    };
  }, [header.id, attempt, epoch]);

  if (state.status === 'loading')
    return (
      <div className="mbody-skel" aria-busy="true" aria-label="Loading message">
        {[90, 100, 80, 95, 60, 85].map((w, i) => (
          <Skeleton key={i} w={`${w}%`} h={12} />
        ))}
      </div>
    );
  if (state.status === 'error')
    return (
      <div style={{ marginTop: 12 }}>
        <Banner
          tone="danger"
          actions={
            <Button size="sm" onClick={() => { setState({ status: 'loading' }); setAttempt((n) => n + 1); }}>
              Retry
            </Button>
          }
        >
          {state.error.code === 'HOST_UNREACHABLE' || state.error.code === 'TIMEOUT'
            ? "This message isn't available offline. Connect to the internet to read it."
            : `Couldn't load this message. ${state.error.message}`}
        </Banner>
      </div>
    );
  return <BodyPanel body={state.body} senderAddress={header.from?.address ?? null} />;
}
