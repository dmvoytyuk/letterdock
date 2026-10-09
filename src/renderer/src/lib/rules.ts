// Words and checks for Rules (DESIGN-SPEC 3.12). Pure functions, so they can be tested without a screen.
import type { Address, RuleActions, RuleCondition, RuleConditionField, RuleDraft } from '../../../shared/ipc';
import { MAX_RULE_CONDITIONS } from '../../../shared/ipc';

export const FIELD_LABELS: Record<RuleConditionField, string> = {
  from: 'From contains',
  toCc: 'To or Cc contains',
  subject: 'Subject contains',
  hasAttachment: 'Has attachment',
};
export const FIELD_ORDER: RuleConditionField[] = ['from', 'toCc', 'subject', 'hasAttachment'];

/** "From contains "shop@acme.com"" or "Has attachment". */
export function conditionText(c: RuleCondition): string {
  if (c.field === 'hasAttachment') return 'Has attachment';
  return `${FIELD_LABELS[c.field]} "${(c.value ?? '').trim()}"`;
}

/** The action words of a rule: "Move to Receipts, Mark as read". `folderName` is the shown name of the target folder. */
export function actionWords(a: RuleActions, folderName?: string | null): string[] {
  const out: string[] = [];
  if (a.moveToFolderId) out.push(`Move to ${folderName || a.moveToFolderPath || 'a folder'}`);
  if (a.delete) out.push('Move to Trash');
  if (a.markRead) out.push('Mark as read');
  if (a.flag) out.push('Flag');
  if (a.stop) out.push('Stop processing more rules');
  return out;
}

/** The one-line summary under the name of a rule: `If From contains "shop@acme.com" > Move to Receipts`. */
export function ruleSummary(r: Pick<RuleDraft, 'conditions' | 'matchMode' | 'actions'>, folderName?: string | null): string {
  const joiner = r.matchMode === 'any' ? ' or ' : ' and ';
  const cond = r.conditions.map(conditionText).join(joiner);
  return `If ${cond} > ${actionWords(r.actions, folderName).join(', ')}`;
}

export interface RuleErrors {
  name: string | null;
  /** One entry per condition: null when fine. */
  conditions: (string | null)[];
  /** No action chosen. */
  actions: string | null;
  /** True when nothing is wrong. */
  ok: boolean;
}

/** The same checks as the engine, in plain words, so the editor can show them before saving. */
export function validateRule(r: Pick<RuleDraft, 'name' | 'conditions' | 'actions'>): RuleErrors {
  const name = r.name.trim() ? (r.name.trim().length > 60 ? 'Use 60 letters or fewer.' : null) : 'Give the rule a name.';
  const conditions = r.conditions.map((c) =>
    c.field !== 'hasAttachment' && !(c.value ?? '').trim() ? 'Type some text to look for.' : null,
  );
  const a = r.actions;
  const any = !!a.moveToFolderId || a.markRead || a.flag || a.delete;
  const actions = any ? null : 'Choose what should happen to the message.';
  return {
    name,
    conditions,
    actions,
    ok: name === null && r.conditions.length >= 1 && conditions.every((c) => c === null) && actions === null,
  };
}

/** Conditions that are complete enough to count matches (empty text conditions are left out). */
export function countableConditions(list: RuleCondition[]): RuleCondition[] {
  return list.filter((c) => c.field === 'hasAttachment' || (c.value ?? '').trim());
}

export const canAddCondition = (n: number): boolean => n < MAX_RULE_CONDITIONS;

/** "Mail from Jane Cooper" for a rule made from a message. */
export function defaultNameFor(sender: Address | null | undefined): string {
  const who = sender?.name?.trim() || sender?.address || 'a sender';
  return `Mail from ${who}`.slice(0, 60);
}

/** The text of "Matches 12 of the 248 messages in this Inbox right now." */
export function matchCountText(matches: number, total: number, allAccounts: boolean): string {
  if (matches === 0) return 'No messages match yet.';
  const where = allAccounts ? 'in your Inboxes' : 'in this Inbox';
  return `Matches ${matches.toLocaleString()} of the ${total.toLocaleString()} messages ${where} right now.`;
}

/** Time of an activity entry: "10:42", "Yesterday 18:03" or "12 Mar". */
export function activityTime(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const n = new Date(now);
  const startToday = new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime();
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (ts >= startToday) return time;
  if (ts >= startToday - 86_400_000) return `Yesterday ${time}`;
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(d.getFullYear() === n.getFullYear() ? {} : { year: 'numeric' }) });
}

/** The toast after a Run now: "Receipts: 12 messages moved, 12 marked as read." */
export function runResultText(
  name: string | null,
  p: { matched: number; moved: number; trashed: number; markedRead: number; flagged: number },
): string {
  // The first part names the messages ("12 messages moved"), the next ones only count ("12 marked as read").
  const num = (x: number) => x.toLocaleString();
  const parts: string[] = [];
  const add = (x: number, tail: string) => {
    if (!x) return;
    parts.push(parts.length === 0 ? `${num(x)} ${x === 1 ? 'message' : 'messages'} ${tail}` : `${num(x)} ${tail}`);
  };
  add(p.moved, 'moved');
  add(p.trashed, 'moved to Trash');
  add(p.markedRead, 'marked as read');
  add(p.flagged, 'flagged');
  const body = parts.length > 0 ? parts.join(', ') : p.matched === 0 ? 'No messages matched' : 'Nothing to change';
  return `${name ? `${name}: ` : ''}${body}.`;
}
