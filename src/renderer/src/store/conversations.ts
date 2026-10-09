import { create } from 'zustand';

/**
 * A small signal for the open conversation: it goes up when messages or conversations changed (new
 * reply, move, flag). `threadIds` is what the last `conversations:changed` event listed; about 2000
 * entries mean "refresh everything" (DESIGN-SPEC 3.10.8).
 */
interface ConvSignal {
  tick: number;
  threadIds: string[];
  bump: (threadIds?: string[]) => void;
}

export const useConvSignal = create<ConvSignal>((set) => ({
  tick: 0,
  threadIds: [],
  bump: (threadIds = []) => set((s) => ({ tick: s.tick + 1, threadIds })),
}));

/** The open conversation should reload when the event names it, or lists so many that it means "all". */
export function touches(threadIds: string[], threadId: string): boolean {
  return threadIds.length === 0 || threadIds.length >= 1500 || threadIds.includes(threadId);
}
