import { create } from 'zustand';
import type { SnoozeCount } from '../../../shared/ipc';
import { call } from '../lib/api';

/** How many messages are snoozed (sidebar item, status bar). Only the numbers; the list is read when the Snoozed view opens. */
interface SnoozeState {
  count: SnoozeCount | null;
  refetch: () => Promise<void>;
}

export const useSnooze = create<SnoozeState>((set) => ({
  count: null,
  async refetch() {
    try {
      set({ count: await call('snooze.count') });
    } catch {
      /* the next event retries */
    }
  },
}));
