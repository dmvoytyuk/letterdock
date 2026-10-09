// Ways to open the rule editor and the Run now dialog (DESIGN-SPEC 3.12.3, 3.12.4).
import type { AccountId, Address, FolderId, MessageHeader } from '../../../../shared/ipc';
import { MAX_RULES } from '../../../../shared/ipc';
import { useApp } from '../../store/app';
import { useRules } from '../../store/rules';
import { useUi, type RuleEditorRequest } from '../../store/ui';
import { toast } from '../../store/toasts';
import { defaultNameFor } from '../../lib/rules';

export function openRuleEditor(req: RuleEditorRequest): void {
  if (!req.rule && useRules.getState().rules.length >= MAX_RULES) {
    toast(`You have ${MAX_RULES} rules. Delete one to add another.`);
    return;
  }
  useUi.getState().set({ ruleEditor: req });
}

/** "Create rule from this sender...": a new rule for that account with one condition "From contains {address}". */
export function createRuleFromSender(accountId: AccountId, from: Address | null | undefined): void {
  if (!from?.address) {
    toast('This message has no sender to make a rule from.');
    return;
  }
  openRuleEditor({
    prefill: { name: defaultNameFor(from), accountId, conditions: [{ field: 'from', value: from.address }] },
  });
}

/** From a message row, the reading pane or a conversation card. Sent, Drafts, Outbox and Scheduled mail has no sender to sort. */
export function canMakeRuleFrom(m: Pick<MessageHeader, 'folderId' | 'draft'>): boolean {
  if (m.draft) return false;
  const role = useApp.getState().folders.find((f) => f.id === m.folderId)?.role;
  return role !== 'sent' && role !== 'drafts';
}

export function openRunRules(ruleId: number | 'all', folderId?: FolderId | 'allInboxes'): void {
  useUi.getState().set({ runRules: { ruleId, ...(folderId !== undefined ? { folderId } : {}) } });
}
