import type {
  AccountId,
  ApplyActionRes,
  ComposeMode,
  Folder,
  FolderId,
  MarkAllReadScope,
  MessageAction,
  MessageHeader,
  MessageId,
  PrepareComposeReq,
} from '../../../shared/ipc';
import { asAppError, call } from './api';
import { useApp } from '../store/app';
import { useList } from '../store/list';
import { isUnified, useUi } from '../store/ui';
import { useUndo, undoWithToken } from '../store/undo';
import { toast, toastError } from '../store/toasts';

/**
 * The message window sets this to take over the "message left" feedback (its own Undo panel),
 * because a toast in a window that closes would be lost.
 */
let leaveHandler: ((info: { label: string; token?: string }) => void) | null = null;
export function setLeaveHandler(fn: (info: { label: string; token?: string }) => void): () => void {
  leaveHandler = fn;
  return () => {
    if (leaveHandler === fn) leaveHandler = null;
  };
}

const LEAVING: MessageAction['type'][] = ['move', 'archive', 'delete', 'spam', 'notSpam'];

function folderById(id: FolderId): Folder | undefined {
  return useApp.getState().folders.find((f) => f.id === id);
}

function messagesOf(ids: MessageId[]): MessageHeader[] {
  const set = new Set(ids);
  return useList.getState().items.filter((m) => set.has(m.id));
}

const plural = (n: number, one: string, many: string) => (n === 1 ? `1 ${one}` : `${n} ${many}`);

function accountSuffix(msgs: MessageHeader[]): string {
  if (leaveHandler || !isUnified(useUi.getState().view) || msgs.length === 0) return '';
  const first = msgs[0]!.accountId;
  if (!msgs.every((m) => m.accountId === first)) return '';
  const a = useApp.getState().accounts.find((x) => x.id === first);
  return a ? ` from ${a.displayName}` : '';
}

/** Short folder name for toasts. */
export function folderTitle(f: Folder | undefined): string {
  if (!f) return 'folder';
  const names: Record<string, string> = {
    inbox: 'Inbox',
    drafts: 'Drafts',
    sent: 'Sent',
    archive: 'Archive',
    all: 'All Mail',
    junk: 'Spam',
    trash: 'Trash',
  };
  return (f.role && names[f.role]) || f.name;
}

function describe(action: MessageAction, msgs: MessageHeader[], n: number, permanent: boolean): string {
  const suffix = accountSuffix(msgs);
  switch (action.type) {
    case 'delete':
      return permanent
        ? `${plural(n, 'message', 'messages')} deleted for good${suffix}`
        : `${plural(n, 'message', 'messages')} deleted${suffix}`;
    case 'archive':
      return `${plural(n, 'message', 'messages')} archived${suffix}`;
    case 'spam':
      return `${plural(n, 'message', 'messages')} moved to Spam${suffix}`;
    case 'notSpam':
      return `${plural(n, 'message', 'messages')} moved to Inbox${suffix}`;
    case 'move':
      return `Moved ${plural(n, 'message', 'messages')} to ${folderTitle(folderById(action.destFolderId))}${suffix}`;
    default:
      return '';
  }
}

/** The message to select after the given ones leave the list: the next one, else the one before. */
function nextToSelect(ids: MessageId[]): MessageId | null {
  const { items, selectedIds } = useList.getState();
  if (selectedIds.length !== 1 || !ids.includes(selectedIds[0]!)) return null;
  const gone = new Set(ids);
  const at = items.findIndex((m) => m.id === selectedIds[0]);
  for (let i = at + 1; i < items.length; i++) if (!gone.has(items[i]!.id)) return items[i]!.id;
  for (let i = at - 1; i >= 0; i--) if (!gone.has(items[i]!.id)) return items[i]!.id;
  return null;
}

/**
 * Run an action on messages. Read and flag changes show instantly. Moves, deletes and spam
 * remove the rows at once, show an Undo toast, and come back by themselves if the server says no
 * (the engine then sends action:failed and messages:changed).
 */
export async function applyToMessages(ids: MessageId[], action: MessageAction): Promise<boolean> {
  if (ids.length === 0) return false;
  const list = useList.getState();
  const msgs = messagesOf(ids);

  if (!LEAVING.includes(action.type)) {
    const before = new Map(msgs.map((m) => [m.id, m]));
    if (action.type === 'markRead') list.patch(ids, { seen: action.read });
    if (action.type === 'flag') list.patch(ids, { flagged: action.flagged });
    const revert = () => {
      const l = useList.getState();
      for (const [id, m] of before) l.patch([id], { seen: m.seen, flagged: m.flagged });
    };
    try {
      const res = await call('messages.apply', { messageIds: ids, action });
      if (res.failed.length > 0) {
        revert();
        toastError(res.failed[0]!.error.message);
        return res.succeeded.length > 0;
      }
      return true;
    } catch (e) {
      revert();
      toastError(asAppError(e).message);
      return false;
    }
  }

  const permanent =
    action.type === 'delete' && msgs.length > 0 && msgs.every((m) => folderById(m.folderId)?.role === 'trash');
  const next = nextToSelect(ids);
  list.removeLocal(ids);
  if (next !== null) list.selectOnly(next);
  else if (useUi.getState().mode === 'narrow') useUi.setState({ readerOpen: false });

  let res: ApplyActionRes;
  try {
    res = await call('messages.apply', { messageIds: ids, action });
  } catch (e) {
    toastError(asAppError(e).message);
    void useList.getState().refresh();
    return false;
  }
  if (res.failed.length > 0) {
    toastError(res.failed[0]!.error.message);
    void useList.getState().refresh();
  }
  if (res.succeeded.length === 0) return false;
  const label = describe(action, msgs, res.succeeded.length, permanent || (action.type === 'delete' && !res.undoToken));
  const token = res.undoToken;
  if (token) useUndo.getState().push(token, res.succeeded.length);
  if (leaveHandler) {
    leaveHandler(token ? { label, token } : { label });
  } else if (token) {
    toast(label, { actionLabel: 'Undo', onAction: () => void undoWithToken(token), duration: 6000 });
  } else {
    toast(label);
  }
  if (action.type === 'move') {
    const dest = folderById(action.destFolderId);
    if (dest) useUi.getState().rememberFolder(dest.accountId, dest.id);
  }
  return true;
}

/** Delete: asks first when the messages are already in Trash (that is final). */
export function deleteMessages(ids: MessageId[]): void {
  if (ids.length === 0) return;
  const msgs = messagesOf(ids);
  const final = msgs.length > 0 && msgs.every((m) => folderById(m.folderId)?.role === 'trash');
  if (final) useUi.getState().set({ confirmPermanent: ids });
  else void applyToMessages(ids, { type: 'delete' });
}

export function moveMessages(ids: MessageId[], destFolderId: FolderId): Promise<boolean> {
  return applyToMessages(ids, { type: 'move', destFolderId });
}

/** Folder role of a message ("junk" decides between Spam and Not spam). */
export function roleOf(m: MessageHeader): Folder['role'] | undefined {
  return folderById(m.folderId)?.role;
}

export async function markAllRead(scope: MarkAllReadScope, what: string): Promise<void> {
  try {
    const r = await call('messages.markAllRead', { scope });
    toast(
      r.count === 0
        ? `Nothing to mark in ${what}.`
        : `${plural(r.count, 'message', 'messages')} in ${what} marked as read.`,
    );
    void useList.getState().refresh();
  } catch (e) {
    toastError(asAppError(e).message);
  }
}

export async function emptyFolder(folderId: FolderId): Promise<boolean> {
  try {
    const r = await call('folders.empty', { folderId });
    toast(r.deleted === 0 ? 'Nothing to delete.' : `${plural(r.deleted, 'message', 'messages')} deleted for good.`);
    void useList.getState().refresh();
    return true;
  } catch (e) {
    toastError(asAppError(e).message);
    return false;
  }
}

// ---------- compose ----------
export function openCompose(req: PrepareComposeReq): void {
  call('compose.openWindow', req).catch((e) => toastError(asAppError(e).message));
}

/** Account the user is looking at, for "New mail" (undefined = let the engine choose). */
export function currentAccountId(): AccountId | undefined {
  const { view } = useUi.getState();
  if (view.kind === 'account') return view.accountId;
  if (view.kind === 'folder') return folderById(view.folderId)?.accountId;
  if (view.kind === 'search') return view.accountId ?? undefined;
  return undefined;
}

export function newMessage(): void {
  const accountId = currentAccountId();
  openCompose({ mode: 'new', ...(accountId ? { accountId } : {}) });
}

export function composeFrom(mode: Exclude<ComposeMode, 'new'>, id: MessageId | undefined): void {
  if (id === undefined) {
    toast('Select a message first.');
    return;
  }
  openCompose({ mode, sourceMessageId: id });
}

/** Open a draft from the Drafts folder in the compose window. */
export function editDraft(id: MessageId): void {
  openCompose({ mode: 'new', draftMessageId: id });
}

/** Open a message in its own window (DESIGN-SPEC 3.9). Drafts open in compose instead. */
export function openInWindow(m: MessageHeader): void {
  if (m.draft || roleOf(m) === 'drafts') {
    editDraft(m.id);
    return;
  }
  call('message.openWindow', { messageId: m.id }).catch((e) => toastError(asAppError(e).message));
}

export function describeError(e: unknown): string {
  return asAppError(e).message;
}
