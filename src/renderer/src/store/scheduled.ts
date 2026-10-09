import { create } from 'zustand';
import type { AccountId, AppEvent, ScheduledCount, ScheduledItem } from '../../../shared/ipc';
import { call } from '../lib/api';
import { whenText } from '../lib/schedule';
import { toast, toastError } from './toasts';
import { useUi } from './ui';

interface ScheduledState {
  /** Every scheduled message of every account, soonest first. */
  items: ScheduledItem[];
  count: ScheduledCount | null;
  loaded: boolean;
  /** The message selected in the Scheduled view. */
  selectedId: number | null;
  /** "Change time..." dialog (main window). */
  pick: ScheduledItem | null;
  /** "Delete this scheduled message?" confirmation. */
  confirmDelete: ScheduledItem | null;
  select: (id: number | null) => void;
  refetch: () => Promise<void>;
}

// Ids already seen, so only a message that is new gets the "Scheduled for ..." toast.
let known: Set<number> | null = null;

export const useScheduled = create<ScheduledState>((set, get) => ({
  items: [],
  count: null,
  loaded: false,
  selectedId: null,
  pick: null,
  confirmDelete: null,
  select: (selectedId) => set({ selectedId }),
  async refetch() {
    try {
      const [items, count] = await Promise.all([call('scheduled.list', {}), call('scheduled.count')]);
      const sorted = [...items].sort((a, b) => a.sendAt - b.sendAt || a.id - b.id);
      if (known === null) {
        known = new Set(sorted.map((x) => x.id));
      } else {
        const fresh = sorted.filter((x) => !known!.has(x.id));
        fresh.forEach((x) => known!.add(x.id));
        // A message scheduled in a compose window: tell the user where it went (no Undo, it can be changed any time).
        if (fresh.length === 1 && fresh[0]!.status === 'scheduled') {
          const it = fresh[0]!;
          toast(`Scheduled for ${whenText(it.sendAt)}.`, {
            duration: 4000,
            actionLabel: 'View',
            onAction: () => openScheduledView(it.accountId),
          });
        }
      }
      const selected = get().selectedId;
      set({
        items: sorted,
        count,
        loaded: true,
        selectedId: selected !== null && sorted.some((x) => x.id === selected) ? selected : null,
      });
    } catch {
      /* the next event retries */
    }
  },
}));

/** Open the Scheduled view of one account, or the one for all accounts. */
export function openScheduledView(accountId: AccountId | null): void {
  useScheduled.getState().select(null);
  useUi.getState().setView({ kind: 'scheduled', accountId });
}

/** The Scheduled view the status bar item opens: the one account that has mail, else all accounts. */
export function scheduledTarget(count: ScheduledCount | null): AccountId | null {
  const withMail = (count?.perAccount ?? []).filter((p) => p.total > 0);
  return withMail.length === 1 ? withMail[0]!.accountId : null;
}

export function handleScheduledEvent(e: AppEvent): void {
  if (e.type === 'scheduled:changed') {
    void useScheduled.getState().refetch();
  } else if (e.type === 'scheduled:due') {
    // Persistent: mail that was due while Letterdock was closed is being sent now.
    toast(
      `Letterdock was closed when ${e.count === 1 ? '1 scheduled message was' : `${e.count} scheduled messages were`} due. ${e.count === 1 ? 'It is' : 'They are'} being sent now.`,
      { duration: 0, actionLabel: 'View', onAction: () => openScheduledView(scheduledTarget(useScheduled.getState().count)) },
    );
    void useScheduled.getState().refetch();
  } else if (e.type === 'scheduled:failed') {
    toastError(`Couldn't send "${e.subject || '(no subject)'}" on time.`, {
      actionLabel: 'Open',
      onAction: () => useUi.getState().setView({ kind: 'outbox' }),
    });
    void useScheduled.getState().refetch();
  }
}
