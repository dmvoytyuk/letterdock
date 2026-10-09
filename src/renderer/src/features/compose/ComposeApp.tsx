import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Account, Address, AppError, ComposeDraft, DraftAttachment, PrepareComposeReq, SendReq } from '../../../../shared/ipc';
import { Icon } from '../../components/Icon';
import { AccountBadge, Banner, Button, Dialog, IconButton, MenuHost, ToastHost, openMenuAt, useMenu } from '../../components/ui';
import { useApp } from '../../store/app';
import { syncKindOf } from '../../components/Sync';
import { useAccountColor, useThemeEffect } from '../../lib/hooks';
import { asAppError, call, logRenderer } from '../../lib/api';
import { fileSize } from '../../lib/format';
import {
  MAX_ATTACH_BYTES,
  WARN_ATTACH_BYTES,
  addAddresses,
  isValidAddress,
  resolvePending,
  mentionsAttachment,
  normalizeUrl,
  signatureHtml,
} from '../../lib/compose';
import { toast, toastError } from '../../store/toasts';
import { RecipientField, type RecipientKind } from './RecipientField';
import { FormatBar, RichEditor, type RichEditorHandle, type ToolbarState } from './RichEditor';

const AUTOSAVE_MS = 10_000;

/** Entry component of the compose window: loads what it needs, then shows the form. */
export function ComposeApp({ request }: { request: PrepareComposeReq }) {
  useThemeEffect();
  const [draft, setDraft] = useState<ComposeDraft | null>(null);
  const [error, setError] = useState<AppError | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [accounts, statuses, settings] = await Promise.all([
          call('accounts.list'),
          call('accounts.statuses'),
          call('settings.get'),
        ]);
        useApp.setState({
          accounts,
          statuses: Object.fromEntries(statuses.map((s) => [s.accountId, s])),
          settings,
          loaded: true,
        });
        const d = await call('compose.prepare', request);
        if (alive) setDraft(d);
      } catch (e) {
        if (alive) setError(asAppError(e));
      }
    })();
    const off = window.api.on((e) => useApp.getState().handleEvent(e));
    return () => {
      alive = false;
      off();
    };
  }, [request]);

  useEffect(() => {
    document.title = error ? 'Message' : 'New message';
  }, [error]);

  if (error) {
    return (
      <div className="app cmp">
        <header className="titlebar ctitle">
          <b>Message</b>
        </header>
        <div className="cfail">
          <Banner tone="danger">{error.message}</Banner>
          <Button onClick={() => window.close()}>Close</Button>
        </div>
      </div>
    );
  }
  if (!draft) {
    return (
      <div className="app cmp" aria-busy="true">
        <header className="titlebar ctitle">
          <b>New message</b>
        </header>
        <div className="cfail">
          <i className="spin big" />
        </div>
        <ToastHost />
      </div>
    );
  }
  return <ComposeForm draft={draft} request={request} />;
}

type Confirm = 'subject' | 'attach' | 'discard' | null;

function usable(a: Account, kindBad: boolean): boolean {
  return a.enabled && !kindBad;
}

function ComposeForm({ draft, request }: { draft: ComposeDraft; request: PrepareComposeReq }) {
  const accounts = useApp((s) => s.accounts);
  const statuses = useApp((s) => s.statuses);
  const online = useApp((s) => s.online);
  const colorOf = useAccountColor();

  const [accountId, setAccountId] = useState(draft.accountId);
  const [to, setTo] = useState<Address[]>(draft.to);
  const [cc, setCc] = useState<Address[]>(draft.cc);
  const [bcc, setBcc] = useState<Address[]>(draft.bcc);
  // Addresses already in To, Cc or Bcc are not suggested again.
  const excluded = useMemo(() => [...to, ...cc, ...bcc].map((a) => a.address.toLowerCase()), [to, cc, bcc]);
  // Cc / Bcc rows (DESIGN-SPEC 3.7): shown when they have recipients, when the user asks, or always (setting).
  const alwaysShow = useApp((s) => s.settings?.alwaysShowCcBcc ?? false);
  const [wantCc, setShowCc] = useState(draft.cc.length > 0);
  const [wantBcc, setShowBcc] = useState(draft.bcc.length > 0);
  const [anim, setAnim] = useState({ cc: false, bcc: false });
  const showCc = alwaysShow || wantCc;
  const showBcc = alwaysShow || wantBcc;
  const [subject, setSubject] = useState(draft.subject);
  const [atts, setAtts] = useState<DraftAttachment[]>(draft.attachments);
  const [pending, setPending] = useState<string[]>([]);
  const [fmt, setFmt] = useState<ToolbarState>({});
  const [status, setStatus] = useState('');
  const [sending, setSending] = useState(false);
  const [sentDone, setSentDone] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [toError, setToError] = useState<string | null>(null);
  const [fixError, setFixError] = useState<{ kind: RecipientKind; text: string } | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [linkDlg, setLinkDlg] = useState<{ hasSelection: boolean } | null>(null);
  const [dragging, setDragging] = useState(false);

  const editor = useRef<RichEditorHandle>(null);
  const toInput = useRef<HTMLInputElement>(null);
  const ccInput = useRef<HTMLInputElement>(null);
  const bccInput = useRef<HTMLInputElement>(null);
  const subjectInput = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sent = useRef(false);
  const handled = useRef(false);
  const initialSnap = useRef('');
  const savedSnap = useRef('');
  const dragDepth = useRef(0);
  const reopened = !!(request.draftId || request.draftMessageId);

  const account = accounts.find((a) => a.id === accountId);
  const total = atts.reduce((n, a) => n + a.size, 0);

  // Text typed in a recipient box but not yet a chip. A complete address counts as a recipient when
  // saving or sending; anything else is never stored as one (and blocks Send).
  const pendingText = useRef({ to: '', cc: '', bcc: '' });
  const withPending = useCallback(
    (kind: RecipientKind, list: Address[]) => resolvePending(list, pendingText.current[kind]),
    [],
  );

  const snapshot = useCallback(
    () =>
      JSON.stringify({
        accountId,
        to: withPending('to', to).list,
        cc: withPending('cc', cc).list,
        bcc: withPending('bcc', bcc).list,
        subject,
        atts: atts.map((a) => a.tokenId),
        html: editor.current?.getHtml() ?? '',
      }),
    [accountId, to, cc, bcc, subject, atts, withPending],
  );
  // The snapshot closure goes stale; the save code reads the latest through this ref.
  const snapRef = useRef(snapshot);
  useEffect(() => {
    snapRef.current = snapshot;
  });

  const buildReq = useCallback(
    (): SendReq => ({
      draftId: draft.draftId,
      accountId,
      to: withPending('to', to).list,
      cc: withPending('cc', cc).list,
      bcc: withPending('bcc', bcc).list,
      subject,
      html: editor.current?.getHtml() ?? '',
      attachmentTokens: atts.map((a) => a.tokenId),
    }),
    [draft.draftId, accountId, to, cc, bcc, subject, atts, withPending],
  );
  const reqRef = useRef(buildReq);
  useEffect(() => {
    reqRef.current = buildReq;
  });

  const isMeaningful = () => reopened || snapRef.current() !== initialSnap.current;

  useEffect(() => {
    // The editor fills itself in its own effect, which runs before this one.
    initialSnap.current = snapRef.current();
    savedSnap.current = reopened ? initialSnap.current : '';
    if (draft.to.length === 0) toInput.current?.focus();
    else editor.current?.focusStart();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = useCallback(async (): Promise<boolean> => {
    if (sent.current || handled.current) return false;
    if (!isMeaningful()) return false;
    const snap = snapRef.current();
    if (snap === savedSnap.current) return true;
    try {
      const r = await call('compose.saveDraft', reqRef.current());
      savedSnap.current = snap;
      setStatus(`Draft saved ${new Date(r.savedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`);
      return true;
    } catch (e) {
      setStatus("Couldn't save the draft");
      logRenderer('warn', `draft save failed: ${asAppError(e).message}`);
      return false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Autosave 10 seconds after the last change.
  const changed = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      void save();
    }, AUTOSAVE_MS);
  }, [save]);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const onPending = useCallback(
    (kind: RecipientKind, text: string) => {
      if (pendingText.current[kind] === text) return;
      pendingText.current[kind] = text;
      changed();
    },
    [changed],
  );
  // Any field change schedules an autosave (the editor calls `changed` itself).
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    changed();
  }, [accountId, to, cc, bcc, subject, atts, changed]);

  const title = subject.trim() || 'New message';
  useEffect(() => {
    document.title = title;
  }, [title]);

  // ----- leaving -----
  const closeNow = () => {
    handled.current = true;
    window.close();
  };

  const closeWindow = useCallback(async () => {
    if (sent.current) {
      closeNow();
      return;
    }
    if (timer.current) clearTimeout(timer.current);
    if (isMeaningful()) {
      await Promise.race([save(), new Promise((r) => setTimeout(r, 2000))]);
    } else {
      void call('compose.discard', { draftId: draft.draftId }).catch(() => undefined);
    }
    closeNow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [save, draft.draftId]);

  useEffect(() => {
    const onUnload = () => {
      if (sent.current || handled.current) return;
      if (isMeaningful()) {
        if (snapRef.current() !== savedSnap.current) void call('compose.saveDraft', reqRef.current()).catch(() => undefined);
      } else {
        void call('compose.discard', { draftId: draft.draftId }).catch(() => undefined);
      }
    };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.draftId]);

  // ----- attachments -----
  const addFiles = useCallback(
    async (files: File[]) => {
      for (const f of files) {
        if (f.size > MAX_ATTACH_BYTES) {
          toastError(`"${f.name}" is larger than 25 MB, so it cannot be attached.`);
          continue;
        }
        const key = `${f.name}-${f.size}-${Date.now()}`;
        setPending((p) => [...p, key]);
        try {
          const data = new Uint8Array(await f.arrayBuffer());
          const att = await call('compose.attachData', {
            filename: f.name || 'attachment',
            contentType: f.type || 'application/octet-stream',
            data,
          });
          setAtts((a) => [...a, att]);
        } catch (e) {
          toastError(asAppError(e).message);
        } finally {
          setPending((p) => p.filter((x) => x !== key));
        }
      }
    },
    [],
  );

  const pickFiles = useCallback(async () => {
    try {
      const r = await call('compose.pickFiles');
      if (r.attachments.length > 0) setAtts((a) => [...a, ...r.attachments]);
    } catch (e) {
      toastError(asAppError(e).message);
    }
  }, []);

  // ----- sending -----
  const trySend = useCallback(
    async (skip: { subject?: boolean; attach?: boolean } = {}) => {
      if (sending || sent.current) return;
      setBanner(null);
      setToError(null);
      setFixError(null);
      const rt = withPending('to', to);
      const rc = withPending('cc', cc);
      const rb = withPending('bcc', bcc);
      const all: [RecipientKind, Address[], boolean][] = [['to', rt.list, rt.bad], ['cc', rc.list, rc.bad], ['bcc', rb.list, rb.bad]];
      // Typed text that is not a real address counts as an invalid address.
      const count = (l: Address[], bad: boolean) => l.filter((a) => !isValidAddress(a)).length + (bad ? 1 : 0);
      const invalid = all.reduce((n, [, l, bad]) => n + count(l, bad), 0);
      if (invalid > 0) {
        const kind = all.find(([, l, bad]) => count(l, bad) > 0)![0];
        if (kind === 'cc') setShowCc(true);
        if (kind === 'bcc') setShowBcc(true);
        setFixError({ kind, text: invalid === 1 ? 'Fix 1 invalid address' : `Fix ${invalid} invalid addresses` });
        return;
      }
      if (rt.list.length + rc.list.length + rb.list.length === 0) {
        setToError('Add at least one recipient');
        toInput.current?.focus();
        return;
      }
      if (total > MAX_ATTACH_BYTES) {
        setBanner(`The attachments are ${fileSize(total)}. Messages over 25 MB are rejected by most providers. Remove some files.`);
        return;
      }
      if (!skip.subject && !subject.trim()) {
        setConfirm('subject');
        return;
      }
      if (!skip.attach && atts.length === 0 && pending.length === 0 && mentionsAttachment(editor.current?.getOwnText() ?? '')) {
        setConfirm('attach');
        return;
      }
      if (timer.current) clearTimeout(timer.current);
      setSending(true);
      try {
        await call('compose.send', buildReq());
        sent.current = true;
        handled.current = true;
        setSentDone(true);
        window.close();
      } catch (e) {
        setSending(false);
        const err = asAppError(e);
        setBanner(err.message);
      }
    },
    [sending, to, cc, bcc, total, subject, atts.length, pending.length, buildReq, withPending],
  );
  const trySendRef = useRef(trySend);
  useEffect(() => {
    trySendRef.current = trySend;
  });

  // ----- discard -----
  const doDiscard = async () => {
    handled.current = true;
    if (timer.current) clearTimeout(timer.current);
    try {
      await call('compose.discard', { draftId: draft.draftId });
    } catch {
      /* the draft is gone from the screen anyway */
    }
    window.close();
  };
  const askDiscard = () => {
    const hasText = (editor.current?.getOwnText().trim().length ?? 0) > 0;
    const typed = pendingText.current.to.trim() || pendingText.current.cc.trim() || pendingText.current.bcc.trim();
    if (hasText || subject.trim() || atts.length > 0 || typed || to.length + cc.length + bcc.length > 0) setConfirm('discard');
    else void doDiscard();
  };

  // ----- link -----
  const askLink = () => {
    editor.current?.saveSelection();
    setLinkDlg({ hasSelection: (editor.current?.selectedText().length ?? 0) > 0 });
  };

  // ----- Cc / Bcc rows -----
  const revealRow = useCallback((k: 'cc' | 'bcc') => {
    (k === 'cc' ? setShowCc : setShowBcc)(true);
    setAnim((a) => ({ ...a, [k]: true }));
    setTimeout(() => (k === 'cc' ? ccInput : bccInput).current?.focus(), 0);
  }, []);
  const hideRow = (k: 'cc' | 'bcc') => {
    (k === 'cc' ? setShowCc : setShowBcc)(false);
    setTimeout(() => toInput.current?.focus(), 0);
  };
  const toggleRow = (k: 'cc' | 'bcc') => {
    const shown = k === 'cc' ? showCc : showBcc;
    const has = (k === 'cc' ? cc : bcc).length > 0;
    if (!shown) revealRow(k);
    else if (has) (k === 'cc' ? ccInput : bccInput).current?.focus();
    else hideRow(k);
  };

  // ----- shortcuts -----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const k = e.key.toLowerCase();
      if (e.ctrlKey && k === 'enter') {
        e.preventDefault();
        void trySendRef.current();
      } else if (e.altKey && !e.ctrlKey && k === 's') {
        e.preventDefault();
        void trySendRef.current();
      } else if (e.ctrlKey && !e.shiftKey && k === 's') {
        e.preventDefault();
        void save().then((ok) => ok && toast('Draft saved.'));
      } else if (e.ctrlKey && !e.shiftKey && k === 'k') {
        e.preventDefault();
        askLink();
      } else if (e.ctrlKey && e.shiftKey && k === 'h') {
        e.preventDefault();
        void pickFiles();
      } else if (e.ctrlKey && e.shiftKey && k === 'c') {
        e.preventDefault();
        revealRow('cc');
      } else if (e.ctrlKey && e.shiftKey && k === 'b') {
        e.preventDefault();
        revealRow('bcc');
      } else if (e.key === 'Escape' && !document.querySelector('.modal') && !useMenu.getState().menu) {
        e.preventDefault();
        void closeWindow();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save, pickFiles, closeWindow, revealRow]);

  // ----- From picker -----
  const changeFrom = (next: Account) => {
    if (next.id === accountId) return;
    const old = accounts.find((a) => a.id === accountId);
    editor.current?.swapSignature(signatureHtml(old?.signature), signatureHtml(next.signature));
    setAccountId(next.id);
  };
  const openFromMenu = (el: HTMLElement) =>
    openMenuAt(
      el,
      accounts.map((a) => {
        const kind = syncKindOf(statuses[a.id], false, online);
        const bad = kind === 'auth';
        return {
          label: `${a.displayName} <${a.email}>${bad ? ' (sign in again)' : !a.enabled ? ' (turned off)' : ''}`,
          disabled: !usable(a, bad),
          onSelect: () => changeFrom(a),
        };
      }),
    );

  const move = (a: Address, from: RecipientKind, target: RecipientKind) => {
    const set = { to: setTo, cc: setCc, bcc: setBcc };
    const cur = { to, cc, bcc };
    set[from](cur[from].filter((x) => x !== a));
    set[target](addAddresses(cur[target], [a]));
    if (target === 'cc') setShowCc(true);
    if (target === 'bcc') setShowBcc(true);
  };

  const accountBad = useMemo(
    () => (account ? syncKindOf(statuses[account.id], false, online) === 'auth' : false),
    [account, statuses, online],
  );

  return (
    <div
      className="app cmp"
      onDragEnter={(e) => {
        if (!Array.from(e.dataTransfer.types).includes('Files')) return;
        dragDepth.current++;
        setDragging(true);
      }}
      onDragOver={(e) => {
        if (Array.from(e.dataTransfer.types).includes('Files')) e.preventDefault();
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragging(false);
      }}
      onDrop={(e) => {
        dragDepth.current = 0;
        setDragging(false);
        if (e.dataTransfer.files.length > 0) {
          e.preventDefault();
          void addFiles(Array.from(e.dataTransfer.files));
        }
      }}
    >
      <header className="titlebar ctitle" role="banner">
        <span className="appico" aria-hidden="true">
          <Icon name="edit" />
        </span>
        <b>{title}</b>
        <span className="cstatus" role="status">
          {status}
        </span>
      </header>

      <div className="ctool" role="toolbar" aria-label="Message actions">
        <Button variant="primary" icon="send" loading={sending} disabled={sentDone || accountBad} onClick={() => void trySend()} title="Send (Ctrl+Enter)">
          Send
        </Button>
        <Button variant="subtle" icon="clip" onClick={() => void pickFiles()} title="Attach files (Ctrl+Shift+H)">
          Attach
        </Button>
        <Button variant="subtle" icon="link" onClick={askLink} title="Insert link (Ctrl+K)">
          Insert link
        </Button>
        <span style={{ marginLeft: 'auto' }} />
        <Button variant="subtle" icon="trash" onClick={askDiscard} title="Discard this message">
          Discard
        </Button>
        <Button variant="subtle" onClick={() => void save().then((ok) => ok && toast('Draft saved.'))} title="Save draft (Ctrl+S)">
          Save
        </Button>
      </div>

      {banner ? (
        <Banner tone="danger" onDismiss={() => setBanner(null)} className="cbanner">
          {banner}
        </Banner>
      ) : null}
      {accountBad && account ? (
        <Banner tone="warning" className="cbanner">
          {account.displayName} needs you to sign in again before it can send mail. Choose another account in From, or sign in again from the main window.
        </Banner>
      ) : null}
      {total > WARN_ATTACH_BYTES && total <= MAX_ATTACH_BYTES ? (
        <Banner tone="warning" className="cbanner">
          Attachments are {fileSize(total)}. Some providers reject files over 25 MB.
        </Banner>
      ) : null}

      <div className="cfields">
        <div className="crow">
          <label id="from-lbl">From</label>
          {accounts.length > 1 ? (
            <button
              type="button"
              className="fromsel"
              aria-haspopup="menu"
              aria-labelledby="from-lbl from-val"
              onClick={(e) => openFromMenu(e.currentTarget)}
            >
              {account ? <AccountBadge color={colorOf(account.id)} name={account.displayName} letter={account.badge} /> : null}
              <span id="from-val" className="fv">
                {account ? `${account.displayName} <${account.email}>` : 'Choose an account'}
              </span>
              <Icon name="chev-d" />
            </button>
          ) : (
            <div className="fromsel static" id="from-val">
              {account ? <AccountBadge color={colorOf(account.id)} name={account.displayName} letter={account.badge} /> : null}
              <span className="fv">{account ? `${account.displayName} <${account.email}>` : ''}</span>
            </div>
          )}
        </div>
        <RecipientField
          kind="to"
          onPending={onPending}
          value={to}
          onChange={(v) => {
            setTo(v);
            setToError(null);
          }}
          onMove={(a, k) => move(a, 'to', k)}
          inputRef={toInput}
          accountId={accountId}
          exclude={excluded}
          error={toError ?? (fixError?.kind === 'to' ? fixError.text : null)}
          extra={
            alwaysShow ? null : (
              <span className="cc">
                <button
                  type="button"
                  className="cbtn"
                  aria-pressed={showCc}
                  aria-label="Add Cc recipients"
                  title="Add Cc (Ctrl+Shift+C)"
                  onClick={() => toggleRow('cc')}
                >
                  Cc
                </button>
                <button
                  type="button"
                  className="cbtn"
                  aria-pressed={showBcc}
                  aria-label="Add Bcc (hidden copy) recipients"
                  aria-describedby="bcc-explain"
                  title="Add Bcc - hidden copy. Other recipients can't see these addresses. (Ctrl+Shift+B)"
                  onClick={() => toggleRow('bcc')}
                >
                  Bcc
                </button>
                <span id="bcc-explain" className="sr-only">
                  Hidden copy: other recipients can&apos;t see these addresses.
                </span>
              </span>
            )
          }
        />
        {showCc ? (
          <RecipientField kind="cc" onPending={onPending} className={anim.cc ? 'crow-in' : undefined} onHide={alwaysShow ? undefined : () => hideRow('cc')} value={cc} onChange={setCc} onMove={(a, k) => move(a, 'cc', k)} inputRef={ccInput} accountId={accountId} exclude={excluded} error={fixError?.kind === 'cc' ? fixError.text : null} />
        ) : null}
        {showBcc ? (
          <RecipientField kind="bcc" onPending={onPending} className={anim.bcc ? 'crow-in' : undefined} placeholder="Hidden copy: other recipients can't see these addresses" onHide={alwaysShow ? undefined : () => hideRow('bcc')} value={bcc} onChange={setBcc} onMove={(a, k) => move(a, 'bcc', k)} inputRef={bccInput} accountId={accountId} exclude={excluded} error={fixError?.kind === 'bcc' ? fixError.text : null} />
        ) : null}
        <div className="crow">
          <label htmlFor="subject">Subject</label>
          <input
            id="subject"
            ref={subjectInput}
            className="subj"
            value={subject}
            autoComplete="off"
            onChange={(e) => setSubject(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                editor.current?.focusStart();
              }
            }}
          />
        </div>
      </div>

      <FormatBar state={fmt} onExec={(c) => editor.current?.exec(c)} onLink={askLink} />
      <div className="ebox scroll" onClick={(e) => { if (e.target === e.currentTarget) editor.current?.focus(); }}>
        <RichEditor
          ref={editor}
          initialHtml={draft.html}
          label="Message body"
          onChange={changed}
          onFiles={(f) => void addFiles(f)}
          onToolbarState={setFmt}
        />
      </div>

      {atts.length > 0 || pending.length > 0 ? (
        <div className="catts" role="list" aria-label="Attachments">
          {atts.map((a) => (
            <span key={a.tokenId} className="catt" role="listitem">
              <Icon name="file" />
              <span className="n" title={a.filename}>{a.filename}</span>
              <span className="z">{fileSize(a.size)}</span>
              <IconButton
                icon="x"
                label={`Remove ${a.filename}`}
                size="xs"
                onClick={() => setAtts((l) => l.filter((x) => x.tokenId !== a.tokenId))}
              />
            </span>
          ))}
          {pending.map((k) => (
            <span key={k} className="catt" role="listitem" aria-busy="true">
              <i className="spin" />
              <span className="n">Adding file...</span>
            </span>
          ))}
        </div>
      ) : null}

      {dragging ? (
        <div className="cdrop" aria-hidden="true">
          <div>Drop files to attach</div>
        </div>
      ) : null}

      {confirm === 'subject' ? (
        <Dialog title="Send without a subject?" size="sm" onClose={() => setConfirm(null)} initialFocus=".foot .btn:not(.primary)">
          <p>This message has no subject.</p>
          <div className="foot">
            <Button onClick={() => { setConfirm(null); subjectInput.current?.focus(); }}>Cancel</Button>
            <Button variant="primary" onClick={() => { setConfirm(null); void trySend({ subject: true }); }}>
              Send anyway
            </Button>
          </div>
        </Dialog>
      ) : null}
      {confirm === 'attach' ? (
        <Dialog title="Forgot the attachment?" size="sm" onClose={() => setConfirm(null)} initialFocus=".foot .btn:not(.primary)">
          <p>You wrote &ldquo;attached&rdquo; but there is no attachment.</p>
          <div className="foot">
            <Button onClick={() => { setConfirm(null); void pickFiles(); }}>Attach a file</Button>
            <Button variant="primary" onClick={() => { setConfirm(null); void trySend({ attach: true }); }}>
              Send anyway
            </Button>
          </div>
        </Dialog>
      ) : null}
      {confirm === 'discard' ? (
        <Dialog title="Discard this message?" size="sm" onClose={() => setConfirm(null)} initialFocus=".foot .btn:not(.danger)">
          <p>The draft will be deleted. This cannot be undone.</p>
          <div className="foot">
            <Button onClick={() => setConfirm(null)}>Keep editing</Button>
            <Button variant="danger" onClick={() => { setConfirm(null); void doDiscard(); }}>
              Discard
            </Button>
          </div>
        </Dialog>
      ) : null}
      {linkDlg ? (
        <LinkDialog
          hasSelection={linkDlg.hasSelection}
          onClose={() => {
            setLinkDlg(null);
            editor.current?.focus();
          }}
          onInsert={(url, text) => {
            setLinkDlg(null);
            editor.current?.insertLink(url, text);
          }}
        />
      ) : null}
      {sentDone ? (
        <div className="cdrop on-sent" role="status">
          <div>Message sent. You can close this window.</div>
        </div>
      ) : null}
      <MenuHost />
      <ToastHost />
    </div>
  );
}

function LinkDialog({
  hasSelection,
  onClose,
  onInsert,
}: {
  hasSelection: boolean;
  onClose: () => void;
  onInsert: (url: string, text?: string) => void;
}) {
  const [url, setUrl] = useState('');
  const [text, setText] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const submit = () => {
    const u = normalizeUrl(url);
    if (!u) {
      setErr('Enter a web address (like example.com) or an email address.');
      return;
    }
    onInsert(u, text);
  };
  return (
    <Dialog title="Insert link" size="sm" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="field">
          <label htmlFor="link-url">Web address</label>
          <input id="link-url" className={`inp ${err ? 'err' : ''}`} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" autoComplete="off" aria-invalid={err ? true : undefined} />
          {err ? <div className="bad"><Icon name="warn" />{err}</div> : null}
        </div>
        {!hasSelection ? (
          <div className="field">
            <label htmlFor="link-text">Text to show (optional)</label>
            <input id="link-text" className="inp" value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" />
          </div>
        ) : null}
        <div className="foot">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!url.trim()}>
            Insert
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
