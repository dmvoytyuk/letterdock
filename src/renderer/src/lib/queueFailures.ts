// Errors from the offline action queue (DESIGN-SPEC 4.4.1). The engine undoes a change that the server
// refuses for good and sends `action:failed`. Several at once become one toast with a Details list.
import type { AppEvent, MessageId } from '../../../shared/ipc';
import { call } from './api';
import { useApp } from '../store/app';
import { toast, toastError } from '../store/toasts';

type Failed = Extract<AppEvent, { type: 'action:failed' }>;
type Dropped = Extract<AppEvent, { type: 'pending:dropped' }>;

const BATCH_MS = 300;
let buffer: Failed[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

function accountName(accountId: string | undefined): string {
  const a = accountId ? useApp.getState().accounts.find((x) => x.id === accountId) : undefined;
  return a ? a.displayName : 'your account';
}

/** "Couldn't delete 'Subject' on Work Outlook." */
function failureSentence(kind: Failed['kind'], subject: string, account: string): string {
  const s = `'${subject}'`;
  switch (kind) {
    case 'delete':
      return `Couldn't delete ${s} on ${account}.`;
    case 'move':
      return `Couldn't move ${s} on ${account}.`;
    case 'read':
      return `Couldn't change the read state of ${s} on ${account}.`;
    case 'flag':
      return `Couldn't change the flag of ${s} on ${account}.`;
    default:
      return `Couldn't save a change to ${s} on ${account}.`;
  }
}

const KIND_NOUN: Record<NonNullable<Failed['kind']>, string> = {
  delete: 'Delete',
  move: 'Move',
  read: 'Read state',
  flag: 'Flag',
};

async function subjectsOf(ids: MessageId[]): Promise<Map<MessageId, string>> {
  const map = new Map<MessageId, string>();
  if (ids.length === 0) return map;
  try {
    const headers = await call('messages.getHeaders', { messageIds: ids });
    for (const h of headers) map.set(h.id, h.subject || '(no subject)');
  } catch {
    /* fall back to a general text */
  }
  return map;
}

async function flush(): Promise<void> {
  timer = null;
  const batch = buffer;
  buffer = [];
  if (batch.length === 0) return;
  const subjects = await subjectsOf([...new Set(batch.flatMap((f) => f.messageIds))]);
  const byAccount = new Map<string, Failed[]>();
  for (const f of batch) byAccount.set(f.accountId ?? '', [...(byAccount.get(f.accountId ?? '') ?? []), f]);
  for (const [accountId, list] of byAccount) {
    const account = accountName(accountId || undefined);
    // One line per message that was undone.
    const lines = list.flatMap((f) =>
      (f.messageIds.length > 0 ? f.messageIds : [-1]).map((id) => ({
        kind: f.kind,
        subject: subjects.get(id) ?? 'a message',
        reason: f.error.message,
      })),
    );
    if (lines.length === 1) {
      const l = lines[0]!;
      toastError(`${failureSentence(l.kind, l.subject, account)} The change was undone.`);
    } else {
      toastError(`${lines.length} changes couldn't be saved to ${account} and were undone.`, {
        details: lines.map((l) => `${l.kind ? KIND_NOUN[l.kind] : 'Change'}: ${l.subject}. ${l.reason}`),
      });
    }
  }
}

export function reportQueueFailure(e: Failed): void {
  buffer.push(e);
  if (!timer) timer = setTimeout(() => void flush(), BATCH_MS);
}

/** Queued changes the engine had to drop. Only a rebuilt mailbox is worth telling the user. */
export function reportDroppedChanges(e: Dropped): void {
  if (e.reason !== 'uidvalidity') return;
  toast(
    `Some changes to ${accountName(e.accountId)} could not be sent, because the server rebuilt its mailbox.`,
    { duration: 6000 },
  );
}

/** Message for the "Back online" toast. */
export function backOnlineText(): string {
  const waiting = Object.values(useApp.getState().statuses).reduce((n, s) => n + (s.pendingCount ?? 0), 0);
  return waiting > 0
    ? `Back online. Syncing ${waiting} ${waiting === 1 ? 'change' : 'changes'}...`
    : 'Back online. Syncing...';
}

// ---------- folder conflicts ----------
type FolderConflict = Extract<AppEvent, { type: 'folder:conflict' }>;

/** The words and tone of the notice for a folder change that met a difference on the server. */
export function folderConflictNotice(e: FolderConflict): { text: string; tone: 'info' | 'danger' } {
  const name = `'${e.folderName}'`;
  const account = accountName(e.accountId);
  const verb = { create: 'create', rename: 'rename', delete: 'delete', empty: 'empty' }[e.op];
  switch (e.reason) {
    case 'exists':
      return e.resolvedName
        ? { text: `Folder ${name} already existed on the server, so yours is now '${e.resolvedName}'.`, tone: 'info' }
        : { text: `A folder named ${name} already exists on ${account}, so the change was not made.`, tone: 'info' };
    case 'gone':
      return e.op === 'delete'
        ? { text: `Folder ${name} was already gone from the server. It is removed from this PC too.`, tone: 'info' }
        : { text: `Folder ${name} is gone from the server, so the change was dropped and the folder is removed from this PC.`, tone: 'info' };
    default:
      return { text: `${account} refused to ${verb} the folder ${name}, so the change was undone.`, tone: 'danger' };
  }
}

export function reportFolderConflict(e: FolderConflict): void {
  const n = folderConflictNotice(e);
  if (n.tone === 'danger') toastError(n.text);
  else toast(n.text, { duration: 7000 });
}
