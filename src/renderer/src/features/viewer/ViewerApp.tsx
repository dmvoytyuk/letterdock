// Root of the message window (DESIGN-SPEC 3.9): custom title bar, the same toolbar, header, body and
// attachments as the reading pane, for one message. Main opens it with `#msg=<messageId>`.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppError, MessageHeader } from '../../../../shared/ipc';
import { Banner, Button, MenuHost, ToastHost, useMenu } from '../../components/ui';
import { Icon } from '../../components/Icon';
import { MessageView } from '../reading/ReadingPane';
import { MailDialogsHost } from '../dialogs/MailDialogs';
import { useApp } from '../../store/app';
import { useList } from '../../store/list';
import { undoWithToken } from '../../store/undo';
import { handleOutboxEvent } from '../../store/outbox';
import { useThemeEffect } from '../../lib/hooks';
import { asAppError, call } from '../../lib/api';
import { applyToMessages, composeFrom, deleteMessages, setLeaveHandler } from '../../lib/actions';
import { printOpenMessage } from '../../lib/print';
import { matchShortcut, isTypingTarget } from '../../lib/shortcuts';
import { useUi } from '../../store/ui';
import appIcon from '../../../../../build/icon-small.svg';

const UNDO_PANEL_MS = 6000;

type Load = { status: 'loading' } | { status: 'error'; error: AppError } | { status: 'ready' };

/** Focus targets of F6, in order: toolbar, header, body, attachments. */
function focusZones(): (HTMLElement | null)[] {
  return [
    document.querySelector<HTMLElement>('.rtool button:not([disabled])'),
    document.querySelector<HTMLElement>('.rhead button'),
    document.querySelector<HTMLElement>('.mbody iframe, .mbody'),
    document.querySelector<HTMLElement>('.atts button'),
  ];
}

const NO_MESSAGE: AppError = { code: 'INVALID_INPUT', message: 'No message was selected.', retryable: false };

export function ViewerApp({ messageId }: { messageId: number | null }) {
  useThemeEffect();
  const [load, setLoad] = useState<Load>(
    messageId === null ? { status: 'error', error: NO_MESSAGE } : { status: 'loading' },
  );
  const [gone, setGone] = useState(false);
  const [left, setLeft] = useState<{ label: string; token?: string } | null>(null);
  const header = useList((s) => s.items.find((m) => m.id === messageId));
  const folderRef = useRef<number | null>(null);
  const loadedRef = useRef(false);

  const fetchHeader = useCallback(async (): Promise<MessageHeader | null> => {
    if (messageId === null) return null;
    const [h] = await call('messages.getHeaders', { messageIds: [messageId] });
    return h ?? null;
  }, [messageId]);

  const refreshHeader = useCallback(async () => {
    try {
      const h = await fetchHeader();
      if (!h) {
        setGone(true);
        return;
      }
      useList.setState({ items: [h], selectedIds: [h.id], focusId: h.id });
      if (folderRef.current !== null && h.folderId !== folderRef.current) setGone(true);
    } catch {
      /* the next event retries */
    }
  }, [fetchHeader]);

  // First load: accounts, folders and settings (the header block and the Move dialog need them), then the message.
  useEffect(() => {
    if (messageId === null) return;
    let alive = true;
    void (async () => {
      try {
        const [accounts, statuses, folders, settings] = await Promise.all([
          call('accounts.list'),
          call('accounts.statuses'),
          call('folders.list', {}),
          call('settings.get'),
        ]);
        useApp.setState({
          accounts,
          statuses: Object.fromEntries(statuses.map((s) => [s.accountId, s])),
          folders,
          settings,
          loaded: true,
        });
        const h = await fetchHeader();
        if (!alive) return;
        if (!h) {
          setLoad({
            status: 'error',
            error: { code: 'NOT_FOUND', message: 'This message is no longer available.', retryable: false },
          });
          return;
        }
        useList.setState({ items: [h], selectedIds: [h.id], focusId: h.id });
        folderRef.current = h.folderId;
        loadedRef.current = true;
        setLoad({ status: 'ready' });
      } catch (e) {
        if (alive) setLoad({ status: 'error', error: asAppError(e) });
      }
    })();
    return () => {
      alive = false;
    };
  }, [messageId, fetchHeader]);

  // Events from the engine: other windows may move or delete this message.
  useEffect(() => {
    const off = window.api.on((e) => {
      useApp.getState().handleEvent(e);
      handleOutboxEvent(e);
      if (e.type === 'messages:changed' && loadedRef.current && messageId !== null) {
        if (e.removed.includes(messageId)) setGone(true);
        else if (e.updated.includes(messageId)) void refreshHeader();
      } else if (e.type === 'engine:restarted') {
        void refreshHeader();
      }
    });
    return off;
  }, [messageId, refreshHeader]);

  // Archive, delete and move: show an Undo panel, then close the window.
  useEffect(() => setLeaveHandler((info) => setLeft(info)), []);
  useEffect(() => {
    if (!left) return;
    const h = setTimeout(() => window.close(), left.token ? UNDO_PANEL_MS : 600);
    return () => clearTimeout(h);
  }, [left]);

  // Window title (taskbar and title bar): "Subject - Mailroom".
  const subject = header ? header.subject || '(no subject)' : null;
  useEffect(() => {
    document.title = subject ? `${subject} - Mailroom` : 'Mailroom';
    document.documentElement.dataset.window = 'message';
  }, [subject]);

  // Focus starts on the message body.
  const ready = load.status === 'ready';
  useEffect(() => {
    if (!ready) return;
    let tries = 0;
    const h = setInterval(() => {
      const el = document.querySelector<HTMLElement>('.mbody iframe, .mbody');
      tries++;
      if (el) {
        el.setAttribute('tabindex', '0');
        el.focus();
      }
      if (el || tries > 30) clearInterval(h);
    }, 100);
    return () => clearInterval(h);
  }, [ready]);

  // Keys (DESIGN-SPEC 3.9). Esc first closes an open menu or dialog, else the window.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || messageId === null) return;
      const sc = matchShortcut(e);
      if (!sc) return;
      if (document.querySelector('.modal') || useMenu.getState().menu) return;
      if (isTypingTarget(e.target) && sc.id !== 'back' && sc.id !== 'closeWindow') return;
      const run = (fn: () => void) => {
        e.preventDefault();
        fn();
      };
      const live = !gone && !left;
      switch (sc.id) {
        case 'back':
        case 'closeWindow':
          return run(() => window.close());
        case 'print':
          return run(() => printOpenMessage(messageId));
        case 'reply':
          return run(() => composeFrom('reply', messageId));
        case 'replyAll':
          return run(() => composeFrom('replyAll', messageId));
        case 'forward':
          return run(() => composeFrom('forward', messageId));
        case 'delete':
        case 'deletePermanent':
          return run(() => {
            if (live) deleteMessages([messageId]);
          });
        case 'archive':
          return run(() => {
            if (live) void applyToMessages([messageId], { type: 'archive' });
          });
        case 'markUnread':
          return run(() => {
            if (live) void applyToMessages([messageId], { type: 'markRead', read: false });
          });
        case 'move':
          return run(() => {
            if (live) useUi.getState().set({ moveDialog: [messageId] });
          });
        case 'nextPane':
        case 'prevPane':
          return run(() => {
            const zones = focusZones().filter((z): z is HTMLElement => !!z);
            if (zones.length === 0) return;
            const at = zones.findIndex((z) => z === document.activeElement || z.contains(document.activeElement));
            const next = (at + (sc.id === 'nextPane' ? 1 : -1) + zones.length) % zones.length;
            zones[next]!.focus();
          });
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [messageId, gone, left]);

  let content;
  if (load.status === 'loading' || (load.status === 'ready' && !header)) {
    content = (
      <div className="vload" aria-busy="true" aria-label="Loading message">
        <i className="spin big" />
      </div>
    );
  } else if (load.status === 'error') {
    content = (
      <div className="vload">
        <Banner tone="danger" actions={<Button size="sm" onClick={() => window.close()}>Close</Button>}>
          {load.error.message}
        </Banner>
      </div>
    );
  } else if (left) {
    content = (
      <div className="vload vleft" role="status">
        <Icon name="check" size={24} />
        <p>{left.label}</p>
        {left.token ? (
          <Button
            variant="primary"
            onClick={() => {
              const token = left.token!;
              setLeft(null);
              setGone(false);
              void undoWithToken(token).then(() => refreshHeader());
            }}
          >
            Undo
          </Button>
        ) : null}
        <button type="button" className="link" onClick={() => window.close()}>
          Close window
        </button>
      </div>
    );
  } else {
    content = <MessageView key={header!.id} header={header!} windowMode gone={gone} />;
  }

  return (
    <div className="app vwin">
      <header className="titlebar ctitle vtitle" role="banner">
        <img className="appico" src={appIcon} alt="" aria-hidden="true" draggable={false} />
        <b>{subject ?? 'Message'}</b>
      </header>
      <main className="reading" aria-label="Message" id="pane-reading" style={{ containerType: 'inline-size' }}>
        {content}
      </main>
      <MailDialogsHost />
      <MenuHost />
      <ToastHost />
    </div>
  );
}
