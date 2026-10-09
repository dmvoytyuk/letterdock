import { useState } from 'react';
import type { AppError } from '../../../../shared/ipc';
import { Banner, Button, Dialog, TextField } from '../../components/ui';
import { useApp } from '../../store/app';
import { useUi } from '../../store/ui';
import { useScheduled } from '../../store/scheduled';
import { useRules } from '../../store/rules';
import { asAppError, call } from '../../lib/api';
import { toast } from '../../store/toasts';
import { SHORTCUTS } from '../../lib/shortcuts';
import { folderLabel } from '../sidebar/Sidebar';

const BAD_CHARS = /[\\/*%#]/;

function folderNameError(name: string, delimiter?: string | null): string | null {
  const n = name.trim();
  if (!n) return 'Enter a name.';
  if (BAD_CHARS.test(n) || (delimiter && n.includes(delimiter))) return 'The name cannot contain / \\ * % or #.';
  return null;
}

export function FolderDialogHost() {
  const dlg = useUi((s) => s.folderDialog);
  const folders = useApp((s) => s.folders);
  const close = () => useUi.getState().set({ folderDialog: null });
  if (!dlg) return null;
  if (dlg.kind === 'create') {
    const delim = folders.find((f) => f.accountId === dlg.accountId && f.delimiter)?.delimiter ?? '/';
    return (
      <NameDialog
        title={dlg.parentName ? `New folder in ${dlg.parentName}` : 'New folder'}
        action="Create"
        delimiter={delim}
        onClose={close}
        onSubmit={async (name) => {
          await call('folders.create', { accountId: dlg.accountId, parentPath: dlg.parentPath, name });
          void useApp.getState().refetchFolders(dlg.accountId);
          toast(`Folder "${name}" created.`);
        }}
      />
    );
  }
  const folder = folders.find((f) => f.id === dlg.folderId);
  if (!folder) return null;
  if (dlg.kind === 'rename') {
    return (
      <NameDialog
        title="Rename folder"
        action="Rename"
        initial={folder.name}
        delimiter={folder.delimiter}
        onClose={close}
        onSubmit={async (name) => {
          await call('folders.rename', { folderId: folder.id, newName: name });
          void useApp.getState().refetchFolders(folder.accountId);
        }}
      />
    );
  }
  return <DeleteFolderDialog folderId={folder.id} name={folderLabel(folder)} accountId={folder.accountId} onClose={close} />;
}

function NameDialog({
  title,
  action,
  initial = '',
  delimiter,
  onClose,
  onSubmit,
}: {
  title: string;
  action: string;
  initial?: string;
  delimiter?: string | null;
  onClose: () => void;
  onSubmit: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const local = name.trim() ? folderNameError(name, delimiter) : null;
  const submit = async () => {
    const bad = folderNameError(name, delimiter);
    if (bad) {
      setError({ code: 'INVALID_INPUT', message: bad, retryable: false });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit(name.trim());
      onClose();
    } catch (e) {
      setError(asAppError(e));
      setBusy(false);
    }
  };
  return (
    <Dialog title={title} size="sm" onClose={onClose} busy={busy}>
      <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <TextField label="Folder name" value={name} onChange={(e) => setName(e.target.value)} error={local ?? error?.message ?? null} autoComplete="off" />
        <div className="foot">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={busy} disabled={!name.trim()}>
            {action}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function DeleteFolderDialog({ folderId, name, accountId, onClose }: { folderId: number; name: string; accountId: string; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  return (
    <Dialog title="Delete folder?" size="sm" onClose={onClose} busy={busy} initialFocus=".foot .btn:not(.danger)">
      <p>
        Delete <b>{name}</b> and every message in it from the server? This cannot be undone.
      </p>
      {error ? <Banner tone="danger" className="dlg-banner" role="alert">{error.message}</Banner> : null}
      <div className="foot">
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="danger"
          loading={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await call('folders.delete', { folderId });
              void useApp.getState().refetchFolders(accountId);
              const ui = useUi.getState();
              if (ui.view.kind === 'folder' && ui.view.folderId === folderId) ui.setView({ kind: 'all' });
              onClose();
            } catch (e) {
              setError(asAppError(e));
              setBusy(false);
            }
          }}
        >
          Delete folder
        </Button>
      </div>
    </Dialog>
  );
}

export function RemoveAccountDialogHost() {
  const id = useUi((s) => s.removeAccountId);
  const account = useApp((s) => s.accounts.find((a) => a.id === id));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const scheduled = useScheduled((s) => s.count?.perAccount.find((p) => p.accountId === id)?.total ?? 0);
  const ruleCount = useRules((s) => s.rules.filter((r) => r.accountId === id).length);
  if (!id || !account) return null;
  const close = () => useUi.getState().set({ removeAccountId: null });
  return (
    <Dialog title={`Remove ${account.displayName}?`} size="sm" onClose={close} busy={busy} initialFocus=".foot .btn:not(.danger)">
      <p>
        Remove {account.displayName} from Letterdock? Mail on the server is not deleted. The copy on this PC{ruleCount > 0 ? ', its rules' : ''} and the saved password are removed.
      </p>
      {scheduled > 0 ? (
        <p style={{ marginTop: 8 }}>
          <b>
            {scheduled} scheduled {scheduled === 1 ? 'message' : 'messages'}
          </b>{' '}
          will be deleted and not sent.
        </p>
      ) : null}
      {error ? <Banner tone="danger" className="dlg-banner">{error.message}</Banner> : null}
      <div className="foot">
        <Button onClick={close}>Cancel</Button>
        <Button
          variant="danger"
          loading={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await call('accounts.remove', { accountId: id });
              const ui = useUi.getState();
              ui.set({ removeAccountId: null, settingsAccountId: null });
              ui.setView({ kind: 'all' });
              await useApp.getState().refetchAccounts();
              toast(`${account.displayName} was removed.`);
            } catch (e) {
              setError(asAppError(e));
              setBusy(false);
            }
          }}
        >
          Remove account
        </Button>
      </div>
    </Dialog>
  );
}

export function CheatsheetDialog() {
  const open = useUi((s) => s.cheatsheetOpen);
  if (!open) return null;
  return (
    <Dialog title="Keyboard shortcuts" size="lg" onClose={() => useUi.getState().set({ cheatsheetOpen: false })}>
      {/* Only the dialog scrolls inside a box. In Settings the page itself scrolls. */}
      <div className="keys-scroll scroll" tabIndex={0} role="region" aria-label="Keyboard shortcuts">
        <ShortcutTable />
      </div>
      <div className="foot">
        <Button onClick={() => useUi.getState().set({ cheatsheetOpen: false })}>Close</Button>
      </div>
    </Dialog>
  );
}

/** One key combination, for example "Ctrl+Shift+A", as <kbd> chips. */
function Combo({ combo }: { combo: string }) {
  const parts = combo.split('+');
  return (
    <span className="kseq">
      {parts.map((part, j) => (
        <span key={j} className="kpart">
          <kbd>{part}</kbd>
          {j < parts.length - 1 ? (
            <span className="kplus" aria-hidden="true">
              +
            </span>
          ) : null}
        </span>
      ))}
    </span>
  );
}

/** Keys of one shortcut. Alternatives are separated by " / " ("or") and ranges use " to ". */
function KeyChips({ keys }: { keys: string }) {
  return (
    <>
      {keys.split(' / ').map((alt, i) => (
        <span key={alt} className="kalt">
          {i > 0 ? <span className="kor">or</span> : null}
          {alt.split(' to ').map((combo, j) => (
            <span key={combo} className="kalt">
              {j > 0 ? <span className="kor">to</span> : null}
              <Combo combo={combo} />
            </span>
          ))}
        </span>
      ))}
    </>
  );
}

export function ShortcutTable() {
  const groups = ['Global', 'Message list and reading', 'Writing a message'] as const;
  return (
    <table className="keys">
      <caption className="sr-only">Keyboard shortcuts</caption>
      <thead>
        <tr>
          <th scope="col">Keys</th>
          <th scope="col">What it does</th>
        </tr>
      </thead>
      {groups.map((g) => (
        <tbody key={g}>
          <tr>
            <th scope="rowgroup" colSpan={2} className="kgroup">
              {g}
            </th>
          </tr>
          {SHORTCUTS.filter((s) => s.group === g).map((s) => (
            <tr key={s.id}>
              <td>
                <KeyChips keys={s.keys} />
              </td>
              <td>{s.label}</td>
            </tr>
          ))}
        </tbody>
      ))}
    </table>
  );
}
