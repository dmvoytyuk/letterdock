// Conversation assignment: subject cleaning, header links, merges, the "same subject" fallback.
import { describe, expect, it } from 'vitest';
import {
  displaySubject,
  extractMessageIds,
  normalizeSubject,
} from '../../src/engine/messages/threading';
import type { HeaderInput } from '../../src/engine/db/repos/messageRepo';
import { header, makeAccount, makeCtx } from '../helpers';

const DAY = 86_400_000;
const T0 = 1_700_000_000_000;

function setup() {
  const t = makeCtx(() => T0);
  t.ctx.accounts.insert(makeAccount(), 1);
  t.ctx.accounts.insert(makeAccount({ id: 'acc-2', email: 'two@example.com', username: 'two' }), 2);
  t.ctx.folders.syncListed('acc-1', [
    { path: 'INBOX', name: 'INBOX', delimiter: '/', role: 'inbox', subscribed: true, selectable: true },
    { path: 'Sent', name: 'Sent', delimiter: '/', role: 'sent', subscribed: true, selectable: true },
  ]);
  t.ctx.folders.syncListed('acc-2', [
    { path: 'INBOX', name: 'INBOX', delimiter: '/', role: 'inbox', subscribed: true, selectable: true },
  ]);
  const inbox = t.ctx.folders.rowByRole('acc-1', 'inbox')!.id;
  const sent = t.ctx.folders.rowByRole('acc-1', 'sent')!.id;
  const inbox2 = t.ctx.folders.rowByRole('acc-2', 'inbox')!.id;
  let uid = 0;
  const add = (over: Partial<HeaderInput>) => {
    const h = header({ folderId: inbox, uid: ++uid, ...over });
    const r = t.ctx.messages.upsertHeaders([h]);
    return t.ctx.messages.row(r.added[0]!)!;
  };
  return { t, inbox, sent, inbox2, add };
}

describe('subject helpers', () => {
  it('removes reply and forward prefixes in several languages', () => {
    expect(normalizeSubject('Re: Fwd: AW: SV: Budget  review')).toBe('budget review');
    expect(normalizeSubject('RE[2]: Budget')).toBe('budget');
    expect(normalizeSubject('Fw: WG: Éric')).toBe('eric');
    expect(normalizeSubject('Re:')).toBe('');
    expect(displaySubject('Re: Fwd: Budget Review')).toBe('Budget Review');
    expect(displaySubject('Re:')).toBe('Re:');
  });
  it('reads message ids from headers', () => {
    expect(extractMessageIds('<A@x> <b@x>', '<a@x> <C@x>')).toEqual(['<a@x>', '<b@x>', '<c@x>']);
    expect(extractMessageIds(null, undefined)).toEqual([]);
  });
});

describe('conversation assignment', () => {
  it('joins a reply to its parent by In-Reply-To / References', () => {
    const { add } = setup();
    const a = add({ messageId: '<a@x>', subject: 'Plan' });
    const b = add({ messageId: '<b@x>', inReplyTo: '<a@x>', references: '<a@x>', subject: 'Re: Plan' });
    const c = add({ messageId: '<c@x>', references: '<a@x> <b@x>', subject: 'Re: Re: Plan' });
    const other = add({ messageId: '<z@x>', subject: 'Something else' });
    expect(b.thread_id).toBe(a.thread_id);
    expect(c.thread_id).toBe(a.thread_id);
    expect(other.thread_id).not.toBe(a.thread_id);
  });

  it('a parent that arrives late joins its children, and a bridge merges two conversations', () => {
    const { t, add } = setup();
    const child1 = add({ messageId: '<c1@x>', inReplyTo: '<root@x>', references: '<root@x>', subject: 'Re: T' });
    const child2 = add({ messageId: '<c2@x>', inReplyTo: '<mid@x>', references: '<mid@x>', subject: 'Re: T' });
    expect(child1.thread_id).not.toBe(child2.thread_id);
    // The message in the middle links both.
    const bridge = add({ messageId: '<mid@x>', inReplyTo: '<root@x>', references: '<root@x>', subject: 'Re: T' });
    const all = [child1.id, child2.id, bridge.id].map((id) => t.ctx.messages.row(id)!.thread_id);
    expect(new Set(all).size).toBe(1);
    // The root arrives last and joins the same conversation.
    const root = add({ messageId: '<root@x>', subject: 'T' });
    expect(root.thread_id).toBe(all[0]);
    // The merge was reported for the event.
    const touched = t.ctx.messages.drainTouchedThreads();
    expect(touched.get('acc-1')?.has(all[0]!)).toBe(true);
  });

  it('never crosses accounts', () => {
    const { t, add, inbox2 } = setup();
    const a = add({ messageId: '<a@x>', subject: 'Plan' });
    const r = t.ctx.messages.upsertHeaders([
      header({ folderId: inbox2, uid: 1, accountId: 'acc-2', messageId: '<a@x>', subject: 'Plan' }),
    ]);
    expect(t.ctx.messages.row(r.added[0]!)!.thread_id).not.toBe(a.thread_id);
  });

  it('the same message in two folders is one conversation', () => {
    const { t, sent, add } = setup();
    const a = add({ messageId: '<a@x>', subject: 'Plan' });
    const r = t.ctx.messages.upsertHeaders([
      header({ folderId: sent, uid: 1, messageId: '<a@x>', subject: 'Plan' }),
    ]);
    expect(t.ctx.messages.row(r.added[0]!)!.thread_id).toBe(a.thread_id);
  });

  describe('same-subject fallback (no header links)', () => {
    it('needs the same subject, a shared person and 30 days', () => {
      const { add } = setup();
      const a = add({ messageId: '<a@x>', subject: 'Holiday', dateMs: T0 });
      const reply = add({
        messageId: '<b@x>',
        subject: 'Re: Holiday',
        from: { address: 'me@example.com' },
        to: [{ address: 'alice@example.com' }],
        dateMs: T0 + DAY,
      });
      expect(reply.thread_id).toBe(a.thread_id);
      const late = add({ messageId: '<c@x>', subject: 'Holiday', dateMs: T0 + 40 * DAY });
      expect(late.thread_id).not.toBe(a.thread_id);
      const stranger = add({
        messageId: '<d@x>',
        subject: 'Holiday',
        from: { address: 'carol@example.com' },
        dateMs: T0 + 2 * DAY,
      });
      // Both mails go to "me" only: my own address is not a shared person.
      expect(stranger.thread_id).not.toBe(a.thread_id);
    });

    it('does not group unrelated "Invoice" mails from different senders', () => {
      const { add } = setup();
      const x = add({ messageId: '<i1@x>', subject: 'Invoice', from: { address: 'shop1@x.com' } });
      const y = add({ messageId: '<i2@x>', subject: 'Invoice', from: { address: 'shop2@x.com' } });
      expect(x.thread_id).not.toBe(y.thread_id);
    });

    it('is not used when the message has header links', () => {
      const { add } = setup();
      const a = add({ messageId: '<a@x>', subject: 'Holiday' });
      const linked = add({ messageId: '<b@x>', subject: 'Holiday', inReplyTo: '<unknown@x>' });
      expect(linked.thread_id).not.toBe(a.thread_id);
    });
  });

  it('a server conversation id decides (Gmail)', () => {
    const { add, t } = setup();
    const a = add({ messageId: '<a@x>', subject: 'One', gmThrid: '111' });
    const b = add({ messageId: '<b@x>', subject: 'Unrelated subject', gmThrid: '111' });
    const c = add({ messageId: '<c@x>', subject: 'One', inReplyTo: '<a@x>', gmThrid: '222' });
    expect(a.thread_id).toBe('g:acc-1:111');
    expect(b.thread_id).toBe(a.thread_id);
    expect(c.thread_id).toBe('g:acc-1:222'); // the server says it is another conversation
    // A draft written as a reply (no server id) joins the conversation of its parent.
    const d = t.ctx.messages.upsertLocalDraft(
      null,
      {
        accountId: 'acc-1',
        folderId: t.ctx.folders.rowByRole('acc-1', 'sent')!.id,
        messageId: '<draft@x>',
        inReplyTo: '<a@x>',
        references: '<a@x>',
        subject: 'Re: One',
        from: { address: 'me@example.com' },
        to: [{ address: 'alice@example.com' }],
        cc: [],
        bcc: [],
        dateMs: T0,
        hasAttachments: false,
        snippet: '',
        html: '<p>x</p>',
        sync: null,
      },
      T0,
    );
    expect(t.ctx.messages.row(d.id)!.thread_id).toBe(a.thread_id);
  });

  it('backfill joins rows stored before conversations existed', () => {
    const { t, add } = setup();
    const a = add({ messageId: '<a@x>', subject: 'Plan' });
    const b = add({ messageId: '<b@x>', inReplyTo: '<a@x>', references: '<a@x>', subject: 'Re: Plan' });
    const c = add({ messageId: '<c@x>', subject: 'Other' });
    // Like migration 007 left them.
    t.db.exec("UPDATE message SET thread_id = 'm:' || id, subject_norm = NULL");
    t.db.exec('DELETE FROM thread_mid');
    let after = 0;
    for (;;) {
      const res = t.ctx.messages.threads.backfillChunk(after, 2);
      after = res.lastId;
      if (res.done) break;
    }
    const tid = (id: number) => t.ctx.messages.row(id)!.thread_id;
    expect(tid(b.id)).toBe(tid(a.id));
    expect(tid(c.id)).not.toBe(tid(a.id));
    expect(t.ctx.messages.row(a.id)!.subject_norm).toBe('plan');
  });
});
