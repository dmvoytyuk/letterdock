// Pin, Mute and Snooze actions of the message list (DESIGN-SPEC 3.13.2, 3.13.6). Small on purpose:
// the Snooze menu, the command box and the unsubscribe dialogs load later, on first use.
import type { LightTargets, MessageHeader, MessageId, MuteSetReq } from '../../../shared/ipc';
import { MAX_PINS_PER_FOLDER } from '../../../shared/ipc';
import { asAppError, call } from './api';
import { nextToSelect } from './actions';
import { snoozeOptions, snoozeUntilText } from './snooze';
import { useApp } from '../store/app';
import type { MenuEntry } from '../components/ui';
import { useList, type ListItem } from '../store/list';
import { useUi } from '../store/ui';
import { useUndo, undoWithToken } from '../store/undo';
import { toast, toastError } from '../store/toasts';

/** Says something to screen readers without showing it. One polite live region, created when first needed. */
export function announce(text: string): void {
  let el = document.getElementById('ld-live');
  if (!el) {
    el = document.createElement('div');
    el.id = 'ld-live';
    el.className = 'sr-only';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
  }
  const live = el;
  live.textContent = '';
  setTimeout(() => {
    live.textContent = text;
  }, 50);
}

function rowsOf(ids: MessageId[]): ListItem[] {
  const set = new Set(ids);
  return useList.getState().items.filter((m) => set.has(m.id));
}

/** Rows of a conversation list are conversations: act on their messages in the view. Else on the messages. */
function targetsOf(ids: MessageId[]): LightTargets {
  const st = useList.getState();
  const rows = rowsOf(ids);
  if (st.grouped && rows.length > 0 && rows.every((r) => r.conv)) {
    return { threadIds: rows.map((r) => r.conv!.threadId), ...(st.scope ? { scope: st.scope } : {}) };
  }
  return { messageIds: ids };
}

// ---------- pin ----------

/** Pin or unpin. Over the limit nothing changes and a toast says so. No toast on success (the row moves). */
export async function setPinned(ids: MessageId[], pinned: boolean): Promise<void> {
  if (ids.length === 0) return;
  try {
    const res = await call('pin.set', { ...targetsOf(ids), pinned });
    if (!res.ok) {
      toast(`You can pin up to ${res.limit ?? MAX_PINS_PER_FOLDER} messages in a folder. Unpin one first.`);
      return;
    }
    if (res.undoToken) useUndo.getState().push(res.undoToken, res.changed.length);
    announce(pinned ? 'Pinned' : 'Unpinned');
    void useList.getState().refresh();
  } catch (e) {
    toastError(asAppError(e).message);
  }
}

/** True when every selected row is pinned (then the command says Unpin). */
export function allPinned(ids: MessageId[]): boolean {
  const rows = rowsOf(ids);
  return rows.length > 0 && rows.every((r) => r.pinned);
}

// ---------- mute ----------

export function canMute(m: Pick<MessageHeader, 'threadId'> & { conv?: unknown }): boolean {
  return !!m.threadId || !!m.conv;
}

export async function setMuted(ids: MessageId[], muted: boolean): Promise<void> {
  if (ids.length === 0) return;
  const st = useList.getState();
  const rows = rowsOf(ids);
  const req: MuteSetReq =
    st.grouped && st.scope && rows.length > 0 && rows.every((r) => r.conv)
      ? { threads: rows.map((r) => ({ accountId: r.accountId, threadId: r.conv!.threadId })), scope: st.scope, muted }
      : { messageIds: ids, muted };
  const next = muted ? nextToSelect(ids) : null;
  try {
    const res = await call('mute.set', req);
    if (res.undoToken) useUndo.getState().push(res.undoToken, Math.max(1, res.changed.length));
    const token = res.undoToken;
    if (muted) {
      if (res.archivedCount > 0) {
        useList.getState().removeLocal(ids);
        if (next !== null) useList.getState().selectOnly(next);
        else if (useUi.getState().mode === 'narrow') useUi.setState({ readerOpen: false });
      }
      toast('Conversation muted. New replies go straight to Archive.', {
        duration: 6000,
        ...(token ? { actionLabel: 'Undo', onAction: () => void undoWithToken(token) } : {}),
      });
    } else {
      toast('Conversation unmuted. New messages will arrive in your Inbox.', {
        duration: 6000,
        ...(token ? { actionLabel: 'Undo', onAction: () => void undoWithToken(token) } : {}),
      });
    }
    void useList.getState().refresh();
  } catch (e) {
    toastError(asAppError(e).message);
  }
}

export function allMuted(ids: MessageId[]): boolean {
  const rows = rowsOf(ids);
  return rows.length > 0 && rows.every((r) => r.muted);
}

// ---------- snooze ----------

/**
 * Hide messages until `until`. The rows leave the list like a delete (the next row is selected) and a
 * toast offers Undo. In the Snoozed view (`keepRows`) the rows stay: only the time changes.
 */
export async function snoozeMessages(ids: MessageId[], until: number, keepRows = false): Promise<boolean> {
  if (ids.length === 0) return false;
  const list = useList.getState();
  const next = keepRows ? null : nextToSelect(ids);
  const targets = targetsOf(ids);
  if (!keepRows) {
    list.removeLocal(ids);
    if (next !== null) list.selectOnly(next);
    else if (useUi.getState().mode === 'narrow') useUi.setState({ readerOpen: false });
  }
  try {
    const res = await call('snooze.set', { ...targets, until });
    if (res.snoozed.length === 0) {
      toastError("Couldn't snooze this message.");
      void useList.getState().refresh();
      return false;
    }
    const token = res.undoToken;
    if (token) useUndo.getState().push(token, res.snoozed.length);
    useUi.setState((s) => ({ snoozeCount: s.snoozeCount + 1 }));
    toast(`Snoozed until ${snoozeUntilText(until)}`, {
      duration: 6000,
      ...(token ? { actionLabel: 'Undo', onAction: () => void undoWithToken(token) } : {}),
    });
    return true;
  } catch {
    toastError("Couldn't snooze this message.");
    void useList.getState().refresh();
    return false;
  }
}

/** "Unsnooze now": back in the Inbox right away, unread, at the top. */
export async function unsnoozeMessages(ids: MessageId[]): Promise<void> {
  if (ids.length === 0) return;
  try {
    const res = await call('snooze.clear', { messageIds: ids });
    const token = res.undoToken;
    if (token) useUndo.getState().push(token, res.cleared.length);
    toast(res.cleared.length === 1 ? 'Back in your Inbox.' : `${res.cleared.length} messages are back in your Inbox.`, {
      duration: 6000,
      ...(token ? { actionLabel: 'Undo', onAction: () => void undoWithToken(token) } : {}),
    });
    void useList.getState().refresh();
  } catch (e) {
    toastError(asAppError(e).message);
  }
}

/** The quick times of the Snooze submenu, then "Pick date & time..." (DESIGN-SPEC 3.13.2). */
export function snoozeMenuEntries(ids: MessageId[], change = false): MenuEntry[] {
  const times = useApp.getState().settings?.snoozeTimes;
  return [
    ...snoozeOptions(Date.now(), times).map(
      (o): MenuEntry => ({ label: o.label, hint: o.hint, onSelect: () => void snoozeMessages(ids, o.at, change) }),
    ),
    { label: 'Pick date & time...', onSelect: () => useUi.getState().set({ snooze: { ids, x: 0, y: 0, step: 'pick', ...(change ? { change } : {}) } }) },
  ];
}

/** Open the Snooze menu for these rows. The menu code loads now, the first time. */
export function openSnoozeMenu(ids: MessageId[], x: number, y: number, change = false): void {
  if (ids.length === 0) return;
  useUi.getState().set({ snooze: { ids, x, y, step: 'menu', ...(change ? { change } : {}) } });
}

/** Where a keyboard or toolbar command anchors the menu: under the focused row, else under the pane's top. */
export function snoozeAnchor(): { x: number; y: number } {
  const row = document.querySelector<HTMLElement>('#pane-list .row.focus, #pane-list .row.sel');
  const r = row?.getBoundingClientRect() ?? document.querySelector('#pane-list')?.getBoundingClientRect();
  return r ? { x: r.left + 24, y: r.top + Math.min(r.height, 72) } : { x: 120, y: 120 };
}

/** Can the Snooze command be used for the mail in this folder? Inbox and your own folders only. */
export function canSnoozeRole(role: string | null | undefined): boolean {
  return !role || role === 'inbox';
}
