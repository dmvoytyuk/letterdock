import { create } from 'zustand';
import type { AppEvent, Rule, RuleActivityItem, RulesProgress } from '../../../shared/ipc';
import { asAppError, call } from '../lib/api';
import { runResultText } from '../lib/rules';
import { toast, toastError } from './toasts';
import { useUi } from './ui';

interface RulesState {
  rules: Rule[];
  activity: RuleActivityItem[];
  rulesLoaded: boolean;
  activityLoaded: boolean;
  /** Last progress of each Run now, by run id. */
  progress: Record<string, RulesProgress>;
  refetchRules: () => Promise<void>;
  refetchActivity: () => Promise<void>;
}

export const useRules = create<RulesState>((set) => ({
  rules: [],
  activity: [],
  rulesLoaded: false,
  activityLoaded: false,
  progress: {},
  async refetchRules() {
    try {
      const rules = [...(await call('rules.list'))].sort((a, b) => a.position - b.position);
      set({ rules, rulesLoaded: true });
    } catch {
      /* the next event retries */
    }
  },
  async refetchActivity() {
    try {
      set({ activity: await call('rulesActivity.list'), activityLoaded: true });
    } catch {
      /* the next event retries */
    }
  },
}));

// Name shown in the result toast of each Run now (a run for one rule is named; "all" is not).
const runNames = new Map<string, string | null>();
export function registerRun(runId: string, name: string | null): void {
  runNames.set(runId, name);
}

/** The toast after a Run now: "Receipts: 12 messages moved, 12 marked as read. [Undo] [View activity]". */
function finishRun(p: RulesProgress): void {
  const name = runNames.get(p.runId) ?? null;
  runNames.delete(p.runId);
  if (p.state === 'failed') {
    toastError(p.error?.message ?? "Couldn't run the rule.");
    return;
  }
  const text = runResultText(name, p);
  if (p.state === 'cancelled') {
    toast(`Stopped after ${p.done.toLocaleString()} of ${p.total.toLocaleString()} messages. ${text}`, { duration: 6000 });
    return;
  }
  const ids = p.activityIds;
  toast(text, {
    duration: 8000,
    ...(ids.length > 0
      ? {
          actionLabel: 'Undo',
          onAction: () => {
            Promise.all(ids.map((id) => call('rulesActivity.undo', { id })))
              .then(() => toast('Undone.'))
              .catch((err) => toastError(asAppError(err).message));
          },
        }
      : {}),
    secondaryLabel: 'View activity',
    onSecondary: () => useUi.getState().set({ rulesTab: 'activity', page: 'settings', settingsSection: 'rules', drawerOpen: false }),
  });
}

export function handleRulesEvent(e: AppEvent): void {
  if (e.type === 'rules:changed') void useRules.getState().refetchRules();
  else if (e.type === 'rulesActivity:changed') void useRules.getState().refetchActivity();
  else if (e.type === 'rules:progress') {
    const { type: _t, ...p } = e;
    useRules.setState((s) => ({ progress: { ...s.progress, [p.runId]: p } }));
    if (p.state !== 'running') finishRun(p);
  }
}
