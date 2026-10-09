import { useEffect, useRef, useState } from 'react';
import type { Account, AppSettings, OAuthSettings } from '../../../../shared/ipc';
import { Icon } from '../../components/Icon';
import {
  AccountAvatar,
  Banner,
  Button,
  Checkbox,
  PasswordField,
  Radio,
  SelectField,
  Switch,
  TextField,
  Dialog,
} from '../../components/ui';
import { useSyncKind } from '../../components/Sync';
import { useApp } from '../../store/app';
import { useUi, type SettingsSection } from '../../store/ui';
import { useAccountColor, useThemeState } from '../../lib/hooks';
import { PALETTE, contrastRatio, isHexColor, resolveAccountColor } from '../../lib/colors';
import { badgeOf, fileSize, megabytes } from '../../lib/format';
import { cleanPassword, isAppPasswordProvider } from '../../lib/password';
import { asAppError, call } from '../../lib/api';
import { reportActionError, toast, toastError } from '../../store/toasts';
import { useUpdates } from '../../store/updates';
import { updateLine } from '../../lib/updateText';
import { ShortcutTable } from '../dialogs/Dialogs';
import { RulesPage } from '../rules/RulesPage';

const NAV: [SettingsSection, string][] = [
  ['accounts', 'Accounts'],
  ['general', 'General'],
  ['appearance', 'Appearance'],
  ['mail', 'Mail'],
  ['rules', 'Rules'],
  ['notifications', 'Notifications'],
  ['keys', 'Advanced'],
  ['shortcuts', 'Shortcuts'],
  ['about', 'About'],
];

export function SettingsPage() {
  const section = useUi((s) => s.settingsSection);
  const accountId = useUi((s) => s.settingsAccountId);
  return (
    <div className="sbody">
      <nav className="snav" aria-label="Settings">
        <button type="button" className="srow inset-focus" style={{ marginBottom: 8 }} onClick={() => useUi.getState().closeSettings()}>
          <Icon name="back" />
          <span className="nm">Back to mail</span>
        </button>
        {NAV.map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={`srow inset-focus ${id === section ? 'sel' : ''}`}
            aria-current={id === section ? 'page' : undefined}
            onClick={() => useUi.getState().openSettings(id, null)}
          >
            <span className="nm">{label}</span>
          </button>
        ))}
      </nav>
      <div className="scont">
        <div className={`sin ${section === 'rules' ? 'wide' : ''}`}>
          {section === 'accounts' ? (
            accountId ? <AccountSettings accountId={accountId} /> : <AccountsList />
          ) : section === 'general' ? (
            <General />
          ) : section === 'appearance' ? (
            <Appearance />
          ) : section === 'mail' ? (
            <MailSettings />
          ) : section === 'rules' ? (
            <RulesPage />
          ) : section === 'notifications' ? (
            <Notifications />
          ) : section === 'keys' ? (
            <Advanced />
          ) : section === 'shortcuts' ? (
            <Shortcuts />
          ) : (
            <About />
          )}
        </div>
      </div>
    </div>
  );
}

// ---------- helpers ----------
function useSetting() {
  const update = useApp((s) => s.updateSettings);
  return (patch: Partial<AppSettings>) => update(patch).catch((e) => toastError(asAppError(e).message));
}

function useSavedFlag(): [boolean, () => void] {
  const [saved, setSaved] = useState(false);
  const t = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (t.current) clearTimeout(t.current); }, []);
  return [
    saved,
    () => {
      setSaved(true);
      if (t.current) clearTimeout(t.current);
      t.current = setTimeout(() => setSaved(false), 2000);
    },
  ];
}

// ---------- accounts ----------
function AccountsList() {
  const accounts = useApp((s) => s.accounts);
  const colorOf = useAccountColor();
  return (
    <>
      <h1>Accounts</h1>
      <p className="lead">Add as many accounts as you like. It is free.</p>
      <div style={{ margin: '16px 0 12px' }}>
        <Button variant="primary" icon="plus" onClick={() => useUi.getState().set({ addAccount: {} })}>
          Add account
        </Button>
      </div>
      {accounts.length === 0 ? <p className="hint">No accounts yet.</p> : null}
      {accounts.map((a) => (
        <AccountRow key={a.id} account={a} color={colorOf(a.id)} />
      ))}
    </>
  );
}

function AccountRow({ account: a, color }: { account: Account; color: string }) {
  const kind = useSyncKind(a.id);
  return (
    <button type="button" className="arow inset-focus" onClick={() => useUi.getState().openSettings('accounts', a.id)}>
      <AccountAvatar color={color} letter={badgeOf(a)} size={40} square8 />
      <div className="t">
        <b style={{ fontWeight: 600 }}>{a.displayName}</b>
        <small>
          {a.email} &middot; {a.authType === 'oauth2' ? 'Microsoft (OAuth)' : 'IMAP (password)'}
        </small>
      </div>
      {kind === 'auth' ? (
        <span className="bad"><Icon name="warn" />Sign in again</span>
      ) : kind === 'syncing' ? (
        <i className="spin" />
      ) : kind === 'error' ? (
        <span className="warnT" style={{ fontSize: 12 }}>Can&apos;t connect</span>
      ) : kind === 'offline' ? (
        <span className="hint">Offline</span>
      ) : (
        <span className="ok"><Icon name="check" />Connected</span>
      )}
      <Icon name="chev-r" />
    </button>
  );
}

function BackToAccounts() {
  return (
    <button
      type="button"
      className="link back-link"
      aria-label="Back to accounts"
      onClick={() => useUi.getState().openSettings('accounts', null)}
    >
      <Icon name="back" />
      Accounts
    </button>
  );
}

/** Mute or unmute new-mail notifications for one account (Settings > Notifications and account page). */
function useAccountMute(accountId: string): [boolean, (muted: boolean) => void] {
  const settings = useApp((s) => s.settings);
  const set = useSetting();
  const n = settings?.notifications;
  const muted = !!n?.mutedAccountIds.includes(accountId);
  return [
    muted,
    (next) => {
      if (!n) return;
      const rest = n.mutedAccountIds.filter((id) => id !== accountId);
      void set({ notifications: { ...n, mutedAccountIds: next ? [...rest, accountId] : rest } });
    },
  ];
}

function AccountSettings({ accountId }: { accountId: string }) {
  const account = useApp((s) => s.accounts.find((a) => a.id === accountId));
  const folders = useApp((s) => s.folders);
  const notifyOn = useApp((s) => s.settings?.notifications.enabled ?? true);
  const kind = useSyncKind(accountId);
  const [name, setName] = useState(account?.displayName ?? '');
  const [signature, setSignature] = useState(account?.signature ?? '');
  const isCustom = !!account?.color && !PALETTE.some((p) => p.light.toLowerCase() === account.color!.toLowerCase());
  const [hex, setHex] = useState(isCustom ? (account?.color ?? '') : '');
  const [saved, flashSaved] = useSavedFlag();
  const [pwDialog, setPwDialog] = useState(false);
  const [muted, setMuted] = useAccountMute(accountId);
  const loadedFor = useRef(accountId);

  useEffect(() => {
    if (loadedFor.current !== accountId) {
      loadedFor.current = accountId;
      setName(account?.displayName ?? '');
      setSignature(account?.signature ?? '');
      setHex(isCustom ? (account?.color ?? '') : '');
    }
  }, [accountId, account, isCustom]);

  if (!account) {
    return (
      <>
        <BackToAccounts />
        <p style={{ marginTop: 12 }}>This account is no longer there.</p>
      </>
    );
  }

  const save = async (patch: Parameters<typeof call<'accounts.update'>>[1]['patch']) => {
    try {
      await call('accounts.update', { accountId, patch });
      await useApp.getState().refetchAccounts();
      flashSaved();
    } catch (e) {
      reportActionError(e);
    }
  };

  const dark = document.documentElement.dataset.theme === 'dark';
  const autoColor = account.color === null;
  const current = account.color?.toLowerCase() ?? null;
  const hexLow = isHexColor(hex) && contrastRatio(hex, '#FFFFFF') < 3;
  const color = resolveAccountColor(account.color, dark, 0);
  const specials = folders.filter((f) => f.accountId === accountId && f.role);

  return (
    <>
      <BackToAccounts />
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', margin: '16px 0 8px' }}>
        <AccountAvatar color={color} letter={badgeOf(account)} size={40} round />
        <div>
          <div style={{ fontSize: 20, lineHeight: '28px', fontWeight: 600 }}>{account.displayName}</div>
          <div className="hint">
            {account.email} &middot; {account.authType === 'oauth2' ? 'Microsoft (OAuth)' : 'Password'} &middot;{' '}
            {kind === 'auth' ? 'Needs sign-in' : kind === 'error' ? "Can't connect" : kind === 'offline' ? 'Offline' : 'Connected'}
          </div>
        </div>
        <span className="saved" role="status" style={{ marginLeft: 'auto', opacity: saved ? 1 : 0 }}>
          <Icon name="check" />
          Saved
        </span>
      </div>
      {kind === 'auth' ? (
        <Banner tone="danger" actions={<Button size="sm" onClick={() => useUi.getState().set({ addAccount: { reauthAccountId: accountId } })}>Sign in again</Button>}>
          This account needs you to sign in again.
        </Banner>
      ) : null}

      <h2>GENERAL</h2>
      <TextField
        label="Account name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => {
          const v = name.trim();
          if (v && v !== account.displayName) void save({ displayName: v });
          else setName(account.displayName);
        }}
      />
      <BadgeField
        key={account.badge}
        value={account.badge}
        fallback={badgeOf({ displayName: account.displayName, email: account.email })}
        onSave={(badge) => save({ badge })}
      />
      <div className="field">
        <span className="lbl" id="color-lbl">Color</span>
        <div className="swatches" role="radiogroup" aria-labelledby="color-lbl">
          <button
            type="button"
            role="radio"
            aria-checked={autoColor}
            aria-label="Automatic"
            title="Automatic: Letterdock picks a color"
            className={`swatch auto ${autoColor ? 'sel' : ''}`}
            style={{ ['--ac' as string]: 'var(--ctrl)' }}
            onClick={() => {
              setHex('');
              void save({ color: null });
            }}
          >
            Auto
          </button>
          {PALETTE.map((p) => {
            const sel = current === p.light.toLowerCase();
            const c = dark ? p.dark : p.light;
            return (
              <button
                key={p.name}
                type="button"
                role="radio"
                aria-checked={sel}
                aria-label={p.name}
                title={p.name}
                className={`swatch ${sel ? 'sel' : ''}`}
                style={{ ['--ac' as string]: c, color: dark ? '#0b0b0b' : '#fff' }}
                onClick={() => {
                  setHex('');
                  void save({ color: p.light });
                }}
              >
                {sel ? <Icon name="check" /> : null}
              </button>
            );
          })}
        </div>
        <div className="custom-color">
          <label htmlFor="custom-color" className="cc-lbl">Custom color</label>
          <input
            id="custom-color"
            className="inp mono"
            style={{ width: 120 }}
            placeholder="#RRGGBB"
            value={hex}
            aria-invalid={hex && !isHexColor(hex) ? true : undefined}
            onChange={(e) => setHex(e.target.value)}
            onBlur={() => {
              if (isHexColor(hex) && hex.toUpperCase() !== (account.color ?? '').toUpperCase()) void save({ color: hex.toUpperCase() });
            }}
          />
          {hex && !isHexColor(hex) ? <span className="bad"><Icon name="warn" />Use six digits, like #0F6CBD</span> : null}
          {hexLow ? <span className="warnT" style={{ fontSize: 12 }}>This color may be hard to see on white.</span> : null}
        </div>
      </div>

      <h2>SIGNATURE</h2>
      <div className="field">
        <label htmlFor="sig">Signature (plain text)</label>
        <textarea
          id="sig"
          className="inp"
          style={{ height: 96, padding: 8, resize: 'vertical' }}
          value={signature}
          onChange={(e) => setSignature(e.target.value)}
          onBlur={() => {
            if ((account.signature ?? '') !== signature) void save({ signature: signature || null });
          }}
        />
        <div className="hint">Added to new messages, replies and forwards written from this account.</div>
      </div>

      <h2>SYNC</h2>
      <SelectField
        label="Keep mail on this PC for"
        value={String(account.syncDays)}
        onChange={(e) => void save({ syncDays: Number(e.target.value) })}
        style={{ maxWidth: 240 }}
      >
        {[30, 90, 180, 365].map((d) => (
          <option key={d} value={d}>{d === 365 ? '1 year' : `${d} days`}</option>
        ))}
        {![30, 90, 180, 365].includes(account.syncDays) ? <option value={account.syncDays}>{account.syncDays} days</option> : null}
      </SelectField>
      <p className="hint" style={{ marginTop: -6, marginBottom: 12 }}>
        Older mail is removed from this PC only. It stays on the server. Use 'Search on server' to find it.
      </p>
      <Checkbox
        checked={account.enabled}
        label="Check this account for new mail"
        onChange={(v) => void save({ enabled: v })}
      />

      <h2>NOTIFICATIONS</h2>
      <Checkbox
        checked={!muted}
        disabled={!notifyOn}
        label="Show a notification for new mail in this account"
        onChange={(v) => setMuted(!v)}
      />
      {!notifyOn ? <p className="hint indent">Notifications are turned off for all accounts in Settings, Notifications.</p> : null}

      {specials.length > 0 ? (
        <>
          <h2>FOLDERS</h2>
          <p className="hint">Special folders found on the server: {specials.map((f) => f.name).join(', ')}.</p>
        </>
      ) : null}

      <h2>SERVER</h2>
      {account.authType === 'oauth2' ? (
        <p>Signed in with Microsoft.</p>
      ) : (
        <>
          <div className="cpy" style={{ marginBottom: 8 }}>
            Incoming: {account.imap.host}:{account.imap.port} {account.imap.security === 'ssl' ? 'SSL/TLS' : 'STARTTLS'}
          </div>
          <div className="cpy" style={{ marginBottom: 8 }}>
            Outgoing: {account.smtp.host}:{account.smtp.port} {account.smtp.security === 'ssl' ? 'SSL/TLS' : 'STARTTLS'}
          </div>
          <div className="hint" style={{ marginBottom: 8 }}>User name: {account.username}</div>
          <Button onClick={() => setPwDialog(true)}>Change password</Button>
        </>
      )}

      <div className="danger-zone">
        <h2>DANGER ZONE</h2>
        <Button variant="danger" onClick={() => useUi.getState().set({ removeAccountId: accountId })}>
          Sign out and remove account...
        </Button>
      </div>
      {pwDialog ? <PasswordDialog accountId={accountId} onClose={() => setPwDialog(false)} /> : null}
    </>
  );
}

function PasswordDialog({ accountId, onClose }: { accountId: string; onClose: () => void }) {
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const appPw = useApp((s) => {
    const a = s.accounts.find((x) => x.id === accountId);
    return !!a && isAppPasswordProvider(a.imap.host);
  });
  return (
    <Dialog title="Change password" size="sm" onClose={onClose} busy={busy}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await call('accounts.updateCredentials', { accountId, password: cleanPassword(pw, appPw) });
            toast('Password saved.');
            onClose();
          } catch (ex) {
            setErr(asAppError(ex).message);
            setBusy(false);
          }
        }}
      >
        <PasswordField label="New password" value={pw} onChange={(e) => setPw(e.target.value)} error={err} />
        <div className="foot">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={busy} disabled={!pw}>
            Save
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

// ---------- General ----------
type DefaultAppState = 'default' | 'other' | 'unknown';

/** Settings > General > Default email app (DESIGN-SPEC 3.4.1). Windows decides; we only open its page. */
export function DefaultAppRow({
  status,
  announce,
  onOpenWindowsSettings,
}: {
  status: DefaultAppState;
  /** Spoken once when the status changed to "default" while the page is open. */
  announce?: string;
  onOpenWindowsSettings: () => void;
}) {
  const text =
    status === 'default'
      ? 'Letterdock is your default email app.'
      : status === 'other'
        ? 'Letterdock is not your default email app.'
        : "We can't tell which app opens email links.";
  return (
    <div className="dapp" role="group" aria-labelledby="dapp-title">
      <div className="dt">
        <div className="dl" id="dapp-title">Default email app</div>
        <div className={`ds ${status === 'default' ? 'good' : ''}`}>
          <Icon name={status === 'default' ? 'check' : 'info'} />
          <span>{text}</span>
        </div>
        <div className="hint dc">
          Windows only lets you choose this yourself. Press the button, then pick Letterdock in the list that opens.
        </div>
      </div>
      <Button variant={status === 'default' ? 'secondary' : 'primary'} onClick={onOpenWindowsSettings}>
        {status === 'default' ? 'Open Windows Default apps' : 'Make Letterdock the default email app'}
      </Button>
      <span className="sr-only" role="status">{announce ?? ''}</span>
    </div>
  );
}

function useDefaultApp(): { status: DefaultAppState; announce: string } {
  const [status, setStatus] = useState<DefaultAppState>('unknown');
  const [announce, setAnnounce] = useState('');
  const last = useRef<DefaultAppState | null>(null);
  useEffect(() => {
    let alive = true;
    const check = () => {
      call('app.mailtoStatus')
        .then((r) => {
          if (!alive) return;
          const next: DefaultAppState = r.isDefault === true ? 'default' : r.isDefault === false ? 'other' : 'unknown';
          if (last.current !== null && last.current !== 'default' && next === 'default') {
            setAnnounce('Letterdock is now your default email app.');
          }
          last.current = next;
          setStatus(next);
        })
        .catch(() => {
          if (alive) setStatus('unknown');
        });
    };
    check();
    window.addEventListener('focus', check); // the user may have changed it in Windows Settings
    return () => {
      alive = false;
      window.removeEventListener('focus', check);
    };
  }, []);
  return { status, announce };
}

function General() {
  const settings = useApp((s) => s.settings);
  const set = useSetting();
  const defaultApp = useDefaultApp();
  const update = useUpdates((s) => s.status);
  useEffect(() => {
    // The live status also arrives as "update:status" events (see useAppEvents).
    call('updates.status')
      .then((s) => useUpdates.getState().setStatus(s))
      .catch(() => undefined);
  }, []);
  if (!settings) return null;
  const unavailable = update?.state === 'unavailable';
  const busy = update?.state === 'checking' || update?.state === 'downloading';
  return (
    <>
      <h1>General</h1>
      <h2>STARTUP</h2>
      <Checkbox checked={settings.launchAtLogin} label="Start Letterdock when I sign in to Windows" onChange={(v) => void set({ launchAtLogin: v })} />
      <Checkbox
        checked={settings.startMinimizedToTray}
        disabled={!settings.launchAtLogin}
        label="Start hidden in the background"
        onChange={(v) => void set({ startMinimizedToTray: v })}
      />
      <p className="hint indent">
        Start hidden when Windows starts. This only works together with &ldquo;Start Letterdock when I sign in to Windows&rdquo;.
      </p>
      <Checkbox checked={settings.closeToTray} label="Keep running in the background when I close the window" onChange={(v) => void set({ closeToTray: v })} />
      <p className="hint indent">
        Letterdock keeps checking for mail and shows notifications. To close it fully, use Quit in the menu of its icon near the clock.
      </p>

      <h2>DEFAULT EMAIL APP</h2>
      <DefaultAppRow
        status={defaultApp.status}
        announce={defaultApp.announce}
        onOpenWindowsSettings={() => void call('app.openDefaultAppsSettings').catch((e) => reportActionError(e))}
      />

      <h2>UPDATES</h2>
      <Checkbox
        checked={settings.autoUpdateCheck}
        disabled={unavailable}
        label="Check for updates automatically"
        onChange={(v) => void set({ autoUpdateCheck: v })}
      />
      {unavailable ? (
        <p className="hint indent">Updates work in the installed app. This is a development run.</p>
      ) : (
        <div className="btn-row" style={{ marginTop: 8 }}>
          {update?.state === 'ready' ? (
            <Button
              variant="primary"
              onClick={() => void call('updates.install').catch((e) => reportActionError(e))}
            >
              Restart now
            </Button>
          ) : (
            <Button
              loading={update?.state === 'checking'}
              disabled={busy}
              onClick={() =>
                void call('updates.check')
                  .then((s) => useUpdates.getState().setStatus(s))
                  .catch((e) => reportActionError(e))
              }
            >
              {update?.state === 'checking' ? 'Checking...' : 'Check now'}
            </Button>
          )}
          <span className="hint" role="status" aria-live="polite">
            {updateLine(update)}
          </span>
        </div>
      )}
    </>
  );
}

// ---------- Shortcuts ----------
function Shortcuts() {
  const settings = useApp((s) => s.settings);
  const set = useSetting();
  if (!settings) return null;
  const gmail = settings.shortcutPreset === 'gmail';
  return (
    <>
      <h1>Shortcuts</h1>
      <h2 id="h-keystyle">KEYBOARD SHORTCUTS</h2>
      <div role="radiogroup" aria-labelledby="h-keystyle" aria-describedby="keystyle-help">
        <Radio
          name="keystyle"
          checked={!gmail}
          onChange={() => void set({ shortcutPreset: 'outlook' })}
          label="Outlook style (default)"
        />
        <Radio name="keystyle" checked={gmail} onChange={() => void set({ shortcutPreset: 'gmail' })} label="Gmail style" />
      </div>
      <p className="hint rad-hint" id="keystyle-help">
        {gmail
          ? 'The Outlook keys keep working. Gmail style adds single keys such as J and K. They work when the focus is on the message list or the reading pane, never while you type in a field.'
          : 'Keys like Ctrl+R and Delete, as in Outlook. They work in the main window and in message windows.'}
      </p>
      <p className="keys-note">These shortcuts can&apos;t be changed yet.</p>
      <ShortcutTable />
    </>
  );
}

// ---------- Appearance ----------
function Appearance() {
  const settings = useApp((s) => s.settings);
  const density = useUi((s) => s.density);
  const showAccountBadge = useUi((s) => s.showAccountBadge);
  const showStatusBar = useUi((s) => s.showStatusBar);
  const emailDarkMode = useUi((s) => s.emailDarkMode);
  const dark = useThemeState((s) => s.dark);
  const set = useSetting();
  if (!settings) return null;
  return (
    <>
      <h1>Appearance</h1>
      <h2 id="h-theme">THEME</h2>
      <div role="radiogroup" aria-labelledby="h-theme">
        <Radio name="theme" checked={settings.theme === 'system'} onChange={() => void set({ theme: 'system' })} label="Use system setting" />
        <Radio name="theme" checked={settings.theme === 'light'} onChange={() => void set({ theme: 'light' })} label="Light" />
        <Radio name="theme" checked={settings.theme === 'dark'} onChange={() => void set({ theme: 'dark' })} label="Dark" />
      </div>
      <h2>WINDOW</h2>
      <Checkbox
        checked={showStatusBar}
        label="Show status bar"
        onChange={(v) => useUi.setState({ showStatusBar: v })}
      />
      <p className="hint indent">Shows sync status, message counts and updates at the bottom of the window.</p>
      <h2 id="h-density">DENSITY</h2>
      <div role="radiogroup" aria-labelledby="h-density" style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
        <Radio name="density" checked={density === 'compact'} onChange={() => useUi.setState({ density: 'compact' })} label="Compact" />
        <Radio name="density" checked={density === 'comfortable'} onChange={() => useUi.setState({ density: 'comfortable' })} label="Comfortable" />
        <Radio name="density" checked={density === 'roomy'} onChange={() => useUi.setState({ density: 'roomy' })} label="Roomy" />
      </div>
      <p className="hint" style={{ marginTop: 4 }}>
        Compact fits more messages on the screen. Roomy gives each message more space.
      </p>
      <h2 id="h-edm">EMAIL CONTENT IN DARK MODE</h2>
      <div role="radiogroup" aria-labelledby="h-edm">
        <Radio
          name="emailDarkMode"
          checked={emailDarkMode === 'auto'}
          disabled={!dark}
          onChange={() => useUi.setState({ emailDarkMode: 'auto' })}
          label="Auto (recommended)"
        />
        <div className="hint rad-hint">
          Plain emails follow the dark theme. Designed emails are adjusted when it is safe.
        </div>
        <Radio
          name="emailDarkMode"
          checked={emailDarkMode === 'light'}
          disabled={!dark}
          onChange={() => useUi.setState({ emailDarkMode: 'light' })}
          label="Always light background"
        />
      </div>
      {!dark ? <div className="hint">Only applies in the dark theme.</div> : null}
      <h2>MESSAGE LIST</h2>
      <Checkbox
        checked={showAccountBadge}
        label="Always show account badge"
        onChange={(v) => useUi.setState({ showAccountBadge: v })}
      />
      <p className="hint indent">
        Show the account letter on every message. When off, it shows only in combined views with 2 or more accounts.
      </p>
    </>
  );
}

function BadgeField({
  value,
  fallback,
  onSave,
}: {
  value: string;
  fallback: string;
  onSave: (badge: string) => Promise<void>;
}) {
  const [text, setText] = useState(value);
  const clean = Array.from(text.trim()).slice(0, 2).join('');
  return (
    <div className="field">
      <label htmlFor="badge">Badge (1 or 2 characters)</label>
      <input
        id="badge"
        className="inp"
        style={{ width: 96 }}
        maxLength={4}
        value={text}
        placeholder={fallback}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          if (!clean) setText(value);
          else if (clean !== value) void onSave(clean);
          else setText(clean);
        }}
      />
      <div className="hint">Shown on the account tile in the sidebar.</div>
    </div>
  );
}

// ---------- Mail ----------
function MailSettings() {
  const settings = useApp((s) => s.settings);
  const set = useSetting();
  if (!settings) return null;
  const opts: [number, string][] = [
    [0, 'Immediately'],
    [1000, 'After 1 second'],
    [2000, 'After 2 seconds'],
    [5000, 'After 5 seconds'],
    [-1, 'Never'],
  ];
  if (!opts.some(([v]) => v === settings.markReadDelayMs)) {
    opts.splice(1, 0, [settings.markReadDelayMs, `After ${settings.markReadDelayMs / 1000} seconds`]);
  }
  const undoOpts: [number, string][] = [
    [0, 'Off (send right away)'],
    [5000, '5 seconds'],
    [10000, '10 seconds'],
    [30000, '30 seconds'],
  ];
  return (
    <>
      <h1>Mail</h1>
      <h2>READING</h2>
      <SelectField
        label="Mark a message as read"
        value={String(settings.markReadDelayMs)}
        onChange={(e) => void set({ markReadDelayMs: Number(e.target.value) })}
        style={{ maxWidth: 260 }}
      >
        {opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </SelectField>
      <div style={{ margin: '4px 0 2px' }}>
        <Switch
          checked={settings.groupConversations}
          onChange={(v) => void set({ groupConversations: v })}
          label="Group messages into conversations"
          describedBy="conv-help"
        />
      </div>
      <p className="hint rad-hint" id="conv-help">
        Shows replies to the same subject as one row. Messages you sent are included. Turn it off to see every message by itself.
      </p>
      <h2>SENDING</h2>
      <SelectField
        label="Time to undo a sent message"
        value={String(settings.undoSendDelayMs)}
        onChange={(e) => void set({ undoSendDelayMs: Number(e.target.value) })}
        style={{ maxWidth: 260 }}
      >
        {undoOpts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </SelectField>
      <p className="hint" style={{ marginTop: -6 }}>
        After you press Send, the message waits this long. Until then you can take it back with Undo.
      </p>
      <p className="hint" style={{ marginTop: 0 }}>
        Send later keeps the message on this PC. Letterdock must be running to send it.
      </p>
      <h2>WRITING</h2>
      <Checkbox
        checked={settings.alwaysShowCcBcc}
        label="Always show Cc and Bcc"
        onChange={(v) => void set({ alwaysShowCcBcc: v })}
      />
      <p className="hint rad-hint">
        When this is off, you add Cc and Bcc with the buttons next to the To line (or Ctrl+Shift+C and Ctrl+Shift+B). Bcc is a hidden copy: the other people can&apos;t see who is in it.
      </p>
      <Checkbox
        checked={settings.rememberComposeBounds}
        label="Remember the size and position of the new mail window"
        onChange={(v) => void set({ rememberComposeBounds: v })}
      />
      <p className="hint rad-hint">
        When this is off, every new mail window opens in the middle of the screen at the standard size.
      </p>
      <Checkbox
        checked={settings.suggestFromAllAccounts}
        label="Suggest addresses from all my accounts"
        onChange={(v) => void set({ suggestFromAllAccounts: v })}
      />
      <p className="hint rad-hint">
        Addresses from the account you write from come first. Addresses you know from your other accounts follow, marked with that account&apos;s letter.
      </p>
      <h2 id="h-img">REMOTE IMAGES</h2>
      <div role="radiogroup" aria-labelledby="h-img">
        <Radio name="img" checked={settings.remoteImages === 'block'} onChange={() => void set({ remoteImages: 'block' })} label="Ask me for each message (recommended)" />
        <p className="hint rad-hint">Images stay blocked until you press Load images. Loading images can tell the sender you opened the message.</p>
        <Radio name="img" checked={settings.remoteImages === 'allowKnownSenders'} onChange={() => void set({ remoteImages: 'allowKnownSenders' })} label="Load images from senders I allowed" />
      </div>
      <AllowedSenders active={settings.remoteImages === 'allowKnownSenders'} />
      <MailStorage />
      <ImageCache />
    </>
  );
}

const fmtBytes = fileSize;

function MailStorage() {
  const settings = useApp((s) => s.settings);
  const set = useSetting();
  if (!settings) return null;
  const sizes = [256, 512, 1024, 2048];
  if (!sizes.includes(settings.maxBodyCacheMB)) sizes.push(settings.maxBodyCacheMB);
  sizes.sort((a, b) => a - b);
  return (
    <>
      <h2>DOWNLOADED MAIL</h2>
      <SelectField
        label="Largest size of downloaded mail on this PC"
        value={String(settings.maxBodyCacheMB)}
        onChange={(e) => void set({ maxBodyCacheMB: Number(e.target.value) })}
        style={{ maxWidth: 260 }}
      >
        {sizes.map((mb) => (
          <option key={mb} value={mb}>{megabytes(mb)}</option>
        ))}
      </SelectField>
      <p className="hint" style={{ marginTop: -6 }}>
        Downloaded mail is removed from this PC, oldest opened first, when it passes this size. It downloads again when you open it.
      </p>
    </>
  );
}

function ImageCache() {
  const settings = useApp((s) => s.settings);
  const set = useSetting();
  const [info, setInfo] = useState<{ bytes: number; files: number } | null>(null);
  const [clearing, setClearing] = useState(false);
  const reload = () => {
    call('images.cacheInfo')
      .then(setInfo)
      .catch(() => setInfo(null));
  };
  useEffect(reload, []);
  if (!settings) return null;
  const sizes = [100, 250, 500, 1024];
  if (!sizes.includes(settings.imageCacheMaxMb)) sizes.push(settings.imageCacheMaxMb);
  const ageOpts = [7, 30, 90];
  if (!ageOpts.includes(settings.imageCacheMaxAgeDays)) ageOpts.push(settings.imageCacheMaxAgeDays);
  ageOpts.sort((a, b) => a - b);
  return (
    <>
      <h2>IMAGE CACHE</h2>
      <p className="hint" style={{ marginTop: 0 }}>
        Images you load are saved on this PC, so they open faster next time. Images not viewed for{' '}
        {settings.imageCacheMaxAgeDays} days are removed automatically.
      </p>
      <p className="hint" style={{ margin: '4px 0 12px' }}>
        {info ? `${fmtBytes(info.bytes)} used, ${info.files} ${info.files === 1 ? 'image' : 'images'}` : 'Size unknown'}
      </p>
      <SelectField
        label="Largest size of the image cache"
        value={String(settings.imageCacheMaxMb)}
        onChange={(e) => void set({ imageCacheMaxMb: Number(e.target.value) })}
        style={{ maxWidth: 260 }}
      >
        {sizes.sort((a, b) => a - b).map((mb) => (
          <option key={mb} value={mb}>{megabytes(mb)}</option>
        ))}
      </SelectField>
      <SelectField
        label="Remove images not viewed for"
        value={String(settings.imageCacheMaxAgeDays)}
        onChange={(e) => void set({ imageCacheMaxAgeDays: Number(e.target.value) })}
        style={{ maxWidth: 260 }}
      >
        {ageOpts.map((d) => (
          <option key={d} value={d}>{d} days</option>
        ))}
      </SelectField>
      <Button
        loading={clearing}
        disabled={clearing}
        onClick={() => {
          setClearing(true);
          call('images.clearCache')
            .then(() => {
              toast('Cache cleared.');
              reload();
            })
            .catch((e) => toastError(asAppError(e).message))
            .finally(() => setClearing(false));
        }}
      >
        Clear image cache
      </Button>
    </>
  );
}

function AllowedSenders({ active }: { active: boolean }) {
  const [list, setList] = useState<string[] | null>(null);
  const reload = () => {
    call('senders.listAllowed')
      .then((l) => setList([...l].sort()))
      .catch(() => setList([]));
  };
  useEffect(reload, []);
  return (
    <div style={{ margin: '12px 0 0 28px' }}>
      <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4 }} id="allowed-title">Allowed senders</div>
      <p className="hint" style={{ marginBottom: 6 }}>
        {active
          ? 'Images from these senders load by themselves.'
          : 'These senders are saved, but their images only load by themselves when you choose "Load images from senders I allowed".'}
      </p>
      {list === null ? (
        <div className="hint">Loading...</div>
      ) : list.length === 0 ? (
        <div className="hint">
          None yet. Press &ldquo;Always load from...&rdquo; on a message to add a sender.
        </div>
      ) : (
        <ul className="allowed scroll" role="region" tabIndex={0} aria-labelledby="allowed-title">
          {list.map((addr) => (
            <li key={addr}>
              <span>{addr}</span>
              <Button
                size="sm"
                variant="subtle"
                aria-label={`Remove ${addr}`}
                onClick={() =>
                  call('senders.allowImages', { address: addr, allow: false })
                    .then(reload)
                    .catch((e) => toastError(asAppError(e).message))
                }
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------- Notifications ----------
function Notifications() {
  const settings = useApp((s) => s.settings);
  const accounts = useApp((s) => s.accounts);
  const colorOf = useAccountColor();
  const set = useSetting();
  if (!settings) return null;
  const n = settings.notifications;
  const toggleAccount = (id: string, notify: boolean) => {
    const rest = n.mutedAccountIds.filter((x) => x !== id);
    void set({ notifications: { ...n, mutedAccountIds: notify ? rest : [...rest, id] } });
  };
  return (
    <>
      <h1>Notifications</h1>
      <Checkbox checked={n.enabled} label="Show a notification for new mail" onChange={(v) => void set({ notifications: { ...n, enabled: v } })} />
      <div className="indent">
        <Checkbox checked={n.showPreview} disabled={!n.enabled} label="Show the sender and subject" onChange={(v) => void set({ notifications: { ...n, showPreview: v } })} />
        <Checkbox checked={n.sound} disabled={!n.enabled} label="Play a sound" onChange={(v) => void set({ notifications: { ...n, sound: v } })} />
      </div>
      {accounts.length > 0 ? (
        <>
          <h2 id="h-notify-acc">NOTIFY FOR THESE ACCOUNTS</h2>
          <div className="mute-list" role="group" aria-labelledby="h-notify-acc">
            {accounts.map((a) => (
              <Checkbox
                key={a.id}
                checked={!n.mutedAccountIds.includes(a.id)}
                disabled={!n.enabled}
                label={
                  <span className="acc-lbl">
                    <AccountAvatar color={colorOf(a.id)} letter={badgeOf(a)} />
                    {a.displayName}
                    <span className="hint">{a.email}</span>
                  </span>
                }
                onChange={(v) => toggleAccount(a.id, v)}
              />
            ))}
          </div>
        </>
      ) : null}
    </>
  );
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------- Advanced ----------
function Advanced() {
  const oauth = useApp((s) => s.oauth);
  const settings = useApp((s) => s.settings);
  const set = useSetting();
  const [id, setId] = useState(oauth?.microsoft.clientIdOverride ?? '');
  const [tenant, setTenant] = useState(oauth?.microsoft.tenant ?? 'common');
  const [saved, flashSaved] = useSavedFlag();
  const first = useRef(true);

  const idErr = id && !GUID.test(id.trim()) ? 'This does not look like a full ID (36 characters, like xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx).' : null;
  const tenantTrim = tenant.trim();
  const tenantErr = !tenantTrim
    ? 'Enter a tenant, like common.'
    : ['common', 'consumers', 'organizations'].includes(tenantTrim.toLowerCase()) ||
        GUID.test(tenantTrim) ||
        /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(tenantTrim)
      ? null
      : 'Use common, organizations, consumers, a tenant ID, or a domain like contoso.com.';

  // Save automatically (500 ms after the last edit) when valid.
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if ((id && idErr) || tenantErr) return;
    const h = setTimeout(() => {
      call('oauth.setSettings', { microsoft: { clientIdOverride: id.trim(), tenant: tenant.trim() } })
        .then((o: OAuthSettings) => {
          useApp.getState().setOAuth(o);
          flashSaved();
        })
        .catch((e) => toastError(asAppError(e).message));
    }, 500);
    return () => clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, tenant]);

  if (!oauth || !settings) return null;
  const usingBuiltIn = !oauth.microsoft.clientIdOverride && !!oauth.microsoft.builtInClientId;
  return (
    <>
      <h1>Advanced</h1>
      <p className="lead">Most people never need to change these.</p>
      <h2>MICROSOFT SIGN-IN KEY</h2>
      <p className="hint" style={{ marginBottom: 8 }}>
        Letterdock has its own key for &ldquo;Sign in with Microsoft&rdquo;. If you registered your own app, you can use its key instead. Your key stays on this PC.
      </p>
      {usingBuiltIn ? (
        <div style={{ marginBottom: 12 }}>
          <span className="chipsm">Using built-in key</span>
        </div>
      ) : null}
      {!oauth.microsoft.effectiveClientId ? (
        <div className="bad" style={{ marginBottom: 12 }}><Icon name="warn" />No key is set, so Microsoft sign-in will not work yet.</div>
      ) : null}
      <TextField
        label="Application (client) ID"
        mono
        value={id}
        placeholder={oauth.microsoft.builtInClientId ?? 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'}
        onChange={(e) => setId(e.target.value)}
        error={idErr}
        hint={undefined}
      />
      {id && !idErr ? <div className="ok field-ok"><Icon name="check" />Looks good</div> : null}
      <div style={{ maxWidth: 260 }}>
        <SelectField
          label="Tenant"
          value={['common', 'consumers', 'organizations'].includes(tenant) ? tenant : 'custom'}
          onChange={(e) => setTenant(e.target.value === 'custom' ? '' : e.target.value)}
        >
          <option value="common">common</option>
          <option value="organizations">organizations</option>
          <option value="consumers">consumers</option>
          <option value="custom">Other (ID or domain)</option>
        </SelectField>
        {!['common', 'consumers', 'organizations'].includes(tenant) ? (
          <TextField label="Tenant ID or domain" mono value={tenant} onChange={(e) => setTenant(e.target.value)} error={tenantErr} />
        ) : null}
      </div>
      <div className="btn-row" style={{ marginTop: 8 }}>
        <Button onClick={() => { setId(''); setTenant('common'); }}>Reset to defaults</Button>
        <span className="saved" role="status" style={{ opacity: saved ? 1 : 0 }}><Icon name="check" />Saved</span>
      </div>
      <h2>LOGGING</h2>
      <Checkbox checked={settings.verboseLogging} label="Write detailed logs (for troubleshooting)" onChange={(v) => void set({ verboseLogging: v })} />
      <div style={{ marginTop: 8 }}>
        <Button onClick={() => void call('app.openLogs').catch((e) => reportActionError(e))}>Open log folder</Button>
      </div>
    </>
  );
}

// ---------- About ----------
function About() {
  const [info, setInfo] = useState<{ version: string; dbPath: string; electron: string } | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    call('app.info').then(setInfo).catch(() => undefined);
  }, []);
  return (
    <>
      <h1>About</h1>
      <p className="lead">Letterdock is a free, open-source email client for Windows. Unlimited accounts. Your mail stays on your PC.</p>
      {info ? (
        <dl className="rdetails" style={{ fontSize: 13 }}>
          <dt>Version</dt><dd>{info.version}</dd>
          <dt>Electron</dt><dd>{info.electron}</dd>
          <dt>Data file</dt>
          <dd>
            <span className="copy-row">
              <span style={{ fontFamily: 'var(--mono)', overflowWrap: 'anywhere' }}>{info.dbPath}</span>
              <Button
                size="sm"
                icon={copied ? 'check' : 'copy'}
                aria-label="Copy the data file path"
                onClick={() => {
                  navigator.clipboard.writeText(info.dbPath).then(
                    () => {
                      setCopied(true);
                      setTimeout(() => setCopied(false), 2000);
                      toast('Path copied.');
                    },
                    () => toastError('Could not copy.'),
                  );
                }}
              >
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </span>
          </dd>
        </dl>
      ) : null}
      <div style={{ marginTop: 16 }}>
        <Button onClick={() => void call('app.openLogs').catch((e) => reportActionError(e))}>Open log folder</Button>
      </div>
    </>
  );
}
