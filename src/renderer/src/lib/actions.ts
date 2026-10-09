import type {
  AccountId,
  ApplyActionRes,
  ComposeMode,
  ConversationActRes,
  ConversationRow,
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
import { useList, type ListItem } from '../store/list';
import { isUnified, useUi } from '../store/ui';
import { useUndo, undoWithToken } from '../store/undo';
import { toast, toastError } from '../store/toasts';

/**
 * The message window sets this to take over the "message left" feedback (its own Undo panel),
 * because a toast in a window that closes would be lost.
 */
export interface LeaveInfo {
  label: string;
  token?: string;
  /** How many messages the token covers. */
  count: number;
}
let leaveHandler: ((info: LeaveInfo) => void) | null = null;
export function setLeaveHandler(fn: (info: LeaveInfo) => void): () => void {
  leaveHandler = fn;
  return () => {
    if (leaveHandler === fn) leaveHandler = null;
  };
}

const LEAVING: MessageAction['type'][] = ['move', 'archive', 'delete', 'deletePermanent', 'spam', 'notSpam'];

function folderById(id: FolderId): Folder | undefined {
  return useApp.getState().folders.find((f) => f.id === id);
}

function messagesOf(ids: MessageId[]): ListItem[] {
  const set = new Set(ids);
  return useList.getState().items.filter((m) => set.has(m.id));
}

/** The list rows (conversations) these ids stand for, when the list shows conversations. */
function conversationRows(ids: MessageId[]): ListItem[] | null {
  const st = useList.getState();
  if (!st.grouped || ids.length === 0) return null;
  const rows = ids.map((id) => st.items.find((m) => m.id === id));
  return rows.every((r) => !!r?.conv) ? (rows as ListItem[]) : null;
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
    case 'deletePermanent':
      return `${plural(n, 'message', 'messages')} deleted permanently${suffix}`;
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
export interface ApplyOptions {
  /** `deletePermanent` only: the user said yes in the confirm dialog. */
  confirm?: boolean;
}

export async function applyToRealMessages(ids: MessageId[], action: MessageAction, opts: ApplyOptions = {}): Promise<boolean> {
  if (ids.length === 0) return false;
  if (action.type === 'deletePermanent' && !opts.confirm) return askPermanent(ids, null);
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
    action.type === 'deletePermanent' ||
    (action.type === 'delete' && msgs.length > 0 && msgs.every((m) => folderById(m.folderId)?.role === 'trash'));
  const next = nextToSelect(ids);
  list.removeLocal(ids);
  if (next !== null) list.selectOnly(next);
  else if (useUi.getState().mode === 'narrow') useUi.setState({ readerOpen: false });

  let res: ApplyActionRes;
  try {
    res = await call('messages.apply', { messageIds: ids, action, ...(opts.confirm ? { confirm: true } : {}) });
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
    leaveHandler({ label, count: res.succeeded.length, ...(token ? { token } : {}) });
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

/**
 * Run an action on the selected rows. With conversations on, the ids are rows of the list and the
 * action changes the messages of each conversation that are in the folder being viewed (3.10.3).
 * Otherwise they are message ids.
 */
export async function applyToMessages(ids: MessageId[], action: MessageAction, opts: ApplyOptions = {}): Promise<boolean> {
  const rows = conversationRows(ids);
  if (action.type === 'deletePermanent' && !opts.confirm) return askPermanent(ids, rows);
  if (rows) return applyToConversations(rows, action, opts);
  return applyToRealMessages(ids, action, opts);
}

/**
 * Shift+Delete, step 1: ask the engine what would be deleted (no `confirm`, so nothing changes), then
 * open the confirm dialog with that number. Step 2 is the dialog's button, which sends the same action
 * with `confirm: true` (DESIGN-SPEC 3.10.3). Returns false: nothing was deleted yet.
 */
async function askPermanent(ids: MessageId[], rows: ListItem[] | null): Promise<boolean> {
  const action: MessageAction = { type: 'deletePermanent' };
  try {
    let requires: boolean | undefined;
    let count = ids.length;
    if (rows) {
      const scope = useList.getState().scope;
      if (!scope) return false;
      const res = await call('conversations.act', { threadIds: rows.map((r) => r.conv!.threadId), scope, action });
      requires = res.requiresConfirm;
      count = res.messageCount;
    } else {
      requires = (await call('messages.apply', { messageIds: ids, action })).requiresConfirm;
    }
    if (!requires) {
      // The engine did not ask (it always should): show what is really there.
      void useList.getState().refresh();
      return false;
    }
    if (count === 0) {
      toast('There is nothing to delete here.');
      return false;
    }
    useUi.getState().set({ confirmPermanent: { ids, count } });
    return false;
  } catch (e) {
    toastError(asAppError(e).message);
    return false;
  }
}

/** How many messages a delete-for-good of these list rows removes (a conversation counts its messages in this folder). */
export function permanentCount(ids: MessageId[]): number {
  const rows = useList.getState().items.filter((m) => ids.includes(m.id));
  return rows.some((m) => m.conv) ? rows.reduce((sum, m) => sum + (m.conv ? m.conv.folderMessageIds.length : 1), 0) : ids.length;
}

function convLabel(action: MessageAction, rows: ConversationRow[], n: number, permanent: boolean, suffix: string): string {
  const one = rows.length === 1;
  const noun = one ? 'Conversation' : `${rows.length} conversations`;
  const tail = `(${plural(n, 'message', 'messages')})`;
  switch (action.type) {
    case 'delete':
      return `${noun} deleted${permanent ? ' for good' : ''} ${tail}${suffix}`;
    case 'deletePermanent':
      return `${noun} deleted permanently ${tail}${suffix}`;
    case 'archive':
      return `${noun} archived ${tail}${suffix}`;
    case 'spam':
      return `${noun} moved to Spam ${tail}${suffix}`;
    case 'notSpam':
      return `${noun} moved to Inbox ${tail}${suffix}`;
    case 'move': {
      const dest = folderTitle(folderById(action.destFolderId));
      return one ? `Moved conversation to ${dest} ${tail}${suffix}` : `Moved ${rows.length} conversations ${tail} to ${dest}${suffix}`;
    }
    default:
      return '';
  }
}

function patchRows(ids: MessageId[], header: Partial<MessageHeader>, conv: (c: ConversationRow) => Partial<ConversationRow>): void {
  const set = new Set(ids);
  useList.setState((s) => ({
    items: s.items.map((m) => (set.has(m.id) ? { ...m, ...header, ...(m.conv ? { conv: { ...m.conv, ...conv(m.conv) } } : {}) } : m)),
  }));
}

async function applyToConversations(rows: ListItem[], action: MessageAction, opts: ApplyOptions = {}): Promise<boolean> {
  const list = useList.getState();
  const scope = list.scope;
  if (!scope) return false;
  const ids = rows.map((r) => r.id);
  const convs = rows.map((r) => r.conv!);
  const threadIds = convs.map((c) => c.threadId);

  if (!LEAVING.includes(action.type)) {
    const before = new Map(rows.map((m) => [m.id, m]));
    if (action.type === 'markRead') {
      patchRows(ids, { seen: action.read }, (c) => ({ unreadCount: action.read ? 0 : Math.max(1, c.unreadCount) }));
    }
    if (action.type === 'flag') patchRows(ids, { flagged: action.flagged }, () => ({ hasFlag: action.flagged }));
    const revert = () => {
      useList.setState((s) => ({ items: s.items.map((m) => before.get(m.id) ?? m) }));
    };
    try {
      const res = await call('conversations.act', { threadIds, scope, action });
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
    action.type === 'deletePermanent' ||
    (action.type === 'delete' && rows.length > 0 && rows.every((m) => folderById(m.folderId)?.role === 'trash'));
  const next = nextToSelect(ids);
  list.removeLocal(ids);
  if (next !== null) list.selectOnly(next);
  else if (useUi.getState().mode === 'narrow') useUi.setState({ readerOpen: false });

  let res: ConversationActRes;
  try {
    res = await call('conversations.act', { threadIds, scope, action, ...(opts.confirm ? { confirm: true } : {}) });
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
  const n = res.messageCount;
  const gone = permanent || (action.type === 'delete' && !res.undoToken);
  const label =
    rows.length === 1 && n <= 1 ? describe(action, rows, 1, gone) : convLabel(action, convs, n, gone, accountSuffix(rows));
  const token = res.undoToken;
  if (token) useUndo.getState().push(token, res.succeeded.length);
  if (token) toast(label, { actionLabel: 'Undo', onAction: () => void undoWithToken(token), duration: 6000 });
  else toast(label);
  if (action.type === 'move') {
    const dest = folderById(action.destFolderId);
    if (dest) useUi.getState().rememberFolder(dest.accountId, dest.id);
  }
  return true;
}

/** One message of a conversation was marked read inside the open conversation: update its list row. */
export function noteThreadRead(threadId: string): void {
  useList.setState((s) => ({
    items: s.items.map((m) => {
      if (m.conv?.threadId !== threadId) return m;
      const unreadCount = Math.max(0, m.conv.unreadCount - 1);
      return { ...m, seen: unreadCount === 0, conv: { ...m.conv, unreadCount } };
    }),
  }));
}

/** Delete: asks first when the messages are already in Trash (that is final). */
export function deleteMessages(ids: MessageId[]): void {
  if (ids.length === 0) return;
  const msgs = messagesOf(ids);
  const final = msgs.length > 0 && msgs.every((m) => folderById(m.folderId)?.role === 'trash');
  if (final) useUi.getState().set({ confirmPermanent: { ids, count: permanentCount(ids) } });
  else void applyToMessages(ids, { type: 'delete' });
}

/** Shift+Delete: delete for good, from any folder, after a confirmation. There is no Undo. */
export function deleteMessagesPermanently(ids: MessageId[]): void {
  if (ids.length === 0) return;
  void applyToMessages(ids, { type: 'deletePermanent' });
}

/** "Save as .eml...": the raw message into a file the user picks (needs a connection). */
export async function saveAsEml(messageId: MessageId): Promise<void> {
  try {
    const r = await call('messages.saveEml', { messageId });
    if (r.saved) toast(r.path ? `Saved to ${r.path}` : 'Message saved.', { duration: 8000 });
  } catch (e) {
    toastError(asAppError(e).message);
  }
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

/**
 * The message to reply to in a conversation: the newest one that is not yours; if every message is
 * yours, the newest one (3.10.3).
 */
export async function replyTargetOf(c: ConversationRow): Promise<MessageId> {
  if (!c.latest.fromMe || c.count < 2) return c.latest.id;
  const scope = useList.getState().scope ?? undefined;
  const res = await call('conversations.get', { threadId: c.threadId, accountId: c.accountId, ...(scope ? { scope } : {}) });
  const real = res.messages.filter((m) => !m.isDraft);
  const theirs = real.filter((m) => !m.fromMe);
  return (theirs[theirs.length - 1] ?? real[real.length - 1])?.header.id ?? c.latest.id;
}

export function composeFrom(mode: Exclude<ComposeMode, 'new'>, id: MessageId | undefined): void {
  if (id === undefined) {
    toast('Select a message first.');
    return;
  }
  const row = conversationRows([id])?.[0];
  if (row?.conv && row.conv.latest.fromMe && row.conv.count > 1) {
    replyTargetOf(row.conv)
      .then((target) => openCompose({ mode, sourceMessageId: target }))
      .catch((e) => toastError(asAppError(e).message));
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
