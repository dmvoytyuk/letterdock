import { create } from 'zustand';
import { asAppError, isUnsupported } from '../lib/api';

export interface ToastItem {
  id: number;
  message: string;
  tone: 'info' | 'danger';
  actionLabel?: string;
  onAction?: () => void;
  /** Optional second link that only closes the toast, for example "Later". */
  secondaryLabel?: string;
  onSecondary?: () => void;
  duration: number; // ms, 0 = stays until dismissed
  /** One line per item; shown under the message when the user presses Details. */
  details?: string[];
}

type NewToast = Pick<ToastItem, 'message'> &
  Partial<Pick<ToastItem, 'tone' | 'actionLabel' | 'onAction' | 'secondaryLabel' | 'onSecondary' | 'duration' | 'details'>>;

interface ToastState {
  items: ToastItem[];
  push: (t: NewToast) => void;
  dismiss: (id: number) => void;
}

let nextId = 1;
export const useToasts = create<ToastState>((set, get) => ({
  items: [],
  push: (t) => {
    const tone = t.tone ?? 'info';
    const item: ToastItem = {
      ...t,
      id: nextId++,
      tone,
      duration: t.duration ?? (tone === 'danger' ? 0 : 4000),
    };
    // At most 3 toasts, newest last. The same message replaces its older copy.
    const rest = get().items.filter((x) => x.message !== item.message);
    set({ items: [...rest, item].slice(-3) });
  },
  dismiss: (id) => set({ items: get().items.filter((x) => x.id !== id) }),
}));

export const toast = (message: string, extra: Omit<NewToast, 'message'> = {}) =>
  useToasts.getState().push({ message, ...extra });

export const toastError = (message: string, extra: Omit<NewToast, 'message' | 'tone'> = {}) =>
  useToasts.getState().push({ message, tone: 'danger', ...extra });

/** Actions the backend has not built yet (reply, forward, ...). */
export function comingSoon(what?: string): void {
  toast(what ? `${what}: coming in the next update.` : 'Coming in the next update.');
}

/** Shows the right toast for a failed action. UNSUPPORTED becomes the friendly "coming soon" toast. */
export function reportActionError(e: unknown, what?: string): void {
  if (isUnsupported(e)) {
    comingSoon(what);
    return;
  }
  toastError(asAppError(e).message);
}
