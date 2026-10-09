// Contacts index: learning, ranking, matching, forgetting, backfill, speed.
import { describe, expect, it } from 'vitest';
import { ContactService, type ContactSource } from '../../src/engine/contacts/contactService';
import { cleanAddress, fold, isNoReply, tokenize } from '../../src/engine/contacts/text';
import { DEFAULT_SETTINGS } from '../../src/main/settings';
import { openDatabase } from '../../src/engine/db/connection';
import { header, makeAccount, makeCtx } from '../helpers';

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

function src(over: Partial<ContactSource>): ContactSource {
  return {
    accountId: 'acc-1',
    role: 'inbox',
    fromName: null,
    fromAddr: null,
    to: [],
    cc: [],
    bcc: [],
    replyTo: [],
    dateMs: NOW - DAY,
    messageId: null,
    ...over,
  };
}

function setup() {
  const t = makeCtx(() => NOW);
  t.ctx.accounts.insert(makeAccount(), 1);
  t.ctx.accounts.insert(
    makeAccount({ id: 'acc-2', email: 'work@corp.example', username: 'work@corp.example' }),
    2,
  );
  t.ctx.folders.syncListed('acc-1', [
    { path: 'INBOX', name: 'INBOX', delimiter: '/', role: 'inbox', subscribed: true, selectable: true },
    { path: 'Sent', name: 'Sent', delimiter: '/', role: 'sent', subscribed: true, selectable: true },
    { path: 'Junk', name: 'Junk', delimiter: '/', role: 'junk', subscribed: true, selectable: true },
  ]);
  return t;
}

describe('text helpers', () => {
  it('folds case and accents for any script', () => {
    expect(fold('Éric ÅNGSTRÖM')).toBe('eric angstrom');
    expect(fold('Łukasz Müller Straße')).toBe('lukasz muller strasse');
    expect(fold('ЁЛКА Йогурт')).toBe('елка иогурт');
    expect(tokenize('a.smith@Example.com')).toEqual(['a', 'smith', 'example', 'com']);
  });
  it('knows automatic addresses', () => {
    for (const a of [
      'noreply@x.com',
      'no-reply@x.com',
      'No_Reply@x.com',
      'do-not-reply@x.com',
      'donotreply@x.com',
      'mailer-daemon@x.com',
      'postmaster@x.com',
      'noreply+abc@x.com',
      'bounce+1234@mail.x.com',
    ]) {
      expect(isNoReply(a), a).toBe(true);
    }
    expect(isNoReply('anna.noreply@x.com')).toBe(false);
    expect(isNoReply('reply@x.com')).toBe(false);
  });
  it('accepts plain addresses only', () => {
    expect(cleanAddress(' Bob@Example.COM ')).toBe('bob@example.com');
    expect(cleanAddress('not an address')).toBeNull();
    expect(cleanAddress('a@b')).toBeNull();
    expect(cleanAddress('"x"@y.com')).toBeNull();
  });
});

describe('ContactService', () => {
  it('learns from received and sent mail and ranks sent-to people first', () => {
    const { ctx } = setup();
    ctx.contacts.observe([
      src({
        fromName: 'Anna Smith',
        fromAddr: 'a.smith@example.com',
        to: [{ address: 'me@example.com' }],
      }),
      src({ fromName: 'Andrew Lee', fromAddr: 'andrew@example.org' }),
      src({ fromName: 'Andrew Lee', fromAddr: 'andrew@example.org', dateMs: NOW - 2 * DAY }),
      // Sent folder: written to Anna's colleague.
      src({
        role: 'sent',
        fromAddr: 'me@example.com',
        to: [{ name: 'Anton Brown', address: 'anton@example.net' }],
        dateMs: NOW - 30 * DAY,
      }),
    ]);
    const res = ctx.contacts.suggest('an');
    expect(res.map((r) => r.address)).toEqual([
      'anton@example.net', // sent to, even though older and only once
      'andrew@example.org', // received twice
      'a.smith@example.com',
    ]);
    expect(res[0]).toMatchObject({ name: 'Anton Brown', sentCount: 1, isOwn: false });
    expect(res[1]!.sentCount).toBe(0);
    expect(res[2]!.name).toBe('Anna Smith');
  });

  it('matches word starts in name and address, ignoring accents, case and script', () => {
    const { ctx } = setup();
    ctx.contacts.observe([
      src({ fromName: 'Éric Dupont', fromAddr: 'eric@example.fr' }),
      src({ fromName: 'Иван Петров', fromAddr: 'ivan.petrov@example.ru' }),
      src({ fromName: 'Smith, Anna', fromAddr: 'asmith@example.com' }),
    ]);
    expect(ctx.contacts.suggest('eri').map((r) => r.address)).toEqual(['eric@example.fr']);
    expect(ctx.contacts.suggest('ÉRI').map((r) => r.address)).toEqual(['eric@example.fr']);
    expect(ctx.contacts.suggest('пет').map((r) => r.address)).toEqual(['ivan.petrov@example.ru']);
    expect(ctx.contacts.suggest('ИВАН').map((r) => r.address)).toEqual(['ivan.petrov@example.ru']);
    expect(ctx.contacts.suggest('иван пе').map((r) => r.address)).toEqual(['ivan.petrov@example.ru']);
    expect(ctx.contacts.suggest('anna smi').map((r) => r.address)).toEqual(['asmith@example.com']);
    expect(ctx.contacts.suggest('asmith@ex').map((r) => r.address)).toEqual(['asmith@example.com']);
    expect(ctx.contacts.suggest('zzz')).toEqual([]);
    // A word in the middle of a word does not match.
    expect(ctx.contacts.suggest('ric')).toEqual([]);
  });

  it('skips no-reply addresses, junk, trash and drafts', () => {
    const { ctx } = setup();
    ctx.contacts.observe([
      src({ fromAddr: 'noreply@shop.example', fromName: 'Shop' }),
      src({ fromAddr: 'mailer-daemon@x.example' }),
      src({ role: 'junk', fromAddr: 'spam@junk.example', fromName: 'Spammer' }),
      src({ role: 'trash', fromAddr: 'old@trash.example' }),
      src({ role: 'drafts', to: [{ address: 'draft@x.example' }] }),
      src({ fromAddr: 'real@person.example', fromName: 'Real Person' }),
    ]);
    expect(ctx.contacts.suggest('').map((r) => r.address)).toEqual(['real@person.example']);
  });

  it('marks own addresses and ranks them last', () => {
    const { ctx } = setup();
    ctx.contacts.observe([
      src({ fromName: 'Me', fromAddr: 'me@example.com' }),
      src({ role: 'sent', to: [{ address: 'me@example.com' }, { address: 'zed@example.com' }] }),
      src({ fromName: 'Meg', fromAddr: 'meg@example.com', dateMs: NOW - 400 * DAY }),
    ]);
    const res = ctx.contacts.suggest('me');
    expect(res.map((r) => r.address)).toEqual(['meg@example.com', 'me@example.com']);
    expect(res[1]!.isOwn).toBe(true);
    expect(res[0]!.isOwn).toBe(false);
  });

  it('does not mark a login name that differs from the account email as own', () => {
    const t = makeCtx(() => NOW);
    t.ctx.accounts.insert(makeAccount({ id: 'acc-1', email: 'me@example.com', username: 'other.person@example.com' }), 1);
    t.ctx.contacts.observe([
      src({ fromName: 'Other Person', fromAddr: 'other.person@example.com' }),
      src({ fromName: 'Me', fromAddr: 'me@example.com' }),
    ]);
    const res = t.ctx.contacts.suggest('');
    expect(res.find((r) => r.address === 'other.person@example.com')!.isOwn).toBe(false);
    expect(res.find((r) => r.address === 'me@example.com')!.isOwn).toBe(true);
  });

  it('keeps accounts apart when asked, and merges them otherwise', () => {
    const { ctx } = setup();
    ctx.contacts.observe([
      src({ fromName: 'Bob', fromAddr: 'bob@x.example' }),
      src({ accountId: 'acc-2', fromName: 'Bobby Tables', fromAddr: 'bob@x.example', dateMs: NOW }),
      src({ accountId: 'acc-2', fromAddr: 'carl@x.example' }),
    ]);
    expect(ctx.contacts.suggest('b').map((r) => r.address)).toEqual(['bob@x.example']);
    expect(ctx.contacts.suggest('b')[0]!.name).toBe('Bobby Tables'); // newest name wins
    ctx.settings = () => ({ ...DEFAULT_SETTINGS, suggestFromAllAccounts: false });
    expect(ctx.contacts.suggest('', 'acc-1').map((r) => r.address)).toEqual(['bob@x.example']);
    expect(ctx.contacts.suggest('', 'acc-2').map((r) => r.address).sort()).toEqual([
      'bob@x.example',
      'carl@x.example',
    ]);
    ctx.contacts.removeAccount('acc-2');
    expect(ctx.contacts.suggest('').map((r) => r.address)).toEqual(['bob@x.example']);
  });

  describe('suggestions from other accounts', () => {
    function seed() {
      const { ctx } = setup();
      ctx.contacts.observe([
        // acc-1 knows Anna (received) and Alan (received).
        src({ fromName: 'Anna One', fromAddr: 'anna@one.example' }),
        src({ fromName: 'Alan One', fromAddr: 'alan@one.example' }),
        // acc-2 knows Anna too, plus Amy (received many times) and Adam (once).
        src({ accountId: 'acc-2', fromName: 'Anna One', fromAddr: 'anna@one.example' }),
        ...[1, 2, 3, 4, 5].map((i) =>
          src({ accountId: 'acc-2', fromName: 'Amy Two', fromAddr: 'amy@two.example', dateMs: NOW - i * 1000 }),
        ),
        src({ accountId: 'acc-2', fromName: 'Adam Two', fromAddr: 'adam@two.example' }),
      ]);
      return ctx;
    }

    it('lists this account first, then contacts only other accounts know', () => {
      const ctx = seed();
      const res = ctx.contacts.suggest('a', 'acc-1');
      expect(res.map((r) => r.address)).toEqual([
        'anna@one.example',
        'alan@one.example',
        'amy@two.example',
        'adam@two.example',
      ]);
      expect(res.map((r) => r.otherAccountId)).toEqual([undefined, undefined, 'acc-2', 'acc-2']);
      expect('otherAccountId' in res[0]!).toBe(false);
    });

    it('does not mark a contact both accounts know, and honours the limit', () => {
      const ctx = seed();
      const res = ctx.contacts.suggest('anna', 'acc-2');
      expect(res).toHaveLength(1);
      expect(res[0]!.otherAccountId).toBeUndefined();
      expect(ctx.contacts.suggest('a', 'acc-1', 3).map((r) => r.address)).toEqual([
        'anna@one.example',
        'alan@one.example',
        'amy@two.example',
      ]);
    });

    it('keeps own addresses last', () => {
      const ctx = seed();
      // Own address seen through acc-1 (the From account), a normal one only through acc-2.
      ctx.contacts.observe([src({ fromAddr: 'work@corp.example' })]);
      ctx.contacts.observe([src({ accountId: 'acc-2', fromAddr: 'a.work@x.example' })]);
      const res = ctx.contacts.suggest('work', 'acc-1');
      expect(res.map((r) => r.address)).toEqual(['a.work@x.example', 'work@corp.example']);
      expect(res[1]!.isOwn).toBe(true);
    });

    it('is strict when the setting is off', () => {
      const ctx = seed();
      ctx.settings = () => ({ ...DEFAULT_SETTINGS, suggestFromAllAccounts: false });
      const res = ctx.contacts.suggest('a', 'acc-1');
      expect(res.map((r) => r.address)).toEqual(['anna@one.example', 'alan@one.example']);
      expect(res.every((r) => r.otherAccountId === undefined)).toBe(true);
    });

    it('without an account the setting makes no difference', () => {
      const ctx = seed();
      const on = ctx.contacts.suggest('a');
      ctx.settings = () => ({ ...DEFAULT_SETTINGS, suggestFromAllAccounts: false });
      expect(ctx.contacts.suggest('a')).toEqual(on);
      expect(on.every((r) => r.otherAccountId === undefined)).toBe(true);
    });
  });

  it('forget removes the contact and it is not learned again', () => {
    const { ctx } = setup();
    ctx.contacts.observe([src({ fromName: 'Bob', fromAddr: 'bob@x.example' })]);
    expect(ctx.contacts.suggest('bob')).toHaveLength(1);
    ctx.contacts.forget('Bob@X.example');
    expect(ctx.contacts.suggest('bob')).toEqual([]);
    ctx.contacts.observe([src({ fromName: 'Bob', fromAddr: 'bob@x.example' })]);
    expect(ctx.contacts.suggest('bob')).toEqual([]);
    // A restart (new service on the same database) still remembers.
    const again = new ContactService(ctx);
    expect(again.suggest('bob')).toEqual([]);
    // Writing to the address again brings it back.
    ctx.contacts.recordSent('acc-1', [{ address: 'bob@x.example' }], null);
    expect(ctx.contacts.suggest('bob')).toHaveLength(1);
    ctx.contacts.observe([src({ fromAddr: 'bob@x.example' })]);
    expect(new ContactService(ctx).suggest('bob')[0]!.sentCount).toBe(1);
  });

  it('counts a send once, even when its Sent-folder copy is synced later', () => {
    const { ctx } = setup();
    ctx.contacts.recordSent(
      'acc-1',
      [{ name: 'Cara', address: 'cara@x.example' }],
      '<abc@example.com>',
    );
    expect(ctx.contacts.suggest('cara')[0]).toMatchObject({ sentCount: 1, name: 'Cara' });
    ctx.contacts.observe([
      src({ role: 'sent', to: [{ address: 'cara@x.example' }], messageId: '<abc@example.com>' }),
    ]);
    expect(ctx.contacts.suggest('cara')[0]!.sentCount).toBe(1);
    // A different message to Cara counts.
    ctx.contacts.observe([
      src({ role: 'sent', to: [{ address: 'cara@x.example' }], messageId: '<other@example.com>' }),
    ]);
    expect(ctx.contacts.suggest('cara')[0]!.sentCount).toBe(2);
  });

  it('survives a restart (reloads from the database)', () => {
    const { ctx } = setup();
    ctx.contacts.observe([src({ fromName: 'Dora', fromAddr: 'dora@x.example' })]);
    const again = new ContactService(ctx);
    expect(again.suggest('do')).toMatchObject([{ address: 'dora@x.example', name: 'Dora' }]);
  });

  it('empty query returns the best contacts and limit is respected', () => {
    const { ctx } = setup();
    ctx.contacts.observe(
      Array.from({ length: 20 }, (_, i) => src({ fromAddr: `p${i}@x.example`, dateMs: NOW - i * DAY })),
    );
    const res = ctx.contacts.suggest('', undefined, 5);
    expect(res).toHaveLength(5);
    expect(res[0]!.address).toBe('p0@x.example');
  });

  it('backfill learns from already-synced headers once, in chunks', async () => {
    const { ctx } = setup();
    const inbox = ctx.folders.rowByRole('acc-1', 'inbox')!;
    const sent = ctx.folders.rowByRole('acc-1', 'sent')!;
    const junk = ctx.folders.rowByRole('acc-1', 'junk')!;
    ctx.messages.upsertHeaders([
      header({ folderId: inbox.id, uid: 1, from: { name: 'Alice', address: 'alice@example.com' } }),
      header({ folderId: inbox.id, uid: 2, from: { name: 'Alice', address: 'alice@example.com' } }),
      header({
        folderId: sent.id,
        uid: 1,
        from: { address: 'me@example.com' },
        to: [{ name: 'Bruno', address: 'bruno@example.com' }],
      }),
      header({ folderId: junk.id, uid: 1, from: { address: 'spam@junk.example' } }),
    ]);
    expect(ctx.contacts.needsBackfill()).toBe(true);
    // Rows added while the job runs are not counted twice.
    const job = ctx.contacts.backfill();
    ctx.contacts.observe([src({ fromAddr: 'ignored@x.example' })]); // no-op while running
    await job;
    expect(ctx.contacts.needsBackfill()).toBe(false);
    const res = ctx.contacts.suggest('');
    // (me@example.com is in every To header: it is kept but marked as own and ranked last.)
    expect(res.map((r) => r.address)).toEqual([
      'bruno@example.com',
      'alice@example.com',
      'me@example.com',
    ]);
    expect(res[2]!.isOwn).toBe(true);
    expect(res[0]!.sentCount).toBe(1);
    await ctx.contacts.backfill(); // second run does nothing
    expect(ctx.contacts.suggest('')).toHaveLength(3);
    // After the job, new mail is learned normally.
    ctx.contacts.observe([src({ fromAddr: 'new@x.example' })]);
    expect(ctx.contacts.suggest('new')).toHaveLength(1);
  });

  it('answers in a few milliseconds with 50 000 contacts', () => {
    const { ctx } = setup();
    const db = ctx.db;
    const ins = db.prepare(
      `INSERT INTO contact (account_id, address, name, name_ms, sent_count, recv_count, last_sent_ms, last_seen_ms)
       VALUES ('acc-1', ?, ?, ?, ?, ?, ?, ?)`,
    );
    const firsts = ['Anna', 'Andrew', 'Boris', 'Carla', 'Dmitri', 'Elena', 'Frank', 'Greta', 'Hugo', 'Ivana'];
    db.transaction(() => {
      for (let i = 0; i < 50_000; i++) {
        const f = firsts[i % firsts.length]!;
        ins.run(
          `${f.toLowerCase()}.${i}@host${i % 500}.example`,
          `${f} Person${i}`,
          NOW - (i % 400) * DAY,
          i % 7 === 0 ? 1 + (i % 5) : 0,
          1 + (i % 9),
          NOW - (i % 900) * DAY,
          NOW - (i % 300) * DAY,
        );
      }
    })();
    const big = new ContactService(ctx);
    expect(big.size).toBe(50_000);
    for (const q of ['', 'a', 'an', 'and', 'andrew.1', 'zzzz']) big.suggest(q); // warm up
    for (const q of ['a', 'an', 'and', 'person4', 'zzzz', '']) {
      const times: number[] = [];
      for (let i = 0; i < 7; i++) {
        const t0 = performance.now();
        big.suggest(q, undefined, 8);
        times.push(performance.now() - t0);
      }
      times.sort((x, y) => x - y);
      if (process.env['BENCH']) process.stderr.write(`suggest("${q}") median ${times[3]!.toFixed(2)} ms
`);
      // Best of 7: under parallel CPU load the median is noisy, the fastest run is not. Goal 10 ms; slack for slow CI.
      expect(times[0], `query "${q}" best ms`).toBeLessThan(25);
    }
  });
});

describe('migration', () => {
  it('creates the contact tables on a fresh database', () => {
    const db = openDatabase(':memory:');
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
    ).map((r) => r.name);
    expect(names).toEqual(
      expect.arrayContaining(['contact', 'contact_forgotten', 'contact_sent_mid']),
    );
  });
});
