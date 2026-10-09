import { create } from 'zustand';
import type { UpdateStatus } from '../../../shared/ipc';

interface UpdatesState {
  /** null until the first answer from the backend. */
  status: UpdateStatus | null;
  /** Version whose "ready" banner the user closed with Later. Shown again for a newer version. */
  dismissedVersion: string | null;
  setStatus: (s: UpdateStatus) => void;
  dismissBanner: () => void;
}

export const useUpdates = create<UpdatesState>((set, get) => ({
  status: null,
  dismissedVersion: null,
  setStatus: (status) => set({ status }),
  dismissBanner: () => {
    const s = get().status;
    if (s?.state === 'ready') set({ dismissedVersion: s.newVersion });
  },
}));
