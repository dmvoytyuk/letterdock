import { useEffect, useRef, useState, type ReactNode } from 'react';
import type {
  Account,
  AppError,
  DiscoveredConfig,
  ServerEndpoint,
  Security,
  TestAccountRes,
} from '../../../../shared/ipc';
import { resolveUsername } from '../../../../shared/providers';
import { Icon } from '../../components/Icon';
import { MsLogo } from '../../components/Icon';
import { Banner, Button, Dialog, IconButton, PasswordField, SelectField, TextField } from '../../components/ui';
import { accountInbox, useApp } from '../../store/app';
import { useUi, type AddAccountRequest } from '../../store/ui';
import { asAppError, call } from '../../lib/api';
import { domainOf, isValidEmail } from '../../lib/format';
import { cleanPassword, isAppPasswordProvider } from '../../lib/password';
import { toast } from '../../store/toasts';

type Step = 'email' | 'detecting' | 'credentials' | 'oauth' | 'manual' | 'verify';

interface ServerForm {
  host: string;
  port: string;
  security: Security;
}

const DEFAULT_PORT: Record<'imap' | 'smtp', Record<Security, number>> = {
  imap: { ssl: 993, starttls: 143 },
  smtp: { ssl: 465, starttls: 587 },
};

const toEndpoint = (f: ServerForm): ServerEndpoint => ({
  host: f.host.trim(),
  port: Number(f.port),
  security: f.security,
});
const fromEndpoint = (e: ServerEndpoint): ServerForm => ({
  host: e.host,
  port: String(e.port),
  security: e.security,
});

export function AddAccountDialog({ request }: { request: AddAccountRequest }) {
  const close = () => useUi.getState().set({ addAccount: null });
  if (request.reauthAccountId) return <ReauthDialog accountId={request.reauthAccountId} onClose={close} />;
  return <AddFlow request={request} onClose={close} />;
}

function AddFlow({ request, onClose }: { request: AddAccountRequest; onClose: () => void }) {
  const [step, setStep] = useState<Step>('email');
  const [email, setEmail] = useState(request.initialEmail ?? '');
  const [touched, setTouched] = useState(false);
  const [config, setConfig] = useState<DiscoveredConfig | null>(null);
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [imap, setImap] = useState<ServerForm>({ host: '', port: '993', security: 'ssl' });
  const [smtp, setSmtp] = useState<ServerForm>({ host: '', port: '465', security: 'ssl' });
  const [error, setError] = useState<AppError | null>(null);
  const [notice, setNotice] = useState<ReactNode>(null);
  const [busy, setBusy] = useState(false);
  const [testRes, setTestRes] = useState<TestAccountRes | null>(null);
  const [fromManual, setFromManual] = useState(false);
  const [addedId, setAddedId] = useState<string | null>(null);
  const [oauthUrl, setOauthUrl] = useState<string | null>(null);
  const cancelled = useRef(false);
  const oauthSession = useRef<string | null>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const passRef = useRef<HTMLInputElement>(null);

  const trimmed = email.trim();
  const valid = isValidEmail(trimmed);
  const dom = domainOf(trimmed);
  const msLike = /(^|\.)(outlook|hotmail|live|msn)\./.test(dom) || /outlook\.com$/.test(dom);

  useEffect(() => {
    cancelled.current = false;
    return () => {
      cancelled.current = true;
      if (oauthSession.current) void call('oauth.cancel', { sessionId: oauthSession.current }).catch(() => undefined);
    };
  }, []);

  const cancelAndClose = () => {
    cancelled.current = true;
    onClose();
  };

  // ----- step: detect -----
  const detect = async () => {
    if (!valid) {
      setTouched(true);
      return;
    }
    setError(null);
    setNotice(null);
    setStep('detecting');
    cancelled.current = false;
    try {
      const res = await call('accounts.discover', { email: trimmed });
      if (cancelled.current) return;
      const cfg = res.config;
      if (!cfg) {
        openManual(null);
        return;
      }
      setConfig(cfg);
      setImap(fromEndpoint(cfg.imap));
      setSmtp(fromEndpoint(cfg.smtp));
      setUsername(resolveUsername(cfg.usernameTemplate || '', trimmed));
      setStep(cfg.oauthRequired ? 'oauth' : 'credentials');
      if (cfg.oauthRequired) void startOAuth();
    } catch (e) {
      if (cancelled.current) return;
      setError(asAppError(e));
      setStep('email');
    }
  };

  const openManual = (cfg: DiscoveredConfig | null) => {
    setFromManual(true);
    setNotice(
      cfg
        ? null
        : "We couldn't find settings automatically. Enter them below. Your provider's help page lists them.",
    );
    if (!cfg) {
      const d = dom || 'example.com';
      setImap({ host: `imap.${d}`, port: '993', security: 'ssl' });
      setSmtp({ host: `smtp.${d}`, port: '465', security: 'ssl' });
      setUsername(trimmed);
    }
    setTestRes(null);
    setError(null);
    setStep('manual');
  };

  // ----- microsoft -----
  const startOAuth = async () => {
    setError(null);
    setNotice(null);
    cancelled.current = false;
    try {
      const start = await call('oauth.start', { provider: 'microsoft', loginHint: isValidEmail(trimmed) ? trimmed : undefined });
      if (cancelled.current) return;
      oauthSession.current = start.sessionId;
      setOauthUrl(start.authUrl);
      setStep('oauth');
      const done = await call('oauth.complete', { sessionId: start.sessionId });
      if (cancelled.current) return;
      oauthSession.current = null;
      setBusy(true);
      let cfg = config;
      if (!cfg) {
        cfg = (await call('accounts.discover', { email: done.email })).config;
      }
      if (!cfg) throw { code: 'INTERNAL', message: 'Could not find the server settings for this account.', retryable: false } satisfies AppError;
      const acct = await call('accounts.add', {
        email: done.email,
        displayName: name.trim() || done.email,
        authType: 'oauth2',
        oauthProvider: 'microsoft',
        oauthSessionId: done.sessionId,
        username: done.email,
        imap: cfg.imap,
        smtp: cfg.smtp,
      });
      afterAdded(acct);
    } catch (e) {
      if (cancelled.current) return;
      const err = asAppError(e);
      oauthSession.current = null;
      setBusy(false);
      setError(err);
      setStep(config ? 'oauth' : 'email');
    }
  };

  // ----- add (password) -----
  const afterAdded = (acct: Account) => {
    setBusy(false);
    setAddedId(acct.id);
    setStep('verify');
    void useApp.getState().refetchAccounts();
  };

  const addWithPassword = async () => {
    if (!password) {
      setError({ code: 'INVALID_INPUT', message: 'Enter the password.', retryable: false });
      passRef.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const acct = await call('accounts.add', {
        email: trimmed,
        displayName: name.trim() || trimmed,
        authType: 'password',
        password: cleanPassword(password, config?.help?.authMethod === 'app-password'),
        username: username.trim() || trimmed,
        imap: toEndpoint(imap),
        smtp: toEndpoint(smtp),
      });
      afterAdded(acct);
    } catch (e) {
      setBusy(false);
      setError(asAppError(e));
      if (asAppError(e).code === 'AUTH_FAILED') passRef.current?.focus();
    }
  };

  const validateManual = (): string | null => {
    for (const [label, f] of [['incoming', imap], ['outgoing', smtp]] as const) {
      if (!f.host.trim() || /[\s/]/.test(f.host)) return `Enter a valid ${label} server name.`;
      const p = Number(f.port);
      if (!Number.isInteger(p) || p < 1 || p > 65535) return `Enter a valid ${label} port.`;
    }
    if (!username.trim()) return 'Enter the user name.';
    if (!password) return 'Enter the password.';
    return null;
  };

  const testAndAdd = async () => {
    const bad = validateManual();
    if (bad) {
      setError({ code: 'INVALID_INPUT', message: bad, retryable: false });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const input = {
        email: trimmed,
        authType: 'password' as const,
        password: cleanPassword(password, config?.help?.authMethod === 'app-password'),
        username: username.trim(),
        imap: toEndpoint(imap),
        smtp: toEndpoint(smtp),
      };
      // Second click after a failed SMTP test = "Add anyway".
      if (!(testRes && testRes.imap.ok && !testRes.smtp.ok)) {
        const res = await call('accounts.test', { input });
        setTestRes(res);
        if (!res.imap.ok) {
          setBusy(false);
          setError(res.imap.error ?? { code: 'INTERNAL', message: 'The incoming server test failed.', retryable: true });
          return;
        }
        if (!res.smtp.ok) {
          setBusy(false);
          return;
        }
      }
      const acct = await call('accounts.add', { ...input, displayName: name.trim() || trimmed });
      afterAdded(acct);
    } catch (e) {
      setBusy(false);
      setError(asAppError(e));
    }
  };

  const errorBanner = (): ReactNode => {
    if (!error) return null;
    const help = config?.help;
    let text = error.message;
    let extra: ReactNode = null;
    switch (error.code) {
      case 'AUTH_FAILED':
        if (help?.authMethod === 'app-password') {
          text = `${trimmed} needs an app password, not your normal password.`;
          extra = help.appPasswordHelpUrl ? (
            <button type="button" className="link" onClick={() => void call('app.openExternal', { url: help.appPasswordHelpUrl! })}>
              How to create one
            </button>
          ) : null;
        } else text = 'The server rejected the password. Check it and try again.';
        break;
      case 'HOST_UNREACHABLE':
      case 'TIMEOUT':
        text = "Can't reach the server. Check your internet connection.";
        break;
      case 'TLS_ERROR':
        text = `The server's security certificate is not trusted.${error.details ? ` (${error.details})` : ''}`;
        break;
      case 'OAUTH_NOT_CONFIGURED':
        extra = (
          <button
            type="button"
            className="link"
            onClick={() => {
              onClose();
              useUi.getState().openSettings('keys');
            }}
          >
            Open settings
          </button>
        );
        break;
      case 'CANCELLED':
        text = 'Sign-in was canceled or took too long.';
        break;
      case 'SMTP_AUTH_DISABLED':
        text = 'Your provider has turned off sending mail with a password for this account.';
        break;
      default:
        break;
    }
    const serverSaid = error.code === 'AUTH_FAILED' ? error.details : undefined;
    return (
      <Banner tone="danger" className="dlg-banner" actions={extra ?? undefined}>
        {text}
        {serverSaid ? (
          <div className="hint" style={{ marginTop: 4, opacity: 0.8, fontSize: 12, wordBreak: 'break-word' }}>
            Server said: {serverSaid}
          </div>
        ) : null}
      </Banner>
    );
  };

  const hp = config?.help;
  const back = (to: Step) => (
    <IconButton
      icon="back"
      label="Back"
      onClick={() => {
        setError(null);
        setTestRes(null);
        setStep(to);
      }}
      style={{ marginLeft: -8, marginRight: 4 }}
    />
  );

  // ================= render =================
  if (step === 'email') {
    return (
      <Dialog title="Add an account" onClose={cancelAndClose} initialFocus="#acct-email">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void detect();
          }}
        >
          <TextField
            id="acct-email"
            inputRef={emailRef}
            label="Email address"
            placeholder={request.hintProvider === 'gmail' ? 'name@gmail.com' : request.hintProvider === 'microsoft' ? 'name@outlook.com' : 'name@example.com'}
            value={email}
            autoComplete="off"
            onChange={(e) => setEmail(e.target.value)}
            onBlur={() => setTouched(true)}
            error={touched && email && !valid ? 'Enter a full address like name@example.com' : null}
          />
          {notice ? <Banner tone="info" className="dlg-banner">{notice}</Banner> : null}
          {errorBanner()}
          <div className="prov">
            <Button
              className={msLike || request.hintProvider === 'microsoft' ? 'hi' : ''}
              onClick={() => {
                setStep('oauth');
                void startOAuth();
              }}
            >
              <MsLogo /> Sign in with Microsoft
            </Button>
          </div>
          <div className="foot">
            <Button onClick={cancelAndClose}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={!valid}>
              Continue
            </Button>
          </div>
        </form>
      </Dialog>
    );
  }

  if (step === 'detecting') {
    return (
      <Dialog title="Add an account" onClose={cancelAndClose} initialFocus=".foot .btn">
        <div role="status">
          Looking up settings for <b>{dom}</b> ...
        </div>
        <div className="pbar" />
        <div className="foot">
          <Button
            onClick={() => {
              cancelled.current = true;
              setStep('email');
            }}
          >
            Cancel
          </Button>
        </div>
      </Dialog>
    );
  }

  if (step === 'oauth') {
    return (
      <Dialog
        title="Sign in with Microsoft"
        onClose={() => {
          if (oauthSession.current) void call('oauth.cancel', { sessionId: oauthSession.current }).catch(() => undefined);
          cancelAndClose();
        }}
        busy={busy}
        initialFocus=".foot .btn"
      >
        {error ? (
          <>
            {errorBanner()}
            <div className="foot">
              <Button onClick={cancelAndClose}>Close</Button>
              {error.code === 'OAUTH_NOT_CONFIGURED' ? (
                <Button
                  onClick={() => {
                    cancelAndClose();
                    useUi.getState().openSettings('keys', null);
                  }}
                >
                  Open Advanced settings
                </Button>
              ) : null}
              <Button variant="primary" onClick={() => void startOAuth()}>
                Try again
              </Button>
            </div>
          </>
        ) : (
          <>
            {hp ? <p style={{ marginBottom: 8 }}>{hp.instructions}</p> : null}
            <div role="status" style={{ display: 'flex', gap: 12, alignItems: 'center', margin: '8px 0' }}>
              <i className="spin big" />
              Waiting for you to finish in your browser...
            </div>
            {oauthUrl ? (
              <div className="hint">
                Didn&apos;t open?{' '}
                <button
                  type="button"
                  className="link"
                  onClick={() => void navigator.clipboard.writeText(oauthUrl).then(() => toast('Sign-in link copied.'))}
                >
                  Copy sign-in link
                </button>
              </div>
            ) : null}
            <div className="foot">
              <Button
                onClick={() => {
                  if (oauthSession.current) void call('oauth.cancel', { sessionId: oauthSession.current }).catch(() => undefined);
                  oauthSession.current = null;
                  cancelled.current = true;
                  setStep(config && !config.oauthRequired ? 'credentials' : 'email');
                }}
              >
                Cancel
              </Button>
            </div>
          </>
        )}
      </Dialog>
    );
  }

  if (step === 'credentials') {
    const found = `${imap.host} / ${smtp.host}`;
    return (
      <Dialog title={`Sign in to ${trimmed}`} onClose={cancelAndClose} leading={back('email')} busy={busy} initialFocus="#acct-pass">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void addWithPassword();
          }}
        >
          <div className="hint" style={{ marginBottom: 14 }}>
            Found: {found} &nbsp;
            <button type="button" className="link plain" onClick={() => openManual(config)}>
              Edit
            </button>
          </div>
          {hp && hp.authMethod === 'microsoft-oauth' ? (
            <Banner
              tone="info"
              className="dlg-banner"
              actions={
                <Button size="sm" onClick={() => { setStep('oauth'); void startOAuth(); }}>
                  <MsLogo /> Sign in with Microsoft
                </Button>
              }
            >
              {hp.instructions}
            </Banner>
          ) : null}
          <PasswordField
            label={hp?.authMethod === 'app-password' ? 'App password' : 'Password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            inputRef={passRef}
            id="acct-pass"
          />
          {hp && hp.authMethod === 'app-password' ? (
            <Banner
              tone="info"
              className="dlg-banner"
              actions={
                hp.appPasswordHelpUrl ? (
                  <button type="button" className="link" onClick={() => void call('app.openExternal', { url: hp.appPasswordHelpUrl! })}>
                    How to create one
                  </button>
                ) : undefined
              }
            >
              <div>{hp.instructions}</div>
              {hp.notes.map((n, i) => (
                <div key={i} className="hint" style={{ marginTop: 4 }}>{n}</div>
              ))}
            </Banner>
          ) : null}
          <TextField label="Account name (optional)" value={name} onChange={(e) => setName(e.target.value)} placeholder={hp?.providerName ?? ''} />
          {notice ? <Banner tone="info" className="dlg-banner">{notice}</Banner> : null}
          {errorBanner()}
          <div className="foot">
            <Button onClick={() => setStep('email')}>Back</Button>
            <Button type="submit" variant="primary" loading={busy}>
              Add account
            </Button>
          </div>
        </form>
      </Dialog>
    );
  }

  if (step === 'manual') {
    const secOpt = (
      <>
        <option value="ssl">SSL/TLS</option>
        <option value="starttls">STARTTLS</option>
      </>
    );
    const setSec = (kind: 'imap' | 'smtp', sec: Security) => {
      const cur = kind === 'imap' ? imap : smtp;
      const set = kind === 'imap' ? setImap : setSmtp;
      const wasDefault = Number(cur.port) === DEFAULT_PORT[kind][cur.security];
      set({ ...cur, security: sec, port: wasDefault ? String(DEFAULT_PORT[kind][sec]) : cur.port });
    };
    const row = (label: string, r?: { ok: boolean; error?: AppError }) =>
      r ? (
        <div className={r.ok ? 'ok' : 'bad'} role="status" style={{ marginBottom: 6 }}>
          <Icon name={r.ok ? 'check' : 'warn'} />
          {label}: {r.ok ? 'works' : (r.error?.message ?? 'failed')}
        </div>
      ) : null;
    const smtpFailedOnly = !!testRes && testRes.imap.ok && !testRes.smtp.ok;
    return (
      <Dialog title="Server settings" onClose={cancelAndClose} leading={back(fromManual && config ? 'credentials' : 'email')} busy={busy} initialFocus="#imap-host">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void testAndAdd();
          }}
        >
          {notice ? <div className="hint" style={{ marginBottom: 6 }}>{notice}</div> : null}
          <h5 style={{ fontSize: 12, color: 'var(--t2)', margin: '10px 0 6px' }}>INCOMING (IMAP)</h5>
          <div className="row2">
            <div style={{ flex: 3, display: 'flex' }}>
              <TextField id="imap-host" label="Server" mono value={imap.host} onChange={(e) => setImap({ ...imap, host: e.target.value })} />
            </div>
            <TextField label="Port" mono inputMode="numeric" value={imap.port} onChange={(e) => setImap({ ...imap, port: e.target.value })} />
          </div>
          <div className="row2">
            <SelectField label="Security" value={imap.security} onChange={(e) => setSec('imap', e.target.value as Security)}>
              {secOpt}
            </SelectField>
            <TextField label="Username" value={username} onChange={(e) => setUsername(e.target.value)} />
          </div>
          <PasswordField label="Password" value={password} onChange={(e) => setPassword(e.target.value)} inputRef={passRef} />
          <h5 style={{ fontSize: 12, color: 'var(--t2)', margin: '2px 0 6px' }}>OUTGOING (SMTP)</h5>
          <div className="row2">
            <div style={{ flex: 3, display: 'flex' }}>
              <TextField label="Server" mono value={smtp.host} onChange={(e) => setSmtp({ ...smtp, host: e.target.value })} />
            </div>
            <TextField label="Port" mono inputMode="numeric" value={smtp.port} onChange={(e) => setSmtp({ ...smtp, port: e.target.value })} />
          </div>
          <SelectField label="Security" value={smtp.security} onChange={(e) => setSec('smtp', e.target.value as Security)}>
            {secOpt}
          </SelectField>
          <div className="hint" style={{ marginBottom: 10 }}>The same user name and password are used for sending.</div>
          {testRes ? (
            <div style={{ marginBottom: 8 }}>
              {row('Incoming server', testRes.imap)}
              {row('Outgoing server', testRes.smtp)}
            </div>
          ) : null}
          {smtpFailedOnly ? (
            <Banner tone="warning" className="dlg-banner">
              Receiving mail works, but sending did not. You can add the account now and fix sending later.
            </Banner>
          ) : null}
          {errorBanner()}
          <div className="foot">
            <Button onClick={cancelAndClose}>Cancel</Button>
            <Button type="submit" variant="primary" loading={busy}>
              {smtpFailedOnly ? 'Add anyway' : 'Test and add account'}
            </Button>
          </div>
        </form>
      </Dialog>
    );
  }

  return <VerifyStep accountId={addedId} email={trimmed} onClose={onClose} onAnother={() => {
    setEmail('');
    setPassword('');
    setName('');
    setConfig(null);
    setAddedId(null);
    setTouched(false);
    setNotice(null);
    setStep('email');
  }} />;
}

function VerifyStep({
  accountId,
  email,
  onClose,
  onAnother,
}: {
  accountId: string | null;
  email: string;
  onClose: () => void;
  onAnother: () => void;
}) {
  const folders = useApp((s) => s.folders);
  const progress = useApp((s) => (accountId ? s.progress[accountId] : undefined));
  const status = useApp((s) => (accountId ? s.statuses[accountId] : undefined));
  const haveFolders = !!accountId && folders.some((f) => f.accountId === accountId);
  const mailDone =
    haveFolders &&
    ((progress?.phase === 'idle') ||
      (progress?.phase === 'incremental') ||
      (progress?.phase === 'initial' && progress.total !== null && progress.done >= progress.total) ||
      status?.state === 'online');
  const failed = status?.error;

  const step = (done: boolean, running: boolean, text: string, fail?: boolean) => (
    <li className={done ? 'done' : fail ? 'fail' : ''}>
      <span className="st">{done ? <Icon name="check" /> : fail ? <Icon name="warn" /> : running ? <i className="spin" /> : <span aria-hidden="true">&#9675;</span>}</span>
      {text}
    </li>
  );

  const finish = () => {
    onClose();
    if (!accountId) return;
    const inbox = accountInbox(useApp.getState().folders, accountId);
    useUi.getState().toggleExpanded(accountId, true);
    useUi.getState().setView(inbox ? { kind: 'folder', folderId: inbox.id } : { kind: 'account', accountId });
  };

  return (
    <Dialog title="Connecting" onClose={finish} initialFocus=".foot .btn.primary, .foot .btn">
      <p style={{ marginBottom: 8 }}>{email}</p>
      <ul className="steps" aria-live="polite">
        {step(true, false, 'Signed in')}
        {step(haveFolders, !haveFolders && !failed, 'Loading folders', !haveFolders && !!failed)}
        {step(!!mailDone, haveFolders && !mailDone, 'Getting recent mail')}
      </ul>
      {progress && progress.total && !mailDone ? (
        <div className="hint">{progress.done} of ~{progress.total} messages</div>
      ) : null}
      {failed ? <Banner tone="warning" className="dlg-banner">{failed.message} We will keep trying.</Banner> : null}
      <div className="foot">
        <button type="button" className="link grow" onClick={onAnother}>
          Add another account
        </button>
        <span className="hint">{haveFolders ? 'You can start using the account now.' : ''}</span>
        <Button variant="primary" disabled={!haveFolders} onClick={finish}>
          Done
        </Button>
      </div>
    </Dialog>
  );
}

// ---------- sign in again ----------
function ReauthDialog({ accountId, onClose }: { accountId: string; onClose: () => void }) {
  const account = useApp((s) => s.accounts.find((a) => a.id === accountId));
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  if (!account) {
    return (
      <Dialog title="Sign in again" onClose={onClose}>
        <p>This account is no longer there.</p>
        <div className="foot"><Button onClick={onClose}>Close</Button></div>
      </Dialog>
    );
  }
  const oauth = account.authType === 'oauth2';
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      if (oauth) await call('oauth.reauthorize', { accountId });
      else await call('accounts.updateCredentials', { accountId, password: cleanPassword(password, isAppPasswordProvider(account.imap.host)) });
      toast(`${account.displayName} is connected.`);
      void useApp.getState().refetchStatuses();
      onClose();
    } catch (e) {
      const err = asAppError(e);
      setError(
        err.code === 'AUTH_FAILED'
          ? { ...err, message: 'The server rejected the password. Check it and try again.' }
          : err.code === 'CANCELLED'
            ? { ...err, message: 'Sign-in was cancelled or the browser window was closed. Try again when you are ready.' }
            : err,
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title={`Sign in again to ${account.displayName}`} onClose={onClose} busy={busy && !oauth}>
      <form onSubmit={(e) => { e.preventDefault(); void go(); }}>
        <p style={{ marginBottom: 12 }}>{account.email}</p>
        {oauth && busy ? (
          <div role="status" style={{ display: 'flex', gap: 12, alignItems: 'center', margin: '8px 0' }}>
            <i className="spin big" />
            Waiting for you to finish in your browser...
          </div>
        ) : oauth ? (
          <p>You will sign in with Microsoft in your browser.</p>
        ) : (
          <PasswordField label="Password" value={password} onChange={(e) => setPassword(e.target.value)} />
        )}
        {error ? (
          <Banner tone="danger" className="dlg-banner">
            {error.message}
            {error.code === 'AUTH_FAILED' && error.details ? (
              <div className="hint" style={{ marginTop: 4, opacity: 0.8, fontSize: 12, wordBreak: 'break-word' }}>
                Server said: {error.details}
              </div>
            ) : null}
          </Banner>
        ) : null}
        <div className="foot">
          <Button onClick={onClose}>{oauth && busy ? 'Close' : 'Cancel'}</Button>
          {oauth && busy ? null : (
            <Button type="submit" variant="primary" loading={busy} disabled={!oauth && !password}>
              {oauth ? 'Sign in with Microsoft' : 'Sign in'}
            </Button>
          )}
        </div>
      </form>
    </Dialog>
  );
}
