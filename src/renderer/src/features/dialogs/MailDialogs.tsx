import { useMemo, useState, type KeyboardEvent as RKE } from 'react';
import type { Folder } from '../../../../shared/ipc';
import { Icon, type IconName } from '../../components/Icon';
import { Button, Dialog } from '../../components/ui';
import { useApp } from '../../store/app';
import { useList } from '../../store/list';
import { useUi } from '../../store/ui';
import { applyToMessages, emptyFolder, folderTitle, moveMessages } from '../../lib/actions';
import { orderFolders } from '../sidebar/Sidebar';

const ROLE_ICON: Record<string, IconName> = {
  inbox: 'inbox',
  drafts: 'draft',
  sent: 'send',
  archive: 'archive',
  all: 'archive',
  junk: 'spam',
  trash: 'trash',
};

/** All the small confirm and picker dialogs for mail actions. */
export function MailDialogsHost() {
  return (
    <>
      <MoveDialogHost />
      <ConfirmPermanentHost />
      <EmptyFolderHost />
    </>
  );
}

// ---------- move to folder ----------
function MoveDialogHost() {
  const ids = useUi((s) => s.moveDialog);
  if (!ids) return null;
  return <MoveDialog ids={ids} onClose={() => useUi.getState().set({ moveDialog: null })} />;
}

function MoveDialog({ ids, onClose }: { ids: number[]; onClose: () => void }) {
  const folders = useApp((s) => s.folders);
  const recentMap = useUi((s) => s.recentFolders);
  const items = useList((s) => s.items);
  const [filter, setFilter] = useState('');
  const [activeRaw, setActive] = useState<number | null>(null);

  const msgs = useMemo(() => items.filter((m) => ids.includes(m.id)), [items, ids]);
  const accountId = msgs[0]?.accountId;
  const here = useMemo(() => new Set(msgs.map((m) => m.folderId)), [msgs]);

  const rows = useMemo(() => {
    if (!accountId) return [] as { folder: Folder; group: string }[];
    const mine = folders.filter((f) => f.accountId === accountId && f.selectable);
    const q = filter.trim().toLowerCase();
    const match = (f: Folder) => !q || folderTitle(f).toLowerCase().includes(q) || f.path.toLowerCase().includes(q);
    const out: { folder: Folder; group: string }[] = [];
    const used = new Set<number>();
    if (!q) {
      for (const id of recentMap[accountId] ?? []) {
        const f = mine.find((x) => x.id === id);
        if (f && !here.has(f.id)) {
          out.push({ folder: f, group: 'Recent' });
          used.add(f.id);
        }
      }
    }
    const { main, more } = orderFolders(mine);
    for (const f of main) if (match(f) && !used.has(f.id)) out.push({ folder: f, group: 'Folders' });
    for (const f of more) if (match(f) && !used.has(f.id)) out.push({ folder: f, group: 'Folders' });
    return out;
  }, [accountId, folders, filter, recentMap, here]);

  // Start on the first folder the messages can actually move to.
  const firstFree = Math.max(0, rows.findIndex((r) => !(here.has(r.folder.id) && here.size === 1)));
  const active = activeRaw ?? firstFree;

  const pick = (f: Folder) => {
    if (here.has(f.id) && here.size === 1) return;
    onClose();
    void moveMessages(ids, f.id);
  };

  const onKey = (e: RKE) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive(Math.min(rows.length - 1, active + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(Math.max(0, active - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const r = rows[Math.min(active, rows.length - 1)];
      if (r) pick(r.folder);
    }
  };

  const account = useApp.getState().accounts.find((a) => a.id === accountId);
  let lastGroup = '';
  return (
    <Dialog title="Move to folder" size="sm" onClose={onClose}>
      <p className="hint" style={{ marginBottom: 8 }}>
        {msgs.some((m) => m.conv)
          ? ids.length === 1
            ? '1 conversation'
            : `${ids.length} conversations`
          : ids.length === 1
            ? '1 message'
            : `${ids.length} messages`}
        {account ? ` in ${account.displayName}` : ''}
      </p>
      <input
        className="inp"
        placeholder="Find a folder"
        aria-label="Find a folder"
        value={filter}
        onChange={(e) => {
          setFilter(e.target.value);
          setActive(null);
        }}
        onKeyDown={onKey}
        autoComplete="off"
        aria-controls="move-list"
      />
      <div id="move-list" className="movelist scroll" role="listbox" aria-label="Folders" tabIndex={-1}>
        {rows.length === 0 ? <div className="hint" style={{ padding: 12 }}>No folder matches.</div> : null}
        {rows.map((r, i) => {
          const header = r.group !== lastGroup ? r.group : null;
          lastGroup = r.group;
          const disabled = here.has(r.folder.id) && here.size === 1;
          return (
            <div key={`${r.group}-${r.folder.id}`}>
              {header ? <div className="mgroup">{header}</div> : null}
              <button
                type="button"
                role="option"
                aria-selected={i === active}
                disabled={disabled}
                tabIndex={-1}
                className={`mrow ${i === active ? 'act' : ''}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(r.folder)}
              >
                <Icon name={(r.folder.role && ROLE_ICON[r.folder.role]) || 'folder'} />
                <span className="nm">{folderTitle(r.folder)}</span>
                {r.folder.path !== r.folder.name ? <span className="pth">{r.folder.path}</span> : null}
                {disabled ? <span className="pth">current</span> : null}
              </button>
            </div>
          );
        })}
      </div>
      <div className="foot">
        <Button onClick={onClose}>Cancel</Button>
      </div>
    </Dialog>
  );
}

// ---------- delete for good ----------
function ConfirmPermanentHost() {
  const ids = useUi((s) => s.confirmPermanent);
  const items = useList((s) => s.items);
  if (!ids) return null;
  const close = () => useUi.getState().set({ confirmPermanent: null });
  // With conversations on, the ids are conversations: count the messages in this folder (DESIGN-SPEC 3.10.3).
  const rows = items.filter((m) => ids.includes(m.id));
  const n = rows.some((m) => m.conv) ? rows.reduce((sum, m) => sum + (m.conv ? m.conv.folderMessageIds.length : 1), 0) : ids.length;
  return (
    <Dialog title="Delete for good?" size="sm" onClose={close} initialFocus=".foot .btn:not(.danger)">
      <p>
        {n === 1 ? 'This message is' : `These ${n} messages are`} already in Trash. Deleting{' '}
        {n === 1 ? 'it' : 'them'} now removes {n === 1 ? 'it' : 'them'} from the server. This cannot be
        undone.
      </p>
      <div className="foot">
        <Button onClick={close}>Cancel</Button>
        <Button
          variant="danger"
          onClick={() => {
            close();
            void applyToMessages(ids, { type: 'delete' });
          }}
        >
          Delete for good
        </Button>
      </div>
    </Dialog>
  );
}

// ---------- empty Trash / Spam ----------
function EmptyFolderHost() {
  const id = useUi((s) => s.emptyFolderId);
  const folder = useApp((s) => s.folders.find((f) => f.id === id));
  const [busy, setBusy] = useState(false);
  if (!id || !folder) return null;
  const close = () => useUi.getState().set({ emptyFolderId: null });
  const name = folder.role === 'trash' ? 'Trash' : 'Spam';
  const account = useApp.getState().accounts.find((a) => a.id === folder.accountId);
  return (
    <Dialog title={`Empty ${name}?`} size="sm" onClose={close} busy={busy} initialFocus=".foot .btn:not(.danger)">
      <p>
        Delete every message in {name}
        {account ? ` of ${account.displayName}` : ''} for good? This removes them from the server and cannot be undone.
      </p>
      <div className="foot">
        <Button onClick={close}>Cancel</Button>
        <Button
          variant="danger"
          loading={busy}
          onClick={async () => {
            setBusy(true);
            await emptyFolder(folder.id);
            setBusy(false);
            close();
          }}
        >
          Empty {name}
        </Button>
      </div>
    </Dialog>
  );
}
