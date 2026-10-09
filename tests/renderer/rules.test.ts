// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { RuleActions, RuleDraft } from '../../src/shared/ipc';
import {
  activityTime,
  canAddCondition,
  conditionText,
  countableConditions,
  defaultNameFor,
  matchCountText,
  ruleSummary,
  runResultText,
  validateRule,
} from '../../src/renderer/src/lib/rules';
import { folderConflictNotice } from '../../src/renderer/src/lib/queueFailures';

const none: RuleActions = { markRead: false, flag: false, delete: false, stop: false };
const rule = (o: Partial<RuleDraft> = {}): RuleDraft => ({
  name: 'Receipts',
  enabled: true,
  accountId: 'a1',
  matchMode: 'all',
  conditions: [{ field: 'from', value: 'shop@acme.com' }],
  actions: { ...none, moveToFolderId: 5, moveToFolderPath: 'Receipts', markRead: true },
  trigger: 'inbox',
  ...o,
});

describe('rule summary (3.12.1)', () => {
  it('one condition, move and mark read', () => {
    expect(ruleSummary(rule(), 'Receipts')).toBe('If From contains "shop@acme.com" > Move to Receipts, Mark as read');
  });
  it('several conditions join with "and" or "or"', () => {
    const c = [{ field: 'subject' as const, value: 'newsletter' }, { field: 'hasAttachment' as const }];
    expect(ruleSummary(rule({ conditions: c }), 'X')).toContain('Subject contains "newsletter" and Has attachment');
    expect(ruleSummary(rule({ conditions: c, matchMode: 'any' }), 'X')).toContain('"newsletter" or Has attachment');
  });
  it('delete, flag and stop in words', () => {
    const a = { ...none, delete: true, flag: true, stop: true };
    expect(ruleSummary(rule({ actions: a }))).toBe('If From contains "shop@acme.com" > Move to Trash, Flag, Stop processing more rules');
  });
  it('a condition without text is only its name', () => {
    expect(conditionText({ field: 'hasAttachment' })).toBe('Has attachment');
  });
});

describe('validateRule (3.12.2)', () => {
  it('a good rule is ok', () => {
    expect(validateRule(rule()).ok).toBe(true);
  });
  it('needs a name of at most 60 letters', () => {
    expect(validateRule(rule({ name: '  ' })).name).toBe('Give the rule a name.');
    expect(validateRule(rule({ name: 'x'.repeat(61) })).name).not.toBeNull();
    expect(validateRule(rule({ name: 'x'.repeat(60) })).name).toBeNull();
  });
  it('an empty text condition says what to do; "Has attachment" needs no text', () => {
    const e = validateRule(rule({ conditions: [{ field: 'from', value: ' ' }, { field: 'hasAttachment' }] }));
    expect(e.conditions).toEqual(['Type some text to look for.', null]);
    expect(e.ok).toBe(false);
  });
  it('needs one real action: stop alone is not enough', () => {
    const e = validateRule(rule({ actions: { ...none, stop: true } }));
    expect(e.actions).toBe('Choose what should happen to the message.');
    expect(e.ok).toBe(false);
    expect(validateRule(rule({ actions: { ...none, flag: true } })).ok).toBe(true);
  });
});

describe('texts', () => {
  it('match count', () => {
    expect(matchCountText(12, 248, false)).toBe('Matches 12 of the 248 messages in this Inbox right now.');
    expect(matchCountText(12, 248, true)).toBe('Matches 12 of the 248 messages in your Inboxes right now.');
    expect(matchCountText(0, 248, false)).toBe('No messages match yet.');
  });
  it('only complete conditions are counted', () => {
    expect(countableConditions([{ field: 'from', value: '' }, { field: 'subject', value: 'a' }, { field: 'hasAttachment' }])).toHaveLength(2);
  });
  it('up to 6 conditions', () => {
    expect(canAddCondition(5)).toBe(true);
    expect(canAddCondition(6)).toBe(false);
  });
  it('the name of a rule made from a sender', () => {
    expect(defaultNameFor({ name: 'Jane Cooper', address: 'j@x' })).toBe('Mail from Jane Cooper');
    expect(defaultNameFor({ address: 'j@x' })).toBe('Mail from j@x');
  });
  it('result of Run now: the first count names the messages', () => {
    expect(runResultText('Receipts', { matched: 12, moved: 12, trashed: 0, markedRead: 12, flagged: 0 })).toBe('Receipts: 12 messages moved, 12 marked as read.');
    expect(runResultText(null, { matched: 1, moved: 0, trashed: 1, markedRead: 0, flagged: 1 })).toBe('1 message moved to Trash, 1 flagged.');
    expect(runResultText('X', { matched: 0, moved: 0, trashed: 0, markedRead: 0, flagged: 0 })).toBe('X: No messages matched.');
  });
  it('time of an activity entry: time today, "Yesterday", date', () => {
    const now = new Date(2026, 9, 9, 12, 0).getTime();
    expect(activityTime(new Date(2026, 9, 9, 10, 42).getTime(), now)).toMatch(/10.42/);
    expect(activityTime(new Date(2026, 9, 8, 18, 3).getTime(), now)).toMatch(/^Yesterday .*(18.03|6.03)/);
    expect(activityTime(new Date(2026, 2, 12, 9, 0).getTime(), now)).toMatch(/12/);
    expect(activityTime(new Date(2026, 2, 12, 9, 0).getTime(), now)).not.toMatch(/Yesterday/);
  });
});

describe('folder conflict notices (folder:conflict)', () => {
  const base = { type: 'folder:conflict' as const, accountId: 'a1', folderName: 'Receipts' };
  it('the name was taken: tells the new name', () => {
    const n = folderConflictNotice({ ...base, op: 'create', reason: 'exists', resolvedName: 'Receipts (2)' });
    expect(n).toEqual({ text: "Folder 'Receipts' already existed on the server, so yours is now 'Receipts (2)'.", tone: 'info' });
  });
  it('gone from the server', () => {
    expect(folderConflictNotice({ ...base, op: 'delete', reason: 'gone' }).text).toContain('already gone from the server');
    expect(folderConflictNotice({ ...base, op: 'rename', reason: 'gone' }).text).toContain('is gone from the server');
  });
  it('refused for good is an error', () => {
    const n = folderConflictNotice({ ...base, op: 'rename', reason: 'refused' });
    expect(n.tone).toBe('danger');
    expect(n.text).toContain("refused to rename the folder 'Receipts'");
  });
});
