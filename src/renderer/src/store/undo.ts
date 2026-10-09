import { create } from 'zustand';
import { UNDO_WINDOW_MS } from '../../../shared/ipc';
import { asAppError, call } from '../lib/api';
import { toast, toastError, useToasts } from './toasts';
import { useList } from './list';

interface UndoState {
  token: string | null;
  at: number;
  count: number;
  push: (token: string, count: number) => void;
  clear: () => void;
}

export const useUndo = create<UndoState>((set) => ({
  token: null,
  at: 0,
  count: 0,
  push: (token, count) => set({ token, at: Date.now(), count }),
  clear: () => set({ token: null }),
}));

/** Undo a move, archive, delete or spam by token. Used by the toast button and Ctrl+Z. */
export async function undoWithToken(token: string): Promise<void> {
  const u = useUndo.getState();
  if (u.token === token) u.clear();
  // The Undo button of the message that is being undone is no longer useful.
  useToasts.setState((s) => ({ items: s.items.filter((i) => i.actionLabel !== 'Undo' || i.message === 'Message sent.') }));
  try {
    const res = await call('messages.undo', { undoToken: token });
    const n = res.restored.length;
    toast(n === 1 ? 'Message restored.' : `${n} messages restored.`);
    void useList.getState().refresh();
  } catch (e) {
    const err = asAppError(e);
    toastError(err.code === 'NOT_FOUND' ? "It's too late to undo this." : err.message);
  }
}

/** Ctrl+Z: undo the most recent action while the engine still holds its token. */
export function undoLast(): void {
  const u = useUndo.getState();
  if (!u.token || Date.now() - u.at > UNDO_WINDOW_MS) {
    toast('Nothing to undo.');
    return;
  }
  void undoWithToken(u.token);
}
