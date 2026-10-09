import { create } from 'zustand';
import type { AppEvent, OutboxItem } from '../../../shared/ipc';
import { asAppError, call } from '../lib/api';
import { toast, toastError } from './toasts';
import { useUi } from './ui';

interface OutboxState {
  items: OutboxItem[];
  loaded: boolean;
  refetch: () => Promise<void>;
}

/** Outbox ids that already got an "Undo send" toast, and subjects for error messages. */
// Keyed by id and send time: the engine can reuse an id after "Undo send" removed the row.
const toasted = new Set<string>();
const keyOf = (it: OutboxItem) => `${it.id}:${it.sendAt}`;
const subjects = new Map<number, string>();
const undoShown = new Set<number>();
let baseline = false;

export const useOutbox = create<OutboxState>((set) => ({
  items: [],
  loaded: false,
  async refetch() {
    try {
      const items = await call('outbox.list');
      for (const it of items) subjects.set(it.id, it.subject);
      if (!baseline) {
        // Mail that was already waiting when the window opened gets no "Undo" toast.
        for (const it of items) toasted.add(keyOf(it));
        baseline = true;
      } else {
        for (const it of items) {
          if (toasted.has(keyOf(it))) continue;
          toasted.add(keyOf(it));
          const wait = it.sendAt - Date.now();
          if (it.state === 'queued' && it.attempts === 0 && wait > 1500) showUndoSend(it, wait);
        }
      }
      set({ items, loaded: true });
    } catch {
      /* the next event retries */
    }
  },
}));

function showUndoSend(it: OutboxItem, wait: number): void {
  undoShown.add(it.id);
  toast('Message sent.', {
    actionLabel: 'Undo',
    duration: wait,
    onAction: () => void undoSend(it.id),
  });
}

/** "Undo send": take the message back and reopen it in a compose window. */
export async function undoSend(outboxId: number): Promise<void> {
  try {
    const r = await call('outbox.cancel', { outboxId });
    if (r.draftId) await call('compose.openWindow', { mode: 'new', draftId: r.draftId });
    else toast('The message was taken back.');
  } catch (e) {
    const err = asAppError(e);
    toastError(err.code === 'CANCELLED' ? "It's too late. This message is already being sent." : err.message);
  } finally {
    undoShown.delete(outboxId);
    void useOutbox.getState().refetch();
  }
}

export function handleOutboxEvent(e: AppEvent): void {
  if (e.type === 'outbox:changed') {
    void useOutbox.getState().refetch();
  } else if (e.type === 'send:result') {
    const subject = subjects.get(e.outboxId);
    const name = subject ? ` "${subject}"` : '';
    if (e.ok && !e.error) {
      // Messages that had an Undo toast need no second toast.
      if (!undoShown.delete(e.outboxId)) toast('Message sent.');
    } else if (e.ok && e.error) {
      toastError(`Message${name} was sent, but: ${e.error.message}`);
    } else {
      toastError(`Couldn't send${name}. ${e.error?.message ?? ''}`.trim(), {
        actionLabel: 'Open Outbox',
        onAction: () => useUi.getState().setView({ kind: 'outbox' }),
      });
    }
    void useOutbox.getState().refetch();
  }
}
