// Engine integration: rules (DESIGN-SPEC 3.12) against the fake IMAP server.
import { afterEach, describe, expect, it } from 'vitest';
import type {
  CountMatchesRes,
  Rule,
  RuleActivityItem,
  RuleDraft,
  RulesProgress,
} from '../../src/shared/ipc';
import { createHarness, waitFor, type Harness } from '../fakes/engineHarness';
import { rawMessage, startFakeImap, type FakeImapOptions, type FakeImapServer } from '../fakes/fakeImapServer';

let server: FakeImapServer | null = null;
let h: Harness | null = null;

afterEach(async () => {
  await h?.cleanup();
  await server?.close().catch(() => undefined);
  h = server = null;
});

const DAY = 86_400_000;

async function boot(opts: FakeImapOptions = {}, harness: { rulesBatchSize?: number } = {}) {
  server = await startFakeImap({
    inbox: [
      { raw: rawMessage({ subject: 'Old news', messageId: '<old1@x>' }) },
      { raw: rawMessage({ subject: 'Older news', messageId: '<old2@x>' }) },
    ],
    ...opts,
  });
  h = await createHarness(server);
  if (harness.rulesBatchSize) h.engine.ctx.rulesBatchSize = harness.rulesBatchSize;
  const acc = await h.addAccount();
  await waitFor('inbox synced', () => h!.inboxMessages(acc.id).length === (opts.inbox?.length ?? 2));
  await waitFor('quiet', () => h!.engine.sessions.statuses()[0]?.state === 'online');
  await waitFor('folders listed', () => h!.engine.ctx.folders.rowByRole(acc.id, 'trash'));
  await h.engine.actions.drain();
  const projects = h.folderByPath(acc.id, 'Projects');
  return { h, server, acc, projects };
}
type Booted = Awaited<ReturnType<typeof boot>>;

const call = <T>(hh: Harness, ch: string, req?: unknown) => hh.engine.handle(ch, req) as Promise<T>;

function draft(over: Partial<RuleDraft> = {}): RuleDraft {
  return {
    name: 'Test rule',
    enabled: true,
    accountId: null,
    matchMode: 'all',
    conditions: [{ field: 'from', value: 'shop@acme.com' }],
    actions: { markRead: true, flag: false, delete: false, stop: false },
    trigger: 'inbox',
    ...over,
  };
}
const act = (over: Partial<RuleDraft['actions']>): RuleDraft['actions'] => ({
  markRead: false,
  flag: false,
  delete: false,
  stop: false,
  ...over,
});

const createRule = (c: Booted, over: Partial<RuleDraft> = {}) => call<Rule>(c.h, 'rules.create', draft(over));
const activity = (c: Booted) => call<RuleActivityItem[]>(c.h, 'rulesActivity.list');
const mails = (c: Booted) => c.h.eventsOfType('notify:newMail').flatMap((e) => e.messages.map((m) => m.subject));
const enc = (t: string) => '=?utf-8?B?' + Buffer.from(t).toString('base64') + '?=';
const fromShop = (subject: string, extra: object = {}) =>
  rawMessage({ subject, from: 'Shop <shop@acme.com>', ...extra });
const idOf = (c: Booted, subject: string) => {
  const row = c.h.engine.ctx.db.prepare('SELECT id FROM message WHERE subject = ?').get(subject) as { id: number } | undefined;
  return row?.id;
};
const rowOf = (c: Booted, subject: string) => c.h.engine.ctx.messages.row(idOf(c, subject)!)!;
const waitMail = (c: Booted, subject: string) => waitFor(`mail "${subject}"`, () => idOf(c, subject));

describe('automatic run on new mail', () => {
  it('moves and marks read before the notification, so that mail does not notify', async () => {
    const c = await boot();
    await createRule(c, {
      name: 'Shop',
      accountId: c.acc.id,
      actions: act({ moveToFolderId: c.projects.id, markRead: true }),
    });
    c.h.events.length = 0;
    c.server.deliver('INBOX', { raw: fromShop('Order 1') });
    c.server.deliver('INBOX', { raw: rawMessage({ subject: 'Hello friend', from: 'Bob <bob@example.com>' }) });
    await waitMail(c, 'Order 1');
    await waitFor('notified about the other mail', () => mails(c).includes('Hello friend'));
    await waitFor('moved', () => rowOf(c, 'Order 1').folder_id === c.projects.id);
    expect(rowOf(c, 'Order 1').flag_seen).toBe(1);
    expect(mails(c)).toEqual(['Hello friend']);
    // The server follows through the normal queue.
    await c.h.engine.actions.drain();
    expect(c.server.mailbox('Projects').messages).toHaveLength(1);
    const a = await activity(c);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({
      ruleName: 'Shop',
      subject: 'Order 1',
      sender: 'Shop',
      summary: 'Moved to Projects, marked as read',
      canUndo: true,
      undone: false,
      count: 1,
    });
    expect(c.h.eventsOfType('rulesActivity:changed').length).toBeGreaterThan(0);
  });

  it('a rule that only flags does not hide the notification; reading or deleting does', async () => {
    const c = await boot();
    await createRule(c, { name: 'Flag', conditions: [{ field: 'subject', value: 'flagme' }], actions: act({ flag: true }) });
    await createRule(c, { name: 'Read', conditions: [{ field: 'subject', value: 'readme' }], actions: act({ markRead: true }) });
    await createRule(c, { name: 'Trash', conditions: [{ field: 'subject', value: 'trashme' }], actions: act({ delete: true }) });
    c.h.events.length = 0;
    for (const s of ['flagme', 'readme', 'trashme', 'plain']) {
      c.server.deliver('INBOX', { raw: rawMessage({ subject: s }) });
    }
    await waitFor('notified', () => mails(c).includes('plain'));
    await new Promise((r) => setTimeout(r, 500));
    expect(mails(c).sort()).toEqual(['flagme', 'plain']);
    expect(rowOf(c, 'flagme').flag_flagged).toBe(1);
    expect(rowOf(c, 'readme').flag_seen).toBe(1);
    expect(rowOf(c, 'trashme').folder_id).toBe(c.h.folderByRole(c.acc.id, 'trash').id);
    await c.h.engine.actions.drain();
    expect(c.server.mailbox('Trash').messages).toHaveLength(1);
  });

  it('matches From / To or Cc / Subject / attachment, all or any, ignoring case and accents, taking the text literally', async () => {
    const c = await boot();
    await createRule(c, {
      name: 'Accents',
      conditions: [{ field: 'subject', value: 'CAFE' }],
      actions: act({ flag: true }),
    });
    await createRule(c, {
      name: 'Name',
      conditions: [{ field: 'from', value: 'jose garcia' }],
      actions: act({ flag: true }),
    });
    await createRule(c, {
      name: 'Cc',
      conditions: [{ field: 'toCc', value: 'carol@example.com' }],
      actions: act({ flag: true }),
    });
    await createRule(c, {
      name: 'Attach and subject',
      conditions: [{ field: 'hasAttachment' }, { field: 'subject', value: 'invoice' }],
      actions: act({ flag: true }),
    });
    await createRule(c, {
      name: 'Any',
      matchMode: 'any',
      conditions: [{ field: 'subject', value: 'a.c' }, { field: 'subject', value: 'zzz' }],
      actions: act({ flag: true }),
    });
    const deliver = (subject: string, extra: object = {}) =>
      c.server.deliver('INBOX', { raw: rawMessage({ subject, ...extra }) });
    deliver(enc('Un café noir'));
    deliver('Hola', { from: enc('José García') + ' <jg@example.es>' });
    deliver('Copy', { cc: 'Carol <carol@example.com>' });
    deliver('Invoice 1', { attachment: true });
    deliver('Invoice 2');
    deliver('Totally abc');
    deliver('regex a.c here');
    deliver('Control');
    await waitMail(c, 'Control');
    await waitFor('rules ran', async () => (await activity(c)).length >= 5);
    const flagged = (s: string) => rowOf(c, s).flag_flagged === 1;
    expect(flagged('Un café noir')).toBe(true);
    expect(flagged('Hola')).toBe(true);
    expect(flagged('Copy')).toBe(true);
    expect(flagged('Invoice 1')).toBe(true);
    expect(flagged('Invoice 2')).toBe(false); // all of: needs the attachment too
    expect(flagged('Totally abc')).toBe(false); // "a.c" is not a pattern
    expect(flagged('regex a.c here')).toBe(true);
    expect(flagged('Control')).toBe(false);
  });

  it('order: all matching rules apply; the first Move wins; Stop ends it', async () => {
    const c = await boot();
    await createRule(c, { name: 'A flag', conditions: [{ field: 'subject', value: 'multi' }], actions: act({ flag: true }) });
    await createRule(c, {
      name: 'B to Projects',
      accountId: c.acc.id,
      conditions: [{ field: 'subject', value: 'multi' }],
      actions: act({ moveToFolderId: c.projects.id }),
    });
    await createRule(c, { name: 'C to Trash', conditions: [{ field: 'subject', value: 'multi' }], actions: act({ delete: true, markRead: true }) });
    await createRule(c, { name: 'D stop', conditions: [{ field: 'subject', value: 'stopper' }], actions: act({ stop: true, flag: true }) });
    await createRule(c, { name: 'E never', conditions: [{ field: 'subject', value: 'stopper' }], actions: act({ markRead: true }) });
    c.server.deliver('INBOX', { raw: rawMessage({ subject: 'multi rule mail' }) });
    c.server.deliver('INBOX', { raw: rawMessage({ subject: 'stopper mail' }) });
    await waitMail(c, 'stopper mail');
    await waitFor('both handled', async () => (await activity(c)).length >= 4);
    const multi = rowOf(c, 'multi rule mail');
    expect(multi.folder_id).toBe(c.projects.id); // B's move won, C's delete was ignored
    expect(multi.flag_flagged).toBe(1); // A
    expect(multi.flag_seen).toBe(1); // C still adds "mark read"
    const stopper = rowOf(c, 'stopper mail');
    expect(stopper.flag_flagged).toBe(1);
    expect(stopper.flag_seen).toBe(0); // E never ran
    expect((await activity(c)).some((a) => a.ruleName === 'E never')).toBe(false);
  });

  it('leaves old mail, the first download, and mail it already looked at alone', async () => {
    server = await startFakeImap({
      inbox: [{ raw: fromShop('Already there') }],
    });
    h = await createHarness(server);
    // The rule exists before the account is added.
    const early = await call<Rule>(h, 'rules.create', draft({ name: 'Early', actions: act({ markRead: true, flag: true }) }));
    expect(early.id).toBeGreaterThan(0);
    const acc = await h.addAccount();
    await waitFor('synced', () => h!.inboxMessages(acc.id).length === 1);
    await waitFor('online', () => h!.engine.sessions.statuses()[0]?.state === 'online');
    const c: Booted = { h, server, acc, projects: h.folderByPath(acc.id, 'Projects') };
    expect(rowOf(c, 'Already there').flag_seen).toBe(0);
    expect(rowOf(c, 'Already there').flag_flagged).toBe(0);

    // Mail dated more than 3 days ago is not sorted automatically.
    server.deliver('INBOX', { raw: fromShop('From last week'), internaldate: new Date(Date.now() - 5 * DAY) });
    server.deliver('INBOX', { raw: fromShop('Fresh') });
    await waitMail(c, 'Fresh');
    await waitFor('fresh handled', () => rowOf(c, 'Fresh').flag_flagged === 1);
    expect(rowOf(c, 'From last week').flag_flagged).toBe(0);
    expect(rowOf(c, 'Fresh').rules_done).toBe(1);

    // Once per message: the user undoes it, a later sync does not run the rule again.
    const id = idOf(c, 'Fresh')!;
    await call(h, 'messages.apply', { messageIds: [id], action: { type: 'flag', flagged: false } });
    await call(h, 'messages.apply', { messageIds: [id], action: { type: 'markRead', read: false } });
    await call(h, 'sync.all');
    await new Promise((r) => setTimeout(r, 500));
    expect(rowOf(c, 'Fresh').flag_flagged).toBe(0);
    expect(rowOf(c, 'Fresh').flag_seen).toBe(0);
  });

  it('skips Spam, Trash, Drafts and Sent; "any folder" also covers other folders', async () => {
    const c = await boot();
    await createRule(c, { name: 'Anywhere', trigger: 'anyFolder', actions: act({ flag: true }) });
    await createRule(c, {
      name: 'Inbox only',
      trigger: 'inbox',
      conditions: [{ field: 'subject', value: 'inboxonly' }],
      actions: act({ flag: true }),
    });
    for (const f of ['Junk', 'Trash', 'Sent']) {
      c.server.deliver(f, { raw: fromShop(`In ${f}`) });
      await c.h.engine.handle('sync.folder', { folderId: c.h.folderByPath(c.acc.id, f).id });
    }
    c.server.deliver('Projects', { raw: fromShop('In Projects') });
    c.server.deliver('Projects', { raw: rawMessage({ subject: 'inboxonly in Projects', from: 'Shop <shop@acme.com>' }) });
    await c.h.engine.handle('sync.folder', { folderId: c.projects.id });
    await waitMail(c, 'In Projects');
    await waitFor('projects handled', () => rowOf(c, 'In Projects').flag_flagged === 1);
    await new Promise((r) => setTimeout(r, 300));
    for (const f of ['Junk', 'Trash', 'Sent']) expect(rowOf(c, `In ${f}`).flag_flagged).toBe(0);
    expect(rowOf(c, 'inboxonly in Projects').flag_flagged).toBe(1); // the "any folder" rule, not the inbox one
    expect((await activity(c)).every((a) => a.ruleName === 'Anywhere')).toBe(true);
  });

  it('a burst of more than 5 messages from one rule is a single entry', async () => {
    const c = await boot();
    await createRule(c, { name: 'Burst', actions: act({ flag: true }) });
    for (let i = 1; i <= 7; i++) c.server.deliver('INBOX', { raw: fromShop(`Burst ${i}`) });
    await waitMail(c, 'Burst 7');
    await waitFor('all flagged', () => Array.from({ length: 7 }, (_, i) => rowOf(c, `Burst ${i + 1}`).flag_flagged).every((v) => v === 1));
    await waitFor('one entry for seven', async () => {
      const a = await activity(c);
      return a.length === 1 && a[0]!.count === 7;
    });
  });
});

describe('Run now', () => {
  async function seeded(n: number, batch: number) {
    return boot(
      {
        inbox: Array.from({ length: n }, (_, i) => ({
          raw: fromShop(`Batch ${i + 1}`, { messageId: `<b${i + 1}@x>` }),
        })),
      },
      { rulesBatchSize: batch },
    );
  }
  const finished = (c: Booted, runId: string) =>
    waitFor('run finished', () =>
      c.h
        .eventsOfType('rules:progress')
        .find((e) => e.runId === runId && e.state !== 'running'),
    ) as Promise<RulesProgress & { type: 'rules:progress' }>;

  it('works through the folder in batches and reports progress', async () => {
    const c = await seeded(12, 5);
    const rule = await createRule(c, { accountId: c.acc.id, actions: act({ moveToFolderId: c.projects.id, markRead: true }) });
    const inbox = c.h.folderByRole(c.acc.id, 'inbox');
    const res = await call<{ runId: string }>(c.h, 'rules.runNow', { ruleId: rule.id, folderId: inbox.id, runId: 'r1' });
    expect(res.runId).toBe('r1');
    const end = await finished(c, 'r1');
    expect(end).toMatchObject({ state: 'finished', total: 12, done: 12, matched: 12, moved: 12, markedRead: 12 });
    const running = c.h.eventsOfType('rules:progress').filter((e) => e.runId === 'r1' && e.state === 'running');
    expect(running.length).toBeGreaterThanOrEqual(3);
    expect(running.map((e) => e.done)).toEqual([...running.map((e) => e.done)].sort((a, b) => a - b));
    expect(c.h.folderMessages(c.projects.id)).toHaveLength(12);
    expect(c.h.inboxMessages(c.acc.id)).toHaveLength(0);
    // One entry for the whole run.
    const a = await activity(c);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ count: 12, runNow: true, canUndo: true });
    expect(end.activityIds).toEqual([a[0]!.id]);
    await c.h.engine.actions.drain();
    expect(c.server.mailbox('Projects').messages).toHaveLength(12);
  });

  it('can be cancelled between batches', async () => {
    const c = await seeded(12, 5);
    const rule = await createRule(c, { accountId: c.acc.id, actions: act({ moveToFolderId: c.projects.id }) });
    const inbox = c.h.folderByRole(c.acc.id, 'inbox');
    await call(c.h, 'rules.runNow', { ruleId: rule.id, folderId: inbox.id, runId: 'r2' });
    await call(c.h, 'rules.cancelRun', { runId: 'r2' });
    const end = await finished(c, 'r2');
    expect(end.state).toBe('cancelled');
    expect(end.moved).toBe(5);
    expect(c.h.folderMessages(c.projects.id)).toHaveLength(5);
    expect(c.h.inboxMessages(c.acc.id)).toHaveLength(7);
  });

  it('"all enabled rules" and the same message twice: still evaluated even if already looked at', async () => {
    const c = await seeded(3, 500);
    await createRule(c, { name: 'One', actions: act({ flag: true }) });
    await createRule(c, { name: 'Off', enabled: false, actions: act({ markRead: true }) });
    c.h.engine.ctx.db.exec('UPDATE message SET rules_done = 1');
    await call(c.h, 'rules.runNow', { ruleId: 'all', folderId: 'allInboxes', runId: 'r3' });
    const end = await finished(c, 'r3');
    expect(end).toMatchObject({ state: 'finished', matched: 3, flagged: 3, markedRead: 0 });
  });

  it('works offline: the change is local at once and the server follows when the connection is back', async () => {
    const c = await seeded(3, 500);
    const rule = await createRule(c, { accountId: c.acc.id, actions: act({ moveToFolderId: c.projects.id }) });
    await call(c.h, 'system.networkChanged', { online: false });
    await waitFor('offline', () => c.h.engine.sessions.statuses()[0]?.state === 'offline');
    const inbox = c.h.folderByRole(c.acc.id, 'inbox');
    await call(c.h, 'rules.runNow', { ruleId: rule.id, folderId: inbox.id, runId: 'r4' });
    const end = await finished(c, 'r4');
    expect(end.moved).toBe(3);
    expect(c.h.folderMessages(c.projects.id)).toHaveLength(3);
    expect(c.h.engine.sessions.statuses()[0]!.pendingCount).toBe(3);
    expect(c.server.mailbox('Projects').messages).toHaveLength(0);
    await call(c.h, 'system.networkChanged', { online: true });
    await waitFor('server follows', () => c.server.mailbox('Projects').messages.length === 3, 15_000);
  });

  it('refuses a folder of another account', async () => {
    const c = await seeded(1, 500);
    const rule = await createRule(c, { accountId: c.acc.id, actions: act({ flag: true }) });
    const other = await c.h.addAccount({ email: 'two@example.com', displayName: 'Two' });
    await waitFor('second synced', () => c.h.inboxMessages(other.id).length === 1);
    const inbox2 = c.h.folderByRole(other.id, 'inbox');
    await expect(
      call(c.h, 'rules.runNow', { ruleId: rule.id, folderId: inbox2.id, runId: 'r5' }),
    ).rejects.toMatchObject({ appError: { code: 'INVALID_INPUT' } });
  });
});

describe('activity and undo', () => {
  it('undo moves the message back, marks it unread again and unflags it', async () => {
    const c = await boot();
    await createRule(c, {
      accountId: c.acc.id,
      actions: act({ moveToFolderId: c.projects.id, markRead: true, flag: true }),
    });
    c.server.deliver('INBOX', { raw: fromShop('Undo me') });
    await waitMail(c, 'Undo me');
    await waitFor('sorted', async () => (await activity(c)).length === 1);
    const [entry] = await activity(c);
    expect(entry!.summary).toBe('Moved to Projects, marked as read, flagged');
    const res = await call<{ restored: number }>(c.h, 'rulesActivity.undo', { id: entry!.id });
    expect(res.restored).toBe(1);
    const row = rowOf(c, 'Undo me');
    expect(row.folder_id).toBe(c.h.folderByRole(c.acc.id, 'inbox').id);
    expect(row.flag_seen).toBe(0);
    expect(row.flag_flagged).toBe(0);
    const after = await activity(c);
    expect(after[0]).toMatchObject({ undone: true, canUndo: false });
    await expect(call(c.h, 'rulesActivity.undo', { id: entry!.id })).rejects.toMatchObject({
      appError: { code: 'INVALID_INPUT' },
    });
    // Undone mail comes back to the Inbox without a notification or a second run.
    await new Promise((r) => setTimeout(r, 500));
    await c.h.engine.actions.drain();
    expect(rowOf(c, 'Undo me').folder_id).toBe(c.h.folderByRole(c.acc.id, 'inbox').id);
    expect(mails(c)).not.toContain('Undo me');
  });

  it('cannot be undone once the message was changed', async () => {
    const c = await boot();
    await createRule(c, { accountId: c.acc.id, actions: act({ moveToFolderId: c.projects.id }) });
    c.server.deliver('INBOX', { raw: fromShop('Moved again') });
    await waitMail(c, 'Moved again');
    await waitFor('sorted', async () => (await activity(c)).length === 1);
    // The user moves it on to Archive.
    await call(c.h, 'messages.apply', { messageIds: [idOf(c, 'Moved again')], action: { type: 'archive' } });
    const [entry] = await activity(c);
    expect(entry!.canUndo).toBe(false);
    await expect(call(c.h, 'rulesActivity.undo', { id: entry!.id })).rejects.toMatchObject({
      appError: { message: expect.stringContaining('changed since') },
    });
    await c.h.engine.actions.drain();
  });

  it('keeps the last 50 and can be cleared; a deleted rule keeps its name', async () => {
    const c = await boot();
    const rule = await createRule(c, { name: 'Gone soon', actions: act({ flag: true }) });
    const db = c.h.engine.ctx.db;
    for (let i = 0; i < 55; i++) {
      db.prepare(
        `INSERT INTO rule_activity (ts, rule_id, rule_name, account_id, count, summary) VALUES (?, ?, 'Gone soon', ?, 1, 'Flagged')`,
      ).run(1000 + i, rule.id, c.acc.id);
    }
    // The cap applies on insert: one more real entry trims the list.
    c.server.deliver('INBOX', { raw: fromShop('Trim') });
    await waitMail(c, 'Trim');
    await waitFor('entry made', async () => (await activity(c)).some((a) => a.subject === 'Trim'));
    expect(await activity(c)).toHaveLength(50);
    await call(c.h, 'rules.delete', { id: rule.id });
    const list = await activity(c);
    expect(list[0]).toMatchObject({ ruleName: 'Gone soon', ruleDeleted: true, ruleId: null });
    await call(c.h, 'rulesActivity.clear');
    expect(await activity(c)).toHaveLength(0);
  });
});

describe('target folders', () => {
  it('a missing folder switches the rule off with a warning and a line in the activity', async () => {
    const c = await boot();
    const tmp = await call<{ id: number }>(c.h, 'folders.create', { accountId: c.acc.id, parentPath: null, name: 'Tmp' });
    const rule = await createRule(c, { name: 'Tmp rule', accountId: c.acc.id, actions: act({ moveToFolderId: tmp.id }) });
    expect(rule.actions.moveToFolderPath).toBe('Tmp');
    c.h.events.length = 0;
    await call(c.h, 'folders.delete', { folderId: tmp.id });
    await waitFor('rule off', async () => (await call<Rule[]>(c.h, 'rules.list'))[0]?.enabled === false);
    const [r] = await call<Rule[]>(c.h, 'rules.list');
    expect(r!.warning).toMatchObject({ kind: 'folderMissing', message: "Folder 'Tmp' is missing. Edit the rule to choose another." });
    expect(c.h.eventsOfType('rules:changed').length).toBeGreaterThan(0);
    const a = await activity(c);
    expect(a[0]).toMatchObject({ warning: true, ruleName: 'Tmp rule', canUndo: false });
    // Switching it on again does not work until another folder is chosen.
    await expect(call(c.h, 'rules.update', { id: r!.id, patch: { enabled: true } })).rejects.toMatchObject({
      appError: { code: 'INVALID_INPUT' },
    });
    const fixed = await call<Rule>(c.h, 'rules.update', {
      id: r!.id,
      patch: { enabled: true, actions: { ...r!.actions, moveToFolderId: c.projects.id } },
    });
    expect(fixed).toMatchObject({ enabled: true, warning: null });
    expect(fixed.actions.moveToFolderPath).toBe('Projects');
  });

  it('a renamed folder keeps working and the path is refreshed', async () => {
    const c = await boot();
    const f = await call<{ id: number }>(c.h, 'folders.create', { accountId: c.acc.id, parentPath: null, name: 'Before' });
    await createRule(c, { accountId: c.acc.id, actions: act({ moveToFolderId: f.id }) });
    await call(c.h, 'folders.rename', { folderId: f.id, newName: 'After' });
    c.server.deliver('INBOX', { raw: fromShop('Into renamed') });
    await waitMail(c, 'Into renamed');
    await waitFor('moved', () => rowOf(c, 'Into renamed').folder_id === f.id);
    const [r] = await call<Rule[]>(c.h, 'rules.list');
    expect(r!.actions.moveToFolderPath).toBe('After');
    expect(r!.enabled).toBe(true);
  });
});

describe('managing rules', () => {
  it('checks the input', async () => {
    const c = await boot();
    const bad = (over: Partial<RuleDraft>) => expect(createRule(c, over)).rejects.toMatchObject({ appError: { code: 'INVALID_INPUT' } });
    await bad({ name: '   ' });
    await bad({ name: 'x'.repeat(61) });
    await bad({ conditions: [] });
    await bad({ conditions: Array.from({ length: 7 }, () => ({ field: 'subject' as const, value: 'x' })) });
    await bad({ conditions: [{ field: 'subject', value: '  ' }] });
    await bad({ actions: act({}) }); // nothing to do
    await bad({ actions: act({ stop: true }) }); // Stop alone is not an action
    await bad({ accountId: c.acc.id, actions: act({ moveToFolderId: c.projects.id, delete: true }) });
    await bad({ accountId: null, actions: act({ moveToFolderId: c.projects.id }) }); // a folder needs one account
    expect(await call<Rule[]>(c.h, 'rules.list')).toHaveLength(0);
    // A condition "has attachment" carries no text.
    const ok = await createRule(c, { conditions: [{ field: 'hasAttachment', value: 'ignored' }] });
    expect(ok.conditions).toEqual([{ field: 'hasAttachment' }]);
  });

  it('allows 50 rules, reorders them, and can bring a deleted rule back in its place', async () => {
    const c = await boot();
    const made: Rule[] = [];
    for (let i = 1; i <= 50; i++) made.push(await createRule(c, { name: `Rule ${i}` }));
    await expect(createRule(c, { name: 'one too many' })).rejects.toMatchObject({ appError: { code: 'INVALID_INPUT' } });
    const ids = made.map((r) => r.id);
    const reversed = [...ids].reverse();
    const re = await call<Rule[]>(c.h, 'rules.reorder', { ids: reversed });
    expect(re.map((r) => r.id)).toEqual(reversed);
    expect(re.map((r) => r.position)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    await expect(call(c.h, 'rules.reorder', { ids: ids.slice(1) })).rejects.toMatchObject({ appError: { code: 'INVALID_INPUT' } });

    const third = re[2]!;
    const deleted = await call<Rule>(c.h, 'rules.delete', { id: third.id });
    expect(deleted.id).toBe(third.id);
    expect(await call<Rule[]>(c.h, 'rules.list')).toHaveLength(49);
    const back = await call<Rule>(c.h, 'rules.create', { ...deleted, position: 3, id: deleted.id });
    expect(back).toMatchObject({ id: third.id, position: 3 });
    expect((await call<Rule[]>(c.h, 'rules.list')).map((r) => r.id)).toEqual(reversed);
  });

  it('counts the matches in the Inbox', async () => {
    const c = await boot({
      inbox: [
        { raw: fromShop('Receipt 1') },
        { raw: fromShop('Receipt 2', { attachment: true }) },
        { raw: rawMessage({ subject: 'Hi', from: 'Bob <bob@example.com>' }) },
      ],
    });
    const count = (rule: object, folderId?: number) =>
      call<CountMatchesRes>(c.h, 'rules.countMatches', { rule, folderId });
    expect(await count({ accountId: c.acc.id, matchMode: 'all', conditions: [{ field: 'from', value: 'shop@acme.com' }] })).toEqual({ matches: 2, total: 3 });
    expect(
      await count({ accountId: null, matchMode: 'all', conditions: [{ field: 'from', value: 'SHOP' }, { field: 'hasAttachment' }] }),
    ).toEqual({ matches: 1, total: 3 });
    expect(await count({ accountId: null, matchMode: 'any', conditions: [{ field: 'subject', value: 'hi' }, { field: 'from', value: 'acme' }] })).toEqual({ matches: 3, total: 3 });
    expect(await count({ accountId: null, matchMode: 'all', conditions: [{ field: 'subject', value: 'nothing' }] }, c.projects.id)).toEqual({ matches: 0, total: 0 });
  });

  it('removing the account removes its rules', async () => {
    const c = await boot();
    await createRule(c, { name: 'Mine', accountId: c.acc.id });
    await createRule(c, { name: 'Everyone', accountId: null });
    c.h.events.length = 0;
    await call(c.h, 'accounts.remove', { accountId: c.acc.id });
    expect((await call<Rule[]>(c.h, 'rules.list')).map((r) => r.name)).toEqual(['Everyone']);
    expect(c.h.eventsOfType('rules:changed').length).toBeGreaterThan(0);
  });
});
